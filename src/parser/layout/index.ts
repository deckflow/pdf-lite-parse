import type {
  CrossPageContinuationCandidate,
  LayoutPageArtifact,
  OverlaidTextMode,
  PageProbe,
  ParseRawPageArtifact,
  ProbeCrossArtifact,
  RawSourceObject,
  Region,
} from '../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../schema/artifacts.ts';
import type { Bbox, SourceObjectId } from '../../schema/element.ts';
import {
  BLOCK_FONT_SIZE_TOLERANCE_RATIO,
  BLOCK_CENTER_ALIGNMENT_RATIO,
  BLOCK_LEFT_ALIGNMENT_RATIO,
  BLOCK_LINE_GAP_RATIO,
  BLOCK_LINE_OVERLAP_RATIO,
  BLOCK_SHORT_FINAL_LINE_MIN_RATIO,
  BLOCK_WRAPPED_LINE_GAP_RATIO,
  CODE_MONOSPACE_CHARACTER_SHARE,
  DIAGRAM_RELATION_BASELINE_TOLERANCE_RATIO,
  DIAGRAM_RELATION_CONNECTOR_FONT_MAX_RATIO,
  DIAGRAM_RELATION_CONNECTOR_MAX_CHARACTERS,
  DIAGRAM_RELATION_MAX_HORIZONTAL_GAP_RATIO,
  DIAGRAM_RELATION_OUTER_FONT_TOLERANCE_RATIO,
  FALLBACK_AVERAGE_GLYPH_WIDTH_RATIO,
  FIGURE_CAPTION_HORIZONTAL_OVERLAP_RATIO,
  FIGURE_CAPTION_MARKER,
  FIGURE_CAPTION_MAX_GAP_RATIO,
  FIGURE_OWNED_TEXT_CONTAINMENT_RATIO,
  FORMULA_CENTER_TOLERANCE_RATIO,
  FORMULA_MAX_LATIN_RUN,
  GRID_MIN_ALIGNED_REGION_SHARE,
  GRID_MIN_ALIGNED_ROWS,
  GRID_ROW_TOP_TOLERANCE_PT,
  HANGING_INDENT_MAX_RATIO,
  HEADING_FORBIDDEN_TAIL,
  HEADING_MAX_CHARACTERS,
  HEADING_MAX_LINES,
  LIST_ITEM_START_MARKER,
  LIST_MARKER_MAX_GAP_RATIO,
  LINE_SEGMENT_GAP_RATIO,
  LINE_TOL_RATIO,
  LOCAL_LAYOUT_CONFIDENCE,
  MONOSPACE_FONT_NAME,
  NUMERIC_HEADING_MARKER,
  NUMERIC_HEADING_MAX_CHARACTERS,
  PRIMARY_HEADING_MARKER,
  SECONDARY_HEADING_MARKER,
  SPACE_GAP_RATIO,
  SPANNING_REGION_MIN_WIDTH_SHARE,
} from '../params/layout.ts';
import { CONTINUATION_TRAILING_PHRASE } from '../params/l2.ts';
import { isInkFreeText } from '../params/ledger.ts';
import { detectTablesWithWarnings } from './table/index.ts';
import { furnitureRegionsForPage } from './furniture/index.ts';
import { isListMarkerText } from './list-marker.ts';
import { stripCjkTrackingSpaces } from './tracking-space.ts';
import {
  dominantTextStyle,
  headingLevelForFontSize,
  type DocumentTextProfile,
} from './text-profile.ts';

type TextObject = Extract<RawSourceObject, { kind: 'text' }>;
type VisualObject = Extract<RawSourceObject, { kind: 'graphic' | 'image' | 'rule' }>;
type DrawingObject = Extract<RawSourceObject, { kind: 'graphic' | 'rule' }>;

interface RegionCandidate {
  lane: number;
  region: Omit<Region, 'readingOrder'>;
  /**
   * 画在图上的标签属于那张图。它们按几何插进正文流会把同一句话切成两半，
   * 所以在排序时不参与全页比较，只跟着 owner 走。
   */
  ownerId?: string;
}

interface ClassifiedTextBlock {
  block: TextBlock;
  type: Region['type'];
  classificationEngine: string;
}

/** 一张图连同它自己的文字：压在图上的标签与紧邻的图注。 */
interface FigureZone {
  image: Extract<VisualObject, { kind: 'image' }>;
  captionObjects: TextObject[];
  overlayObjects: TextObject[];
}

/** 版面分类需要的文档级上下文；只有它是跨页的，其余判据都在页内。 */
export interface LayoutContext {
  textProfile?: DocumentTextProfile;
  overlaidText?: OverlaidTextMode;
}

export const DIAGRAM_RELATION_ENGINE = 'local-diagram-relation-v1';
export const FIGURE_ZONE_ENGINE = 'local-figure-zone-v1';
export const LIST_ITEM_ENGINE = 'local-list-item-v1';
export const HEADING_FONT_RANK_ENGINE = 'local-heading-font-rank-v1';

/** item → line 的中间结果。它只引用源对象，不是文档元素。 */
export interface TextLine {
  page: number;
  bbox: Bbox;
  baseline: number;
  fontSize: number;
  lane: number;
  items: TextObject[];
  sourceObjectIds: SourceObjectId[];
}

/**
 * 行合并后的版面块。TextBlock 属于阶段⑥，不能携带 Element 的 type/id/order 等语义字段。
 * readingOrder 是页内顺序；全局 Element.order 只能在 assemble 末尾产生。
 */
export interface TextBlock {
  page: number;
  bbox: Bbox;
  readingOrder: number;
  lane: number;
  lines: TextLine[];
  sourceObjectIds: SourceObjectId[];
}

/** 阶段⑥：源对象只经几何推断成版面区域，文字仍由 sourceObjectIds 解引用。 */
export function layoutPage(
  page: ParseRawPageArtifact,
  probe: Pick<PageProbe, 'columns'>,
  crossProbe?: Pick<ProbeCrossArtifact, 'furniture' | 'continuations'>,
  context?: LayoutContext,
): LayoutPageArtifact {
  const furnitureRegions = furnitureRegionsForPage(page, crossProbe);
  const furnitureIds = new Set(
    furnitureRegions.flatMap((region) => region.sourceObjectIds),
  );
  const contentObjects = page.objects.filter((object) => !furnitureIds.has(object.id));
  const tableDetection = detectTablesWithWarnings(contentObjects);
  const { tables } = tableDetection;
  const tableTextIds = new Set(tables.flatMap((table) => table.textSourceObjectIds));
  const tableRuleIds = new Set(tables.flatMap((table) => table.ruleSourceObjectIds));
  const textPage = {
    ...page,
    objects: contentObjects.filter((object) =>
      object.kind !== 'text' || !tableTextIds.has(object.id)),
  };
  const images = contentObjects
    .filter((object): object is Extract<VisualObject, { kind: 'image' }> => object.kind === 'image')
    .sort(compareVisualObjects);
  // ★ 图先占位，正文再分块。反过来做的话，压在图上的标签会以自己的 baseline
  //   插进正文行序列，把同一段的相邻两行隔开 —— 段落合并只看紧邻的上一块。
  const figureZones = figureZonesForPage(images, textPage, probe.columns);
  const figureOwnedIds = new Set(figureZones.flatMap((zone) =>
    [...zone.captionObjects, ...zone.overlayObjects].map((object) => object.id)));
  const flowPage = {
    ...textPage,
    objects: textPage.objects.filter((object) => !figureOwnedIds.has(object.id)),
  };
  const continuation = crossProbe?.continuations.find((candidate) =>
    candidate.fromPage === page.page && candidate.kind === 'paragraph');
  const segmentedBlocks = splitContinuationTailBlocks(
    buildTextBlocks(flowPage, probe.columns),
    continuation,
  );
  const textBlocks = classifyTextBlocks(segmentedBlocks, page.width, context);
  const candidates: RegionCandidate[] = textBlocks.map(({ block, type, classificationEngine }) => ({
    lane: block.lane,
    region: {
      id: regionId(block.sourceObjectIds),
      page: block.page,
      type,
      bbox: block.bbox,
      confidence: LOCAL_LAYOUT_CONFIDENCE,
      sourceObjectIds: [...block.sourceObjectIds],
      classificationEngine,
    },
  }));
  for (const table of tables) {
    candidates.push({
      lane: columnLane(table.bbox, validColumnCount(probe.columns), page.width),
      region: {
        id: regionId(table.sourceObjectIds),
        page: table.page,
        type: 'table',
        bbox: table.bbox,
        confidence: table.confidence,
        sourceObjectIds: [...table.sourceObjectIds],
        classificationEngine: 'local-ruled-grid-v1',
      },
    });
  }

  for (const region of furnitureRegions) {
    candidates.push({
      lane: columnLane(region.bbox, validColumnCount(probe.columns), page.width),
      region,
    });
  }

  // 未被 G16 网格吸收的路径仍以 drawing layer 明示；G17 再继续做图形分类。
  const drawings = contentObjects.filter((object): object is DrawingObject =>
    (object.kind === 'graphic' || object.kind === 'rule') && !tableRuleIds.has(object.id));
  if (drawings.length > 0) {
    const sourceObjectIds = drawings.map((drawing) => drawing.id);
    const bbox = unionBboxes(drawings.map((drawing) => drawing.bbox));
    candidates.push({
      lane: columnLane(bbox, validColumnCount(probe.columns), page.width),
      region: {
        id: regionId(sourceObjectIds),
        page: page.page,
        type: 'unknown',
        bbox,
        confidence: LOCAL_LAYOUT_CONFIDENCE,
        sourceObjectIds,
        classificationEngine: 'local-drawing-layer-v1',
      },
    });
  }
  for (const zone of figureZones) {
    const overlaidText = context?.overlaidText ?? 'auto';
    // auto 把图内标签并进 figure：元素仍保留原文与锚，资产阶段再从整页视觉结果裁剪，
    // Markdown 因而不会把同一批标签作为正文重复一遍。keep 明确要求保留独立文本流；
    // drop 仍把锚挂在 figure 上，但 assemble 会按用户选择清空 figure.text。
    const embeddedOverlays = overlaidText === 'keep'
      ? []
      : zone.overlayObjects.filter((object) => object.text.length > 0);
    const figureSourceObjectIds = [zone.image.id, ...embeddedOverlays.map((object) => object.id)];
    const untrimmedFigureBbox = unionBboxes([
      zone.image.bbox,
      ...embeddedOverlays.map((object) => object.bbox),
    ]);
    // PDF 字形框可能与底图 bbox 轻微重叠；既然 caption 已被确定识别，就以它的上沿
    // 截断视觉 figure，避免页面裁剪把图注第一行的顶端烤进图片。
    const captionTop = zone.captionObjects.length === 0
      ? untrimmedFigureBbox[3]
      : Math.min(...zone.captionObjects.map((object) => object.bbox[1]));
    const figureBottom = captionTop > untrimmedFigureBbox[1]
      ? Math.min(untrimmedFigureBbox[3], captionTop)
      : untrimmedFigureBbox[3];
    const figureBbox: Bbox = [
      untrimmedFigureBbox[0],
      untrimmedFigureBbox[1],
      untrimmedFigureBbox[2],
      figureBottom,
    ];
    const figureRegionId = regionId(figureSourceObjectIds);
    candidates.push({
      lane: columnLane(figureBbox, validColumnCount(probe.columns), page.width),
      region: {
        id: figureRegionId,
        page: zone.image.page,
        type: 'figure',
        bbox: figureBbox,
        confidence: LOCAL_LAYOUT_CONFIDENCE,
        sourceObjectIds: figureSourceObjectIds,
        classificationEngine: zone.captionObjects.length === 0 && zone.overlayObjects.length === 0
          ? 'local-source-object-v1'
          : FIGURE_ZONE_ENGINE,
      },
    });
    if (overlaidText === 'keep') {
      const overlayPage = { ...page, objects: zone.overlayObjects };
      for (const block of buildTextBlocks(overlayPage, 1)) {
        candidates.push({
          lane: columnLane(block.bbox, validColumnCount(probe.columns), page.width),
          ownerId: figureRegionId,
          region: {
            id: regionId(block.sourceObjectIds),
            page: block.page,
            type: 'unknown',
            bbox: block.bbox,
            confidence: LOCAL_LAYOUT_CONFIDENCE,
            sourceObjectIds: [...block.sourceObjectIds],
            classificationEngine: FIGURE_ZONE_ENGINE,
          },
        });
      }
    }
    if (zone.captionObjects.length > 0) {
      const captionSourceObjectIds = zone.captionObjects.map((object) => object.id);
      const captionBbox = unionBboxes(zone.captionObjects.map((object) => object.bbox));
      candidates.push({
        lane: columnLane(captionBbox, validColumnCount(probe.columns), page.width),
        ownerId: figureRegionId,
        region: {
          id: regionId(captionSourceObjectIds),
          page: zone.image.page,
          type: 'caption',
          bbox: captionBbox,
          confidence: LOCAL_LAYOUT_CONFIDENCE,
          sourceObjectIds: captionSourceObjectIds,
          classificationEngine: FIGURE_ZONE_ENGINE,
        },
      });
    }
  }
  const regions = orderRegionCandidates(candidates).map((candidate, index) => ({
    ...candidate.region,
    readingOrder: index + 1,
  }));

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.layoutPage,
    page: page.page,
    width: page.width,
    height: page.height,
    rotation: page.rotation,
    regions,
    warnings: tableDetection.warnings,
  };
}

/**
 * 把每张图连同"属于它的文字"圈出来。
 *
 * 两类：① 落在图像 bbox 里的标签（坐标轴名、数据标注），它们是画在图上的，
 * 不是正文；② 紧邻图的图注，以及图注自己的续行。probe 早就报了
 * `hasOverlaidTextOnImage`，但没有任何本地代码消费它 —— 这里是消费点。
 */
function figureZonesForPage(
  images: readonly Extract<VisualObject, { kind: 'image' }>[],
  textPage: ParseRawPageArtifact,
  columns: number,
): FigureZone[] {
  if (images.length === 0) return [];
  const texts = textPage.objects.filter((object): object is TextObject => object.kind === 'text');
  if (texts.length === 0) {
    return images.map((image) => ({ image, captionObjects: [], overlayObjects: [] }));
  }
  const claimed = new Set<SourceObjectId>();
  // 图注要按行找（换行后的下半句没有任何词形特征），纯空白 chunk 的宽度不可信，
  // 不能参与行聚类的几何判断，但它们如果落在图里同样得跟着图走。
  const lines = clusterTextItemsIntoLines(
    texts.filter((object) => object.text.trim().length > 0),
    columns,
    textPage.width,
  ).sort(compareLinesVertically);
  return images.map((image) => {
    const overlayObjects: TextObject[] = [];
    for (const object of texts) {
      if (claimed.has(object.id)) continue;
      if (containmentRatio(object.bbox, image.bbox) < FIGURE_OWNED_TEXT_CONTAINMENT_RATIO) continue;
      claimed.add(object.id);
      overlayObjects.push(object);
    }
    return {
      image,
      captionObjects: captionObjectsForImage(image, lines, claimed),
      overlayObjects,
    };
  });
}

/**
 * 图注只认确定性证据："Figure 1" 这类图号词形 + 与图水平重叠 + 垂直贴着图。
 * 认定首行之后再按普通行距把它的续行收进来 —— 图注换行后的下半句仍然是图注，
 * 但它本身没有任何词形特征，只能靠"接着上一行"来认。
 */
function captionObjectsForImage(
  image: Extract<VisualObject, { kind: 'image' }>,
  lines: readonly TextLine[],
  claimed: Set<SourceObjectId>,
): TextObject[] {
  const available = lines.filter((line) =>
    line.items.every((item) => !claimed.has(item.id))
    && horizontalOverlapRatio(line.bbox, image.bbox) >= FIGURE_CAPTION_HORIZONTAL_OVERLAP_RATIO);
  const seedIndex = available.findIndex((line) =>
    FIGURE_CAPTION_MARKER.test(textForLine(line).trim())
    && verticalGap(line.bbox, image.bbox) <= FIGURE_CAPTION_MAX_GAP_RATIO * line.fontSize);
  if (seedIndex < 0) return [];
  const caption = [available[seedIndex]];
  for (let index = seedIndex + 1; index < available.length; index += 1) {
    const previous = caption[caption.length - 1];
    const line = available[index];
    const referenceSize = Math.max(previous.fontSize, line.fontSize);
    const gap = line.bbox[1] - previous.bbox[3];
    if (gap > BLOCK_LINE_GAP_RATIO * referenceSize) break;
    if (Math.abs(previous.fontSize - line.fontSize) / referenceSize > BLOCK_FONT_SIZE_TOLERANCE_RATIO) break;
    caption.push(line);
  }
  const objects = caption.flatMap((line) => line.items);
  for (const object of objects) claimed.add(object.id);
  return objects;
}

/** target 被 container 覆盖的面积占比；字形 bbox 常比排版框略大，不能要求严格包含。 */
function containmentRatio(target: Bbox, container: Bbox): number {
  const area = bboxArea(target);
  if (area <= 0) return 0;
  return intersectionArea(target, container) / area;
}

function horizontalOverlapRatio(target: Bbox, container: Bbox): number {
  const width = bboxWidth(target);
  if (width <= 0) return 0;
  const overlap = Math.max(0, Math.min(target[2], container[2]) - Math.max(target[0], container[0]));
  return overlap / width;
}

/** 两个 bbox 的垂直空隙；相交时为 0，图注压在图边上也算贴着。 */
function verticalGap(target: Bbox, container: Bbox): number {
  if (target[1] > container[3]) return target[1] - container[3];
  if (container[1] > target[3]) return container[1] - target[3];
  return 0;
}

/**
 * 与文字行相同的 lane 顺序；跨栏区域在其纵向位置切开各栏内容。
 * 图自己的标签不参与全页比较，只紧跟在它那张图后面成组出现。
 */
function orderRegionCandidates(candidates: readonly RegionCandidate[]): RegionCandidate[] {
  const ownedByOwner = new Map<string, RegionCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.ownerId === undefined) continue;
    append(ownedByOwner, candidate.ownerId, candidate);
  }
  const free = candidates.filter((candidate) => candidate.ownerId === undefined);
  const spanning = free
    .filter((candidate) => candidate.lane < 0)
    .sort(compareRegionCandidatesVertically);
  const laneCandidates = free.filter((candidate) => candidate.lane >= 0);
  const ordered: RegionCandidate[] = [];
  let lowerBoundary = Number.NEGATIVE_INFINITY;
  for (const separator of spanning) {
    const separatorY = regionTop(separator);
    ordered.push(...orderBandRegions(laneCandidates.filter((candidate) => {
      const y = regionTop(candidate);
      return y >= lowerBoundary && y < separatorY;
    })));
    ordered.push(separator);
    lowerBoundary = separatorY;
  }
  ordered.push(...orderBandRegions(
    laneCandidates.filter((candidate) => regionTop(candidate) >= lowerBoundary)));
  return ordered.flatMap((candidate) => [
    candidate,
    ...orderRegionRows(ownedByOwner.get(candidate.region.id) ?? []),
  ]);
}

/**
 * 区域按**上边界**而不是中心线排序。中心线会让一张纵跨整栏的图排到它旁边正文的
 * 中间去，把一段连续的列表劈成两半；而"从哪里开始"正是阅读顺序里 float 的锚点。
 */
function regionTop(candidate: RegionCandidate): number {
  return candidate.region.bbox[1];
}

function compareRegionCandidatesVertically(left: RegionCandidate, right: RegionCandidate): number {
  return regionTop(left) - regionTop(right)
    || left.region.bbox[0] - right.region.bbox[0]
    || left.region.id.localeCompare(right.region.id);
}

/**
 * 先用上边界形成确定的视觉行，再在行内从左到右读。
 *
 * 不能把容差直接塞进 Array.sort 的比较器：A≈B、B≈C、A≉C 时比较关系不传递，
 * 排序结果会依赖引擎实现。以每行第一个候选为固定锚点，既不链式扩张行高，也保持确定性。
 */
function orderRegionRows(candidates: readonly RegionCandidate[]): RegionCandidate[] {
  const rows: RegionCandidate[][] = [];
  for (const candidate of [...candidates].sort(compareRegionCandidatesVertically)) {
    const row = rows.at(-1);
    if (row !== undefined
      && Math.abs(regionTop(candidate) - regionTop(row[0])) <= GRID_ROW_TOP_TOLERANCE_PT) {
      row.push(candidate);
    } else {
      rows.push([candidate]);
    }
  }
  return rows.flatMap((row) => row.sort((left, right) =>
    left.region.bbox[0] - right.region.bbox[0]
    || regionTop(left) - regionTop(right)
    || left.region.id.localeCompare(right.region.id)));
}

/**
 * 一条水平带内的顺序：默认按栏读完再换栏，但**反复对齐成行的栏是网格不是文流**。
 *
 * 两栏正文只是恰好并列，行与行之间没有对应关系；而"栏 1 / 栏 2 / 栏 3"这种把并列
 * 条目排成三列的版面，同一行的三格讲的是同一件事，读完一整栏再回头读第二栏会把
 * 每一行拆散。判据只用几何：跨栏的等高行反复出现，就按行读。
 */
function orderBandRegions(candidates: readonly RegionCandidate[]): RegionCandidate[] {
  if (isRowAlignedGrid(candidates)) return orderRegionRows(candidates);
  const byLane = new Map<number, RegionCandidate[]>();
  for (const candidate of candidates) append(byLane, candidate.lane, candidate);
  return [...byLane.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, laneCandidates]) => orderRegionRows(laneCandidates));
}

function isRowAlignedGrid(candidates: readonly RegionCandidate[]): boolean {
  if (candidates.length === 0) return false;
  if (new Set(candidates.map((candidate) => candidate.lane)).size < 2) return false;
  const rows: RegionCandidate[][] = [];
  for (const candidate of [...candidates].sort(compareRegionCandidatesVertically)) {
    const row = rows.at(-1);
    if (row !== undefined
      && Math.abs(regionTop(candidate) - regionTop(row[0])) <= GRID_ROW_TOP_TOLERANCE_PT) {
      row.push(candidate);
    } else {
      rows.push([candidate]);
    }
  }
  const crossLaneRows = rows.filter((row) =>
    new Set(row.map((candidate) => candidate.lane)).size >= 2);
  if (crossLaneRows.length < GRID_MIN_ALIGNED_ROWS) return false;
  const aligned = crossLaneRows.reduce((total, row) => total + row.length, 0);
  return aligned / candidates.length >= GRID_MIN_ALIGNED_REGION_SHARE;
}

/** 三步布局算法的 text block 出口，单测直接检查这一层而不是语义 Element。 */
export function buildTextBlocks(page: ParseRawPageArtifact, requestedColumns: number): TextBlock[] {
  const columns = validColumnCount(requestedColumns);
  const texts = page.objects.filter((object): object is TextObject =>
    object.kind === 'text' && object.text.length > 0);
  const lines = clusterTextItemsIntoLines(texts, columns, page.width);
  const orderedLines = orderLines(lines);
  const drafts: Array<Omit<TextBlock, 'readingOrder'>> = [];

  for (let index = 0; index < orderedLines.length; index += 1) {
    const line = orderedLines[index];
    const previous = drafts.at(-1);
    if (previous !== undefined && canMergeLine(previous, line, orderedLines[index + 1])) {
      previous.lines.push(line);
      previous.bbox = unionBboxes([previous.bbox, line.bbox]);
      previous.sourceObjectIds.push(...line.sourceObjectIds);
    } else {
      drafts.push({
        page: line.page,
        bbox: [...line.bbox],
        lane: line.lane,
        lines: [line],
        sourceObjectIds: [...line.sourceObjectIds],
      });
    }
  }

  return drafts.map((block, index) => ({ ...block, readingOrder: index + 1 }));
}

/**
 * 先按 column lane 隔离，再在每个 lane 内按 baseline 聚类。否则双栏同高度的两行会被
 * baseline 算法误认成同一行，后续再聪明的阅读顺序也无法拆回来。
 */
export function clusterTextItemsIntoLines(
  items: readonly TextObject[],
  requestedColumns: number,
  pageWidth: number,
): TextLine[] {
  const columns = validColumnCount(requestedColumns);
  const byLane = new Map<number, TextObject[]>();
  const spanningIds = new Set<string>();
  if (columns > 1) {
    // 字体切换会把同一条通栏行拆成多个窄 chunk。先只连接间隙小于半个字身的
    // 同基线片段，整体足够宽才认通栏；真实双栏的栏间空白不能被这一步跨越。
    for (const line of clusterTextItemsIntoLines(items, 1, pageWidth)) {
      let group: TextObject[] = [];
      const flush = () => {
        if (group.length > 0 && columnLane(unionBboxes(group.map(item => item.bbox)), columns, pageWidth) < 0) {
          for (const item of group) spanningIds.add(item.id);
        }
        group = [];
      };
      for (const item of line.items) {
        const previous = group.at(-1);
        if (previous && item.bbox[0] - previous.bbox[2] > SPACE_GAP_RATIO * Math.max(previous.fontSize, item.fontSize)) flush();
        group.push(item);
      }
      flush();
    }
  }
  for (const item of items) append(byLane, spanningIds.has(item.id) ? -1 : columnLane(item.bbox, columns, pageWidth), item);

  const lines: TextLine[] = [];
  for (const [lane, laneItems] of byLane) {
    const laneLines: TextLine[] = [];
    const ordered = [...laneItems].sort((left, right) =>
      baseline(left) - baseline(right) || left.bbox[0] - right.bbox[0] || left.id.localeCompare(right.id));
    for (const item of ordered) {
      let best: TextLine | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of laneLines) {
        const distance = Math.abs(candidate.baseline - baseline(item));
        const tolerance = LINE_TOL_RATIO * Math.max(candidate.fontSize, item.fontSize);
        if (distance <= tolerance && distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      if (best === undefined) {
        laneLines.push(lineFromItem(item, lane));
      } else {
        addItemToLine(best, item);
      }
    }
    for (const line of laneLines) {
      line.items.sort((left, right) => left.bbox[0] - right.bbox[0] || left.id.localeCompare(right.id));
      line.sourceObjectIds = line.items.map((item) => item.id);
      lines.push(...splitTextLine(line));
    }
  }
  return lines;
}

/**
 * line 内按 x 拼接；只推断缺失空格，不改动任一 source item 自带的字符。
 *
 * 无墨 chunk（pdf.js 为 TJ 位移补出的 `' '`）不是字形：它没有宽度，照抄进正文
 * 就会在 1.5pt 的字距里凭空多出一个空格。它仍是"文本层在此断开"的证据，所以
 * 保留成一个断点交给几何判据 —— 空到底算不算空格，看两侧真字之间的间隙。
 */
export function textForLine(line: Pick<TextLine, 'items'>): string {
  const items = [...line.items].sort((left, right) =>
    left.bbox[0] - right.bbox[0] || left.id.localeCompare(right.id));
  let text = '';
  let previous: TextObject | undefined;
  let markedBreak = false;
  for (const current of items) {
    if (isInkFreeText(current.text)) {
      markedBreak = true;
      continue;
    }
    if (previous !== undefined && needsSpaceBetweenItems(previous, current, markedBreak)) text += ' ';
    text += stripCjkTrackingSpaces(current.text);
    previous = current;
    markedBreak = false;
  }
  return text;
}

/** assemble 解引用一个 TextBlock 后复用同一套行内与跨行拼接规则。 */
export function textForBlockSources(items: readonly TextObject[]): string {
  const lines = clusterTextItemsIntoLines(items, 1, positivePageWidth(items));
  lines.sort((left, right) => left.baseline - right.baseline || left.bbox[0] - right.bbox[0]);
  let text = '';
  for (const line of lines) text = joinLineText(text, textForLine(line));
  return text;
}

/** 图内键值行保留连接词原文，同时用独立首行表达可寻址的有向关系。 */
export function textForDiagramRelationSources(items: readonly TextObject[]): string | null {
  const lines = clusterTextItemsIntoLines(items, 1, positivePageWidth(items));
  const parts = diagramRelationParts(lines);
  if (parts === null) return null;
  const [left, connector, right] = parts;
  return `${textForLine(left)} → ${textForLine(right)}\n${textForLine(connector)}`;
}

function classifyTextBlocks(
  blocks: readonly TextBlock[],
  pageWidth: number,
  context: LayoutContext | undefined,
): ClassifiedTextBlock[] {
  const consumed = new Set<TextBlock>();
  const listItems = pairListItemBlocks(blocks, consumed);
  const relations: ClassifiedTextBlock[] = [];
  const singleLines = blocks.filter((block) =>
    block.lines.length === 1 && !consumed.has(block));
  const connectors = [...singleLines].sort((left, right) =>
    left.lines[0].fontSize - right.lines[0].fontSize
    || left.bbox[1] - right.bbox[1]
    || left.bbox[0] - right.bbox[0]);

  for (const connector of connectors) {
    if (consumed.has(connector)
      || visibleLength(textForLine(connector.lines[0])) > DIAGRAM_RELATION_CONNECTOR_MAX_CHARACTERS) {
      continue;
    }
    const peers = singleLines.filter((candidate) =>
      candidate !== connector
      && !consumed.has(candidate)
      && candidate.lane === connector.lane);
    const left = nearestHorizontalPeer(connector, peers, 'left');
    const right = nearestHorizontalPeer(connector, peers, 'right');
    if (left === undefined || right === undefined) continue;
    const parts = diagramRelationParts([left.lines[0], connector.lines[0], right.lines[0]]);
    if (parts === null) continue;
    consumed.add(left);
    consumed.add(connector);
    consumed.add(right);
    const relation = mergeTextBlocks([left, connector, right]);
    relations.push({
      block: relation,
      type: 'paragraph',
      classificationEngine: DIAGRAM_RELATION_ENGINE,
    });
  }

  const ordinary = blocks
    .filter((block) => !consumed.has(block))
    .map((block): ClassifiedTextBlock => classifyTextBlock(block, pageWidth, context));
  return [...ordinary, ...relations, ...listItems];
}

/**
 * marker 与正文是两个源对象，C9 要求它们合成一个 `list_item`（marker 不进 text）。
 * 配对只认"同一基线、marker 在左、间隙不超过几个字身"——纯几何，不猜语义。
 */
function pairListItemBlocks(
  blocks: readonly TextBlock[],
  consumed: Set<TextBlock>,
): ClassifiedTextBlock[] {
  const items: ClassifiedTextBlock[] = [];
  for (const marker of blocks) {
    if (consumed.has(marker) || !isStandaloneListMarker(marker.lines[0])) continue;
    if (marker.lines.length !== 1) continue;
    // 代码块里的 `-` 是 YAML 语法不是项目符号；等宽字体是这里唯一能用的判据。
    if (isCodeBlock(marker)) continue;
    const markerLine = marker.lines[0];
    const body = blocks
      .filter((candidate) => {
        if (candidate === marker || consumed.has(candidate)) return false;
        if (candidate.lane !== marker.lane) return false;
        if (isStandaloneListMarker(candidate.lines[0]) || isCodeBlock(candidate)) return false;
        const first = candidate.lines[0];
        const referenceSize = Math.max(markerLine.fontSize, first.fontSize);
        if (Math.abs(first.baseline - markerLine.baseline) > LINE_TOL_RATIO * referenceSize) return false;
        const gap = first.bbox[0] - markerLine.bbox[2];
        return gap >= 0 && gap <= LIST_MARKER_MAX_GAP_RATIO * markerLine.fontSize;
      })
      .sort((left, right) => left.bbox[0] - right.bbox[0])[0];
    if (body === undefined) continue;
    consumed.add(marker);
    consumed.add(body);
    items.push({
      block: mergeTextBlocks([marker, body]),
      type: 'list_item',
      classificationEngine: LIST_ITEM_ENGINE,
    });
  }
  return items;
}

function splitContinuationTailBlocks(
  blocks: readonly TextBlock[],
  continuation: CrossPageContinuationCandidate | undefined,
): TextBlock[] {
  if (continuation === undefined) return [...blocks];
  const anchors = new Set(continuation.sourceObjectIds);
  const output: TextBlock[] = [];
  for (const block of blocks) {
    const lineIndex = block.lines.findLastIndex((line) => line.items.some((item) =>
      anchors.has(item.id) && CONTINUATION_TRAILING_PHRASE.test(item.text.trim())));
    if (lineIndex < 0) {
      output.push(block);
      continue;
    }
    const line = block.lines[lineIndex];
    const suffix = [...line.items].reverse().find((item) =>
      anchors.has(item.id) && CONTINUATION_TRAILING_PHRASE.test(item.text.trim()));
    if (suffix === undefined || line.items.at(-1)?.id !== suffix.id) {
      output.push(block);
      continue;
    }
    const prefixItems = line.items.filter((item) => item.id !== suffix.id);
    const prefixLines = [
      ...block.lines.slice(0, lineIndex),
      ...(prefixItems.length === 0 ? [] : [lineFromItems(prefixItems, line.lane)]),
      ...block.lines.slice(lineIndex + 1),
    ];
    if (prefixLines.length > 0) output.push(textBlockFromLines(block, prefixLines));
    output.push(textBlockFromLines(block, [lineFromItems([suffix], line.lane)]));
  }
  return output;
}

function textBlockFromLines(block: TextBlock, lines: readonly TextLine[]): TextBlock {
  return {
    page: block.page,
    bbox: unionBboxes(lines.map((line) => line.bbox)),
    readingOrder: block.readingOrder,
    lane: block.lane,
    lines: [...lines],
    sourceObjectIds: lines.flatMap((line) => line.sourceObjectIds),
  };
}

function classifyTextBlock(
  block: TextBlock,
  pageWidth: number,
  context: LayoutContext | undefined,
): ClassifiedTextBlock {
  const text = blockText(block);
  const semantics = (type: Region['type']): ClassifiedTextBlock =>
    ({ block, type, classificationEngine: 'local-text-semantics-v1' });
  if (isHeadingText(text) || isNumericHeadingBlock(block, text)) return semantics('heading');
  if (FIGURE_CAPTION_MARKER.test(text)) return semantics('figure');
  if (monospaceCharacterShare(block) >= CODE_MONOSPACE_CHARACTER_SHARE) return semantics('code');
  // 编号是确定性证据，字号只是排版惯例，所以字号排名永远排在编号判据之后（rfc § 7.2）。
  if (isFontRankHeadingBlock(block, text, context)) {
    return { block, type: 'heading', classificationEngine: HEADING_FONT_RANK_ENGINE };
  }
  if (isDisplayFormulaBlock(block, text, pageWidth)) return semantics('formula');
  return { block, type: 'unknown', classificationEngine: 'local-line-block-v1' };
}

function blockText(block: TextBlock): string {
  return block.lines.map((line) => textForLine(line)).join(' ').trim();
}

/**
 * 没有编号的标题只剩字号可判 —— D21 把 style.fontSize 放进元素正是为了这件事。
 * 判据不能只有"比正文大"：强调用的稍大字体也比正文大，所以同时要求块很短、
 * 不以句末标点收尾，并且这个字号在全文的占比小到不像另一种正文（画像里已经过滤）。
 */
function isFontRankHeadingBlock(
  block: TextBlock,
  text: string,
  context: LayoutContext | undefined,
): boolean {
  if (context?.textProfile === undefined) return false;
  if (block.lines.length > HEADING_MAX_LINES) return false;
  if (visibleLength(text) > HEADING_MAX_CHARACTERS) return false;
  if (HEADING_FORBIDDEN_TAIL.test(text)) return false;
  const items = block.lines.flatMap((line) => line.items);
  if (items.length === 0) return false;
  return headingLevelForFontSize(context.textProfile, dominantTextStyle(items).fontSize) !== null;
}

/**
 * 展示公式：独占一行、页面居中、含等号，且没有任何成词的字母串。
 * 只认这四条同时成立的情形 —— 宁可把公式留在 unknown，也不能把居中的短句判成公式。
 */
function isDisplayFormulaBlock(block: TextBlock, text: string, pageWidth: number): boolean {
  if (block.lines.length !== 1 || pageWidth <= 0) return false;
  if (!text.includes('=')) return false;
  if (longestLatinRun(text) > FORMULA_MAX_LATIN_RUN) return false;
  return Math.abs(horizontalCenter(block.bbox) - pageWidth / 2)
    <= FORMULA_CENTER_TOLERANCE_RATIO * pageWidth;
}

function longestLatinRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    if (/\p{Script=Latin}/u.test(character)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function nearestHorizontalPeer(
  connector: TextBlock,
  peers: readonly TextBlock[],
  side: 'left' | 'right',
): TextBlock | undefined {
  const candidates = peers.filter((candidate) => {
    const outerSize = candidate.lines[0].fontSize;
    const verticalDistance = Math.abs(verticalCenter(candidate.bbox) - verticalCenter(connector.bbox));
    if (verticalDistance > DIAGRAM_RELATION_BASELINE_TOLERANCE_RATIO * outerSize) return false;
    const onRequestedSide = side === 'left'
      ? candidate.bbox[2] < connector.bbox[0]
      : candidate.bbox[0] > connector.bbox[2];
    if (!onRequestedSide) return false;
    const horizontalGap = side === 'left'
      ? connector.bbox[0] - candidate.bbox[2]
      : candidate.bbox[0] - connector.bbox[2];
    return horizontalGap <= DIAGRAM_RELATION_MAX_HORIZONTAL_GAP_RATIO * outerSize;
  });
  return candidates.sort((left, right) => {
    const leftGap = side === 'left'
      ? connector.bbox[0] - left.bbox[2]
      : left.bbox[0] - connector.bbox[2];
    const rightGap = side === 'left'
      ? connector.bbox[0] - right.bbox[2]
      : right.bbox[0] - connector.bbox[2];
    return leftGap - rightGap || left.bbox[0] - right.bbox[0];
  })[0];
}

function diagramRelationParts(lines: readonly TextLine[]): [TextLine, TextLine, TextLine] | null {
  if (lines.length !== 3) return null;
  const [left, connector, right] = [...lines].sort((a, b) => a.bbox[0] - b.bbox[0]);
  const outerSize = Math.max(left.fontSize, right.fontSize);
  const outerDifference = Math.abs(left.fontSize - right.fontSize) / outerSize;
  const outerBaselineDifference = Math.abs(left.baseline - right.baseline);
  const connectorBaselineDistance = Math.max(
    Math.abs(connector.baseline - left.baseline),
    Math.abs(connector.baseline - right.baseline),
  );
  if (outerDifference > DIAGRAM_RELATION_OUTER_FONT_TOLERANCE_RATIO
    || outerBaselineDifference > LINE_TOL_RATIO * outerSize
    || connectorBaselineDistance > DIAGRAM_RELATION_BASELINE_TOLERANCE_RATIO * outerSize
    || connector.fontSize > DIAGRAM_RELATION_CONNECTOR_FONT_MAX_RATIO * Math.min(left.fontSize, right.fontSize)
    || visibleLength(textForLine(connector)) > DIAGRAM_RELATION_CONNECTOR_MAX_CHARACTERS) {
    return null;
  }
  return [left, connector, right];
}

function mergeTextBlocks(blocks: readonly TextBlock[]): TextBlock {
  const first = blocks[0];
  if (first === undefined) throw new TypeError('图内关系不得由空块组成');
  return {
    page: first.page,
    bbox: unionBboxes(blocks.map((block) => block.bbox)),
    readingOrder: first.readingOrder,
    lane: first.lane,
    lines: blocks.flatMap((block) => block.lines),
    sourceObjectIds: blocks.flatMap((block) => block.sourceObjectIds),
  };
}

function isCodeBlock(block: TextBlock): boolean {
  return monospaceCharacterShare(block) >= CODE_MONOSPACE_CHARACTER_SHARE;
}

function monospaceCharacterShare(block: TextBlock): number {
  let monospace = 0;
  let total = 0;
  for (const item of block.lines.flatMap((line) => line.items)) {
    const length = visibleLength(item.text);
    total += length;
    if (MONOSPACE_FONT_NAME.test(item.fontName)) monospace += length;
  }
  return total === 0 ? 0 : monospace / total;
}

function orderLines(lines: readonly TextLine[]): TextLine[] {
  const spanning = lines.filter((line) => line.lane < 0).sort(compareLinesVertically);
  const columnLines = lines.filter((line) => line.lane >= 0);
  const ordered: TextLine[] = [];
  let lowerBoundary = Number.NEGATIVE_INFINITY;
  for (const separator of spanning) {
    const separatorY = verticalCenter(separator.bbox);
    ordered.push(...columnLines
      .filter((line) => {
        const y = verticalCenter(line.bbox);
        return y >= lowerBoundary && y < separatorY;
      })
      .sort(compareColumnLines));
    ordered.push(separator);
    lowerBoundary = separatorY;
  }
  ordered.push(...columnLines
    .filter((line) => verticalCenter(line.bbox) >= lowerBoundary)
    .sort(compareColumnLines));
  return ordered;
}

function canMergeLine(
  block: Omit<TextBlock, 'readingOrder'>,
  next: TextLine,
  following: TextLine | undefined,
): boolean {
  if (block.lane !== next.lane) return false;
  const previous = block.lines[block.lines.length - 1];
  if (isStandaloneListMarker(previous) || isStandaloneListMarker(next)) return false;
  const previousText = textForLine(previous).trim();
  const nextText = textForLine(next).trim();
  if (isHeadingText(previousText) || isSemanticBlockStart(nextText)
    || startsWithListMarker(next)
    || isCodeLine(previous) || isCodeLine(next)) return false;
  const referenceSize = Math.max(previous.fontSize, next.fontSize);
  const gap = next.bbox[1] - previous.bbox[3];
  const ordinaryLineSpacing = gap <= BLOCK_LINE_GAP_RATIO * referenceSize;
  const matchingRightEdge = Math.abs(previous.bbox[2] - next.bbox[2])
    <= BLOCK_LEFT_ALIGNMENT_RATIO * referenceSize;
  const shortFinalLine = previous.bbox[2] - next.bbox[2]
    >= BLOCK_SHORT_FINAL_LINE_MIN_RATIO * referenceSize;
  const wrappedLineSpacing = gap <= BLOCK_WRAPPED_LINE_GAP_RATIO * referenceSize
    && (matchingRightEdge || shortFinalLine);
  const lineSpacingMatches = (ordinaryLineSpacing || wrappedLineSpacing)
    && gap >= -BLOCK_LINE_OVERLAP_RATIO * referenceSize;
  const fontSizeMatches = Math.abs(previous.fontSize - next.fontSize) / referenceSize
    <= BLOCK_FONT_SIZE_TOLERANCE_RATIO;
  const offset = Math.abs(previous.bbox[0] - next.bbox[0]);
  const ordinaryAlignment = offset <= BLOCK_LEFT_ALIGNMENT_RATIO * referenceSize;
  const centeredAlignment = block.lines.length === 1
    && Math.abs(horizontalCenter(previous.bbox) - horizontalCenter(next.bbox))
      <= BLOCK_CENTER_ALIGNMENT_RATIO * referenceSize;
  // 例外只对块首行开放：后续段落的首行缩进不会被前一段的尾行吞掉，列表的 marker
  // 也只把自己的续行纳入。行距与字号两道门仍然必须同时通过。
  const firstLineIndent = block.lines.length === 1
    && offset <= HANGING_INDENT_MAX_RATIO * referenceSize
    && following !== undefined
    && following.lane === next.lane
    && Math.abs(next.bbox[0] - following.bbox[0])
      <= BLOCK_LEFT_ALIGNMENT_RATIO * Math.max(next.fontSize, following.fontSize);
  // 满行接短末行已经给出比“再看下一行”更直接的换行证据；列表恰好在末行后结束时
  // 不存在 following 可供对齐，不能因此把末行拆掉。
  const wrappedIndent = shortFinalLine
    && offset <= HANGING_INDENT_MAX_RATIO * referenceSize;
  return lineSpacingMatches && fontSizeMatches
    && (ordinaryAlignment || centeredAlignment || firstLineIndent || wrappedIndent);
}

function isSemanticBlockStart(text: string): boolean {
  return isHeadingText(text)
    || NUMERIC_HEADING_MARKER.test(text)
    || LIST_ITEM_START_MARKER.test(text);
}

/** 符号字体的项目符号在 Unicode 上没有词形，只能连着字体名一起判。 */
function startsWithListMarker(line: TextLine): boolean {
  const first = line.items.find((item) => item.text.trim().length > 0);
  return first !== undefined && isListMarkerText(first.text, first.fontName);
}

function isHeadingText(text: string): boolean {
  return PRIMARY_HEADING_MARKER.test(text) || SECONDARY_HEADING_MARKER.test(text);
}

/**
 * 数字编号单独不足以判定章节：`1.` 是列表 marker，以编号开头的正文段落也存在。
 * 再要求整块是单行且短，才把它当成确定性的章节证据。
 */
function isNumericHeadingBlock(block: TextBlock, text: string): boolean {
  return block.lines.length === 1
    && NUMERIC_HEADING_MARKER.test(text)
    && visibleLength(text) <= NUMERIC_HEADING_MAX_CHARACTERS;
}

function isCodeLine(line: TextLine): boolean {
  let monospace = 0;
  let total = 0;
  for (const item of line.items) {
    const length = visibleLength(item.text);
    total += length;
    if (MONOSPACE_FONT_NAME.test(item.fontName)) monospace += length;
  }
  return total > 0 && monospace / total >= CODE_MONOSPACE_CHARACTER_SHARE;
}

/** 同基线先按大空洞拆成版面段，再把独立项目符号与正文分开承载。 */
function splitTextLine(line: TextLine): TextLine[] {
  const horizontalGroups: TextObject[][] = [];
  for (const item of line.items) {
    const previous = horizontalGroups.at(-1)?.at(-1);
    const gap = previous === undefined ? 0 : item.bbox[0] - previous.bbox[2];
    const referenceSize = previous === undefined ? item.fontSize : Math.max(previous.fontSize, item.fontSize);
    if (previous === undefined || gap <= LINE_SEGMENT_GAP_RATIO * referenceSize) {
      const current = horizontalGroups.at(-1);
      if (current === undefined) horizontalGroups.push([item]);
      else current.push(item);
    } else {
      horizontalGroups.push([item]);
    }
  }

  const semanticGroups: TextObject[][] = [];
  for (const group of horizontalGroups) {
    const firstInk = group.findIndex((item) => item.text.trim().length > 0);
    if (firstInk < 0 || !isListMarkerText(group[firstInk].text, group[firstInk].fontName)) {
      semanticGroups.push(group);
      continue;
    }
    let contentIndex = firstInk + 1;
    while (contentIndex < group.length && group[contentIndex].text.trim().length === 0) contentIndex += 1;
    if (contentIndex >= group.length) semanticGroups.push(group);
    else semanticGroups.push(group.slice(0, contentIndex), group.slice(contentIndex));
  }
  return semanticGroups.map((items) => lineFromItems(items, line.lane));
}

function lineFromItems(items: readonly TextObject[], lane: number): TextLine {
  const [first, ...rest] = items;
  if (first === undefined) throw new TypeError('文字行分段不得为空');
  const line = lineFromItem(first, lane);
  for (const item of rest) addItemToLine(line, item);
  line.items.sort((left, right) => left.bbox[0] - right.bbox[0] || left.id.localeCompare(right.id));
  line.sourceObjectIds = line.items.map((item) => item.id);
  return line;
}

function isStandaloneListMarker(line: TextLine | undefined): boolean {
  if (line === undefined) return false;
  const inkItems = line.items.filter((item) => item.text.trim().length > 0);
  if (inkItems.length !== 1) return false;
  return isListMarkerText(inkItems[0].text, inkItems[0].fontName);
}

/**
 * `markedBreak` = 两个真字之间原本隔着一个无墨 chunk。文本层已经说了"这里断开"，
 * 剩下的只是宽度够不够一个空格；此时中日韩不再豁免 —— 汉字之间不写空格是排版
 * 惯例，不是"再宽的间隙也读作连写"。
 */
function needsSpaceBetweenItems(
  left: TextObject,
  right: TextObject,
  markedBreak = false,
): boolean {
  if (left.text.length === 0 || right.text.length === 0) return false;
  if (/\s$/u.test(left.text) || /^\s/u.test(right.text)) return false;
  const leftCharacter = lastCharacter(left.text);
  const rightCharacter = firstCharacter(right.text);
  if (!markedBreak && isCjk(leftCharacter) && isCjk(rightCharacter)) return false;
  if (!markedBreak && !hasLatinOrNumber(left.text) && !hasLatinOrNumber(right.text)) return false;
  const gap = right.bbox[0] - left.bbox[2];
  const averageWidth = averageGlyphWidth(left, right);
  return gap > SPACE_GAP_RATIO * averageWidth;
}

/**
 * 行与行的拼接规则。跨页续接走同一个函数：页边造成的断行与栏内换行是同一件事，
 * 两处各写一套迟早会在「中文不加空格、拉丁加空格」这条上分歧。
 */
export function joinLineText(left: string, right: string): string {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (/\s$/u.test(left) || /^\s/u.test(right)) return left + right;
  const leftCharacter = lastCharacter(left);
  const rightCharacter = firstCharacter(right);
  // C11 的软换行连字符规则只作用于拉丁词；中文破折号和数字负号都不能被顺手删掉。
  if (leftCharacter === '-'
    && hasLatinOrNumber(characterBeforeLast(left))
    && /\p{Script=Latin}/u.test(rightCharacter)) {
    return left.slice(0, -1) + right;
  }
  if (isCjk(leftCharacter) && isCjk(rightCharacter)) return left + right;
  if (NO_SPACE_BEFORE.test(rightCharacter) || NO_SPACE_AFTER.test(leftCharacter)) return left + right;
  if (hasLatinOrNumber(leftCharacter) || hasLatinOrNumber(rightCharacter)) return `${left} ${right}`;
  return left + right;
}

const NO_SPACE_BEFORE = /^[,.;:!?%\)\]\}\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u3009\u300b\u300d\u300f\u3011]$/u;
const NO_SPACE_AFTER = /^[\(\[\{\u3008\u300a\u300c\u300e\u3010]$/u;

function averageGlyphWidth(left: TextObject, right: TextObject): number {
  const visibleCharacters = visibleLength(left.text) + visibleLength(right.text);
  const measuredWidth = bboxWidth(left.bbox) + bboxWidth(right.bbox);
  if (visibleCharacters > 0 && measuredWidth > 0) return measuredWidth / visibleCharacters;
  return Math.max(left.fontSize, right.fontSize) * FALLBACK_AVERAGE_GLYPH_WIDTH_RATIO;
}

function lineFromItem(item: TextObject, lane: number): TextLine {
  return {
    page: item.page,
    bbox: [...item.bbox],
    baseline: baseline(item),
    fontSize: item.fontSize,
    lane,
    items: [item],
    sourceObjectIds: [item.id],
  };
}

function addItemToLine(line: TextLine, item: TextObject): void {
  const count = line.items.length;
  line.baseline = (line.baseline * count + baseline(item)) / (count + 1);
  line.fontSize = (line.fontSize * count + item.fontSize) / (count + 1);
  line.bbox = unionBboxes([line.bbox, item.bbox]);
  line.items.push(item);
}

/**
 * lane < 0 表示"通栏"：它会成为阅读顺序里的分隔带。可是栏界只是按栏数均分出来的
 * 假想线，一个只有五分之一页宽的小块压在假想线上并不通栏 —— 判成分隔带会把它两侧
 * 同高的内容切到不同的段里。真通栏的东西自己就很宽，所以再加一条宽度判据。
 */
function columnLane(bbox: Bbox, columns: number, pageWidth: number): number {
  if (columns === 1 || pageWidth <= 0) return 0;
  const spansPage = (bbox[2] - bbox[0]) >= SPANNING_REGION_MIN_WIDTH_SHARE * pageWidth;
  if (spansPage) {
    for (let divider = 1; divider < columns; divider += 1) {
      const x = pageWidth * divider / columns;
      if (bbox[0] < x && bbox[2] > x) return -1;
    }
  }
  return clampInteger(Math.floor(horizontalCenter(bbox) / pageWidth * columns), 0, columns - 1);
}

function validColumnCount(columns: number): number {
  return Number.isInteger(columns) && columns > 0 ? columns : 1;
}

function positivePageWidth(items: readonly TextObject[]): number {
  const maximum = Math.max(1, ...items.map((item) => item.bbox[2]));
  return maximum;
}

function regionId(sourceObjectIds: readonly SourceObjectId[]): string {
  const first = sourceObjectIds[0];
  const last = sourceObjectIds[sourceObjectIds.length - 1];
  if (first === undefined || last === undefined) throw new TypeError('版面区域必须引用至少一个源对象');
  return first === last ? `region_${first}` : `region_${first}_${last}`;
}

function compareVisualObjects(left: VisualObject, right: VisualObject): number {
  return left.bbox[1] - right.bbox[1]
    || left.bbox[0] - right.bbox[0]
    || left.id.localeCompare(right.id);
}

function compareLinesVertically(left: TextLine, right: TextLine): number {
  return left.baseline - right.baseline || left.bbox[0] - right.bbox[0];
}

function compareColumnLines(left: TextLine, right: TextLine): number {
  return left.lane - right.lane || compareLinesVertically(left, right);
}

function unionBboxes(bboxes: readonly Bbox[]): Bbox {
  return [
    Math.min(...bboxes.map((bbox) => bbox[0])),
    Math.min(...bboxes.map((bbox) => bbox[1])),
    Math.max(...bboxes.map((bbox) => bbox[2])),
    Math.max(...bboxes.map((bbox) => bbox[3])),
  ];
}

function baseline(item: TextObject): number {
  return item.bbox[3];
}

function bboxWidth(bbox: Bbox): number {
  return Math.max(0, bbox[2] - bbox[0]);
}

function bboxArea(bbox: Bbox): number {
  return bboxWidth(bbox) * Math.max(0, bbox[3] - bbox[1]);
}

function intersectionArea(left: Bbox, right: Bbox): number {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  return width * height;
}

function horizontalCenter(bbox: Bbox): number {
  return (bbox[0] + bbox[2]) / 2;
}

function verticalCenter(bbox: Bbox): number {
  return (bbox[1] + bbox[3]) / 2;
}

function visibleLength(text: string): number {
  return [...text].filter((character) => !/\s/u.test(character)).length;
}

function firstCharacter(text: string): string {
  return [...text][0] ?? '';
}

function lastCharacter(text: string): string {
  return [...text].at(-1) ?? '';
}

function characterBeforeLast(text: string): string {
  return [...text].at(-2) ?? '';
}

function isCjk(character: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
}

function hasLatinOrNumber(text: string): boolean {
  return /[\p{Script=Latin}\p{Number}]/u.test(text);
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
