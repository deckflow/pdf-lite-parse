import type { ParseRawPageArtifact, RawSourceObject } from '../../../schema/artifacts.ts';
import type { Bbox, PageProbeSummary, SourceObjectId } from '../../../schema/element.ts';
import {
  BORDERLESS_TABLE_ALIGNMENT_TOLERANCE_PT,
  BORDERLESS_TABLE_MAX_ALIGNMENT_ENTROPY,
  BORDERLESS_TABLE_MIN_COLUMNS,
  BORDERLESS_TABLE_MIN_COLUMN_SUPPORT,
  BORDERLESS_TABLE_MIN_ROWS,
  BORDERLESS_TABLE_MIN_ROW_CONSISTENCY,
  CHART_MAX_MEAN_TEXT_LENGTH,
  CHART_MIN_NUMERIC_TOKENS,
  CHART_MIN_VECTOR_OBJECTS,
  COLUMN_GUTTER_MAX_OCCUPANCY_SHARE,
  COLUMN_GUTTER_MAX_WIDTH_SHARE,
  COLUMN_GUTTER_MIN_WIDTH_PT,
  COLUMN_GUTTER_SEARCH_MAX_SHARE,
  COLUMN_GUTTER_SEARCH_MIN_SHARE,
  COLUMN_MAX_COLUMNS,
  COLUMN_MIN_GUTTER_PURITY,
  COLUMN_MIN_SIDE_CHARACTER_SHARE,
  COLUMN_PROJECTION_BINS,
  COLUMN_THRESHOLD_PERTURBATION,
  COLUMN_BAND_MIN_LINES,
  COLUMN_BAND_MIN_TEXT_WIDTH_SHARE,
  FORMULA_MIN_MATH_CHARACTERS,
  IMAGE_TEXT_OVERLAP_SHARE,
  MIXED_TEXT_IMAGE_MIN_IMAGE_SHARE,
  POINTS_PER_INCH,
  PROBE_AREA_DECIMAL_PLACES,
  PROBE_HIGH_UNCERTAINTY,
  PROBE_MEDIUM_UNCERTAINTY,
  PROBE_OVERLAID_TEXT_UNCERTAINTY,
  PROBE_PARTIAL_TEXT_UNCERTAINTY,
  ROTATED_TEXT_MIN_DEGREES,
  RULE_CLUSTER_TOLERANCE_PT,
  RULE_INTERSECTION_TOLERANCE_PT,
  RULE_MAX_THICKNESS_PT,
  RULE_MIN_ASPECT_RATIO,
  RULE_MIN_LENGTH_PT,
  RULED_TABLE_MIN_AXIS_RULES,
  RULED_TABLE_MIN_CELL_TEXT_HIT_RATE,
  RULED_TABLE_MIN_GRID_CLOSURE,
  SCANNED_PAGE_IMAGE_SHARE,
  SCANNED_PAGE_MAX_TEXT_DENSITY,
  TABLE_CELL_GAP_PT,
  TABLE_GEOMETRY_CONFIDENCE_WEIGHT,
  TABLE_ROW_BASELINE_TOLERANCE_PT,
  TABLE_TEXT_CONFIDENCE_WEIGHT,
} from '../../params/l1.ts';

type TextObject = Extract<RawSourceObject, { kind: 'text' }>;
type GraphicObject = Extract<RawSourceObject, { kind: 'graphic' }>;

interface AxisRule {
  orientation: 'h' | 'v';
  axis: number;
  start: number;
  end: number;
  sourceObjectIds: SourceObjectId[];
}

interface Gutter {
  x0: number;
  x1: number;
  width: number;
  purity: number;
}

export interface TableProbeResult {
  hasTable: boolean;
  tableKind: PageProbeSummary['tableKind'];
  tableConfidence: number;
  gridClosure: number;
  cellTextHitRate: number;
  columnSupport: number;
  alignmentEntropy: number;
  anchorObjectIds: SourceObjectId[];
}

export interface ColumnProbeResult {
  columns: number;
  gutterWidth: number;
  gutterPurity: number;
  columnStability: number;
}

export interface OtherPageSignals {
  rotation: number;
  hasImage: boolean;
  imageAreaRatio: number;
  scanEffectivePpi: number | null;
  hasLowResolutionScan: boolean;
  vectorDensity: number;
  hasOverlaidTextOnImage: boolean;
  hasMixedTextImage: boolean;
  hasFormula: boolean;
  hasChart: boolean;
  hasRotatedText: boolean;
  textDensity: number;
}

export function probeTable(page: ParseRawPageArtifact): TableProbeResult {
  const texts = visibleTextObjects(page);
  const rules = mergeRules(page.objects.flatMap((object) => {
    if (object.kind === 'graphic') return axisRulesFromGraphic(object);
    if (object.kind === 'rule') {
      return [{
        orientation: object.orientation,
        axis: object.orientation === 'h' ? object.y0 : object.x0,
        start: object.orientation === 'h'
          ? Math.min(object.x0, object.x1)
          : Math.min(object.y0, object.y1),
        end: object.orientation === 'h'
          ? Math.max(object.x0, object.x1)
          : Math.max(object.y0, object.y1),
        sourceObjectIds: [object.id],
      } satisfies AxisRule];
    }
    return [];
  }));
  const horizontal = rules.filter((rule) => rule.orientation === 'h');
  const vertical = rules.filter((rule) => rule.orientation === 'v');
  const expectedIntersections = horizontal.length * vertical.length;
  const closedIntersections = horizontal.reduce(
    (total, hRule) => total + vertical.filter((vRule) => rulesIntersect(hRule, vRule)).length,
    0,
  );
  const gridClosure = expectedIntersections === 0 ? 0 : closedIntersections / expectedIntersections;
  const gridBounds = rules.length === 0 ? null : boundsForRules(rules);
  const gridText = gridBounds === null ? [] : texts.filter((text) => pointInBbox(center(text.bbox), gridBounds));
  const cellTextHitRate = texts.length === 0 ? 0 : gridText.length / texts.length;
  const ruledConfidence = clamp(
    gridClosure * TABLE_GEOMETRY_CONFIDENCE_WEIGHT
    + cellTextHitRate * TABLE_TEXT_CONFIDENCE_WEIGHT,
  );
  const hasRuled = horizontal.length >= RULED_TABLE_MIN_AXIS_RULES
    && vertical.length >= RULED_TABLE_MIN_AXIS_RULES
    && gridClosure >= RULED_TABLE_MIN_GRID_CLOSURE
    && cellTextHitRate >= RULED_TABLE_MIN_CELL_TEXT_HIT_RATE;

  const borderless = probeBorderlessTable(texts);
  const hasBorderless = borderless.rows >= BORDERLESS_TABLE_MIN_ROWS
    && borderless.columns >= BORDERLESS_TABLE_MIN_COLUMNS
    && borderless.rowConsistency >= BORDERLESS_TABLE_MIN_ROW_CONSISTENCY
    && borderless.columnSupport >= BORDERLESS_TABLE_MIN_COLUMN_SUPPORT
    && borderless.alignmentEntropy <= BORDERLESS_TABLE_MAX_ALIGNMENT_ENTROPY;
  const borderlessConfidence = hasBorderless
    ? clamp(
      borderless.rowConsistency * TABLE_TEXT_CONFIDENCE_WEIGHT
      + borderless.columnSupport * TABLE_GEOMETRY_CONFIDENCE_WEIGHT,
    )
    : 0;
  const tableKind = hasRuled && hasBorderless
    ? 'mixed'
    : hasRuled
      ? 'ruled'
      : hasBorderless
        ? 'borderless'
        : 'none';
  const anchorObjectIds = new Set<SourceObjectId>();
  if (hasRuled) {
    for (const rule of rules) for (const id of rule.sourceObjectIds) anchorObjectIds.add(id);
    for (const text of gridText) anchorObjectIds.add(text.id);
  }
  if (hasBorderless) for (const id of borderless.sourceObjectIds) anchorObjectIds.add(id);

  return {
    hasTable: tableKind !== 'none',
    tableKind,
    tableConfidence: round(Math.max(ruledConfidence, borderlessConfidence)),
    gridClosure: round(gridClosure),
    cellTextHitRate: round(cellTextHitRate),
    columnSupport: round(borderless.columnSupport),
    alignmentEntropy: round(borderless.alignmentEntropy),
    anchorObjectIds: [...anchorObjectIds],
  };
}

export function probeColumns(page: ParseRawPageArtifact): ColumnProbeResult {
  const texts = visibleTextObjects(page);
  if (texts.length === 0 || page.width <= 0) {
    return { columns: 1, gutterWidth: 0, gutterPurity: 1, columnStability: 1 };
  }
  const thresholds = [
    1 - COLUMN_THRESHOLD_PERTURBATION,
    1,
    1 + COLUMN_THRESHOLD_PERTURBATION,
  ];
  let analyses = thresholds.map((factor) => analyzeColumns(page.width, texts, factor));
  if (analyses[1].columns === 1) {
    for (const start of [0, 0.25, 0.5]) {
      const band = texts.filter(text => {
        const y = center(text.bbox)[1];
        return y >= page.height * start && y <= page.height * (start + 0.5);
      });
      const candidates = thresholds.map(factor => analyzeColumns(page.width, band, factor));
      const candidate = candidates[1];
      if (candidate.columns !== 2 || candidates.some(item => item.columns !== 2)) continue;
      const gutter = candidate.gutters[0];
      const linesPerSide = [false, true].map(right => new Set(band.filter(text =>
        text.bbox[2] - text.bbox[0] >= page.width * COLUMN_BAND_MIN_TEXT_WIDTH_SHARE
        && (right ? text.bbox[0] >= gutter.x1 : text.bbox[2] <= gutter.x0))
        .map(text => Math.round(center(text.bbox)[1] / TABLE_ROW_BASELINE_TOLERANCE_PT))).size);
      if (linesPerSide.every(count => count >= COLUMN_BAND_MIN_LINES)) { analyses = candidates; break; }
    }
  }
  const base = analyses[1];
  const stableCount = analyses.filter((analysis) => analysis.columns === base.columns).length;
  return {
    columns: base.columns,
    gutterWidth: round(base.gutters.reduce((total, gutter) => total + gutter.width, 0)),
    gutterPurity: round(base.gutters.length === 0
      ? 1
      : mean(base.gutters.map((gutter) => gutter.purity))),
    columnStability: round(stableCount / analyses.length),
  };
}

export function probeOtherSignals(
  page: ParseRawPageArtifact,
  table: TableProbeResult,
): OtherPageSignals {
  const texts = visibleTextObjects(page);
  const images = page.objects.filter((object) => object.kind === 'image');
  const graphics = page.objects.filter((object) => object.kind === 'graphic');
  const pageArea = Math.max(0, page.width * page.height);
  const imageArea = unionArea(images.map((image) => clipBbox(image.bbox, page.width, page.height)));
  const textArea = unionArea(texts.map((text) => clipBbox(text.bbox, page.width, page.height)));
  const imageAreaRatio = pageArea === 0 ? 0 : imageArea / pageArea;
  const textDensity = pageArea === 0 ? 0 : textArea / pageArea;
  const overlaidTexts = texts.filter((text) => {
    const textObjectArea = bboxArea(text.bbox);
    if (textObjectArea === 0) return false;
    const intersections = images
      .map((image) => intersectBbox(text.bbox, image.bbox))
      .filter((bbox): bbox is Bbox => bbox !== null);
    return unionArea(intersections) / textObjectArea >= IMAGE_TEXT_OVERLAP_SHARE;
  });
  const squareInches = pageArea / (POINTS_PER_INCH * POINTS_PER_INCH);
  const vectorDensity = squareInches === 0 ? 0 : graphics.length / squareInches;
  const mathCharacters = texts.reduce(
    (total, text) => total + (text.text.match(/[\p{Sm}∑∫√≈≤≥±×÷∞]/gu) ?? []).length,
    0,
  );
  const hasFormula = mathCharacters >= FORMULA_MIN_MATH_CHARACTERS
    || texts.some((text) => /(?:math|symbol|cmmi|cmsy|rtx)/iu.test(text.fontName));
  const numericTokens = texts.flatMap((text) => text.text.match(/[-+]?\d+(?:[.,]\d+)?/gu) ?? []);
  const meanTextLength = texts.length === 0
    ? 0
    : mean(texts.map((text) => [...text.text].length));
  const hasChart = !table.hasTable
    && graphics.length >= CHART_MIN_VECTOR_OBJECTS
    && meanTextLength <= CHART_MAX_MEAN_TEXT_LENGTH
    && numericTokens.length >= CHART_MIN_NUMERIC_TOKENS;
  return {
    rotation: page.rotation,
    hasImage: images.length > 0,
    imageAreaRatio: round(imageAreaRatio),
    // parse_raw 尚不携带像素宽高；null 明示“无法从现有源对象计算”，不能拿猜值冒充 PPI。
    scanEffectivePpi: null,
    hasLowResolutionScan: false,
    vectorDensity: round(vectorDensity),
    hasOverlaidTextOnImage: overlaidTexts.length > 0,
    hasMixedTextImage: texts.length > 0
      && images.length > 0
      && imageAreaRatio >= MIXED_TEXT_IMAGE_MIN_IMAGE_SHARE,
    hasFormula,
    hasChart,
    hasRotatedText: texts.some(isRotatedText),
    textDensity: round(textDensity),
  };
}

export function pageLayoutType(
  columns: ColumnProbeResult,
  table: TableProbeResult,
  signals: OtherPageSignals,
): PageProbeSummary['layoutType'] {
  if (signals.imageAreaRatio >= SCANNED_PAGE_IMAGE_SHARE
    && signals.textDensity < SCANNED_PAGE_MAX_TEXT_DENSITY) return 'scanned';
  if (columns.columns > 1 && table.hasTable) return 'mixed';
  if (table.hasTable) return 'table_heavy';
  if (columns.columns === 2) return 'two_column';
  return columns.columns > 2 ? 'mixed' : 'single_column';
}

export function structuralUncertainty(
  textVerdict: PageProbeSummary['textLayerVerdict'],
  columns: ColumnProbeResult,
  table: TableProbeResult,
  signals: OtherPageSignals,
): number {
  if (textVerdict === 'broken' || textVerdict === 'absent') return 1;
  const contributions = [
    textVerdict === 'partial' ? PROBE_PARTIAL_TEXT_UNCERTAINTY : 0,
    columns.columns > 1 ? 1 - columns.columnStability : 0,
    table.hasTable ? 1 - table.tableConfidence : 0,
    signals.hasOverlaidTextOnImage ? PROBE_OVERLAID_TEXT_UNCERTAINTY : 0,
  ];
  return round(Math.max(...contributions));
}

export function riskLevel(uncertainty: number): PageProbeSummary['riskLevel'] {
  if (uncertainty >= PROBE_HIGH_UNCERTAINTY) return 'high';
  if (uncertainty >= PROBE_MEDIUM_UNCERTAINTY) return 'medium';
  return 'low';
}

function analyzeColumns(
  pageWidth: number,
  texts: readonly TextObject[],
  thresholdFactor: number,
): { columns: number; gutters: Gutter[] } {
  const occupancy = Array.from({ length: COLUMN_PROJECTION_BINS }, () => 0);
  const binWidth = pageWidth / COLUMN_PROJECTION_BINS;
  for (const text of texts) {
    const start = clampInteger(Math.floor(text.bbox[0] / binWidth), 0, occupancy.length - 1);
    const end = clampInteger(Math.floor(text.bbox[2] / binWidth), 0, occupancy.length - 1);
    const height = Math.max(0, text.bbox[3] - text.bbox[1]);
    for (let bin = start; bin <= end; bin += 1) occupancy[bin] += height;
  }
  const maximum = Math.max(...occupancy);
  if (maximum === 0) return { columns: 1, gutters: [] };
  const threshold = maximum * COLUMN_GUTTER_MAX_OCCUPANCY_SHARE * thresholdFactor;
  const searchStart = Math.floor(occupancy.length * COLUMN_GUTTER_SEARCH_MIN_SHARE);
  const searchEnd = Math.ceil(occupancy.length * COLUMN_GUTTER_SEARCH_MAX_SHARE);
  const runs: Array<[number, number]> = [];
  let runStart: number | null = null;
  for (let bin = searchStart; bin < searchEnd; bin += 1) {
    if (occupancy[bin] <= threshold) {
      if (runStart === null) runStart = bin;
    } else if (runStart !== null) {
      runs.push([runStart, bin]);
      runStart = null;
    }
  }
  if (runStart !== null) runs.push([runStart, searchEnd]);
  const totalCharacters = texts.reduce((total, text) => total + visibleLength(text.text), 0);
  const candidates = runs.map(([start, end]): Gutter => {
    const x0 = start * binWidth;
    const x1 = end * binWidth;
    const crossing = texts.filter((text) => text.bbox[0] < x1 && text.bbox[2] > x0).length;
    return { x0, x1, width: x1 - x0, purity: 1 - crossing / texts.length };
  }).filter((gutter) => {
    const leftCharacters = texts
      .filter((text) => center(text.bbox)[0] < gutter.x0)
      .reduce((total, text) => total + visibleLength(text.text), 0);
    const rightCharacters = texts
      .filter((text) => center(text.bbox)[0] > gutter.x1)
      .reduce((total, text) => total + visibleLength(text.text), 0);
    return gutter.width >= COLUMN_GUTTER_MIN_WIDTH_PT
      && gutter.width <= pageWidth * COLUMN_GUTTER_MAX_WIDTH_SHARE
      && gutter.purity >= COLUMN_MIN_GUTTER_PURITY
      && leftCharacters / totalCharacters >= COLUMN_MIN_SIDE_CHARACTER_SHARE
      && rightCharacters / totalCharacters >= COLUMN_MIN_SIDE_CHARACTER_SHARE;
  });
  const selected = candidates
    .sort((left, right) => left.x0 - right.x0)
    .slice(0, COLUMN_MAX_COLUMNS - 1);
  return { columns: selected.length + 1, gutters: selected };
}

function probeBorderlessTable(texts: readonly TextObject[]): {
  rows: number;
  columns: number;
  rowConsistency: number;
  columnSupport: number;
  alignmentEntropy: number;
  sourceObjectIds: SourceObjectId[];
} {
  const rows: TextObject[][] = [];
  for (const text of [...texts].sort((left, right) => baseline(left) - baseline(right))) {
    const existing = rows.at(-1);
    if (existing !== undefined
      && Math.abs(mean(existing.map(baseline)) - baseline(text)) <= TABLE_ROW_BASELINE_TOLERANCE_PT) {
      existing.push(text);
    } else {
      rows.push([text]);
    }
  }
  const cellsByRow = rows.map((row) => mergeRowCells(row));
  const modalColumns = mode(cellsByRow.map((cells) => cells.length));
  const supportedRows = cellsByRow.filter((cells) => cells.length === modalColumns);
  const rowConsistency = rows.length === 0 ? 0 : supportedRows.length / rows.length;
  if (modalColumns < BORDERLESS_TABLE_MIN_COLUMNS || supportedRows.length === 0) {
    return {
      rows: supportedRows.length,
      columns: modalColumns,
      rowConsistency,
      columnSupport: 0,
      alignmentEntropy: 1,
      sourceObjectIds: [],
    };
  }
  const positions = Array.from({ length: modalColumns }, (_, column) =>
    supportedRows.map((cells) => cells[column].bbox[0])
  );
  const medians = positions.map(median);
  const supports = positions.map((columnPositions, column) =>
    columnPositions.filter((position) =>
      Math.abs(position - medians[column]) <= BORDERLESS_TABLE_ALIGNMENT_TOLERANCE_PT
    ).length / columnPositions.length
  );
  const entropy = mean(positions.map((columnPositions, column) => {
    const deviations = columnPositions.map((position) => Math.abs(position - medians[column]));
    return clamp(mean(deviations) / BORDERLESS_TABLE_ALIGNMENT_TOLERANCE_PT);
  }));
  return {
    rows: supportedRows.length,
    columns: modalColumns,
    rowConsistency,
    columnSupport: mean(supports),
    alignmentEntropy: entropy,
    sourceObjectIds: supportedRows.flatMap((cells) => cells.flatMap((cell) => cell.ids)),
  };
}

function mergeRowCells(row: readonly TextObject[]): Array<{ bbox: Bbox; ids: SourceObjectId[] }> {
  const cells: Array<{ bbox: Bbox; ids: SourceObjectId[] }> = [];
  for (const text of [...row].sort((left, right) => left.bbox[0] - right.bbox[0])) {
    const previous = cells.at(-1);
    if (previous !== undefined && text.bbox[0] - previous.bbox[2] <= TABLE_CELL_GAP_PT) {
      previous.bbox = unionBbox(previous.bbox, text.bbox);
      previous.ids.push(text.id);
    } else {
      cells.push({ bbox: [...text.bbox], ids: [text.id] });
    }
  }
  return cells;
}

function axisRulesFromGraphic(graphic: GraphicObject): AxisRule[] {
  const [x0, y0, x1, y1] = graphic.bbox;
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  if (longSide < RULE_MIN_LENGTH_PT
    || shortSide > RULE_MAX_THICKNESS_PT
    || (shortSide > 0 && longSide / shortSide < RULE_MIN_ASPECT_RATIO)) return [];
  if (width >= height) {
    return [{
      orientation: 'h',
      axis: (y0 + y1) / 2,
      start: x0,
      end: x1,
      sourceObjectIds: [graphic.id],
    }];
  }
  return [{
    orientation: 'v',
    axis: (x0 + x1) / 2,
    start: y0,
    end: y1,
    sourceObjectIds: [graphic.id],
  }];
}

function mergeRules(rules: readonly AxisRule[]): AxisRule[] {
  const merged: AxisRule[] = [];
  for (const rule of [...rules].sort((left, right) =>
    left.orientation.localeCompare(right.orientation)
    || left.axis - right.axis
    || left.start - right.start
  )) {
    const previous = merged.at(-1);
    if (previous !== undefined
      && previous.orientation === rule.orientation
      && Math.abs(previous.axis - rule.axis) <= RULE_CLUSTER_TOLERANCE_PT
      && rule.start <= previous.end + RULE_CLUSTER_TOLERANCE_PT) {
      previous.axis = (previous.axis + rule.axis) / 2;
      previous.start = Math.min(previous.start, rule.start);
      previous.end = Math.max(previous.end, rule.end);
      previous.sourceObjectIds.push(...rule.sourceObjectIds);
    } else {
      merged.push({ ...rule, sourceObjectIds: [...rule.sourceObjectIds] });
    }
  }
  return merged;
}

function rulesIntersect(horizontal: AxisRule, vertical: AxisRule): boolean {
  return vertical.axis >= horizontal.start - RULE_INTERSECTION_TOLERANCE_PT
    && vertical.axis <= horizontal.end + RULE_INTERSECTION_TOLERANCE_PT
    && horizontal.axis >= vertical.start - RULE_INTERSECTION_TOLERANCE_PT
    && horizontal.axis <= vertical.end + RULE_INTERSECTION_TOLERANCE_PT;
}

function boundsForRules(rules: readonly AxisRule[]): Bbox {
  const xs = rules.flatMap((rule) => rule.orientation === 'h'
    ? [rule.start, rule.end]
    : [rule.axis]);
  const ys = rules.flatMap((rule) => rule.orientation === 'v'
    ? [rule.start, rule.end]
    : [rule.axis]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function visibleTextObjects(page: ParseRawPageArtifact): TextObject[] {
  return page.objects.filter((object): object is TextObject =>
    object.kind === 'text' && visibleLength(object.text) > 0 && bboxArea(object.bbox) > 0
  );
}

function isRotatedText(text: TextObject): boolean {
  const [a, b] = text.transform;
  const angle = Math.abs(Math.atan2(b, a) * 180 / Math.PI);
  const normalized = Math.min(angle, Math.abs(180 - angle));
  return normalized >= ROTATED_TEXT_MIN_DEGREES;
}

function baseline(text: TextObject): number {
  return text.bbox[3];
}

function center(bbox: Bbox): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function pointInBbox(point: readonly [number, number], bbox: Bbox): boolean {
  return point[0] >= bbox[0] && point[0] <= bbox[2]
    && point[1] >= bbox[1] && point[1] <= bbox[3];
}

function bboxArea(bbox: Bbox): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function clipBbox(bbox: Bbox, width: number, height: number): Bbox {
  return [
    clampRange(bbox[0], 0, width),
    clampRange(bbox[1], 0, height),
    clampRange(bbox[2], 0, width),
    clampRange(bbox[3], 0, height),
  ];
}

function intersectBbox(left: Bbox, right: Bbox): Bbox | null {
  const intersection: Bbox = [
    Math.max(left[0], right[0]),
    Math.max(left[1], right[1]),
    Math.min(left[2], right[2]),
    Math.min(left[3], right[3]),
  ];
  return bboxArea(intersection) > 0 ? intersection : null;
}

function unionBbox(left: Bbox, right: Bbox): Bbox {
  return [
    Math.min(left[0], right[0]),
    Math.min(left[1], right[1]),
    Math.max(left[2], right[2]),
    Math.max(left[3], right[3]),
  ];
}

/** 扫描 x slab 算矩形并集，图片/文字重叠时不重复累计面积。 */
function unionArea(input: readonly Bbox[]): number {
  const boxes = input.filter((bbox) => bboxArea(bbox) > 0);
  const xs = [...new Set(boxes.flatMap((bbox) => [bbox[0], bbox[2]]))].sort((a, b) => a - b);
  let area = 0;
  for (let index = 0; index + 1 < xs.length; index += 1) {
    const x0 = xs[index];
    const x1 = xs[index + 1];
    const intervals = boxes
      .filter((bbox) => bbox[0] < x1 && bbox[2] > x0)
      .map((bbox) => [bbox[1], bbox[3]] as [number, number])
      .sort((left, right) => left[0] - right[0]);
    let coveredY = 0;
    let current: [number, number] | null = null;
    for (const interval of intervals) {
      if (current === null) current = [...interval];
      else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
      else {
        coveredY += current[1] - current[0];
        current = [...interval];
      }
    }
    if (current !== null) coveredY += current[1] - current[0];
    area += (x1 - x0) * coveredY;
  }
  return area;
}

function mode(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0] ?? 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function visibleLength(text: string): number {
  return [...text].filter((character) => !/\s/u.test(character)).length;
}

function clamp(value: number): number {
  return clampRange(value, 0, 1);
}

function clampRange(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.trunc(clampRange(value, minimum, maximum));
}

function round(value: number): number {
  const scale = 10 ** PROBE_AREA_DECIMAL_PLACES;
  return Math.round(value * scale) / scale;
}
