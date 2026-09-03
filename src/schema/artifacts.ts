import type { Annotation, Bbox, DocumentInfo, Element, LinkTarget, OutlineNode, PageInfo, PageProbeSummary, PageStatus, Result, SourceIndexEntry, SourceObjectId, Stats } from './element.ts';
import type { Warning } from './warnings.ts';

export const ARTIFACT_SCHEMA_VERSIONS = {
  runConfig: 'run_config.local.v1', probeDocument: 'probe_document.v1', sourceIndex: 'source_index.v2',
  parseRaw: 'parse_raw.v3', probePages: 'probe_pages.v2', probeCross: 'probe_cross.v1',
  layoutPage: 'layout_page.v1', documentModel: 'document_model.v2', sourceLedger: 'source_ledger.v3',
  result: 'result.v3', warnings: 'warnings.v1', metadata: 'metadata.local.v1', missingFields: 'missing_fields.v1',
} as const;
export type PageFurnitureMode = 'off' | 'drop' | 'extract';
export type OverlaidTextMode = 'auto' | 'keep' | 'drop';
export interface ResolvedRunConfig {
  pageFurniture: PageFurnitureMode;
  overlaidText: OverlaidTextMode;
  isolate: boolean;
  includeSourcePath: boolean;
  debug: boolean;
  render: boolean;
}
export interface RunConfigArtifact extends ResolvedRunConfig {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.runConfig;
  source: { sha256: string; pages: number; encrypted: boolean; path?: string };
}
export interface FontMappingProbe {
  fontName: string;
  subtype: string;
  encoding: string | null;
  hasToUnicode: boolean | null;
  verdict: 'mappable' | 'not_mappable' | 'unknown';
}

export interface DocumentPageProbe {
  page: number;
  rotation: number;
  hasTextOperators: boolean | null;
  imageXObjectCount: number;
  fonts: FontMappingProbe[];
}

export interface ProbeDocumentArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.probeDocument;
  sourceSha256: string;
  pages: number;
  encrypted: boolean;
  status: 'complete' | 'partial' | 'unavailable';
  pageProbes: DocumentPageProbe[];
  warnings: Warning[];
}

/** 默认模式可解引用的轻量索引；这里故意没有原文 text 字段。 */
export interface SourceIndexArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.sourceIndex;
  sourceSha256: string;
  entries: SourceIndexEntry[];
}

interface RawSourceBase {
  id: SourceObjectId;
  page: number;
  bbox: Bbox;
}

export type RawSourceObject =
  | (RawSourceBase & {
      kind: 'text';
      text: string;
      fontName: string;
      fontSize: number;
      transform: [number, number, number, number, number, number];
    })
  | (RawSourceBase & {
      kind: 'graphic';
      operator: string;
    })
  | (RawSourceBase & {
      kind: 'image';
      xObjectName: string | null;
      assetPath: string | null;
    })
  | (RawSourceBase & {
      kind: 'rule';
      orientation: 'h' | 'v';
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      thickness: number;
      ruleKind: 'stroke' | 'thin_fill';
    })
  | (RawSourceBase & {
      kind: 'annotation';
      /** PDF /Subtype 原样。 */
      subtype: string;
      contents: string;
      target: LinkTarget | null;
    });

/**
 * 按内容类别计数。既用于操作符流普查，也用于源对象产出对照，
 * 两侧同形才能逐类相减。
 *
 * annotation 是唯一不来自操作符流的一类：它的"普查"只能数 /Annots 本身
 * （见 parse/pdfjs.ts 的说明）。放进同一张表是为了让它至少出现在账本里 ——
 * 一个数不出来的类别，丢了永远不会有人发现。
 */
export interface ContentKindCounts {
  text: number;
  path: number;
  image: number;
  annotation: number;
}

export interface ParseRawPageArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.parseRaw;
  page: number;
  width: number;
  height: number;
  rotation: number;
  objects: RawSourceObject[];
  /**
   * ★ 账本的外部分母（§ 3.1b「承载内容的源对象总数」）。直接数操作符流得到，
   *   不经过任何抽取逻辑 —— 一旦抽取整类塌掉，这里仍是原值，差额就暴露出来。
   */
  contentOperators: ContentKindCounts;
  warnings: Warning[];
}

export type TextLayerEvidenceCode =
  | 'font_missing_tounicode'
  | 'replacement_character_rate'
  | 'cid_escape_rate'
  | 'suspicious_codepoint_rate'
  | 'zh_profile_mismatch'
  | 'en_consonant_gibberish'
  | 'sparse_text_over_image';

export interface TextLayerEvidence {
  kind: 'structure' | 'codepoint' | 'linguistic' | 'geometry';
  hardness: 'structural' | 'statistical';
  code: TextLayerEvidenceCode;
  score: number;
  sourceObjectIds: SourceObjectId[];
}

/** L1 的完整证据工件；result.json 只复制 PageProbeSummary 这层稳定摘要。 */
export interface PageProbe extends PageProbeSummary {
  page: number;
  evidence: TextLayerEvidence[];
  tableConfidence: number;
  gridClosure: number;
  cellTextHitRate: number;
  columnSupport: number;
  alignmentEntropy: number;
  anchorObjectIds: SourceObjectId[];
  gutterWidth: number;
  /** 1 表示没有文字对象跨越 gutter；与污染率互补，便于直接表达“分得多干净”。 */
  gutterPurity: number;
  columnStability: number;
  rotation: number;
  hasImage: boolean;
  scanEffectivePpi: number | null;
  hasLowResolutionScan: boolean;
  vectorDensity: number;
  hasMixedTextImage: boolean;
  fontMappable: boolean | null;
}

export interface ProbePagesArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.probePages;
  pages: PageProbe[];
}

export interface CrossPageFurnitureCandidate {
  type: 'header' | 'footer' | 'gutter' | 'watermark' | 'page_number' | 'stamp';
  pages: number[];
  bboxes: { page: number; bbox: Bbox }[];
  sourceObjectIds: SourceObjectId[];
  confidence: number;
}

export interface CrossPageContinuationCandidate {
  fromPage: number;
  toPage: number;
  kind: 'paragraph' | 'list' | 'table';
  sourceObjectIds: SourceObjectId[];
  confidence: number;
}

export interface ProbeCrossArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.probeCross;
  furniture: CrossPageFurnitureCandidate[];
  continuations: CrossPageContinuationCandidate[];
}

export type RegionType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'list_item'
  | 'table'
  | 'figure'
  | 'chart'
  | 'caption'
  | 'formula'
  | 'code'
  | 'header'
  | 'footer'
  | 'gutter'
  | 'watermark'
  | 'page_number'
  | 'stamp'
  | 'unknown';

/** 版面层只引用源对象，不能承载文字。 */
export interface Region {
  id: string;
  page: number;
  type: RegionType;
  bbox: Bbox;
  readingOrder: number;
  confidence: number;
  sourceObjectIds: SourceObjectId[];
  classificationEngine: string;
}

export interface LayoutPageArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.layoutPage;
  page: number;
  width: number;
  height: number;
  rotation: number;
  regions: Region[];
  warnings: Warning[];
}

export interface DocumentModelPage {
  index: number;
  width: number;
  height: number;
  rotation: number;
  status: PageStatus;
  sourceObjectCoverage: number;
}

export interface DocumentModelArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.documentModel;
  source: { sha256: string; pages: number; encrypted: boolean };
  docInfo: DocumentInfo;
  outline: OutlineNode[] | null;
  pages: DocumentModelPage[];
  elements: Element[];
  furniture?: Element[];
  annotations: Annotation[];
}

export type SourceDisposition =
  | 'represented'
  | 'recorded'
  | 'consumed'
  | 'ignored_empty'
  | 'suppressed'
  | 'unrepresentable';

/** unrepresentable 的原因与 represented / recorded 的目标都在类型层强制存在。 */
export type LedgerEntry =
  | {
      sourceObjectId: SourceObjectId;
      page: number;
      disposition: 'represented';
      elementId: string;
    }
  | {
      sourceObjectId: SourceObjectId;
      page: number;
      /** ★ 进了文档级 annotations[]：批注不是元素，但它有确定去向，不算缺口。 */
      disposition: 'recorded';
      annotationId: string;
    }
  | {
      sourceObjectId: SourceObjectId;
      page: number;
      disposition: 'consumed' | 'ignored_empty' | 'suppressed';
    }
  | {
      sourceObjectId: SourceObjectId;
      page: number;
      disposition: 'unrepresentable';
      reason: string;
    };

export interface SourceLedgerPage {
  page: number;
  sourceObjects: number;
  coveredObjects: number;
  sourceObjectCoverage: number;
  /** 操作符流普查（外部分母）与实际产出的源对象数，逐类并列以便一眼看出整类丢失。 */
  contentOperators: ContentKindCounts;
  sourceObjectsByKind: ContentKindCounts;
}

export interface SourceLedgerArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.sourceLedger;
  entries: LedgerEntry[];
  pages: SourceLedgerPage[];
}

/** result.json 保留冻结的 version 字段，同时按工件规则增加 schemaVersion。 */
export type ResultArtifact = Result & {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.result;
};


export interface WarningsArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.warnings;
  warnings: Warning[];
}
export interface MetadataArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.metadata;
  parserVersion: string;
  sourceSha256: string;
  runConfig: ResolvedRunConfig;
  resolvedConfigSha256: string;
  artifactVersions: Record<string, string>;
  timingsMs: Record<string, number>;
  stats: Stats;
}
export interface MissingField {
  path: string;
  field: string;
  elementId?: string;
  message: string;
}

export interface MissingFieldsArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSIONS.missingFields;
  missingFields: MissingField[];
}

export const ARTIFACT_SCHEMA_ROOTS = {
  "run_config.json": "RunConfigArtifact",
  "probe_document.json": "ProbeDocumentArtifact",
  "source_index.json": "SourceIndexArtifact",
  "parse_raw.json": "ParseRawPageArtifact",
  "probe_pages.json": "ProbePagesArtifact",
  "probe_cross.json": "ProbeCrossArtifact",
  "layout_page.json": "LayoutPageArtifact",
  "document_model.json": "DocumentModelArtifact",
  "source_ledger.json": "SourceLedgerArtifact",
  "result.json": "ResultArtifact",
  "warnings.json": "WarningsArtifact",
  "metadata.json": "MetadataArtifact",
  "missing_fields.json": "MissingFieldsArtifact"
} as const;
export type EmittedPage = PageInfo;
