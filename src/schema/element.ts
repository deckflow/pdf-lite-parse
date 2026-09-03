import type { RouteReason } from './reasons.ts';
import type { Warning } from './warnings.ts';

export const SCHEMA_VERSION = 'result.v3';

/** [x0, y0, x1, y1]，单位 pt，使用左上原点。 */
export type Bbox = [number, number, number, number];
export type PageStatus = 'ok' | 'degraded' | 'failed';
export type CellRole = 'column_header' | 'row_header' | 'section_header' | 'data';

/**
 * 跳转目标。外链与文档内跳转是两件事：前者交给浏览器，后者要落到本文档的某一页，
 * 用一个 href 字符串同时表达会逼下游去猜"这个串是 URL 还是 destination 名"。
 *
 * internal 的 page 与 destination 至少有一个非空：destination 是 PDF 里的命名锚点，
 * page 是本程序把它解引用后的结果；解引用不出来时只留名字，不许静默丢。
 */
export type LinkTarget =
  | { kind: 'external'; href: string }
  | { kind: 'internal'; page: number | null; destination: string | null };

/** 区间为 UTF-16 code unit 上的半开区间 [start, end)。 */
export type Mark =
  | {
      type: 'bold' | 'italic' | 'underline' | 'strike' | 'sup' | 'sub' | 'code';
      start: number;
      end: number;
    }
  | { type: 'link'; start: number; end: number; target: LinkTarget };

/**
 * 元素级主导样式。marks 恰好只能表达 Markdown 能表达的那部分，而"IR ≠ Markdown"
 * 的物质基础正是它装不下的部分：字体族与字号在 parse 阶段就在手上（源对象自带），
 * 一旦在 assemble 丢掉就不可逆，下游想重判标题层级只能回读源文件。
 *
 * 一个元素合并多个源对象时取**覆盖字符数最多**的那份样式（M1 行块合并的既定规则）；
 * span 级样式差异是 V1 的 marks 扩展点，V0 不表达。
 */
export interface Style {
  /** PDF 里的字体名，含子集前缀，原样保留，不作归一化。 */
  fontFamily: string;
  /** 字号，pt。 */
  fontSize: number;
}

export type SourceObjectId = string;

/** full_parser 页的弱溯源锚。 */
export interface SourceRaster {
  page: number;
  bbox: Bbox;
  renderDpi: number;
  modelCallId: string;
}

/** 内容、版面、分类和组装分别记录来源，避免用单一 engine 误述血缘。 */
export interface Provenance {
  content: { engine: string; role: 'parser' | 'full_parser' };
  layout: { engine: string; modelCallId?: string };
  classification: { engine: string };
  assembly: { version: string };
}

export interface TableCell {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  bbox: Bbox;
  isHeader: boolean;
  role: CellRole;
  page?: number;
  confidence?: number;
  sourceObjectIds?: SourceObjectId[];
  sourceRasters?: SourceRaster[];
}

export interface TableInfo {
  rows: number;
  cols: number;
  headerRows: number;
  headerCols: number;
  kind: 'ruled' | 'borderless' | 'mixed';
  crossPage: boolean;
  pageSpan?: [number, number];
  visualGroupId?: string;
  /**
   * 题注（`表 1 …` / `TABLE I …`）原文，没有关联到题注时字段缺席。
   * 题注不是网格的一部分，却是这张表的事实之一：只把它拼进 element.text 的话，
   * 下游想单独拿到它就只能做字符串减法，渲染器也就无从把它写回 Markdown。
   */
  caption?: string;
  cells: TableCell[];
}

interface ElementBase {
  id: string;
  page: number;
  order: number;
  text: string;
  marks?: Mark[];
  style?: Style;
  bbox: Bbox;
  bboxes?: { page: number; bbox: Bbox }[];
  parentId: string | null;
  provenance: Provenance;
  confidence: number;
  continuesFrom?: string | null;
  isBodyContent: boolean;
  sourceObjectIds?: SourceObjectId[];
  sourceRasters?: SourceRaster[];
}

/** type 是载荷的判别字段；各分支的必需载荷不能退化为可选字段。 */
export type Element =
  /**
   * ★ 未分类：抽出来了但还没有任何分类结论（M0 只有源对象类别映射，没有分类器）。
   * 拿 paragraph 兜底会让下游 switch (el.type) 稳稳走错分支且不告警，而 type 正是
   * 判别位——没有这一支，"没结论"就只能伪装成某个结论。与 RegionType.unknown 对齐。
   */
  | (ElementBase & { type: 'unknown' })
  | (ElementBase & { type: 'heading'; level: number })
  | (ElementBase & { type: 'paragraph' | 'footnote' })
  | (ElementBase & { type: 'list'; list: { ordered: boolean; depth: number } })
  | (ElementBase & { type: 'list_item'; marker: string; depth: number })
  | (ElementBase & { type: 'table'; table: TableInfo })
  | (ElementBase & {
      type: 'figure' | 'chart';
      figure: { assetPath: string | null; kind: 'raster' | 'vector' };
    })
  | (ElementBase & { type: 'caption'; captionOf: string })
  | (ElementBase & { type: 'formula'; formula: { latex?: string; display: boolean } })
  | (ElementBase & { type: 'code'; code: { language: string | null } })
  | (ElementBase & { type: FurnitureType; furnitureKind: FurnitureType });

export type FurnitureType =
  | 'header'
  | 'footer'
  | 'gutter'
  | 'watermark'
  | 'page_number'
  | 'stamp';

export type RouteTier = 'local' | 'local_model' | 'quick' | 'deep' | 'n/a';

export interface RoutePlan {
  role: 'parser' | 'layout_oracle' | 'full_parser';
  tier: RouteTier;
}

export type RouteDisposition =
  | 'executed_as_planned'
  | 'degraded_no_model'
  | 'degraded_budget'
  | 'fallback_rejected'
  | 'fallback_failed';

export interface PageRoute {
  plan: RoutePlan;
  disposition: RouteDisposition;
  planned: string[];
  actual: string[];
  fallbackFrom: string | null;
  oracleAccepted: boolean | null;
  reason: RouteReason[];
}

export interface PageProbeSummary {
  layoutType: 'single_column' | 'two_column' | 'table_heavy' | 'mixed' | 'scanned';
  textLayerVerdict: 'trusted' | 'partial' | 'broken' | 'absent';
  hasBrokenTextLayer: boolean;
  hasOverlaidTextOnImage: boolean;
  textDensity: number;
  columns: number;
  imageAreaRatio: number;
  hasTable: boolean;
  tableKind: 'ruled' | 'borderless' | 'mixed' | 'none';
  hasFormula: boolean;
  hasChart: boolean;
  hasRotatedText: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  structuralUncertainty: number;
  recommendedEngines: string[];
}

export interface PageInfo {
  index: number;
  width: number;
  height: number;
  rotation: number;
  probe: PageProbeSummary;
  route: PageRoute;
  status: PageStatus;
  sourceObjectCoverage: number;
  cost: { ms: number; inputTokens: number; outputTokens: number; usd: number };
}

export interface Stats {
  totalMs: number;
  byEngine: Record<string, unknown>;
  usd: number;
  weakAnchorShare: number;
}

/**
 * ★ PDF 批注（高亮、批注、表单域、Link）。
 *
 * 它**不在内容流里**，因此操作符普查与元素守恒都天然看不见它：丢了不告警、不降级、
 * sourceObjectCoverage 照样 1.0 —— 这是"绝不静默丢失"的标准违反形态，所以 IR 必须
 * 给它一个独立的承载位置，而不是等某个元素顺手把它带上。
 *
 * 它不是 Element：Link 批注本身没有文字，它的文字是被它覆盖的正文。把批注按几何
 * 挂接到元素（→ link mark / highlight mark）需要版面信息，是 M1 的事；在那之前
 * 批注以文档级记录存在，下游可凭 bbox 自行关联。
 */
export interface Annotation {
  id: string;
  page: number;
  bbox: Bbox;
  /** PDF 的 /Subtype 原样：Link / Text / Highlight / Widget / …。 */
  subtype: string;
  /** /Contents 原文；无内容为空串，不是 null（与 C12 空单元格同一条理由）。 */
  contents: string;
  /** 链接类批注的跳转目标；非链接类为 null。 */
  target: LinkTarget | null;
  sourceObjectIds: SourceObjectId[];
}

/**
 * 文档信息字典。lang 是翻译类 Export 的硬前提，title / author 是 DOCX / EPUB 导出
 * 要写进文件头的东西 —— 它们只存在于文档级，任何元素都带不出来。
 *
 * 日期原样保留 PDF 的 `D:YYYYMMDDHHmmSS+TZ` 形态：归一化是下游的职责。
 * status 区分"文档没写"与"我们读不出来"：后者必须同时有告警。
 */
export interface DocumentInfo {
  status: 'read' | 'unavailable';
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  lang: string | null;
}

/**
 * PDF 自带大纲。heading 能推出一棵树，但那是推断；outline 是文档自己声明的事实，
 * 也是"局部提取"的导航入口与跳转目标的定义处，两者不能互相替代。
 */
export interface OutlineNode {
  title: string;
  target: LinkTarget | null;
  children: OutlineNode[];
}

export interface Result {
  version: typeof SCHEMA_VERSION;
  source: { sha256: string; pages: number; encrypted: boolean; path?: string };
  profile: 'fast' | 'balanced' | 'quality';
  docInfo: DocumentInfo;
  /** null = 这份 PDF 没有大纲；读取失败时为 null 且必有告警。 */
  outline: OutlineNode[] | null;
  pages: PageInfo[];
  elements: Element[];
  furniture?: Element[];
  annotations: Annotation[];
  warnings: Warning[];
  stats: Stats;
}

interface SourceIndexBase {
  id: SourceObjectId;
  page: number;
  bbox: Bbox;
  /** 文本对象的内容哈希，不含原文（§ 8.4 隐私）。 */
  textHash?: string;
}

/**
 * 溯源锚的解引用底座。定位方式随来源分叉：内容流对象定位到"哪个流的哪段算子"，
 * 批注定位到"哪个 PDF 对象" —— 给批注塞一个空的算子区间只会让下游以为能去流里找它。
 */
export type SourceIndexEntry =
  | (SourceIndexBase & {
      kind: 't' | 'g' | 'i' | 'r';
      streamRef: { objNum: number; opStart: number; opEnd: number };
    })
  | (SourceIndexBase & {
      kind: 'a';
      annotRef: { objNum: number };
    });
