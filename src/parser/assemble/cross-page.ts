import type { Bbox, Element, TableCell } from '../../schema/element.ts';
import type { Warning } from '../../schema/warnings.ts';
import { isFurnitureType } from '../layout/furniture/index.ts';
import { tableText } from '../layout/table/cells.ts';
import { CROSS_TABLE_COLUMN_TOLERANCE_PT, CROSS_TABLE_EDGE_SHARE } from '../params/cross-page.ts';

type TableElement = Extract<Element, { type: 'table' }>;
export interface CrossPageMerge {
  elements: Element[];
  redirect: Map<string, string>;
  warnings: Warning[];
}
/** C6 合表、C7 段落保持独立；续段由 L2 候选在 assemble 中挂 continuesFrom。 */
export function mergeCrossPageTables(elements: readonly Element[], pages: readonly { index: number; height: number }[]): CrossPageMerge {
  const heightByPage = new Map(pages.map(p => [p.index, p.height]));
  const flowByPage = new Map<number, Element[]>();
  for (const element of elements) {
    if (isFurnitureType(element.type) || !element.isBodyContent) continue;
    const flow = flowByPage.get(element.page) ?? [];
    flow.push(element); flowByPage.set(element.page, flow);
  }
  const replacements = new Map<string, TableElement>();
  const redirect = new Map<string, string>();
  const warnings: Warning[] = [];
  for (const page of [...flowByPage.keys()].sort((a, b) => a - b)) {
    const tail = flowByPage.get(page)?.at(-1), head = flowByPage.get(page + 1)?.[0];
    if (tail?.type !== 'table' || head?.type !== 'table') continue;
    const height = heightByPage.get(page), nextHeight = heightByPage.get(page + 1);
    if (!height || !nextHeight || tail.bbox[3] < height * (1 - CROSS_TABLE_EDGE_SHARE)
      || head.bbox[1] > nextHeight * CROSS_TABLE_EDGE_SHARE) continue;
    const carrierId = redirect.get(tail.id) ?? tail.id;
    const carrier = replacements.get(carrierId) ?? tail;
    if (!canMerge(tail, head)) {
      warnings.push({ code: 'CROSS_PAGE_MERGE_UNCERTAIN', severity: 'info', scope: 'page', page: head.page,
        message: '相邻页边缘表格的列边界或表头不一致，已保留为独立表格。' });
      continue;
    }
    const repeatedHeaders = sameHeaders(tail, head) ? head.table.headerRows : 0;
    const newCells = head.table.cells.map(cell => ({ ...cell, page: cell.page ?? head.page }));
    // 重复表头的原文、源锚仍归属于合表；相同表头的第二份不重复占用行寻址空间。
    const cells = carrier.table.cells.map(cell => ({ ...cell, page: cell.page ?? carrier.page }));
    for (const cell of newCells) {
      if (cell.r < repeatedHeaders) continue;
      cells.push({ ...cell, r: cell.r - repeatedHeaders + carrier.table.rows });
    }
    const table = { ...carrier.table, rows: carrier.table.rows + head.table.rows - repeatedHeaders,
      crossPage: true, pageSpan: [carrier.page, head.page] as [number, number], cells };
    const boxes = [...(carrier.bboxes ?? [{ page: carrier.page, bbox: carrier.bbox }]), { page: head.page, bbox: head.bbox }];
    const merged: TableElement = { ...carrier, table, text: table.caption ? `${table.caption}\n${tableText(table)}` : tableText(table),
      bboxes: boxes, sourceObjectIds: [...(carrier.sourceObjectIds ?? []), ...(head.sourceObjectIds ?? [])],
      confidence: Math.min(carrier.confidence, head.confidence) };
    replacements.set(carrierId, merged);
    redirect.set(head.id, carrierId);
  }
  return { elements: elements.filter(e => !redirect.has(e.id)).map(e => replacements.get(e.id) ?? e), redirect, warnings };
}
function canMerge(left: TableElement, right: TableElement): boolean {
  if (left.table.cols !== right.table.cols || right.table.caption !== undefined) return false;
  if (right.table.headerRows > 0 && !sameHeaders(left, right)) return false;
  const a = columnEdges(left), b = columnEdges(right);
  return a !== null && b !== null && a.every((value, i) => Math.abs(value - b[i]) <= CROSS_TABLE_COLUMN_TOLERANCE_PT);
}
function sameHeaders(left: TableElement, right: TableElement): boolean {
  if (left.table.headerRows === 0 || left.table.headerRows !== right.table.headerRows) return false;
  const signature = (table: TableElement) => table.table.cells.filter(c => c.r < table.table.headerRows)
    .map(c => [c.r, c.c, c.rowSpan, c.colSpan, c.text]);
  return JSON.stringify(signature(left)) === JSON.stringify(signature(right));
}
function columnEdges(element: TableElement): number[] | null {
  const edges = new Map<number, number>();
  // 合并单元格只贡献两端，所有行合起来仍必须给齐每个列界。
  for (const cell of element.table.cells) {
    for (const [column, value] of [[cell.c, cell.bbox[0]], [cell.c + cell.colSpan, cell.bbox[2]]]) {
      const known = edges.get(column);
      if (known !== undefined && Math.abs(known - value) > CROSS_TABLE_COLUMN_TOLERANCE_PT) return null;
      edges.set(column, value);
    }
  }
  const ordered = Array.from({ length: element.table.cols + 1 }, (_, i) => edges.get(i));
  return ordered.every((v): v is number => v !== undefined) ? ordered : null;
}
