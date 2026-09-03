import type { RawSourceObject } from '../../../schema/artifacts.ts';
import type { Bbox, SourceObjectId, TableCell, TableInfo } from '../../../schema/element.ts';
import {
  BORDERLESS_TABLE_LABEL,
  TABLE_BORDERLESS_COLUMN_ANCHOR_TOLERANCE_RATIO,
  TABLE_BORDERLESS_COLUMN_SNAP_RATIO,
  TABLE_BORDERLESS_CONFIDENCE,
  TABLE_BORDERLESS_LABEL_RUN_GAP_RATIO,
  TABLE_BORDERLESS_LINE_TOLERANCE_RATIO,
  TABLE_BORDERLESS_MAX_LINE_STEP_RATIO,
  TABLE_BORDERLESS_MIN_ANCHOR_REPETITIONS,
  TABLE_BORDERLESS_MIN_COLUMN_GAP_RATIO,
  TABLE_BORDERLESS_MISSING_HEADER_GAP_RATIO,
  TABLE_GRID_MIN_COLS,
  TABLE_GRID_MIN_ROWS,
} from '../../params/table.ts';
import { textForTableCellObjects } from './cells.ts';
import type { DetectedTable } from './index.ts';

type TextObject = Extract<RawSourceObject, { kind: 'text' }>;

interface TextLine {
  top: number;
  bottom: number;
  fontSize: number;
  objects: TextObject[];
}

interface LaneBounds {
  left: number;
  right: number;
}

/** 表编号锚点及其所在题注的横向范围；定栏用范围，判编号用文本。 */
interface LabelRun {
  text: string;
  left: number;
  right: number;
}

interface RowDraft {
  cells: TextObject[][];
  top: number;
  bottom: number;
}

export interface BorderlessTableDetection {
  tables: DetectedTable[];
  rejectedLabelPages: number[];
}

/**
 * 显式 TABLE 编号给出“这里确实是一张表”的语义证据；重复列锚和单调行序只负责恢复形状。
 * 任一证据不闭合就拒绝，不能把普通对齐文本静默猜成表。
 */
export function detectLabeledBorderlessTables(
  objects: readonly RawSourceObject[],
): BorderlessTableDetection {
  const texts = objects.filter((object): object is TextObject =>
    object.kind === 'text' && object.text.length > 0);
  const ink = texts.filter(hasInk);
  const labels = ink
    .filter((object) => startsTypesetLine(object, ink))
    .map((object) => ({ object, run: labelRun(object, ink) }))
    .filter(({ run }) => BORDERLESS_TABLE_LABEL.test(run.text));
  const tables: DetectedTable[] = [];
  const rejectedLabelPages: number[] = [];

  for (const { object, run } of labels) {
    const table = tableFromLabel(object, run, texts, ink);
    if (table === null) rejectedLabelPages.push(object.page);
    else if (!tables.some((candidate) => overlapsSources(candidate, table))) tables.push(table);
  }

  return {
    tables: tables.sort((left, right) => left.page - right.page
      || left.bbox[1] - right.bbox[1]
      || left.bbox[0] - right.bbox[0]),
    rejectedLabelPages,
  };
}

/**
 * PDF 的文本 run 切分是任意的：中文期刊常把 `表` 与编号拆成两个对象，英文的
 * `TABLE I` 通常落在一个对象里。编号只有把同基线的紧邻 run 拼起来才稳定可见，
 * 因此从当前对象向右按间隙拼接。返回的横向范围是整条题注的范围，而不是锚点字形
 * 的范围——单个 `表` 字恰好落在页心附近时会被误判成通栏，题注整体不会。
 * 栏间距远大于该间隙，拼接不会跨栏。
 */
/**
 * 表编号是排版行的行首事实。`……如表 1 所示：` 里的 `表` 向右拼出来同样是
 * `表 1 …`，只有"左边紧挨着字"能把正文里的交叉引用与真正的题注分开。
 * 判据与向右拼接用同一个间隙量纲，因此天然不跨栏：栏间距远大于字距，
 * 右栏行首左边的左栏文字不会被当成同一行的前缀。
 */
function startsTypesetLine(object: TextObject, ink: readonly TextObject[]): boolean {
  return !ink.some((candidate) => {
    if (candidate.id === object.id || candidate.page !== object.page) return false;
    if (candidate.bbox[0] >= object.bbox[0]) return false;
    const em = Math.max(candidate.fontSize, object.fontSize);
    if (Math.abs(candidate.bbox[1] - object.bbox[1])
      > TABLE_BORDERLESS_LINE_TOLERANCE_RATIO * em) return false;
    return object.bbox[0] - candidate.bbox[2] <= TABLE_BORDERLESS_LABEL_RUN_GAP_RATIO * em;
  });
}

function labelRun(object: TextObject, ink: readonly TextObject[]): LabelRun {
  const sameBaseline = ink
    .filter((candidate) => candidate.page === object.page
      && candidate.bbox[0] >= object.bbox[0]
      && Math.abs(candidate.bbox[1] - object.bbox[1])
        <= TABLE_BORDERLESS_LINE_TOLERANCE_RATIO * Math.max(candidate.fontSize, object.fontSize))
    .sort((left, right) => left.bbox[0] - right.bbox[0]);
  let text = '';
  let right = object.bbox[2];
  for (const candidate of sameBaseline) {
    if (candidate.bbox[0] - right
      > TABLE_BORDERLESS_LABEL_RUN_GAP_RATIO * candidate.fontSize) break;
    text = text === '' ? candidate.text.trim() : `${text} ${candidate.text.trim()}`;
    right = Math.max(right, candidate.bbox[2]);
  }
  return { text, left: object.bbox[0], right };
}

function tableFromLabel(
  label: TextObject,
  run: LabelRun,
  pageTexts: readonly TextObject[],
  pageInk: readonly TextObject[],
): DetectedTable | null {
  const samePageInk = pageInk.filter((object) => object.page === label.page);
  if (samePageInk.length === 0) return null;
  const lane = laneBounds(run, samePageInk);
  const laneTexts = pageTexts.filter((object) => object.page === label.page && inLane(object, lane));
  const lines = clusterLines(laneTexts.filter(hasInk));
  const labelLineIndex = lines.findIndex((line) => line.objects.some((object) => object.id === label.id));
  if (labelLineIndex < 0) return null;

  const headerLineIndex = findHeaderLine(lines, labelLineIndex);
  if (headerLineIndex < 0) return null;
  const headerLine = lines[headerLineIndex];
  const tableLines = collectTableLines(lines, headerLineIndex);
  if (tableLines.length < TABLE_GRID_MIN_ROWS + 1) return null;
  const dataLines = tableLines.slice(1);
  const referenceSize = median(tableLines.map((line) => line.fontSize));
  const headerAnchors = distinctAnchors(
    headerLine.objects.filter(hasInk).map((object) => object.bbox[0]),
    referenceSize,
  );
  if (headerAnchors.length < TABLE_GRID_MIN_COLS) return null;
  const anchors = addMissingLeadingAnchor(headerAnchors, dataLines, referenceSize);
  if (!validColumnAnchors(anchors, referenceSize)) return null;

  const rowDrafts = rowsFromSourceOrder(laneTexts, dataLines, anchors, referenceSize);
  if (rowDrafts.length < TABLE_GRID_MIN_ROWS) return null;
  const headerDraft = rowFromLine(laneTexts, headerLine, anchors, referenceSize);
  if (headerDraft === null || !rowsAreMonotonic([headerDraft, ...rowDrafts])) return null;

  const table = tableInfo([headerDraft, ...rowDrafts], anchors, label.page);
  const captionLines = lines.slice(labelLineIndex, headerLineIndex);
  const captionObjects = objectsOnLines(laneTexts, captionLines);
  const tableObjects = uniqueObjects([
    ...captionObjects,
    ...objectsOnLines(laneTexts, tableLines),
  ]);
  const tableInk = tableObjects.filter(hasInk);
  if (tableInk.length === 0) return null;
  const bbox = unionBboxes(tableInk.map((object) => object.bbox));
  const textSourceObjectIds = tableObjects.map((object) => object.id);

  return {
    page: label.page,
    bbox,
    sourceObjectIds: [...textSourceObjectIds],
    ruleSourceObjectIds: [],
    textSourceObjectIds,
    labelTextObjects: captionObjects,
    confidence: TABLE_BORDERLESS_CONFIDENCE,
    table,
  };
}

function laneBounds(run: LabelRun, ink: readonly TextObject[]): LaneBounds {
  const left = Math.min(...ink.map((object) => object.bbox[0]));
  const right = Math.max(...ink.map((object) => object.bbox[2]));
  const center = (left + right) / 2;
  // 按题注的横向范围而不是中点归栏：双栏版面右栏左边界常常紧贴页心，中点法会把
  // 整条右栏题注误判成通栏，进而把左栏正文一起吸进表里。横跨中线才是通栏题注，
  // 这一判据不留容差——容差会把明显偏左的通栏题注推给右栏，反而砍掉最左一列。
  if (run.left >= center) return { left: center, right };
  if (run.right <= center) return { left, right: center };
  return { left, right };
}

function findHeaderLine(lines: readonly TextLine[], labelIndex: number): number {
  // 编号后允许一至两行标题；第一个具有至少两列左边界的行才是表头。
  for (let index = labelIndex + 1; index <= Math.min(lines.length - 1, labelIndex + 3); index += 1) {
    const line = lines[index];
    const anchors = distinctAnchors(
      line.objects.filter(hasInk).map((object) => object.bbox[0]),
      line.fontSize,
    );
    if (anchors.length >= TABLE_GRID_MIN_COLS) return index;
  }
  return -1;
}

function collectTableLines(lines: readonly TextLine[], headerIndex: number): TextLine[] {
  const selected = [lines[headerIndex]];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const previous = selected[selected.length - 1];
    const next = lines[index];
    const referenceSize = Math.max(previous.fontSize, next.fontSize);
    if (next.top - previous.top > TABLE_BORDERLESS_MAX_LINE_STEP_RATIO * referenceSize) break;
    selected.push(next);
  }
  return selected;
}

function addMissingLeadingAnchor(
  headerAnchors: readonly number[],
  dataLines: readonly TextLine[],
  fontSize: number,
): number[] {
  const clusters = clusterNumbers(
    dataLines.flatMap((line) => line.objects.filter(hasInk).map((object) => object.bbox[0])),
    TABLE_BORDERLESS_COLUMN_ANCHOR_TOLERANCE_RATIO * fontSize,
  );
  const leading = clusters
    .filter((cluster) => cluster.values.length >= TABLE_BORDERLESS_MIN_ANCHOR_REPETITIONS)
    .map(clusterCenter)
    .filter((value) => value < headerAnchors[0] - TABLE_BORDERLESS_MISSING_HEADER_GAP_RATIO * fontSize)
    .sort((left, right) => right - left)[0];
  return leading === undefined ? [...headerAnchors] : [leading, ...headerAnchors];
}

function rowsFromSourceOrder(
  laneTexts: readonly TextObject[],
  dataLines: readonly TextLine[],
  anchors: readonly number[],
  fontSize: number,
): RowDraft[] {
  const selectedIds = new Set(objectsOnLines(laneTexts, dataLines).map((object) => object.id));
  const rows: TextObject[][][] = [];
  let current: TextObject[][] | undefined;
  for (const object of laneTexts) {
    if (!selectedIds.has(object.id)) continue;
    const column = columnFor(object, anchors, fontSize);
    if (column < 0) continue;
    if (current === undefined || (column === 0 && higherColumnHasInk(current))) {
      current = Array.from({ length: anchors.length }, () => []);
      rows.push(current);
    }
    current[column].push(object);
  }
  const drafts = rows.map((cells) => rowDraft(cells)).filter((row): row is RowDraft => row !== null);
  return drafts.length === rows.length ? drafts : [];
}

function rowFromLine(
  laneTexts: readonly TextObject[],
  line: TextLine,
  anchors: readonly number[],
  fontSize: number,
): RowDraft | null {
  const cells = Array.from({ length: anchors.length }, () => [] as TextObject[]);
  for (const object of objectsOnLines(laneTexts, [line])) {
    const column = columnFor(object, anchors, fontSize);
    if (column >= 0) cells[column].push(object);
  }
  return rowDraft(cells, false);
}

function rowDraft(cells: TextObject[][], requireFirstColumn = true): RowDraft | null {
  if ((requireFirstColumn && !cells[0].some(hasInk))
    || !cells.slice(1).some((cell) => cell.some(hasInk))) return null;
  const ink = cells.flat().filter(hasInk);
  if (ink.length === 0) return null;
  return {
    cells,
    top: Math.min(...ink.map((object) => object.bbox[1])),
    bottom: Math.max(...ink.map((object) => object.bbox[3])),
  };
}

function tableInfo(rows: readonly RowDraft[], anchors: readonly number[], page: number): TableInfo {
  const lastX = Math.max(
    anchors[anchors.length - 1] + 1,
    ...rows.flatMap((row) => row.cells.flat().filter(hasInk).map((object) => object.bbox[2])),
  );
  const cells: TableCell[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const bottom = r + 1 < rows.length ? Math.max(row.bottom, rows[r + 1].top) : row.bottom;
    for (let c = 0; c < anchors.length; c += 1) {
      const objects = row.cells[c];
      const bbox: Bbox = [anchors[c], row.top, c + 1 < anchors.length ? anchors[c + 1] : lastX, bottom];
      cells.push({
        r,
        c,
        rowSpan: 1,
        colSpan: 1,
        text: textForTableCellObjects(objects),
        bbox,
        isHeader: r === 0 || (r > 0 && c === 0),
        role: r === 0 ? 'column_header' : c === 0 ? 'row_header' : 'data',
        page,
        confidence: TABLE_BORDERLESS_CONFIDENCE,
        ...(objects.length === 0 ? {} : { sourceObjectIds: objects.map((object) => object.id) }),
      });
    }
  }
  return {
    rows: rows.length,
    cols: anchors.length,
    headerRows: 1,
    headerCols: 1,
    kind: 'borderless',
    crossPage: false,
    cells,
  };
}

function columnFor(object: TextObject, anchors: readonly number[], fontSize: number): number {
  const snap = TABLE_BORDERLESS_COLUMN_SNAP_RATIO * fontSize;
  let column = -1;
  for (let index = 0; index < anchors.length; index += 1) {
    if (object.bbox[0] >= anchors[index] - snap) column = index;
  }
  return column;
}

function higherColumnHasInk(cells: readonly TextObject[][]): boolean {
  return cells.slice(1).some((cell) => cell.some(hasInk));
}

function rowsAreMonotonic(rows: readonly RowDraft[]): boolean {
  return rows.every((row, index) => index === 0 || row.top > rows[index - 1].top);
}

function validColumnAnchors(anchors: readonly number[], fontSize: number): boolean {
  if (anchors.length < TABLE_GRID_MIN_COLS) return false;
  for (let index = 1; index < anchors.length; index += 1) {
    if (anchors[index] - anchors[index - 1] < TABLE_BORDERLESS_MIN_COLUMN_GAP_RATIO * fontSize) {
      return false;
    }
  }
  return true;
}

function distinctAnchors(values: readonly number[], fontSize: number): number[] {
  const minimumGap = TABLE_BORDERLESS_MIN_COLUMN_GAP_RATIO * fontSize;
  const sorted = [...values].sort((left, right) => left - right);
  const anchors: number[] = [];
  for (const value of sorted) {
    if (anchors.length === 0 || value - anchors[anchors.length - 1] >= minimumGap) anchors.push(value);
  }
  return anchors;
}

function clusterLines(objects: readonly TextObject[]): TextLine[] {
  const lines: TextLine[] = [];
  const ordered = [...objects].sort((left, right) => left.bbox[1] - right.bbox[1]
    || left.bbox[0] - right.bbox[0]
    || left.id.localeCompare(right.id));
  for (const object of ordered) {
    const line = lines.find((candidate) =>
      Math.abs(candidate.top - object.bbox[1])
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
  for (const line of lines) line.objects.sort((left, right) => left.bbox[0] - right.bbox[0]);
  return lines.sort((left, right) => left.top - right.top);
}

function objectsOnLines(
  objects: readonly TextObject[],
  lines: readonly TextLine[],
): TextObject[] {
  const visibleIds = new Set(lines.flatMap((line) => line.objects.map((object) => object.id)));
  return objects.filter((object) => visibleIds.has(object.id) || lines.some((line) =>
    Math.abs(line.top - object.bbox[1])
      <= TABLE_BORDERLESS_LINE_TOLERANCE_RATIO * Math.max(line.fontSize, object.fontSize)));
}

function clusterNumbers(values: readonly number[], tolerance: number): Array<{ values: number[] }> {
  const clusters: Array<{ values: number[] }> = [];
  for (const value of [...values].sort((left, right) => left - right)) {
    const cluster = clusters.find((candidate) => Math.abs(clusterCenter(candidate) - value) <= tolerance);
    if (cluster === undefined) clusters.push({ values: [value] });
    else cluster.values.push(value);
  }
  return clusters;
}

function clusterCenter(cluster: { values: readonly number[] }): number {
  return cluster.values.reduce((total, value) => total + value, 0) / cluster.values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function unionBboxes(bboxes: readonly Bbox[]): Bbox {
  return [
    Math.min(...bboxes.map((bbox) => bbox[0])),
    Math.min(...bboxes.map((bbox) => bbox[1])),
    Math.max(...bboxes.map((bbox) => bbox[2])),
    Math.max(...bboxes.map((bbox) => bbox[3])),
  ];
}

function uniqueObjects(objects: readonly TextObject[]): TextObject[] {
  const seen = new Set<SourceObjectId>();
  return objects.filter((object) => {
    if (seen.has(object.id)) return false;
    seen.add(object.id);
    return true;
  });
}

function overlapsSources(left: DetectedTable, right: DetectedTable): boolean {
  const ids = new Set(left.sourceObjectIds);
  return right.sourceObjectIds.some((id) => ids.has(id));
}

function inLane(object: TextObject, lane: LaneBounds): boolean {
  const center = (object.bbox[0] + object.bbox[2]) / 2;
  return center >= lane.left && center <= lane.right;
}

function hasInk(object: TextObject): boolean {
  return object.text.trim().length > 0;
}
