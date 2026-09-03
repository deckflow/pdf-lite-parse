import './dom-matrix.ts';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  ContentKindCounts,
  ParseRawPageArtifact,
  RawSourceObject,
} from '../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../schema/artifacts.ts';
import type {
  Bbox,
  DocumentInfo,
  LinkTarget,
  OutlineNode,
  SourceIndexEntry,
  SourceObjectId,
} from '../../schema/element.ts';
import type { Warning } from '../../schema/warnings.ts';
import { encodePng, imageOrientationFromMatrix } from './image-asset.ts';
import { isInkFreeText } from '../params/ledger.ts';
import {
  DEFAULT_STROKE_LINE_WIDTH_PT,
  RULE_AXIS_ALIGNMENT_TOLERANCE_PT,
} from '../params/geometry.ts';
import {
  CONTINUATION_EDGE_BAND_SHARE,
  CONTINUATION_SPLIT_MIN_PREFIX_CHARACTERS,
  CONTINUATION_SPLIT_ROTATION_TOLERANCE_RATIO,
  CONTINUATION_TERMINAL_PUNCTUATION,
  CONTINUATION_TRAILING_PHRASE,
} from '../params/l2.ts';
import {
  quantizeCoordinate,
  pdfPointsToTopLeftBbox,
  topLeftBbox,
  type Point,
} from './coordinates.ts';

type Matrix = [number, number, number, number, number, number];

interface TextItemLike {
  str: string;
  width: number;
  height: number;
  transform: unknown[];
  fontName: string;
}

interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[][];
}

type DecodedImage = Parameters<typeof encodePng>[0];

interface AnnotationLike {
  id: unknown;
  subtype: unknown;
  rect: unknown;
  url?: unknown;
  unsafeUrl?: unknown;
  dest?: unknown;
  contentsObj?: { str?: unknown };
}

interface PageLike {
  rotate: number;
  ref: { num: number } | null;
  commonObjs: { has(name: string): boolean; get(name: string): unknown };
  objs: { get(name: string, callback: (value: unknown) => void): void };
  getViewport(options: { scale: number }): {
    width: number;
    height: number;
    convertToViewportPoint(x: number, y: number): [number, number];
  };
  getTextContent(options: {
    includeMarkedContent: boolean;
    disableNormalization: boolean;
  }): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<OperatorListLike>;
  getAnnotations(options: { intent: string }): Promise<unknown[]>;
}

interface DocumentLike {
  numPages: number;
  getPage(page: number): Promise<PageLike>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  getOutline(): Promise<unknown[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

type SourceRef =
  | { kind: 'stream'; opStart: number; opEnd: number }
  | { kind: 'annotation'; objNum: number };

interface SourceDraft {
  object: RawSourceObject;
  ref: SourceRef;
}

export interface ParsedPage {
  artifact: ParseRawPageArtifact;
  sourceIndexEntries: SourceIndexEntry[];
}

export interface DocumentProperties {
  info: DocumentInfo;
  /** null = 这份 PDF 没有大纲。读取失败同样是 null，但那时 warnings 非空。 */
  outline: OutlineNode[] | null;
  warnings: Warning[];
}

/** 一张抽出的图像资源；sourceObjectId 与 parse 阶段的 image 源对象一一对应。 */
export interface PageImageAsset {
  sourceObjectId: SourceObjectId;
  width: number;
  height: number;
  mimeType: 'image/png';
  bytes: Uint8Array;
}

export interface OpenPdfDocument {
  pages: number;
  encrypted: boolean;
  readProperties(): Promise<DocumentProperties>;
  parsePage(page: number): Promise<ParsedPage>;
  pageGeometry(page: number): Promise<{ width: number; height: number; rotation: number }>;
  extractPageImages(page: number): Promise<PageImageAsset[]>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));

// Node 没有浏览器 Worker；固定 worker 模块让 pdf.js 明确走 fake worker，避免首次调用漂移。
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

export async function openPdf(data: Uint8Array, password?: string, maxImageSize: number = -1): Promise<OpenPdfDocument> {
  const documentParameters = {
    data,
    ...(password === undefined ? {} : { password }),
    isEvalSupported: false,
    maxImageSize,
    useSystemFonts: false,
    standardFontDataUrl: pathToFileURL(join(pdfjsRoot, 'standard_fonts/')).href,
    verbosity: 0,
  };
  // pdf.js 6 的公开 d.ts 漏掉了仍由 evaluator 读取的安全开关。
  const loadingTask = pdfjs.getDocument(
    documentParameters as Parameters<typeof pdfjs.getDocument>[0],
  );
  let document: DocumentLike;
  try { document = await loadingTask.promise as unknown as DocumentLike; }
  catch (error) { await loadingTask.destroy(); throw error; }
  const fallbackFontNames = new Map<string, string>();

  return {
    pages: document.numPages,
    pageGeometry: async (number) => {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height, rotation: page.rotate };
    },
    // 问文档本身，不问调用方传没传口令：空口令加密的 PDF 也必须报 encrypted。
    encrypted: await readEncrypted(document),
    readProperties: async () => readDocumentProperties(document),
    parsePage: async (page) => parsePdfPage(document, page, (fontName) => {
      const existing = fallbackFontNames.get(fontName);
      if (existing) return existing;
      const stableName = `font_${String(fallbackFontNames.size).padStart(4, '0')}`;
      fallbackFontNames.set(fontName, stableName);
      return stableName;
    }),
    extractPageImages: async (page) => extractPdfPageImages(document, page),
    close: async () => {
      await loadingTask.destroy();
    },
  };
}

/** pdf.js 把加密字典的 filter 名放在 documentInfo 里；非空即该文档确实被加密。 */
async function readEncrypted(document: DocumentLike): Promise<boolean> {
  const metadata = await document.getMetadata();
  return typeof metadata.info?.EncryptFilterName === 'string';
}

/**
 * 文档级属性：信息字典与大纲。
 *
 * 两条各自 try/catch —— 读不出大纲不该连带丢掉 author，反之亦然。日期与标题一律
 * 原样落盘，归一化由下游决定。
 */
async function readDocumentProperties(document: DocumentLike): Promise<DocumentProperties> {
  const warnings: Warning[] = [];
  let info: DocumentInfo = emptyDocumentInfo('unavailable');
  try {
    const metadata = await document.getMetadata();
    info = documentInfo(metadata.info ?? {});
  } catch (error) {
    warnings.push(documentWarning('文档信息字典', error));
  }

  let outline: OutlineNode[] | null = null;
  try {
    const raw = await document.getOutline();
    outline = raw === null ? null : await outlineNodes(document, raw);
  } catch (error) {
    warnings.push(documentWarning('文档大纲', error));
  }
  return { info, outline, warnings };
}

function emptyDocumentInfo(status: DocumentInfo['status']): DocumentInfo {
  return {
    status,
    title: null,
    author: null,
    subject: null,
    keywords: null,
    creator: null,
    producer: null,
    createdAt: null,
    modifiedAt: null,
    lang: null,
  };
}

function documentInfo(info: Record<string, unknown>): DocumentInfo {
  return {
    status: 'read',
    title: optionalString(info.Title),
    author: optionalString(info.Author),
    subject: optionalString(info.Subject),
    keywords: optionalString(info.Keywords),
    creator: optionalString(info.Creator),
    producer: optionalString(info.Producer),
    createdAt: optionalString(info.CreationDate),
    modifiedAt: optionalString(info.ModDate),
    // /Lang 在目录字典而非信息字典里，pdf.js 把它并进了同一个 info 对象。
    lang: optionalString(info.Language),
  };
}

/** 空串与"没写"是两件事，但对元数据没有区分价值：两者都表示这份文档没提供。 */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function outlineNodes(document: DocumentLike, items: readonly unknown[]): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    nodes.push({
      title: typeof record.title === 'string' ? record.title : '',
      target: await linkTarget(document, record.url, record.unsafeUrl, record.dest),
      children: Array.isArray(record.items) ? await outlineNodes(document, record.items) : [],
    });
  }
  return nodes;
}

/**
 * 把 pdf.js 的 url / dest 两路统一成 LinkTarget。
 *
 * dest 有两种形态：命名目标（字符串，要再解引用一次）与显式目标（数组，首项是页对象
 * 引用）。解引用失败时保留名字、page 记 null —— "指向不明"要说出来，不能当没有链接。
 */
async function linkTarget(
  document: DocumentLike,
  url: unknown,
  unsafeUrl: unknown,
  dest: unknown,
): Promise<LinkTarget | null> {
  // pdf.js 认为不安全的 URL 只出现在 unsafeUrl 里。IR 是解析快照不是执行器，
  // 原样记录才是诚实的；是否跟随由下游决定。
  const href = typeof url === 'string' ? url : typeof unsafeUrl === 'string' ? unsafeUrl : null;
  if (href !== null) return { kind: 'external', href };
  if (dest === undefined || dest === null) return null;

  const destination = typeof dest === 'string' ? dest : null;
  let explicit: unknown[] | null = Array.isArray(dest) ? dest : null;
  if (destination !== null) {
    try {
      explicit = await document.getDestination(destination);
    } catch {
      explicit = null;
    }
  }
  return { kind: 'internal', page: await destinationPage(document, explicit), destination };
}

async function destinationPage(document: DocumentLike, explicit: unknown[] | null): Promise<number | null> {
  if (explicit === null || explicit.length === 0) return null;
  const target = explicit[0];
  // 显式目标也可能直接写页序号（远程目标常见），此时不必再解引用。
  if (typeof target === 'number' && Number.isInteger(target) && target >= 0) return target + 1;
  try {
    return (await document.getPageIndex(target)) + 1;
  } catch {
    return null;
  }
}

function documentWarning(what: string, error: unknown): Warning {
  return {
    code: 'LOCAL_PARSE_FAILED',
    severity: 'warn',
    scope: 'doc',
    message: `pdf.js 读取${what}失败，该部分已显式记为不可用`,
    detail: { error: errorMessage(error) },
  };
}

async function parsePdfPage(
  document: DocumentLike,
  pageNumber: number,
  stableFontName: (fontName: string) => string,
): Promise<ParsedPage> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const pageObjectNumber = page.ref?.num ?? pageNumber;
  const warnings: Warning[] = [];

  let operatorList: OperatorListLike = { fnArray: [], argsArray: [] };
  try {
    // 必须排在 getTextContent 之前：字体对象要等操作符流跑完才会进 commonObjs，
    // 顺序反了就只剩 pdf.js 的进程内别名，样式里的字体族随之退化成假名字。
    operatorList = await page.getOperatorList();
  } catch (error) {
    warnings.push(parseWarning(pageNumber, 'operators', error));
  }

  let textItems: unknown[] = [];
  try {
    const textContent = await page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    });
    textItems = textContent.items;
  } catch (error) {
    warnings.push(parseWarning(pageNumber, 'text', error));
  }

  let annotations: unknown[] = [];
  try {
    // intent 'any'：display 会滤掉不可见批注，而"不可见"不等于"不存在"，
    // 按可见性提前删内容正是本项目定义的最严重缺陷。
    annotations = await page.getAnnotations({ intent: 'any' });
  } catch (error) {
    warnings.push(parseWarning(pageNumber, 'annotations', error));
  }

  const textOperatorOffsets = findTextOperatorOffsets(operatorList.fnArray);
  const textDrafts = extractTextDrafts(
    textItems,
    textOperatorOffsets,
    viewport,
    pageNumber,
    warnings,
    (fontName) => resolveFontName(page, fontName, stableFontName),
  );
  const visualDrafts = extractVisualDrafts(operatorList, viewport, pageNumber, warnings);
  const annotationDrafts = await extractAnnotationDrafts(
    document,
    annotations,
    viewport,
    pageNumber,
    pageObjectNumber,
  );
  const drafts = [...textDrafts, ...visualDrafts, ...annotationDrafts];
  const artifact: ParseRawPageArtifact = {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.parseRaw,
    page: pageNumber,
    width: quantizeCoordinate(viewport.width),
    height: quantizeCoordinate(viewport.height),
    rotation: page.rotate,
    objects: drafts.map((draft) => draft.object),
    contentOperators: {
      ...censusContentOperators(operatorList),
      // 批注不在内容流里，普查只能数 /Annots 本身。这仍然是"抽取之外的一个计数"，
      // 但两侧同源，抓不到 pdf.js 自己解不出某条批注的情况 —— 真正独立的第二路
      // 要等 L0 结构扫描（rfc § 5.1）能直读页字典。
      annotation: annotations.length,
    },
    warnings,
  };
  return {
    artifact,
    sourceIndexEntries: drafts.map((draft) => sourceIndexEntry(draft, pageObjectNumber)),
  };
}

/**
 * 字体名优先取 PDF 里的真名（含子集前缀，如 `MLJNAR+SimSun`）。
 *
 * pdf.js 的 `g_d{运行序号}_f{序号}` 会随同进程加载次数变化，不能落盘；但它只是个
 * 句柄，真名在 commonObjs 里。取不到时才退回进程内稳定别名 —— 那时样式的字体族
 * 就只剩"可区分"而不再"可辨识"，这是降级不是等价物。
 */
function resolveFontName(
  page: PageLike,
  loadedName: string,
  stableFontName: (fontName: string) => string,
): string {
  try {
    if (page.commonObjs.has(loadedName)) {
      const font = page.commonObjs.get(loadedName);
      if (typeof font === 'object' && font !== null) {
        const name = (font as { name?: unknown }).name;
        if (typeof name === 'string' && name.length > 0) return name;
      }
    }
  } catch {
    // commonObjs 未就绪时按未命中处理，走下面的稳定别名。
  }
  return stableFontName(loadedName);
}

/**
 * 批注抽取。
 *
 * 这类内容的危险之处在于它**不在内容流里**：不抽取的话，操作符普查与守恒账本
 * 双双看不见，丢了不告警、不降级、覆盖率照样 1.000。所以它必须成为源对象。
 */
async function extractAnnotationDrafts(
  document: DocumentLike,
  annotations: readonly unknown[],
  viewport: ReturnType<PageLike['getViewport']>,
  page: number,
  pageObjectNumber: number,
): Promise<SourceDraft[]> {
  const drafts: SourceDraft[] = [];
  for (let index = 0; index < annotations.length; index += 1) {
    const candidate = annotations[index];
    if (typeof candidate !== 'object' || candidate === null) continue;
    const annotation = candidate as AnnotationLike;
    const rect = readBounds(annotation.rect);
    drafts.push({
      object: {
        id: sourceObjectId(page, 'a', index),
        page,
        kind: 'annotation',
        subtype: typeof annotation.subtype === 'string' ? annotation.subtype : 'Unknown',
        contents: typeof annotation.contentsObj?.str === 'string' ? annotation.contentsObj.str : '',
        target: await linkTarget(document, annotation.url, annotation.unsafeUrl, annotation.dest),
        // /Rect 缺失或非法的批注仍然存在，只是定位不到；给整页 bbox 而不是丢掉它。
        bbox: rect === null
          ? [0, 0, quantizeCoordinate(viewport.width), quantizeCoordinate(viewport.height)]
          : pdfBoundsBbox(rect, viewport),
      },
      ref: { kind: 'annotation', objNum: annotationObjectNumber(annotation.id, pageObjectNumber) },
    });
  }
  return drafts;
}

/** pdf.js 的 annotation.id 形如 `12R`，即对象号 + 代数；解析不出就落回页对象号。 */
function annotationObjectNumber(id: unknown, pageObjectNumber: number): number {
  if (typeof id !== 'string') return pageObjectNumber;
  const matched = /^(\d+)R/.exec(id);
  return matched === null ? pageObjectNumber : Number(matched[1]);
}

function extractTextDrafts(
  items: readonly unknown[],
  operatorOffsets: readonly number[],
  viewport: ReturnType<PageLike['getViewport']>,
  page: number,
  warnings: Warning[],
  stableFontName: (fontName: string) => string,
): SourceDraft[] {
  const drafts: SourceDraft[] = [];
  let textIndex = 0;
  let operatorIndex = 0;
  for (const candidate of items) {
    if (!isTextItem(candidate)) continue;
    const transform = readMatrix(candidate.transform);
    let bbox: Bbox;
    let storedTransform: Matrix;
    if (transform === null) {
      storedTransform = [1, 0, 0, 1, 0, 0];
      bbox = [0, 0, quantizeCoordinate(viewport.width), quantizeCoordinate(viewport.height)];
      warnings.push({
        code: 'LOCAL_PARSE_FAILED',
        severity: 'warn',
        scope: 'page',
        page,
        message: `第 ${textIndex} 个文字源对象的变换矩阵无效，bbox 已显式降级为整页`,
      });
    } else {
      storedTransform = transform.map(quantizeCoordinate) as Matrix;
      bbox = textItemBbox(candidate, transform, viewport);
    }
    const opStart = operatorOffsets[operatorIndex] ?? operatorIndex;
    const parts = splitTrailingContinuationText(
      candidate.str,
      bbox,
      storedTransform,
      candidate.width,
      viewport.height,
    );
    for (const part of parts) {
      drafts.push({
        object: {
          id: sourceObjectId(page, 't', textIndex),
          page,
          kind: 'text',
          text: part.text,
          fontName: stableFontName(candidate.fontName),
          fontSize: quantizeCoordinate(Math.hypot(transform?.[2] ?? 0, transform?.[3] ?? 0)),
          transform: part.transform,
          bbox: part.bbox,
        },
        ref: { kind: 'stream', opStart, opEnd: opStart + 1 },
      });
      textIndex += 1;
    }
    operatorIndex += 1;
  }
  return drafts;
}

interface TextDraftPart {
  text: string;
  bbox: Bbox;
  transform: Matrix;
}

/**
 * 页边缘续接的最小无损切分：字符拼回去逐字等于 pdf.js item，且两个源对象仍回指
 * 同一算子区间。切分只是增加可寻址边界，不改变或补写任何字符。
 */
export function splitTrailingContinuationText(
  text: string,
  bbox: Bbox,
  transform: Matrix,
  advance: number,
  pageHeight: number,
): TextDraftPart[] {
  const horizontalScale = Math.hypot(transform[0], transform[1]);
  const rotated = horizontalScale > 0
    && Math.abs(transform[1]) / horizontalScale > CONTINUATION_SPLIT_ROTATION_TOLERANCE_RATIO;
  const match = CONTINUATION_TRAILING_PHRASE.exec(text);
  if (rotated
    || bbox[3] < pageHeight * (1 - CONTINUATION_EDGE_BAND_SHARE)
    || CONTINUATION_TERMINAL_PUNCTUATION.test(text.trimEnd())
    || match === null
    || match.index < CONTINUATION_SPLIT_MIN_PREFIX_CHARACTERS
    || bbox[2] <= bbox[0]) {
    return [{ text, bbox: [...bbox], transform: [...transform] as Matrix }];
  }
  const ratio = match.index / text.length;
  const splitX = quantizeCoordinate(bbox[0] + (bbox[2] - bbox[0]) * ratio);
  const baselineAdvance = Number.isFinite(advance) ? advance * ratio : 0;
  const unitX = horizontalScale > 0 ? transform[0] / horizontalScale : 1;
  const unitY = horizontalScale > 0 ? transform[1] / horizontalScale : 0;
  const suffixTransform = [...transform] as Matrix;
  suffixTransform[4] = quantizeCoordinate(suffixTransform[4] + unitX * baselineAdvance);
  suffixTransform[5] = quantizeCoordinate(suffixTransform[5] + unitY * baselineAdvance);
  return [
    {
      text: text.slice(0, match.index),
      bbox: [bbox[0], bbox[1], splitX, bbox[3]],
      transform: [...transform] as Matrix,
    },
    {
      text: text.slice(match.index),
      bbox: [splitX, bbox[1], bbox[2], bbox[3]],
      transform: suffixTransform,
    },
  ];
}

function textItemBbox(
  item: TextItemLike,
  transform: Matrix,
  viewport: ReturnType<PageLike['getViewport']>,
): Bbox {
  const [a, b, c, d, e, f] = transform;
  const horizontalScale = Math.hypot(a, b);
  const verticalScale = Math.hypot(c, d);
  const horizontal: Point = horizontalScale > 0 ? [a / horizontalScale, b / horizontalScale] : [1, 0];
  const vertical: Point = verticalScale > 0 ? [c / verticalScale, d / verticalScale] : [0, 1];
  // 无墨迹 chunk 的 item.width 是 advance 累积量：实测单空格报 1022pt，
  // 直接当宽度会让三成元素的 bbox 冲出页面，把 I7 变成常态噪声。只记笔位。
  const width = !isInkFreeText(item.str) && Number.isFinite(item.width) ? item.width : 0;
  const height = item.height > 0 && Number.isFinite(item.height) ? item.height : verticalScale;
  const widthVector: Point = [horizontal[0] * width, horizontal[1] * width];
  const heightVector: Point = [vertical[0] * height, vertical[1] * height];
  return pdfPointsToTopLeftBbox(viewport, [
    [e, f],
    [e + widthVector[0], f + widthVector[1]],
    [e + heightVector[0], f + heightVector[1]],
    [e + widthVector[0] + heightVector[0], f + widthVector[1] + heightVector[1]],
  ]);
}

function extractVisualDrafts(
  operatorList: OperatorListLike,
  viewport: ReturnType<PageLike['getViewport']>,
  page: number,
  warnings: Warning[],
): SourceDraft[] {
  const drafts: SourceDraft[] = [];
  const stack: Array<{ ctm: Matrix; lineWidth: number }> = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let lineWidth = DEFAULT_STROKE_LINE_WIDTH_PT;
  let graphicIndex = 0;
  let ruleIndex = 0;
  let imageIndex = 0;

  for (let opIndex = 0; opIndex < operatorList.fnArray.length; opIndex += 1) {
    const operator = operatorList.fnArray[opIndex];
    const args = operatorList.argsArray[opIndex] ?? [];
    if (operator === pdfjs.OPS.save) {
      stack.push({ ctm: [...ctm] as Matrix, lineWidth });
      continue;
    }
    if (operator === pdfjs.OPS.restore) {
      const restored = stack.pop();
      if (restored) {
        ctm = restored.ctm;
        lineWidth = restored.lineWidth;
      } else warnings.push(ctmWarning(page, opIndex, 'restore 没有对应的 save'));
      continue;
    }
    if (operator === pdfjs.OPS.transform) {
      const transform = readMatrix(args);
      if (transform) ctm = multiplyMatrices(ctm, transform);
      else warnings.push(ctmWarning(page, opIndex, 'transform 参数无效'));
      continue;
    }
    if (operator === pdfjs.OPS.setLineWidth) {
      if (isFiniteNumber(args[0])) lineWidth = Math.abs(args[0]);
      continue;
    }
    if (operator === pdfjs.OPS.constructPath) {
      // pdf.js 6 把 stroke/fill/endPath 折进了 constructPath 的 args[0]，不再单独下发。
      // 旧写法等一个永远不会到来的独立绘制操作符，整份文档的矢量对象会一个不剩。
      const paintOperator = args[0];
      if (typeof paintOperator !== 'number') {
        warnings.push(ctmWarning(page, opIndex, 'constructPath 缺少绘制操作符'));
        continue;
      }
      // 纯裁切路径不落墨，不是内容；普查侧同样不计，两边才对得上。
      if (paintOperator === pdfjs.OPS.endPath) continue;
      const bounds = readBounds(args[2]);
      // 无几何的绘制操作符什么都画不出来（pdf.js 对空路径给 minMax = null）。
      if (!bounds) continue;
      const ref = { kind: 'stream', opStart: opIndex, opEnd: opIndex + 1 } as const;
      // ★ 描边矩形是表格边线最常见的落地形态：ReportLab 之类的生成器给每个单元格
      //   画一次 `re S`。只留 bbox 的话，一个 110×32 的单元格框在出口处就退化成
      //   "一个又粗又方的图形"，四条边线从此不存在，下游再怎么推断也补不回来。
      //   路径几何本身是确定性证据，在这里拆成横竖线不是猜测。
      const rules = isStrokePaintOperator(paintOperator)
        ? axisAlignedRuleSegments(args[1], ctm, viewport)
        : null;
      if (rules !== null) {
        const thickness = strokeThickness(lineWidth, ctm);
        for (const rule of rules) {
          drafts.push({
            object: {
              id: sourceObjectId(page, 'r', ruleIndex),
              page,
              kind: 'rule',
              orientation: rule.orientation,
              x0: rule.x0,
              y0: rule.y0,
              x1: rule.x1,
              y1: rule.y1,
              thickness,
              ruleKind: 'stroke',
              bbox: topLeftBbox([[rule.x0, rule.y0], [rule.x1, rule.y1]]),
            },
            ref,
          });
          ruleIndex += 1;
        }
        continue;
      }
      drafts.push({
        object: {
          id: sourceObjectId(page, 'g', graphicIndex),
          page,
          kind: 'graphic',
          operator: operatorName(paintOperator),
          bbox: pdfBoundsBbox(transformBounds(bounds, ctm), viewport),
        },
        ref,
      });
      graphicIndex += 1;
      continue;
    }
    if (isImagePaintOperator(operator)) {
      const id = sourceObjectId(page, 'i', imageIndex);
      drafts.push({
        object: {
          id,
          page,
          kind: 'image',
          xObjectName: typeof args[0] === 'string' ? args[0] : null,
          assetPath: null,
          bbox: transformedBoundsBbox([0, 0, 1, 1], ctm, viewport),
        },
        ref: { kind: 'stream', opStart: opIndex, opEnd: opIndex + 1 },
      });
      imageIndex += 1;
    }
  }
  if (stack.length > 0) warnings.push(ctmWarning(page, operatorList.fnArray.length, 'save/restore 栈未闭合'));
  return drafts;
}

interface RuleSegment {
  orientation: 'h' | 'v';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** pdf.js 6 的路径缓冲区操作码（DrawOPS），与 makePathFromDrawOPS 一一对应。 */
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CLOSE_PATH = 4;

function isStrokePaintOperator(paintOperator: number): boolean {
  return paintOperator === pdfjs.OPS.stroke
    || paintOperator === pdfjs.OPS.closeStroke
    || paintOperator === pdfjs.OPS.fillStroke
    || paintOperator === pdfjs.OPS.eoFillStroke
    || paintOperator === pdfjs.OPS.closeFillStroke
    || paintOperator === pdfjs.OPS.closeEOFillStroke;
}

/**
 * 描边路径 → 页面空间里的横竖线。
 *
 * 只在整条路径都是轴对齐直段时才接管（返回 null 表示"这不是线，按图形落"）。
 * 斜线、曲线、以及任何看不懂的操作码都让路走回 graphic 分支：宁可少认一条线，
 * 也不能把一段弧当成表格边框。
 */
function axisAlignedRuleSegments(
  pathArgument: unknown,
  ctm: Matrix,
  viewport: ReturnType<PageLike['getViewport']>,
): RuleSegment[] | null {
  if (!Array.isArray(pathArgument)) return null;
  const buffer = pathArgument[0];
  if (!ArrayBuffer.isView(buffer) && !Array.isArray(buffer)) return null;
  const data = Array.from(buffer as ArrayLike<number>);
  if (!data.every(isFiniteNumber)) return null;

  const toPage = (x: number, y: number): Point => {
    const [px, py] = applyMatrix(ctm, [x, y]);
    const [vx, vy] = viewport.convertToViewportPoint(px, py);
    return [quantizeCoordinate(vx), quantizeCoordinate(vy)];
  };

  const segments: RuleSegment[] = [];
  let cursor: Point | null = null;
  let subpathStart: Point | null = null;
  for (let index = 0; index < data.length;) {
    const operation = data[index];
    index += 1;
    if (operation === DRAW_MOVE_TO) {
      if (index + 2 > data.length) return null;
      cursor = toPage(data[index], data[index + 1]);
      subpathStart = cursor;
      index += 2;
      continue;
    }
    if (operation === DRAW_LINE_TO) {
      if (index + 2 > data.length || cursor === null) return null;
      const next = toPage(data[index], data[index + 1]);
      index += 2;
      const segment = ruleSegment(cursor, next);
      if (segment === null) return null;
      if (segment !== undefined) segments.push(segment);
      cursor = next;
      continue;
    }
    if (operation === DRAW_CLOSE_PATH) {
      if (cursor === null || subpathStart === null) return null;
      const segment = ruleSegment(cursor, subpathStart);
      if (segment === null) return null;
      if (segment !== undefined) segments.push(segment);
      cursor = subpathStart;
      continue;
    }
    // curveTo / quadraticCurveTo / 未知操作码：不是直线路径。
    return null;
  }
  return segments.length === 0 ? null : segments;
}

/** null = 斜线（整条路径作废）；undefined = 退化成一个点（无墨，直接丢弃）。 */
function ruleSegment(from: Point, to: Point): RuleSegment | null | undefined {
  const horizontal = Math.abs(to[1] - from[1]) <= RULE_AXIS_ALIGNMENT_TOLERANCE_PT;
  const vertical = Math.abs(to[0] - from[0]) <= RULE_AXIS_ALIGNMENT_TOLERANCE_PT;
  if (horizontal && vertical) return undefined;
  if (!horizontal && !vertical) return null;
  if (horizontal) {
    const axis = (from[1] + to[1]) / 2;
    return {
      orientation: 'h',
      x0: Math.min(from[0], to[0]),
      y0: quantizeCoordinate(axis),
      x1: Math.max(from[0], to[0]),
      y1: quantizeCoordinate(axis),
    };
  }
  const axis = (from[0] + to[0]) / 2;
  return {
    orientation: 'v',
    x0: quantizeCoordinate(axis),
    y0: Math.min(from[1], to[1]),
    x1: quantizeCoordinate(axis),
    y1: Math.max(from[1], to[1]),
  };
}

/** 线宽随 CTM 缩放；取行列向量的几何平均，各向异性缩放下也不会退化成 0。 */
function strokeThickness(lineWidth: number, ctm: Matrix): number {
  const [a, b, c, d] = ctm;
  const scale = Math.sqrt(Math.abs(a * d - b * c));
  const scaled = lineWidth * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  return quantizeCoordinate(scaled > 0 ? scaled : DEFAULT_STROKE_LINE_WIDTH_PT);
}

function transformedBoundsBbox(
  bounds: readonly [number, number, number, number],
  ctm: Matrix,
  viewport: ReturnType<PageLike['getViewport']>,
): Bbox {
  return pdfBoundsBbox(transformBounds(bounds, ctm), viewport);
}

function transformBounds(
  bounds: readonly [number, number, number, number],
  ctm: Matrix,
): readonly [number, number, number, number] {
  const [x0, y0, x1, y1] = bounds;
  const points = [
    applyMatrix(ctm, [x0, y0]),
    applyMatrix(ctm, [x1, y0]),
    applyMatrix(ctm, [x0, y1]),
    applyMatrix(ctm, [x1, y1]),
  ];
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}

function pdfBoundsBbox(
  bounds: readonly [number, number, number, number],
  viewport: ReturnType<PageLike['getViewport']>,
): Bbox {
  const [x0, y0, x1, y1] = bounds;
  return pdfPointsToTopLeftBbox(viewport, [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]);
}

function sourceIndexEntry(draft: SourceDraft, objNum: number): SourceIndexEntry {
  const object = draft.object;
  const bbox = object.bbox;
  if (draft.ref.kind === 'annotation') {
    return {
      id: object.id,
      page: object.page,
      kind: 'a',
      bbox,
      ...(object.kind === 'annotation' && object.contents.length > 0
        ? { textHash: textHash(object.contents) }
        : {}),
      annotRef: { objNum: draft.ref.objNum },
    };
  }
  return {
    id: object.id,
    page: object.page,
    kind: streamKindCode(object),
    bbox,
    ...(object.kind === 'text' ? { textHash: textHash(object.text) } : {}),
    streamRef: { objNum, opStart: draft.ref.opStart, opEnd: draft.ref.opEnd },
  };
}

function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function streamKindCode(object: RawSourceObject): 't' | 'g' | 'i' | 'r' {
  switch (object.kind) {
    case 'text': return 't';
    case 'graphic': return 'g';
    case 'image': return 'i';
    case 'rule': return 'r';
    // 批注不走内容流，它的索引条目在上面单独构造。
    case 'annotation': throw new TypeError(`${object.id} 是批注，不能按内容流对象入索引`);
  }
}

function sourceObjectId(page: number, kind: 't' | 'g' | 'i' | 'r' | 'a', index: number): string {
  return `p${page}_${kind}${String(index).padStart(4, '0')}`;
}

/**
 * 抽出本页的图像资源。
 *
 * imageIndex 必须与 extractVisualDrafts 用同一套计数走同一条操作符流，
 * 否则 assetPath 会挂到别的源对象上 —— 那是比没有资源更坏的失败形态。
 * 取不到或编不出的（stencil mask、未知 ImageKind）一律跳过，assetPath 保持 null。
 */
async function extractPdfPageImages(
  document: DocumentLike,
  pageNumber: number,
): Promise<PageImageAsset[]> {
  const page = await document.getPage(pageNumber);
  const operatorList = await page.getOperatorList();
  const assets: PageImageAsset[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let imageIndex = 0;
  for (let opIndex = 0; opIndex < operatorList.fnArray.length; opIndex += 1) {
    const operator = operatorList.fnArray[opIndex];
    const args = operatorList.argsArray[opIndex] ?? [];
    if (operator === pdfjs.OPS.save) {
      stack.push([...ctm] as Matrix);
      continue;
    }
    if (operator === pdfjs.OPS.restore) {
      ctm = stack.pop() ?? ctm;
      continue;
    }
    if (operator === pdfjs.OPS.transform) {
      const matrix = readMatrix(args);
      if (matrix !== null) ctm = multiplyMatrices(ctm, matrix);
      continue;
    }
    if (!isImagePaintOperator(operator)) continue;
    const id = sourceObjectId(pageNumber, 'i', imageIndex);
    imageIndex += 1;
    const decoded = operator === pdfjs.OPS.paintImageXObject
      ? await resolvePageObject(page, args[0])
      : operator === pdfjs.OPS.paintInlineImageXObject
        ? args[0]
        : null;
    if (!isDecodedImage(decoded)) continue;
    // 位图按存储顺序摆出来未必是页面上看到的朝向：CTM 里的 90° 旋转必须补回去，
    // 否则抽出来的图是躺着的 —— 内容在，但没人看得懂。
    const orientation = imageOrientationFromMatrix(ctm);
    if (orientation === null) continue;
    const encoded = encodePng(decoded, orientation);
    if (encoded === null) continue;
    assets.push({ sourceObjectId: id, ...encoded });
  }
  return assets;
}

/** pdf.js 的图像对象是异步解析的；getOperatorList 返回时未必已经就绪。 */
async function resolvePageObject(page: PageLike, name: unknown): Promise<unknown> {
  if (typeof name !== 'string') return null;
  return new Promise<unknown>((resolve) => {
    try {
      page.objs.get(name, resolve);
    } catch {
      resolve(null);
    }
  });
}

function isDecodedImage(value: unknown): value is DecodedImage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.width === 'number'
    && typeof record.height === 'number'
    && typeof record.kind === 'number'
    && ArrayBuffer.isView(record.data);
}

function isTextItem(value: unknown): value is TextItemLike {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.str === 'string'
    && typeof record.width === 'number'
    && typeof record.height === 'number'
    && Array.isArray(record.transform)
    && typeof record.fontName === 'string';
}

function readMatrix(value: unknown): Matrix | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const numbers = Array.from(value as ArrayLike<unknown>);
  if (numbers.length !== 6 || !numbers.every(isFiniteNumber)) return null;
  return numbers as Matrix;
}

function readBounds(value: unknown): readonly [number, number, number, number] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const numbers = Array.from(value as ArrayLike<unknown>);
  if (numbers.length < 4 || !numbers.slice(0, 4).every(isFiniteNumber)) return null;
  return [numbers[0], numbers[1], numbers[2], numbers[3]] as [number, number, number, number];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix(matrix: Matrix, point: Point): Point {
  const [a, b, c, d, e, f] = matrix;
  const [x, y] = point;
  return [a * x + c * y + e, b * x + d * y + f];
}

function findTextOperatorOffsets(operators: readonly number[]): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < operators.length; index += 1) {
    if (TEXT_SHOW_OPERATORS.has(operators[index])) offsets.push(index);
  }
  return offsets;
}

/**
 * ★ 账本的外部分母：只认操作符流，不看抽取结果。
 *
 * 与 extractVisualDrafts 共享的只有"什么算内容"这个语义判断（裁切路径与空路径
 * 不算），计数本身是第二次独立实现。它能抓住"抽取整类塌掉"，抓不住"两处对
 * pdf.js 的理解一起错"——后者只能靠 § 4.1 的陷阱表和真实文档回归。
 *
 * annotation 不在操作符流里，因此这里恒为 0，由调用方补上 /Annots 的计数。
 */
function censusContentOperators(operatorList: OperatorListLike): ContentKindCounts {
  const census: ContentKindCounts = { text: 0, path: 0, image: 0, annotation: 0 };
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operator = operatorList.fnArray[index];
    if (TEXT_SHOW_OPERATORS.has(operator)) {
      census.text += 1;
      continue;
    }
    if (IMAGE_PAINT_OPERATORS.has(operator)) {
      census.image += 1;
      continue;
    }
    if (operator !== pdfjs.OPS.constructPath) continue;
    const args = operatorList.argsArray[index] ?? [];
    if (typeof args[0] !== 'number' || args[0] === pdfjs.OPS.endPath) continue;
    if (readBounds(args[2]) === null) continue;
    census.path += 1;
  }
  return census;
}

function isImagePaintOperator(operator: number): boolean {
  return IMAGE_PAINT_OPERATORS.has(operator);
}

const TEXT_SHOW_OPERATORS = new Set<number>([
  pdfjs.OPS.showText,
  pdfjs.OPS.showSpacedText,
  pdfjs.OPS.nextLineShowText,
  pdfjs.OPS.nextLineSetSpacingShowText,
]);

const IMAGE_PAINT_OPERATORS = new Set<number>([
  pdfjs.OPS.paintImageMaskXObject,
  pdfjs.OPS.paintImageMaskXObjectGroup,
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintInlineImageXObjectGroup,
  pdfjs.OPS.paintSolidColorImageMask,
]);

const OPERATOR_NAMES = new Map<number, string>(
  Object.entries(pdfjs.OPS)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, value]) => [value, name]),
);

function operatorName(operator: number): string {
  return OPERATOR_NAMES.get(operator) ?? `operator_${operator}`;
}

function parseWarning(page: number, component: string, error: unknown): Warning {
  return {
    code: 'LOCAL_PARSE_FAILED',
    severity: 'warn',
    scope: 'page',
    page,
    message: `pdf.js ${component} 解析失败，已保留其他可用源对象`,
    detail: { error: errorMessage(error) },
  };
}

function ctmWarning(page: number, opIndex: number, message: string): Warning {
  return {
    code: 'LOCAL_PARSE_FAILED',
    severity: 'warn',
    scope: 'page',
    page,
    message: `pdf.js 操作符 CTM 在 ${opIndex} 处异常：${message}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
