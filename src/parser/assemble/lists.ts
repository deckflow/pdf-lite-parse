import type { Bbox, Element } from '../../schema/element.ts';
import { LIST_MAX_GAP_FONT_RATIO } from '../params/cross-page.ts';

type Item = Extract<Element, { type: 'list_item' }>;
/** C9：容器承载结构，源对象正文仍只在 item 上表示，账本不会重复计账。 */
export function attachListContainers(elements: readonly Element[]): Element[] {
  const output: Element[] = [];
  let group: Item[] = [];
  function flush(): void {
    if (group.length === 0) return;
    const first = group[0];
    const id = `${first.id}_list`;
    const pages = [...new Set(group.map(item => item.page))];
    const bboxes = pages.map(page => ({ page, bbox: union(group.filter(item => item.page === page).map(item => item.bbox)) }));
    const container: Extract<Element, { type: 'list' }> = {
      ...first, id, type: 'list', text: '', bbox: bboxes[0].bbox,
      ...(pages.length > 1 ? { bboxes } : {}),
      list: { ordered: markerNumber(first.marker) !== null, depth: first.depth },
      sourceObjectIds: [...new Set(group.flatMap(item => item.sourceObjectIds ?? []))],
      confidence: Math.min(...group.map(item => item.confidence)),
    };
    // 判别联合不允许容器带 item 专属载荷。
    Reflect.deleteProperty(container, 'marker'); Reflect.deleteProperty(container, 'depth');
    Reflect.deleteProperty(container, 'continuesFrom'); Reflect.deleteProperty(container, 'marks');
    output.push(container, ...group.map(item => ({ ...item, parentId: id })));
    group = [];
  }
  for (const element of elements) {
    if (element.type !== 'list_item') { flush(); output.push(element); continue; }
    const previous = group.at(-1);
    if (previous !== undefined && !sameList(previous, element)) flush();
    group.push(element);
  }
  flush();
  return output.map((element, i) => ({ ...element, order: i + 1 }));
}
function sameList(left: Item, right: Item): boolean {
  if (left.depth !== right.depth || left.parentId !== right.parentId) return false;
  const a = markerNumber(left.marker), b = markerNumber(right.marker);
  if ((a === null) !== (b === null) || (a !== null && b !== a + 1)) return false;
  if (left.page !== right.page) return right.page === left.page + 1 && right.continuesFrom === left.id;
  return right.bbox[1] - left.bbox[3] <= LIST_MAX_GAP_FONT_RATIO * Math.max(left.style?.fontSize ?? 1, right.style?.fontSize ?? 1);
}
function markerNumber(marker: string): number | null {
  const match = /^\s*(\d+)[.)、．]/u.exec(marker);
  return match ? Number(match[1]) : null;
}
function union(boxes: Bbox[]): Bbox {
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
}
