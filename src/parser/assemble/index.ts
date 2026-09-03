import { attachListContainers } from './lists.ts';
import type {
  ContentKindCounts,
  DocumentModelArtifact,
  DocumentModelPage,
  LedgerEntry,
  LayoutPageArtifact,
  OverlaidTextMode,
  PageFurnitureMode,
  ParseRawPageArtifact,
  ProbeCrossArtifact,
  RawSourceObject,
  Region,
  SourceLedgerArtifact,
  SourceLedgerPage,
} from '../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../schema/artifacts.ts';
import type {
  Annotation,
  Bbox,
  DocumentInfo,
  Element,
  FurnitureType,
  OutlineNode,
  PageStatus,
  SourceObjectId,
  Style,
} from '../../schema/element.ts';
import type { Warning } from '../../schema/warnings.ts';
import { UNCLASSIFIED_SOURCE_CONFIDENCE, VISUAL_SOURCE_CONFIDENCE } from '../params/confidence.ts';
import { MIN_SOURCE_OBJECT_COVERAGE, isIgnorableTextSource } from '../params/ledger.ts';
import type { MaterializedFigureAsset } from '../parse/figure-asset.ts';
import {
  DIAGRAM_RELATION_ENGINE,
  textForBlockSources,
  textForDiagramRelationSources,
} from '../layout/index.ts';
import { isListMarkerText } from '../layout/list-marker.ts';
import {
  documentTextProfile,
  dominantTextStyle,
  headingLevelForFontSize,
  type DocumentTextProfile,
} from '../layout/text-profile.ts';
import { isFurnitureType } from '../layout/furniture/index.ts';
import { tableForRegion } from '../layout/table/index.ts';
import { tableText } from '../layout/table/cells.ts';
import {
  LIST_ITEM_FLAT_DEPTH,
  FIGURE_CAPTION_HORIZONTAL_OVERLAP_RATIO,
  FIGURE_CAPTION_MAX_GAP_RATIO,
  NUMERIC_HEADING_MARKER,
  PRIMARY_HEADING_LEVEL,
  PRIMARY_HEADING_MARKER,
  SECONDARY_HEADING_LEVEL,
  SECONDARY_HEADING_MARKER,
} from '../params/layout.ts';
import { describeLostKinds, summarizeLedgerPage } from './conservation.ts';
import { mergeCrossPageTables } from './cross-page.ts';
import {
  assignStableIds,
  type IdentifiableDraft,
} from './ids.ts';

export interface AssemblyInput {
  sourceSha256: string;
  encrypted: boolean;
  rawPages: readonly ParseRawPageArtifact[];
  /** 版面识别结果，与原始页面一一对应。 */
  layoutPages: readonly LayoutPageArtifact[];
  /** L2 只提出候选；assemble 在元素边界确定后落 continuesFrom。 */
  probeCross?: Pick<ProbeCrossArtifact, 'continuations'>;
  /** C8：识别结论不受模式影响，模式只决定家具留在何处及是否算正文。 */
  pageFurniture?: PageFurnitureMode;
  /** P8：auto 合成图内标签，keep 保留独立文本，drop 明确移出文本视图。 */
  overlaidText?: OverlaidTextMode;
  /** 页面渲染后生成的复合图资产；regionId 是与版面区域的唯一连接键。 */
  figureAssets?: readonly MaterializedFigureAsset[];
  docInfo: DocumentInfo;
  outline: OutlineNode[] | null;
}

export interface AssemblyResult {
  documentModel: DocumentModelArtifact;
  sourceLedger: SourceLedgerArtifact;
  warnings: Warning[];
}

/** 落 id 之前的形态：id 由 anchorKey 派生，冲突消解要看全集，只能等扫完再定。 */
interface Draft extends IdentifiableDraft {
  objects: RawSourceObject[];
  region: Region;
  order: number;
}

interface AnnotationDraft extends IdentifiableDraft {
  object: Extract<RawSourceObject, { kind: 'annotation' }>;
}


/** assemble 是源对象去向的唯一登记点；元素与 ledger 必须由同一份扫描结果产生。 */
export function assembleDocument(input: AssemblyInput): AssemblyResult {
  const { rawPages } = input;
  const pageFurniture = input.pageFurniture ?? 'off';
  const overlaidText = input.overlaidText ?? 'auto';
  const annotationDrafts: AnnotationDraft[] = [];
  const ignoredEmpty = new Set<string>();
  const consumed = new Set<string>();
  const objectsByKindPerPage: ContentKindCounts[] = [];
  const objectsById = new Map<string, RawSourceObject>();
  for (const rawPage of rawPages) {
    const objectsByKind: ContentKindCounts = { text: 0, path: 0, image: 0, annotation: 0 };
    for (const object of rawPage.objects) {
      if (objectsById.has(object.id)) throw new TypeError(`源对象 id 重复：${object.id}`);
      objectsById.set(object.id, object);
      objectsByKind[objectKindCounter(object)] += 1;
      if (object.kind === 'annotation') {
        annotationDrafts.push(annotationDraftFor(object));
        continue;
      }
      if (object.kind === 'text' && isIgnorableTextSource(object.text)) {
        ignoredEmpty.add(object.id);
      }
      if (object.kind === 'graphic' || object.kind === 'rule') {
        // G17 尚未给非表格路径定义可交付的图形载荷；先显式记 consumed，不伪造空元素。
        // G16 的表格 region 仍引用被吸收的边线，使结构推断可追溯但不会重复 represented。
        consumed.add(object.id);
      }
    }
    objectsByKindPerPage.push(objectsByKind);
  }

  const layoutPages = input.layoutPages;
  const elementDrafts = elementDraftsFromLayout(
    layoutPages,
    objectsById,
    ignoredEmpty,
    consumed,
  );

  // 两遍换来的是"id 与产出顺序无关"，那正是 D1 要的性质：内容没变的元素不换 id。
  const elementIds = assignStableIds('e', elementDrafts);
  const annotationIds = assignStableIds('a', annotationDrafts);
  const figureAssetsByRegion = uniqueFigureAssets(input.figureAssets ?? []);
  const captionTargets = captionTargetsByRegion(elementDrafts, elementIds);
  // 与版面阶段同一个纯函数、同一份输入：标题层级因此在全文一致（rfc § 7.2）。
  const textProfile = documentTextProfile(rawPages);
  const localElements = elementDrafts.map((draft, index) => (
    regionElement(
      draft,
      elementIds[index],
      pageFurniture,
      overlaidText,
      textProfile,
      figureAssetsByRegion,
      captionTargets,
    )
  ));
  // 跨页表先于全局重排，段落始终保持独立元素与逐页溯源。
  const continued = mergeCrossPageTables(
    [...localElements].sort(compareElementsByReadingOrder),
    rawPages.map((page) => ({ index: page.page, height: page.height })),
  );
  const orderedElements = continued.elements
    .map((element, index) => ({ ...element, order: index + 1 }));
  const assembledElements = attachListContainers(attachDocumentStructure(
    orderedElements,
    input.probeCross?.continuations ?? [],
  ));
  const furnitureElements = assembledElements.filter(isFurnitureElement);
  const elements = pageFurniture === 'extract'
    ? assembledElements.filter((element) => !isFurnitureElement(element))
    : assembledElements;
  const annotations = annotationDrafts.map((draft, index) => (
    annotationRecord(draft.object, annotationIds[index])
  ));
  const targetBySource = new Map<string, LedgerEntry>();
  for (let index = 0; index < localElements.length; index += 1) {
    for (const object of elementDrafts[index].objects) {
      if (consumed.has(object.id)) continue;
      if (targetBySource.has(object.id)) throw new TypeError(`源对象 ${object.id} 被多个版面区域引用`);
      const element = localElements[index];
      // 被跨页合并吃掉的元素已经不在产出里；源对象要指向承接它的那一个，
      // 否则 represented 反向解引用不到（I13），账本就成了假账。
      const elementId = continued.redirect.get(element.id) ?? element.id;
      targetBySource.set(object.id, pageFurniture === 'extract' && isFurnitureElement(element)
        ? { sourceObjectId: object.id, page: object.page, disposition: 'suppressed' }
        : {
            sourceObjectId: object.id,
            page: object.page,
            disposition: 'represented',
            elementId,
          });
    }
  }
  for (let index = 0; index < annotations.length; index += 1) {
    targetBySource.set(annotationDrafts[index].object.id, {
      sourceObjectId: annotationDrafts[index].object.id,
      page: annotations[index].page,
      disposition: 'recorded',
      annotationId: annotations[index].id,
    });
  }

  const layoutWarningsByPage = new Map(layoutPages.map((page) => [page.page, page.warnings]));
  const warnings = [
    ...rawPages.flatMap((page) => page.warnings),
    ...layoutPages.flatMap((page) => page.warnings),
    ...continued.warnings,

  ];
  const ledgerEntries: LedgerEntry[] = [];
  const ledgerPages: SourceLedgerPage[] = [];
  const pages: DocumentModelPage[] = [];

  for (let index = 0; index < rawPages.length; index += 1) {
    const rawPage = rawPages[index];
    const objectsByKind = objectsByKindPerPage[index];
    // 逐页自带明细，不从全量账本里 filter —— 那是页数 × 源对象数的二次方扫描。
    const pageEntries = rawPage.objects.map((object) =>
      ledgerEntryFor(object, targetBySource, ignoredEmpty, consumed));
    ledgerEntries.push(...pageEntries);

    const ledgerPage = summarizeLedgerPage(
      rawPage.page,
      pageEntries,
      rawPage.contentOperators,
      objectsByKind,
    );
    ledgerPages.push(ledgerPage);

    const pageWarnings = [...rawPage.warnings, ...(layoutWarningsByPage.get(rawPage.page) ?? [])];
    let status: PageStatus = pageWarnings.some((warning) => warning.severity === 'error')
      ? 'failed'
      : pageWarnings.length > 0 ? 'degraded' : 'ok';

    // ★ 整类丢失只有外部分母看得见：元素侧账本的分子分母都来自 parse 的产出，
    //   parse 没看见的东西不会在账本上留下缺口（§ 3.1b 要的是"承载内容的源对象总数"）。
    const lost = describeLostKinds(rawPage.contentOperators, objectsByKind);
    if (lost.length > 0) {
      status = status === 'failed' ? status : 'degraded';
      warnings.push({
        code: 'SOURCE_OBJECT_LOSS',
        severity: 'warn',
        scope: 'page',
        page: rawPage.page,
        message: `操作符普查存在但源对象缺失：${lost.join('；')}`,
        detail: {
          contentOperators: rawPage.contentOperators,
          sourceObjectsByKind: objectsByKind,
        },
      });
    }
    if (ledgerPage.sourceObjectCoverage < MIN_SOURCE_OBJECT_COVERAGE) {
      status = status === 'failed' ? status : 'degraded';
      warnings.push({
        code: 'SOURCE_OBJECT_LOSS',
        severity: 'warn',
        scope: 'page',
        page: rawPage.page,
        message: `源对象守恒覆盖率 ${ledgerPage.sourceObjectCoverage.toFixed(3)} 低于 ${MIN_SOURCE_OBJECT_COVERAGE}`,
      });
    }

    pages.push({
      index: rawPage.page,
      width: rawPage.width,
      height: rawPage.height,
      rotation: rawPage.rotation,
      status,
      sourceObjectCoverage: ledgerPage.sourceObjectCoverage,
    });
  }

  return {
    documentModel: {
      schemaVersion: ARTIFACT_SCHEMA_VERSIONS.documentModel,
      source: { sha256: input.sourceSha256, pages: rawPages.length, encrypted: input.encrypted },
      docInfo: input.docInfo,
      outline: input.outline,
      pages,
      elements,
      ...(pageFurniture === 'extract' ? { furniture: furnitureElements } : {}),
      annotations,
    },
    sourceLedger: {
      schemaVersion: ARTIFACT_SCHEMA_VERSIONS.sourceLedger,
      entries: ledgerEntries,
      pages: ledgerPages,
    },
    warnings,
  };
}

/**
 * 去向必须是被显式登记过的那一个。
 *
 * 用"不在 targetBySource 里就是 ignored_empty"当兜底看起来一样，但那会让将来任何
 * 一条新的 continue 分支悄悄变成"空白"——账本照样平账，内容照样没了。
 */
function ledgerEntryFor(
  object: RawSourceObject,
  targetBySource: ReadonlyMap<string, LedgerEntry>,
  ignoredEmpty: ReadonlySet<string>,
  consumed: ReadonlySet<string>,
): LedgerEntry {
  const target = targetBySource.get(object.id);
  if (target) return target;
  if (ignoredEmpty.has(object.id)) {
    return {
      sourceObjectId: object.id,
      page: object.page,
      disposition: 'ignored_empty',
    };
  }
  if (consumed.has(object.id)) {
    return { sourceObjectId: object.id, page: object.page, disposition: 'consumed' };
  }
  throw new TypeError(`源对象 ${object.id} 没有登记去向：assemble 漏了一条分支`);
}

function annotationDraftFor(
  object: Extract<RawSourceObject, { kind: 'annotation' }>,
): AnnotationDraft {
  return { object, page: object.page, bbox: object.bbox, sourceObjectIds: [object.id] };
}

function objectKindCounter(object: RawSourceObject): keyof ContentKindCounts {
  if (object.kind === 'text') return 'text';
  if (object.kind === 'image') return 'image';
  if (object.kind === 'annotation') return 'annotation';
  return 'path';
}

function uniqueFigureAssets(
  assets: readonly MaterializedFigureAsset[],
): ReadonlyMap<string, MaterializedFigureAsset> {
  const byRegion = new Map<string, MaterializedFigureAsset>();
  for (const asset of assets) {
    if (byRegion.has(asset.regionId)) throw new TypeError(`复合图区域重复：${asset.regionId}`);
    byRegion.set(asset.regionId, asset);
  }
  return byRegion;
}

/**
 * captionOf 必须指向最终元素 id，而 layout 阶段只有 region id。用已经确认的 caption
 * 类型加几何邻接做连接，避免让图注和 figure 共享源对象（那会破坏 I13 守恒）。
 */
function captionTargetsByRegion(
  drafts: readonly Draft[],
  elementIds: readonly string[],
): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (let captionIndex = 0; captionIndex < drafts.length; captionIndex += 1) {
    const caption = drafts[captionIndex];
    if (caption.region.type !== 'caption') continue;
    const fontSizes = caption.objects.flatMap((object) =>
      object.kind === 'text' ? [object.fontSize] : []);
    if (fontSizes.length === 0) throw new TypeError(`图注区域 ${caption.region.id} 没有文字源对象`);
    const referenceFontSize = Math.max(...fontSizes);
    const candidates = drafts.flatMap((draft, index) => {
      if (draft.region.page !== caption.region.page
        || (draft.region.type !== 'figure' && draft.region.type !== 'chart')
        || draft.region.bbox[1] > caption.region.bbox[1]
        || horizontalOverlapRatio(caption.region.bbox, draft.region.bbox)
          < FIGURE_CAPTION_HORIZONTAL_OVERLAP_RATIO) return [];
      const gap = verticalGap(caption.region.bbox, draft.region.bbox);
      if (gap > FIGURE_CAPTION_MAX_GAP_RATIO * referenceFontSize) return [];
      return [{ draft, index, gap }];
    }).sort((left, right) => (
      left.gap - right.gap
      || Number(right.draft.order < caption.order) - Number(left.draft.order < caption.order)
      || right.draft.order - left.draft.order
    ));
    const target = candidates[0];
    if (target === undefined) continue;
    const elementId = elementIds[target.index];
    if (elementId === undefined) throw new TypeError(`图注区域 ${caption.region.id} 的目标 id 缺失`);
    targets.set(caption.region.id, elementId);
  }
  return targets;
}

function horizontalOverlapRatio(target: Bbox, container: Bbox): number {
  const width = target[2] - target[0];
  if (width <= 0) return 0;
  const overlap = Math.max(0, Math.min(target[2], container[2]) - Math.max(target[0], container[0]));
  return overlap / width;
}

function verticalGap(target: Bbox, container: Bbox): number {
  if (target[1] > container[3]) return target[1] - container[3];
  if (container[1] > target[3]) return container[1] - target[3];
  return 0;
}

/**
 * 只采纳 layout 已给出确定性证据的类别；其余源对象仍落 `unknown`。判别位不能靠
 * “看起来像正文”兜底，否则下游会把尚未分类误当作已经分类。
 */
function regionElement(
  draft: Draft,
  id: string,
  pageFurniture: PageFurnitureMode,
  overlaidText: OverlaidTextMode,
  textProfile: DocumentTextProfile,
  figureAssetsByRegion: ReadonlyMap<string, MaterializedFigureAsset>,
  captionTargets: ReadonlyMap<string, string>,
): Element {
  const { objects, order, region } = draft;
  const furnitureType = isFurnitureType(region.type) ? region.type : null;
  const classified = furnitureType !== null || region.type !== 'unknown';
  const base = {
    id,
    page: region.page,
    order,
    bbox: region.bbox,
    parentId: null,
    provenance: {
      content: { engine: 'pdfjs-6.2.108', role: 'parser' as const },
      layout: { engine: region.classificationEngine },
      classification: {
        engine: classified ? region.classificationEngine : 'm0-source-kind-map',
      },
      assembly: { version: 'm1-layout.v1' },
    },
    confidence: classified ? region.confidence : UNCLASSIFIED_SOURCE_CONFIDENCE,
    isBodyContent: furnitureType === null || pageFurniture === 'off',
    sourceObjectIds: [...region.sourceObjectIds],
  };
  const textObjects = objects.filter((object): object is Extract<RawSourceObject, { kind: 'text' }> =>
    object.kind === 'text');
  const text = textObjects.length === 0
    ? ''
    : region.classificationEngine === DIAGRAM_RELATION_ENGINE
      ? textForDiagramRelationSources(textObjects) ?? textForBlockSources(textObjects)
      : textForBlockSources(textObjects);
  if (furnitureType !== null) {
    return {
      ...base,
      type: furnitureType,
      furnitureKind: furnitureType,
      text,
      ...(textObjects.length === 0 ? {} : { style: dominantTextStyle(textObjects) }),
    };
  }
  if (region.type === 'table') {
    const detected = tableForRegion(objects);
    const labelText = detected.labelTextObjects.length === 0
      ? ''
      : textForBlockSources(detected.labelTextObjects);
    const bodyText = tableText(detected.table);
    return {
      ...base,
      type: 'table',
      text: labelText.length === 0 ? bodyText : `${labelText}\n${bodyText}`,
      confidence: detected.confidence,
      table: labelText.length === 0
        ? detected.table
        : { ...detected.table, caption: labelText },
      ...(textObjects.length === 0 ? {} : { style: dominantTextStyle(textObjects) }),
    };
  }
  if (region.type === 'heading' && textObjects.length === objects.length) {
    const style = dominantTextStyle(textObjects);
    return {
      ...base,
      type: 'heading',
      level: headingLevel(text, style.fontSize, textProfile),
      text,
      style,
    };
  }
  // C9：marker 不进 text，否则 `1.` 与 `1、` 的差异会在 normalized_text 上制造假失败。
  if (region.type === 'list_item' && textObjects.length === objects.length) {
    const markerObject = textObjects[0];
    // marker 与正文之间的悬挂缩进常有独立的空白 chunk，它属于 marker 那一侧：
    // 留在正文里会让 text 以空格开头，进而污染 normalized_text 的前缀匹配。
    let bodyStart = 1;
    while (bodyStart < textObjects.length && textObjects[bodyStart].text.trim().length === 0) {
      bodyStart += 1;
    }
    const bodyObjects = textObjects.slice(bodyStart);
    if (markerObject !== undefined
      && isListMarkerText(markerObject.text, markerObject.fontName)
      && bodyObjects.length > 0) {
      return {
        ...base,
        type: 'list_item',
        marker: markerObject.text.trim(),
        depth: LIST_ITEM_FLAT_DEPTH,
        text: textForBlockSources(bodyObjects),
        style: dominantTextStyle(bodyObjects),
      };
    }
  }
  if (region.type === 'paragraph' && textObjects.length === objects.length) {
    return { ...base, type: 'paragraph', text, style: dominantTextStyle(textObjects) };
  }
  if (region.type === 'code' && textObjects.length === objects.length) {
    return {
      ...base,
      type: 'code',
      text,
      style: dominantTextStyle(textObjects),
      code: { language: null },
    };
  }
  if (region.type === 'formula' && textObjects.length === objects.length) {
    return {
      ...base,
      type: 'formula',
      text,
      style: dominantTextStyle(textObjects),
      formula: { display: true },
    };
  }
  if (region.type === 'caption' && textObjects.length === objects.length) {
    const captionOf = captionTargets.get(region.id);
    if (captionOf === undefined) throw new TypeError(`图注区域 ${region.id} 找不到所属 figure/chart`);
    return {
      ...base,
      type: 'caption',
      captionOf,
      text,
      style: dominantTextStyle(textObjects),
    };
  }
  if ((region.type === 'figure' || region.type === 'chart')) {
    const image = objects.find((object): object is Extract<RawSourceObject, { kind: 'image' }> =>
      object.kind === 'image');
    const composite = figureAssetsByRegion.get(region.id);
    if (composite !== undefined && composite.page !== region.page) {
      throw new TypeError(`复合图资产 ${composite.assetPath} 页码与区域 ${region.id} 不一致`);
    }
    // 只有已识别底图的叠字可按选项丢弃；纯文字图注占位没有可证明的叠字关系。
    const figureText = overlaidText === 'drop' && image !== undefined ? '' : text;
    return {
      ...base,
      type: region.type,
      text: figureText,
      ...(figureText.length === 0 ? {} : { style: dominantTextStyle(textObjects) }),
      figure: {
        assetPath: composite?.assetPath ?? image?.assetPath ?? null,
        kind: image === undefined ? 'vector' : 'raster',
      },
    };
  }
  if (textObjects.length === objects.length) {
    return {
      ...base,
      type: 'unknown',
      text,
      style: dominantTextStyle(textObjects),
    };
  }
  if (objects.length === 1 && objects[0].kind === 'image') {
    const object = objects[0];
    // 图像 XObject 确实是图，类别不用猜；assetPath 为 null 表示资源尚未落盘。
    return {
      ...base,
      type: 'figure',
      text: '',
      confidence: VISUAL_SOURCE_CONFIDENCE,
      figure: { assetPath: object.assetPath, kind: 'raster' },
    };
  }
  if (textObjects.length > 0) {
    throw new TypeError(`版面区域 ${region.id} 混合文字与视觉源对象，无法无损装配`);
  }
  return { ...base, type: 'unknown', text: '' };
}

function headingLevel(
  text: string,
  fontSize: number,
  textProfile: DocumentTextProfile,
): number {
  // 单字罗马数字（V.）也符合字母小节的词形，必须先判更具体的一级模式。
  if (PRIMARY_HEADING_MARKER.test(text)) return PRIMARY_HEADING_LEVEL;
  if (SECONDARY_HEADING_MARKER.test(text)) return SECONDARY_HEADING_LEVEL;
  // 分级编号自带层级，不必按字号猜：`2` 一级，`2.1` 二级，`2.1.1` 三级。
  const numeric = NUMERIC_HEADING_MARKER.exec(text);
  if (numeric !== null) return numeric[0].trim().split('.').length;
  // 没有编号时才退到字号排名；排名是文档级的，同一字号在全文拿到同一 level。
  return headingLevelForFontSize(textProfile, fontSize) ?? PRIMARY_HEADING_LEVEL;
}

function attachDocumentStructure(
  elements: readonly Element[],
  continuations: readonly ProbeCrossArtifact['continuations'][number][],
): Element[] {
  const withParents = attachHeadingHierarchy(elements);
  return attachContinuations(withParents, continuations);
}

function attachHeadingHierarchy(elements: readonly Element[]): Element[] {
  const headings = new Map<number, string>();
  return elements.map((element): Element => {
    if (element.type === 'heading') {
      const parentId = nearestHeadingParent(headings, element.level);
      for (const level of [...headings.keys()]) {
        if (level >= element.level) headings.delete(level);
      }
      headings.set(element.level, element.id);
      return { ...element, parentId };
    }
    const parentId = nearestHeadingParent(headings, Number.POSITIVE_INFINITY);
    return { ...element, parentId };
  });
}

function nearestHeadingParent(
  headings: ReadonlyMap<number, string>,
  childLevel: number,
): string | null {
  const levels = [...headings.keys()]
    .filter((level) => level < childLevel)
    .sort((left, right) => right - left);
  const level = levels[0];
  return level === undefined ? null : headings.get(level) ?? null;
}

function attachContinuations(
  elements: readonly Element[],
  continuations: readonly ProbeCrossArtifact['continuations'][number][],
): Element[] {
  const linkByTarget = new Map<string, string>();
  for (const continuation of continuations) {
    if (continuation.kind === 'table') continue;
    const anchors = new Set<SourceObjectId>(continuation.sourceObjectIds);
    const from = elements
      .filter((element) => element.page === continuation.fromPage
        && element.isBodyContent
        && element.sourceObjectIds?.some((id) => anchors.has(id)) === true)
      .sort((left, right) => right.order - left.order)[0];
    const to = elements
      .filter((element) => element.page === continuation.toPage
        && element.isBodyContent
        && element.sourceObjectIds?.some((id) => anchors.has(id)) === true)
      .sort((left, right) => left.order - right.order)[0];
    if (from !== undefined && to !== undefined) linkByTarget.set(to.id, from.id);
  }
  return elements.map((element): Element => {
    const source = linkByTarget.get(element.id);
    return source === undefined ? element : { ...element, continuesFrom: source };
  });
}

function compareElementsByReadingOrder(left: Element, right: Element): number {
  return left.page - right.page || left.order - right.order || left.id.localeCompare(right.id);
}

function isFurnitureElement(
  element: Element,
): element is Extract<Element, { type: FurnitureType }> {
  return isFurnitureType(element.type);
}

function annotationRecord(object: RawSourceObject, id: string): Annotation {
  if (object.kind !== 'annotation') throw new TypeError(`${object.id} 不是批注源对象`);
  return {
    id,
    page: object.page,
    bbox: object.bbox,
    subtype: object.subtype,
    contents: object.contents,
    target: object.target,
    sourceObjectIds: [object.id],
  };
}

function elementDraftsFromLayout(
  layoutPages: readonly LayoutPageArtifact[],
  objectsById: ReadonlyMap<string, RawSourceObject>,
  ignoredEmpty: ReadonlySet<string>,
  consumed: ReadonlySet<string>,
): Draft[] {
  const drafts: Draft[] = [];
  const orderedPages = [...layoutPages].sort((left, right) => left.page - right.page);
  let order = 1;
  for (const page of orderedPages) {
    const readingOrders = new Set<number>();
    for (const region of [...page.regions].sort((left, right) => left.readingOrder - right.readingOrder)) {
      if (!Number.isInteger(region.readingOrder) || region.readingOrder < 1
        || readingOrders.has(region.readingOrder)) {
        throw new TypeError(`第 ${page.page} 页 readingOrder 必须为从 1 开始的无重复整数`);
      }
      readingOrders.add(region.readingOrder);
      const objects = region.sourceObjectIds.map((sourceObjectId) => {
        const object = objectsById.get(sourceObjectId);
        if (object === undefined) throw new TypeError(`版面区域 ${region.id} 引用了未知源对象 ${sourceObjectId}`);
        if (object.page !== page.page || region.page !== page.page) {
          throw new TypeError(`版面区域 ${region.id} 的页码与源对象不一致`);
        }
        if (object.kind === 'annotation') throw new TypeError(`批注 ${object.id} 不能进入阅读顺序`);
        return object;
      });
      if (objects.length === 0) throw new TypeError(`版面区域 ${region.id} 没有源对象锚`);
      if (objects.every((object) => ignoredEmpty.has(object.id) || consumed.has(object.id))) continue;
      if (objects.some((object) => ignoredEmpty.has(object.id))) {
        throw new TypeError(`版面区域 ${region.id} 混入不产元素的空白或矢量源对象`);
      }
      if (region.type !== 'table' && objects.some((object) => consumed.has(object.id))) {
        throw new TypeError(`版面区域 ${region.id} 混入只供派生结构使用的矢量源对象`);
      }
      drafts.push({
        objects,
        region,
        order,
        page: page.page,
        bbox: region.bbox,
        sourceObjectIds: [...region.sourceObjectIds],
      });
      order += 1;
    }
    if (readingOrders.size > 0
      && Math.max(...readingOrders) !== readingOrders.size) {
      throw new TypeError(`第 ${page.page} 页 readingOrder 必须连续无缺号`);
    }
  }
  return drafts;
}

/** 页内装配失败时，以原生源对象构造可交付的降级版面。 */
function fallbackLayoutPages(rawPages: readonly ParseRawPageArtifact[]): LayoutPageArtifact[] {
  return rawPages.map((page) => {
    const objects = page.objects.filter((object) =>
      object.kind !== 'annotation'
      && !(object.kind === 'text' && isIgnorableTextSource(object.text))
      && object.kind !== 'graphic'
      && object.kind !== 'rule');
    return {
      schemaVersion: ARTIFACT_SCHEMA_VERSIONS.layoutPage,
      page: page.page,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      regions: objects.map((object, index) => ({
        id: `fallback_${object.id}`,
        page: page.page,
        type: object.kind === 'image' ? 'figure' : 'unknown',
        bbox: object.bbox,
        readingOrder: index + 1,
        confidence: UNCLASSIFIED_SOURCE_CONFIDENCE,
        sourceObjectIds: [object.id],
        classificationEngine: 'local-source-fallback',
      })),
      warnings: [],
    };
  });
}

/** 页内装配失败保留原生对象；只有跨页契约本身损坏时才整体拒绝交付。 */
export function assembleWithPageIsolation(input: AssemblyInput): AssemblyResult & { layoutPages: LayoutPageArtifact[] } {
  const layouts = [...input.layoutPages];
  try { return { ...assembleDocument({ ...input, layoutPages: layouts }), layoutPages: layouts }; }
  catch (originalError) {
    let recovered = false;
    for (let index = 0; index < input.rawPages.length; index++) {
      const raw = input.rawPages[index];
      try {
        assembleDocument({ ...input, rawPages: [raw], layoutPages: [layouts[index]], probeCross: undefined });
      } catch {
        const layout = fallbackLayoutPages([raw])[0];
        layout.warnings.push({ code: 'LOCAL_PARSE_FAILED', severity: 'error', scope: 'page', page: raw.page,
          message: '本页语义装配异常，已保留逐源对象内容并继续其他页。', detail: { stage: 'assemble' } });
        layouts[index] = layout;
        recovered = true;
      }
    }
    if (!recovered) throw originalError;
    return { ...assembleDocument({ ...input, layoutPages: layouts }), layoutPages: layouts };
  }
}
