import type { LayoutPageArtifact, OverlaidTextMode, PageProbe, ParseRawPageArtifact, ProbeCrossArtifact, RawSourceObject } from '../schema/artifacts.ts';
import type { SourceObjectId } from '../schema/element.ts';
import type { VerdictReason } from '../schema/reasons.ts';
import type { Warning } from '../schema/warnings.ts';
import { layoutPage } from './layout/index.ts';
import { COLUMN_MAX_COLUMNS, RULE_MAX_THICKNESS_PT, RULE_MIN_ASPECT_RATIO, RULE_MIN_LENGTH_PT, RULED_TABLE_MIN_AXIS_RULES } from './params/l1.ts';
import { VERDICT_LOCAL_MAX, VERDICT_SCORE_DECIMAL_PLACES, VERDICT_WEIGHTS } from './params/verdict.ts';
type TextObject = Extract<RawSourceObject, { kind: 'text' }>;
export interface StructuralResidualInput {
  rawPage: ParseRawPageArtifact;
  layoutPage: LayoutPageArtifact;
  pageProbe: PageProbe;
  crossProbe: ProbeCrossArtifact;
  overlaidText?: OverlaidTextMode;
}
export interface PageVerdict {
  textLayer: PageProbe['textLayerVerdict'];
  layoutUncertainty: number;
  status: 'ok' | 'degraded';
  wouldEscalateInFullVersion: false | 'layout_oracle' | 'full_parser';
  reasons: VerdictReason[];
}
/** 文本层证据由 L0/L1 判定；这里不选择或执行任何引擎。 */
export function evaluatePageVerdict(input: StructuralResidualInput, encrypted = false): PageVerdict {
  const probe = input.pageProbe;
  const residuals = {
    objectCoverage: objectCoverageResidual(input.rawPage, input.layoutPage),
    readingOrderStability: readingOrderResidual(input),
    tableGridResidual: tableGridResidual(input.rawPage, probe),
  };
  // 无框线表没有闭合网格；只惩罚检测残差，不能因“没有框线”而惩罚已正确识别的表。
  if (probe.hasTable && probe.tableKind === 'borderless') {
    residuals.tableGridResidual = Math.max(residuals.tableGridResidual, 1 - clamp(probe.tableConfidence), 1 - clamp(probe.cellTextHitRate));
  }
  const totalWeight = Object.values(VERDICT_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const layoutUncertainty = round(clamp(
    Object.entries(VERDICT_WEIGHTS).reduce((sum, [key, weight]) => sum + weight * residuals[key as keyof typeof residuals], 0) / totalWeight,
  ));
  const textLayer = probe.textLayerVerdict;
  const sparseScan = probe.evidence.some(e => e.code === 'sparse_text_over_image');
  const reasons: VerdictReason[] = [];
  if (textLayer === 'absent') reasons.push('no_text_layer');
  if (textLayer === 'broken' || textLayer === 'partial') {
    if (probe.evidence.some(e => e.hardness === 'structural')) reasons.push('broken_text_layer_structural');
    if (probe.evidence.some(e => e.hardness === 'statistical')) reasons.push('broken_text_layer_statistical');
  }
  if (probe.hasOverlaidTextOnImage) reasons.push('overlaid_text_on_image');
  if (probe.hasLowResolutionScan) reasons.push('low_resolution_scan');
  if (encrypted) reasons.push('encrypted');
  const uncertain = layoutUncertainty > VERDICT_LOCAL_MAX;
  if (uncertain) {
    if (residuals.objectCoverage > 0) reasons.push('object_coverage_low');
    if (residuals.readingOrderStability > 0) reasons.push('reading_order_unstable');
    if (residuals.tableGridResidual > 0) reasons.push('table_grid_residual_high');
  }
  return {
    textLayer, layoutUncertainty,
    status: textLayer !== 'trusted' || uncertain ? 'degraded' : 'ok',
    wouldEscalateInFullVersion: textLayer === 'broken' || textLayer === 'absent' || sparseScan
      ? 'full_parser' : textLayer === 'partial' || uncertain ? 'layout_oracle' : false,
    reasons,
  };
}
export function verdictWarnings(page: number, verdict: PageVerdict): Warning[] {
  const warnings: Warning[] = [];
  const detail = { textLayer: verdict.textLayer, recommendedEngine: verdict.wouldEscalateInFullVersion, guidance: '本地版不含 OCR 或模型；此场景需要 OCR 工具或完整版。' };
  if (verdict.textLayer !== 'trusted') warnings.push({
    code: verdict.textLayer === 'absent' ? 'NO_TEXT_LAYER' : verdict.textLayer === 'broken' ? 'BROKEN_TEXT_LAYER' : 'TEXT_LAYER_SUSPECT',
    severity: 'warn', scope: 'page', page,
    message: verdict.textLayer === 'absent' ? '页面没有可用文本层；需要 OCR 工具或完整版。' : '文本层不可信，已保留原文并标记 degraded；可使用完整版进一步解析。',
    detail,
  });
  if (verdict.layoutUncertainty > VERDICT_LOCAL_MAX) warnings.push({
    code: 'LAYOUT_UNCERTAIN', severity: 'warn', scope: 'page', page,
    message: '本地版面识别存在不确定性，已保留全部源内容；复杂版面可使用完整版。',
    detail: { score: verdict.layoutUncertainty, threshold: VERDICT_LOCAL_MAX, reasons: verdict.reasons },
  });
  return warnings;
}

export function objectCoverageResidual(
  page: ParseRawPageArtifact,
  layout: LayoutPageArtifact,
): number {
  const textIds = visibleTexts(page).map((object) => object.id);
  if (textIds.length === 0) return 0;
  const coverage = new Map<SourceObjectId, number>();
  for (const region of layout.regions) {
    for (const id of region.sourceObjectIds) coverage.set(id, (coverage.get(id) ?? 0) + 1);
  }
  return textIds.filter((id) => coverage.get(id) !== 1).length / textIds.length;
}

/**
 * L1 已经扰动过分栏阈值；只有它报告栏数不稳定时，才比较相邻栏数答案的 Kendall 距离。
 * 稳定双栏不会因为“它有两栏”被罚分。
 */
export function readingOrderResidual(input: StructuralResidualInput): number {
  const instability = 1 - clamp(input.pageProbe.columnStability);
  if (instability === 0) return 0;
  const textIds = new Set(visibleTexts(input.rawPage).map((object) => object.id));
  const baseline = textReadingOrder(input.layoutPage, textIds);
  const columnCandidates = new Set([
    Math.max(1, input.pageProbe.columns - 1),
    Math.min(COLUMN_MAX_COLUMNS, input.pageProbe.columns + 1),
  ]);
  columnCandidates.delete(input.pageProbe.columns);
  let maximumDistance = 0;
  for (const columns of columnCandidates) {
    const perturbed = layoutPage(input.rawPage, { columns }, input.crossProbe, {
      overlaidText: input.overlaidText,
    });
    maximumDistance = Math.max(
      maximumDistance,
      normalizedKendallDistance(baseline, textReadingOrder(perturbed, textIds)),
    );
  }
  return maximumDistance * instability;
}

export function tableGridResidual(
  page: ParseRawPageArtifact,
  probe: Pick<PageProbe, 'gridClosure' | 'cellTextHitRate'>,
): number {
  const axes = tableLikeAxes(page.objects);
  if (axes.horizontal < RULED_TABLE_MIN_AXIS_RULES
    || axes.vertical < RULED_TABLE_MIN_AXIS_RULES) return 0;
  return Math.max(1 - clamp(probe.gridClosure), 1 - clamp(probe.cellTextHitRate));
}

/** 两个次序只比较共同的唯一锚点；0 表示一致，1 表示完全逆序。 */
export function normalizedKendallDistance(
  left: readonly SourceObjectId[],
  right: readonly SourceObjectId[],
): number {
  const rightPositions = new Map<SourceObjectId, number>();
  for (const id of right) if (!rightPositions.has(id)) rightPositions.set(id, rightPositions.size);
  const common: number[] = [];
  const seen = new Set<SourceObjectId>();
  for (const id of left) {
    const position = rightPositions.get(id);
    if (position === undefined || seen.has(id)) continue;
    seen.add(id);
    common.push(position);
  }
  if (common.length < 2) return 0;
  let inversions = 0;
  for (let leftIndex = 0; leftIndex < common.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < common.length; rightIndex += 1) {
      if (common[leftIndex] > common[rightIndex]) inversions += 1;
    }
  }
  return inversions / (common.length * (common.length - 1) / 2);
}

function textReadingOrder(
  layout: LayoutPageArtifact,
  textIds: ReadonlySet<SourceObjectId>,
): SourceObjectId[] {
  return [...layout.regions]
    .sort((left, right) => left.readingOrder - right.readingOrder || left.id.localeCompare(right.id))
    .flatMap((region) => region.sourceObjectIds.filter((id) => textIds.has(id)));
}

function tableLikeAxes(objects: readonly RawSourceObject[]): {
  horizontal: number;
  vertical: number;
} {
  let horizontal = 0;
  let vertical = 0;
  for (const object of objects) {
    if (object.kind === 'rule') {
      if (object.orientation === 'h') horizontal += 1;
      else vertical += 1;
      continue;
    }
    if (object.kind !== 'graphic') continue;
    const width = Math.max(0, object.bbox[2] - object.bbox[0]);
    const height = Math.max(0, object.bbox[3] - object.bbox[1]);
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    if (long < RULE_MIN_LENGTH_PT || short > RULE_MAX_THICKNESS_PT) continue;
    if (short > 0 && long / short < RULE_MIN_ASPECT_RATIO) continue;
    if (width >= height) horizontal += 1;
    else vertical += 1;
  }
  return { horizontal, vertical };
}

function visibleTexts(page: ParseRawPageArtifact): TextObject[] {
  return page.objects.filter((object): object is TextObject =>
    object.kind === 'text' && [...object.text].some((character) => !/\s/u.test(character))
  );
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  const scale = 10 ** VERDICT_SCORE_DECIMAL_PLACES;
  return Math.round(value * scale) / scale;
}
