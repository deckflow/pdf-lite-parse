/** result.json 允许出现的 warning code，见 rfc.md § 11.1。 */
export const WARNING_CODES = [
  "ENCRYPTED_PDF_PASSWORD_REQUIRED",
  "ENCRYPTED_PDF_OPENED",
  "LOCAL_PARSE_FAILED",
  "PAGE_RENDER_FAILED",
  "RASTERIZER_UNAVAILABLE",
  "BROKEN_TEXT_LAYER",
  "TEXT_LAYER_SUSPECT",
  "FONT_NOT_MAPPABLE",
  "NO_TEXT_LAYER",
  "LAYOUT_UNCERTAIN",
  "SOURCE_OBJECT_LOSS",
  "UNREPRESENTABLE_CONTENT",
  "L0_PARTIAL",
  "L0_UNAVAILABLE",
  "NO_SOURCE_ANCHOR",
  "DANGLING_SOURCE_ANCHOR",
  "RESOURCE_LIMIT_EXCEEDED",
  "TABLE_GRID_UNCLOSED",
  "CROSS_PAGE_MERGE_UNCERTAIN",
  "FURNITURE_AMBIGUOUS",
  "SCHEMA_VERSION_MISMATCH",
  "MISSING_FIELD"
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];
export type Severity = 'error' | 'warn' | 'info';

/** scope 决定定位字段，避免 page/element warning 缺少可归因位置。 */
export type Warning =
  | {
      code: WarningCode;
      severity: Severity;
      scope: 'doc';
      message: string;
      detail?: Record<string, unknown>;
    }
  | {
      code: WarningCode;
      severity: Severity;
      scope: 'page';
      page: number;
      message: string;
      detail?: Record<string, unknown>;
    }
  | {
      code: WarningCode;
      severity: Severity;
      scope: 'element';
      page: number;
      elementId: string;
      message: string;
      detail?: Record<string, unknown>;
    };
