import type { RawSourceObject } from '../../../schema/artifacts.ts';
import type { Bbox, SourceObjectId, TableInfo } from '../../../schema/element.ts';
import type { Warning } from '../../../schema/warnings.ts';
import {
  TABLE_BORDERLESS_LINE_TOLERANCE_RATIO,
  TABLE_LABEL_LINE_GAP_RATIO,
  TABLE_LABEL_MAX_GAP_RATIO,
  TABLE_LABEL_MAX_LINES,
  TABLE_NEARBY_LABEL,
} from '../../params/table.ts';
import { detectLabeledBorderlessTables } from './borderless.ts';
import { tableInfoFromGrid } from './cells.ts';
import { detectRuledGrids, type RuledGrid } from './grid.ts';

type TextObject = Extract<RawSourceObject, { kind: 'text' }>;

export interface DetectedTable {
  page: number;
  bbox: Bbox;
  sourceObjectIds: SourceObjectId[];
  ruleSourceObjectIds: SourceObjectId[];
  textSourceObjectIds: SourceObjectId[];
  labelTextObjects: TextObject[];
  confidence: number;
  table: TableInfo;
}

export interface TableDetectionResult {
  tables: DetectedTable[];
  warnings: Warning[];
}

/** 完整的 ruled 通路出口：矢量线 → 横竖线 → 连通网格 → cells。 */
export function detectTables(objects: readonly RawSourceObject[]): DetectedTable[] {
  return detectTablesWithWarnings(objects).tables;
}

export function detectTablesWithWarnings(objects: readonly RawSourceObject[]): TableDetectionResult {
  const warnings: Warning[] = [];
  const ruledTables = detectRuledGrids(objects).flatMap((grid) => {
    const table = tableInfoFromGrid(grid);
    if (table !== null) return [detectedTable(grid, table, objects)];
    warnings.push({
      code: 'TABLE_GRID_UNCLOSED',
      severity: 'warn',
      scope: 'page',
      page: grid.page,
      message: '闭合网格的合并区域不是矩形，已显式降级为未分类矢量内容',
      detail: { sourceObjectIds: grid.ruleSourceObjectIds },
    });
    return [];
  });
  const ruledSourceIds = new Set(ruledTables.flatMap((table) => table.sourceObjectIds));
  const borderless = detectLabeledBorderlessTables(
    objects.filter((object) => !ruledSourceIds.has(object.id)),
  );
  // 排除源对象还不够：无框线通路拿到的是"剩下的字"，它可以从有框线表的题注上方起步，
  // 一路把表两侧的正文围成一片区域，形状证据在正文密集的版面上并不难凑齐。
  // 同一块版面不可能既是无框线表又是有框线表，而画出来的线是比推断出来的列锚更硬的
  // 证据——重叠时判给 ruled，并按"证据不闭合"记账。
  const overlapping = borderless.tables.filter((candidate) => ruledTables.some((ruled) =>
    ruled.page === candidate.page && bboxesOverlap(ruled.bbox, candidate.bbox)));
  for (const candidate of overlapping) {
    warnings.push({
      code: 'TABLE_GRID_UNCLOSED',
      severity: 'warn',
      scope: 'page',
      page: candidate.page,
      message: '无框线表候选与同页有框线表区域重叠，已判给有框线表并保留为未分类文字',
    });
  }
  borderless.tables = borderless.tables.filter((candidate) => !overlapping.includes(candidate));
  for (const page of borderless.rejectedLabelPages) {
    warnings.push({
      code: 'TABLE_GRID_UNCLOSED',
      severity: 'warn',
      scope: 'page',
      page,
      message: '检测到显式表编号，但列锚或行序证据不闭合，已保留为未分类文字',
    });
  }
  const tables = [...ruledTables, ...borderless.tables].sort((left, right) =>
    left.page - right.page || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
  return { tables, warnings };
}

/** assemble 对一个 table region 复算产品载荷，避免把 Element 字段塞进 layout 工件。 */
export function tableForRegion(objects: readonly RawSourceObject[]): DetectedTable {
  const tables = detectTables(objects);
  if (tables.length !== 1) {
    throw new TypeError(`table region 必须且只能恢复一个闭合网格，实际 ${tables.length} 个`);
  }
  return tables[0];
}

function detectedTable(
  grid: RuledGrid,
  table: TableInfo,
  objects: readonly RawSourceObject[],
): DetectedTable {
  const labelTextObjects = nearbyLabelTextObjects(grid, objects);
  const textSourceObjectIds = [
    ...labelTextObjects.map((object) => object.id),
    ...grid.textObjects.map((object) => object.id),
  ];
  const sourceObjectIds = [...new Set([
    ...grid.ruleSourceObjectIds,
    ...textSourceObjectIds,
  ])].sort(compareText);
  return {
    page: grid.page,
    bbox: labelTextObjects.length === 0
      ? grid.bbox
      : unionBboxes([grid.bbox, ...labelTextObjects.filter(hasInk).map((object) => object.bbox)]),
    sourceObjectIds,
    ruleSourceObjectIds: [...grid.ruleSourceObjectIds],
    textSourceObjectIds,
    labelTextObjects,
    confidence: Math.min((grid.gridClosure + grid.cellTextHitRate) / 2, 0.99),
    table,
  };
}

function nearbyLabelTextObjects(
  grid: RuledGrid,
  objects: readonly RawSourceObject[],
): TextObject[] {
  const gridTextIds = new Set(grid.textObjects.map((object) => object.id));
  const candidates = objects.filter((object): object is TextObject =>
    object.kind === 'text'
    && object.page === grid.page
    && object.text.length > 0
    && !gridTextIds.has(object.id)
    && object.bbox[3] <= grid.bbox[1]
    && object.bbox[2] > grid.bbox[0]
    && object.bbox[0] < grid.bbox[2]);
  const lines = clusterLabelLines(candidates).sort((left, right) => right.bottom - left.bottom);
  const selected: Array<{ top: number; bottom: number; fontSize: number; objects: TextObject[] }> = [];
  let labelled = false;
  for (const line of lines) {
    if (labelled || selected.length >= TABLE_LABEL_MAX_LINES) break;
    const lowerBoundary = selected.length === 0 ? grid.bbox[1] : selected[selected.length - 1].top;
    const gap = lowerBoundary - line.bottom;
    const limit = (selected.length === 0 ? TABLE_LABEL_MAX_GAP_RATIO : TABLE_LABEL_LINE_GAP_RATIO)
      * line.fontSize;
    if (gap > limit) break;
    selected.push(line);
    // ★ 表编号是一条排版行的开头，不是某一个 run 的开头：PDF 会把 `表 1 标题` 切成
    //   `表` / ` ` / `1` / `标题` 若干 run，逐 run 匹配时没有任何一个 run 以完整编号
    //   开头，于是有框线表认不出自己的题注，题注反过来成了无框线表通路的入口，
    //   把整段正文吞成一张假表。判据因此下沉到"行"这一层。
    //   编号行同时是题注块的封顶：中文期刊把编号与标题写在同一行（向上一行就是正文），
    //   英文期刊把 `TABLE I` 单独写在标题行之上——两种版式下编号都是最上面那一行。
    labelled = TABLE_NEARBY_LABEL.test(lineText(line.objects));
  }
  if (!labelled) return [];
  const selectedIds = new Set(selected.flatMap((line) => line.objects.map((object) => object.id)));
  return candidates.filter((object) => selectedIds.has(object.id)).sort((left, right) =>
    left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0] || left.id.localeCompare(right.id));
}

/** 一条排版行的原文：按左边界拼回 run，供表编号这类"行首"判据使用。 */
function lineText(objects: readonly TextObject[]): string {
  return [...objects]
    .sort((left, right) => left.bbox[0] - right.bbox[0] || left.id.localeCompare(right.id))
    .map((object) => object.text)
    .join('')
    .trim();
}

function clusterLabelLines(
  objects: readonly TextObject[],
): Array<{ top: number; bottom: number; fontSize: number; objects: TextObject[] }> {
  const lines: Array<{ top: number; bottom: number; fontSize: number; objects: TextObject[] }> = [];
  for (const object of [...objects].sort((left, right) => left.bbox[1] - right.bbox[1])) {
    const line = lines.find((candidate) => Math.abs(candidate.top - object.bbox[1])
      <= TABLE_BORDERLESS_LINE_TOLERANCE_RATIO * Math.max(candidate.fontSize, object.fontSize));
    if (line === undefined) {
      lines.push({
        top: object.bbox[1],
        bottom: object.bbox[3],
        fontSize: object.fontSize,
        objects: [object],
      });
    } else {
      line.bottom = Math.max(line.bottom, object.bbox[3]);
      line.fontSize = Math.max(line.fontSize, object.fontSize);
      line.objects.push(object);
    }
  }
  return lines;
}

function bboxesOverlap(left: Bbox, right: Bbox): boolean {
  return Math.min(left[2], right[2]) > Math.max(left[0], right[0])
    && Math.min(left[3], right[3]) > Math.max(left[1], right[1]);
}

function unionBboxes(bboxes: readonly Bbox[]): Bbox {
  return [
    Math.min(...bboxes.map((bbox) => bbox[0])),
    Math.min(...bboxes.map((bbox) => bbox[1])),
    Math.max(...bboxes.map((bbox) => bbox[2])),
    Math.max(...bboxes.map((bbox) => bbox[3])),
  ];
}

function hasInk(object: TextObject): boolean {
  return object.text.trim().length > 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
