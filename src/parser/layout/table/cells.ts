import type { TableCell, TableInfo } from '../../../schema/element.ts';
import {
  TABLE_CELL_BORDER_TOLERANCE_PT,
  TABLE_CELL_LINE_TOLERANCE_PT,
  TABLE_HEADER_TEXT_SHARE,
  TABLE_STANDALONE_HYPHENATED_PREFIX,
} from '../../params/table.ts';
import type { RuledGrid } from './grid.ts';
import { ruleAxis, ruleInterval } from './raw-rules.ts';
import { stripCjkTrackingSpaces } from '../tracking-space.ts';

interface AtomicCell {
  r: number;
  c: number;
}

interface CellDraft {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
}

/** 网格分隔线缺口先合并原子格；每个连通块必须是矩形，才能落 C10 的一个锚点。 */
export function tableInfoFromGrid(grid: RuledGrid): TableInfo | null {
  const rows = grid.ys.length - 1;
  const cols = grid.xs.length - 1;
  const parents = Array.from({ length: rows * cols }, (_, index) => index);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const x = grid.xs[c + 1];
      const y = midpoint(grid.ys[r], grid.ys[r + 1]);
      if (!hasVerticalBorder(grid, x, y)) unite(parents, indexOf(r, c, cols), indexOf(r, c + 1, cols));
    }
  }
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = midpoint(grid.xs[c], grid.xs[c + 1]);
      const y = grid.ys[r + 1];
      if (!hasHorizontalBorder(grid, x, y)) unite(parents, indexOf(r, c, cols), indexOf(r + 1, c, cols));
    }
  }

  const groups = new Map<number, AtomicCell[]>();
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      append(groups, find(parents, indexOf(r, c, cols)), { r, c });
    }
  }
  const drafts: CellDraft[] = [];
  for (const members of groups.values()) {
    const minRow = Math.min(...members.map((member) => member.r));
    const maxRow = Math.max(...members.map((member) => member.r));
    const minCol = Math.min(...members.map((member) => member.c));
    const maxCol = Math.max(...members.map((member) => member.c));
    if (members.length !== (maxRow - minRow + 1) * (maxCol - minCol + 1)) return null;
    drafts.push({
      r: minRow,
      c: minCol,
      rowSpan: maxRow - minRow + 1,
      colSpan: maxCol - minCol + 1,
    });
  }
  drafts.sort((left, right) => left.r - right.r || left.c - right.c);

  const cells = drafts.map((draft) => cellFromDraft(grid, draft));
  const headerLike = Array.from({ length: rows }, (_, row) => isHeaderLikeRow(cells, row, cols));
  let headerRows = 0;
  while (headerRows < headerLike.length && headerLike[headerRows]) headerRows += 1;
  const headerCols = cols > 1 ? 1 : 0;
  for (const cell of cells) applyCellRole(cell, headerRows, headerCols, headerLike, cols);

  return {
    rows,
    cols,
    headerRows,
    headerCols,
    kind: 'ruled',
    crossPage: false,
    cells,
  };
}

/** Element.text 是 cells 的最小可读投影；cell.text 本身始终保留原始字符。 */
export function tableText(table: TableInfo): string {
  const anchors = new Map(table.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
  const lines: string[] = [];
  for (let r = 0; r < table.rows; r += 1) {
    const values: string[] = [];
    for (let c = 0; c < table.cols; c += 1) {
      values.push(anchors.get(`${r}:${c}`)?.text ?? '');
    }
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

function cellFromDraft(grid: RuledGrid, draft: CellDraft): TableCell {
  const bbox: [number, number, number, number] = [
    grid.xs[draft.c],
    grid.ys[draft.r],
    grid.xs[draft.c + draft.colSpan],
    grid.ys[draft.r + draft.rowSpan],
  ];
  const textObjects = grid.textObjects
    .filter((object) => pointInside(center(object.bbox), bbox))
    .sort((left, right) => left.bbox[1] - right.bbox[1]
      || left.bbox[0] - right.bbox[0]
      || left.id.localeCompare(right.id));
  return {
    ...draft,
    text: textForTableCellObjects(textObjects),
    bbox,
    isHeader: false,
    role: 'data',
    page: grid.page,
    confidence: Math.min(grid.gridClosure, 0.99),
    ...(textObjects.length === 0 ? {} : { sourceObjectIds: textObjects.map((object) => object.id) }),
  };
}

export function textForTableCellObjects(
  objects: readonly RuledGrid['textObjects'][number][],
): string {
  const lines: Array<{ baseline: number; objects: RuledGrid['textObjects'] }> = [];
  for (const object of objects) {
    const baseline = object.bbox[3];
    const line = lines.find((candidate) =>
      Math.abs(candidate.baseline - baseline) <= TABLE_CELL_LINE_TOLERANCE_PT);
    if (line === undefined) lines.push({ baseline, objects: [object] });
    else {
      line.baseline = (line.baseline * line.objects.length + baseline) / (line.objects.length + 1);
      line.objects.push(object);
    }
  }
  lines.sort((left, right) => left.baseline - right.baseline);
  const lineTexts = lines.map((line) => [...line.objects]
    .sort((left, right) => left.bbox[0] - right.bbox[0] || left.id.localeCompare(right.id))
    .map((object) => stripCjkTrackingSpaces(object.text))
    .join(''));
  let text = '';
  for (const lineText of lineTexts) text = joinTableCellLine(text, lineText);
  return text;
}

/**
 * 单元格内的换行是版式事实，一律原样保留成 `\n`。
 *
 * 例外只有一条：拉丁文行尾连字符是有证据的断词，可以接回去。其余“看起来该拼一起”
 * 的直觉（中文换行不留空、标点贴上一行）都是在删证据——下游要的是“这个格里有两行”，
 * 拼没了就再也读不出来。渲染侧把 `\n` 写成 `<br>`，转换链两头一致。
 */
function joinTableCellLine(left: string, right: string): string {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const leftCharacter = Array.from(left).at(-1) ?? '';
  const rightCharacter = Array.from(right)[0] ?? '';
  if (leftCharacter === '-' && /\p{Script=Latin}/u.test(rightCharacter)) {
    // 单独占一行的首字母大写短前缀通常是语义连字符；句中行尾连字符才是断词。
    return TABLE_STANDALONE_HYPHENATED_PREFIX.test(left.trim())
      ? left + right
      : left.slice(0, -1) + right;
  }
  return `${left}\n${right}`;
}

function isHeaderLikeRow(cells: readonly TableCell[], row: number, cols: number): boolean {
  const rowCells = cells.filter((cell) => cell.r === row);
  if (rowCells.some((cell) => cell.colSpan === cols && cell.text.length > 0)) return true;
  const nextCells = cells.filter((cell) => cell.r === row + 1);
  if (rowCells.length === 0 || nextCells.length === 0) return false;
  return nonNumericShare(rowCells) >= TABLE_HEADER_TEXT_SHARE
    && numericShare(nextCells) >= TABLE_HEADER_TEXT_SHARE;
}

function nonNumericShare(cells: readonly TableCell[]): number {
  return cells.length === 0 ? 0 : cells.filter((cell) => !looksNumeric(cell.text)).length / cells.length;
}

function numericShare(cells: readonly TableCell[]): number {
  if (cells.length === 0) return 0;
  // 第一列通常是行名；判断数据性时只看其余列，单列表才退回全行。
  const candidates = cells.length > 1 ? cells.slice(1) : cells;
  return candidates.filter((cell) => looksNumeric(cell.text)).length / candidates.length;
}

function looksNumeric(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && /^[-+（(]?[\d,.]+%?[）)]?$/u.test(value);
}

function applyCellRole(
  cell: TableCell,
  headerRows: number,
  headerCols: number,
  headerLike: readonly boolean[],
  cols: number,
): void {
  if (cell.r < headerRows) {
    cell.isHeader = true;
    cell.role = cell.colSpan === cols ? 'section_header' : 'column_header';
    return;
  }
  if (headerLike[cell.r]) {
    cell.isHeader = true;
    cell.role = 'section_header';
    return;
  }
  if (cell.c < headerCols) {
    cell.isHeader = true;
    cell.role = 'row_header';
  }
}

function hasVerticalBorder(grid: RuledGrid, x: number, y: number): boolean {
  return grid.rules.some((rule) => {
    if (rule.orientation !== 'v' || Math.abs(ruleAxis(rule) - x) > TABLE_CELL_BORDER_TOLERANCE_PT) {
      return false;
    }
    const [start, end] = ruleInterval(rule);
    return y >= start - TABLE_CELL_BORDER_TOLERANCE_PT
      && y <= end + TABLE_CELL_BORDER_TOLERANCE_PT;
  });
}

function hasHorizontalBorder(grid: RuledGrid, x: number, y: number): boolean {
  return grid.rules.some((rule) => {
    if (rule.orientation !== 'h' || Math.abs(ruleAxis(rule) - y) > TABLE_CELL_BORDER_TOLERANCE_PT) {
      return false;
    }
    const [start, end] = ruleInterval(rule);
    return x >= start - TABLE_CELL_BORDER_TOLERANCE_PT
      && x <= end + TABLE_CELL_BORDER_TOLERANCE_PT;
  });
}

function find(parents: number[], value: number): number {
  if (parents[value] !== value) parents[value] = find(parents, parents[value]);
  return parents[value];
}

function unite(parents: number[], left: number, right: number): void {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function indexOf(row: number, col: number, cols: number): number {
  return row * cols + col;
}

function midpoint(left: number, right: number): number {
  return (left + right) / 2;
}

function center(bbox: readonly [number, number, number, number]): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function pointInside(
  point: readonly [number, number],
  bbox: readonly [number, number, number, number],
): boolean {
  return point[0] > bbox[0] && point[0] < bbox[2]
    && point[1] > bbox[1] && point[1] < bbox[3];
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
}
