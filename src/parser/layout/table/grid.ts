import type { RawSourceObject } from '../../../schema/artifacts.ts';
import type { Bbox, SourceObjectId } from '../../../schema/element.ts';
import {
  TABLE_GRID_MIN_CELL_TEXT_HIT_RATE,
  TABLE_GRID_MIN_CLOSURE,
  TABLE_GRID_MIN_COLS,
  TABLE_GRID_MIN_ROWS,
  TABLE_RULE_INTERSECTION_TOLERANCE_PT,
} from '../../params/table.ts';
import { inferRawRules, ruleAxis, ruleInterval, type RawRule } from './raw-rules.ts';

type TextObject = Extract<RawSourceObject, { kind: 'text' }>;

export interface RuledGrid {
  page: number;
  bbox: Bbox;
  xs: number[];
  ys: number[];
  rules: RawRule[];
  ruleSourceObjectIds: SourceObjectId[];
  textObjects: TextObject[];
  gridClosure: number;
  cellTextHitRate: number;
}

/** 横竖线 → 交点连通分量 → 确定性闭合网格。 */
export function detectRuledGrids(objects: readonly RawSourceObject[]): RuledGrid[] {
  const rules = inferRawRules(objects);
  const texts = objects.filter((object): object is TextObject =>
    object.kind === 'text' && object.text.length > 0);
  return connectedRuleComponents(rules)
    .map((component) => gridFromComponent(component, texts))
    .filter((grid): grid is RuledGrid => grid !== null)
    .sort((left, right) => left.bbox[1] - right.bbox[1]
      || left.bbox[0] - right.bbox[0]
      || left.ruleSourceObjectIds.join().localeCompare(right.ruleSourceObjectIds.join()));
}

function gridFromComponent(rules: RawRule[], pageTexts: readonly TextObject[]): RuledGrid | null {
  const horizontal = rules.filter((rule) => rule.orientation === 'h');
  const vertical = rules.filter((rule) => rule.orientation === 'v');
  const xs = uniqueSorted(vertical.map(ruleAxis));
  const ys = uniqueSorted(horizontal.map(ruleAxis));
  if (ys.length < TABLE_GRID_MIN_ROWS + 1 || xs.length < TABLE_GRID_MIN_COLS + 1) return null;

  // 同一轴可以由多段线组成（合并单元格正是故意缺一段）。分母按逻辑坐标而不是
  // 物理 segment 数计算，否则把一条断开的竖轴算两列，gridClosure 会被人为压低。
  const expectedIntersections = xs.length * ys.length;
  const closedIntersections = ys.reduce((total, y) =>
    total + xs.filter((x) => pointIsClosed(horizontal, vertical, x, y)).length, 0);
  const gridClosure = expectedIntersections === 0 ? 0 : closedIntersections / expectedIntersections;
  if (gridClosure < TABLE_GRID_MIN_CLOSURE) return null;

  const bbox: Bbox = [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]];
  const textObjects = pageTexts.filter((text) => pointInside(center(text.bbox), bbox));
  // ★ 分母是本网格自己的格子数，不是整页文本数。用整页做分母的话，"表格是否装着
  //   内容"这件本地事实会随页面其余部分的多寡而变：一页只有一张表时轻松过线，
  //   同一张表搬到正文密集的学术版面上就必然掉线——那不是表格变了，是页面变了。
  const cellTextHitRate = filledBandShare(xs, ys, textObjects);
  if (cellTextHitRate < TABLE_GRID_MIN_CELL_TEXT_HIT_RATE) return null;

  return {
    page: rules[0].page,
    bbox,
    xs,
    ys,
    rules,
    ruleSourceObjectIds: [...new Set(rules.flatMap((rule) => rule.sourceObjectIds))].sort(compareText),
    textObjects,
    gridClosure,
    cellTextHitRate,
  };
}

/**
 * 装着文字的行带占比与列带占比中较小的一个；空框、装饰框据此与真表格区分。
 *
 * ★ 不能用"原子格填充率"：合并单元格只在它的左上原子格里落一次文字，空单元格
 *   本来就该是空的——按原子格数做分母，等于让"表格里有没有合并与留白"决定"它
 *   是不是表格"，合并越多、留白越多的表越容易被判成装饰框。按行带 / 列带统计
 *   与合并、留白无关：一条画了线的行带里只要有字，这条行带就在承载内容。
 *   两维取小值，避免"只有一列有字"的目录式竖排框蒙混过关。
 */
function filledBandShare(
  xs: readonly number[],
  ys: readonly number[],
  textObjects: readonly TextObject[],
): number {
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  if (rows <= 0 || cols <= 0) return 0;
  const filledRows = new Set<number>();
  const filledColumns = new Set<number>();
  for (const text of textObjects) {
    const [x, y] = center(text.bbox);
    const column = xs.findLastIndex((value) => value <= x);
    const row = ys.findLastIndex((value) => value <= y);
    if (column < 0 || column >= cols || row < 0 || row >= rows) continue;
    filledRows.add(row);
    filledColumns.add(column);
  }
  return Math.min(filledRows.size / rows, filledColumns.size / cols);
}

function pointIsClosed(
  horizontal: readonly RawRule[],
  vertical: readonly RawRule[],
  x: number,
  y: number,
): boolean {
  const hRules = horizontal.filter((rule) =>
    Math.abs(ruleAxis(rule) - y) <= TABLE_RULE_INTERSECTION_TOLERANCE_PT);
  const vRules = vertical.filter((rule) =>
    Math.abs(ruleAxis(rule) - x) <= TABLE_RULE_INTERSECTION_TOLERANCE_PT);
  return hRules.some((hRule) => vRules.some((vRule) => rulesIntersect(hRule, vRule)));
}

function connectedRuleComponents(rules: readonly RawRule[]): RawRule[][] {
  const components: RawRule[][] = [];
  const visited = new Set<number>();
  for (let start = 0; start < rules.length; start += 1) {
    if (visited.has(start)) continue;
    const queue = [start];
    const component: RawRule[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const currentIndex = queue.shift();
      if (currentIndex === undefined) break;
      const current = rules[currentIndex];
      component.push(current);
      for (let candidateIndex = 0; candidateIndex < rules.length; candidateIndex += 1) {
        if (visited.has(candidateIndex)) continue;
        const candidate = rules[candidateIndex];
        if (current.orientation === candidate.orientation) continue;
        const horizontal = current.orientation === 'h' ? current : candidate;
        const vertical = current.orientation === 'v' ? current : candidate;
        if (!rulesIntersect(horizontal, vertical)) continue;
        visited.add(candidateIndex);
        queue.push(candidateIndex);
      }
    }
    components.push(component);
  }
  return components;
}

function rulesIntersect(horizontal: RawRule, vertical: RawRule): boolean {
  const [hStart, hEnd] = ruleInterval(horizontal);
  const [vStart, vEnd] = ruleInterval(vertical);
  const allowance = (horizontal.thickness + vertical.thickness) / 2
    + TABLE_RULE_INTERSECTION_TOLERANCE_PT;
  return ruleAxis(vertical) >= hStart - allowance
    && ruleAxis(vertical) <= hEnd + allowance
    && ruleAxis(horizontal) >= vStart - allowance
    && ruleAxis(horizontal) <= vEnd + allowance;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function center(bbox: Bbox): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function pointInside(point: readonly [number, number], bbox: Bbox): boolean {
  return point[0] > bbox[0] && point[0] < bbox[2]
    && point[1] > bbox[1] && point[1] < bbox[3];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
