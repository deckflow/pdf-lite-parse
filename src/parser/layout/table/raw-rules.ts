import type { RawSourceObject } from '../../../schema/artifacts.ts';
import type { SourceObjectId } from '../../../schema/element.ts';
import {
  TABLE_RULE_MAX_THICKNESS_PT,
  TABLE_RULE_MERGE_TOLERANCE_PT,
  TABLE_RULE_MIN_ASPECT_RATIO,
  TABLE_RULE_MIN_LENGTH_PT,
} from '../../params/table.ts';

type DrawingObject = Extract<RawSourceObject, { kind: 'graphic' | 'rule' }>;

/** 阶段⑥里的派生线段；id 属于本阶段，sourceObjectIds 才是回到 PDF 的锚。 */
export interface RawRule {
  id: SourceObjectId;
  page: number;
  orientation: 'h' | 'v';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
  kind: 'stroke' | 'thin_fill';
  sourceObjectIds: SourceObjectId[];
}

/** 矢量对象 → 横竖线，并按 G12 标定容差合并共线段。 */
export function inferRawRules(objects: readonly RawSourceObject[]): RawRule[] {
  const candidates: RawRule[] = [];
  for (const object of objects) {
    if (object.kind !== 'graphic' && object.kind !== 'rule') continue;
    const candidate = rawRuleFromDrawing(object, candidates.length);
    if (candidate !== null) candidates.push(candidate);
  }
  return mergeCollinearRules(candidates);
}

function rawRuleFromDrawing(object: DrawingObject, index: number): RawRule | null {
  if (object.kind === 'rule') {
    return {
      id: rawRuleId(object.page, index),
      page: object.page,
      orientation: object.orientation,
      x0: object.x0,
      y0: object.y0,
      x1: object.x1,
      y1: object.y1,
      thickness: object.thickness,
      kind: object.ruleKind,
      sourceObjectIds: [object.id],
    };
  }
  const [x0, y0, x1, y1] = object.bbox;
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  if (longSide < TABLE_RULE_MIN_LENGTH_PT
    || shortSide > TABLE_RULE_MAX_THICKNESS_PT
    || (shortSide > 0 && longSide / shortSide < TABLE_RULE_MIN_ASPECT_RATIO)) {
    return null;
  }
  const kind = isStrokeOperator(object.operator) ? 'stroke' : 'thin_fill';
  if (width >= height) {
    const y = (y0 + y1) / 2;
    return {
      id: rawRuleId(object.page, index),
      page: object.page,
      orientation: 'h',
      x0,
      y0: y,
      x1,
      y1: y,
      thickness: shortSide,
      kind,
      sourceObjectIds: [object.id],
    };
  }
  const x = (x0 + x1) / 2;
  return {
    id: rawRuleId(object.page, index),
    page: object.page,
    orientation: 'v',
    x0: x,
    y0,
    x1: x,
    y1,
    thickness: shortSide,
    kind,
    sourceObjectIds: [object.id],
  };
}

function mergeCollinearRules(rules: readonly RawRule[]): RawRule[] {
  const pending = [...rules].sort(compareRules);
  const merged: RawRule[] = [];
  for (const rule of pending) {
    const target = merged.find((candidate) => canMerge(candidate, rule));
    if (target === undefined) {
      merged.push({ ...rule, sourceObjectIds: [...rule.sourceObjectIds] });
      continue;
    }
    mergeInto(target, rule);
  }
  return merged.sort(compareRules).map((rule, index) => ({
    ...rule,
    id: rawRuleId(rule.page, index),
    sourceObjectIds: [...new Set(rule.sourceObjectIds)].sort(compareText),
  }));
}

function canMerge(left: RawRule, right: RawRule): boolean {
  return left.page === right.page
    && left.orientation === right.orientation
    && Math.abs(axis(left) - axis(right)) <= TABLE_RULE_MERGE_TOLERANCE_PT
    && intervalGap(left, right) <= TABLE_RULE_MERGE_TOLERANCE_PT;
}

function mergeInto(target: RawRule, source: RawRule): void {
  const [targetStart, targetEnd] = interval(target);
  const [sourceStart, sourceEnd] = interval(source);
  const targetLength = targetEnd - targetStart;
  const sourceLength = sourceEnd - sourceStart;
  const mergedAxis = targetLength + sourceLength === 0
    ? (axis(target) + axis(source)) / 2
    : (axis(target) * targetLength + axis(source) * sourceLength) / (targetLength + sourceLength);
  const start = Math.min(targetStart, sourceStart);
  const end = Math.max(targetEnd, sourceEnd);
  target.thickness = Math.max(target.thickness, source.thickness);
  target.kind = target.kind === source.kind ? target.kind : 'stroke';
  target.sourceObjectIds.push(...source.sourceObjectIds);
  if (target.orientation === 'h') {
    target.x0 = start;
    target.x1 = end;
    target.y0 = mergedAxis;
    target.y1 = mergedAxis;
  } else {
    target.x0 = mergedAxis;
    target.x1 = mergedAxis;
    target.y0 = start;
    target.y1 = end;
  }
}

export function ruleAxis(rule: RawRule): number {
  return axis(rule);
}

export function ruleInterval(rule: RawRule): [number, number] {
  return interval(rule);
}

function axis(rule: RawRule): number {
  return rule.orientation === 'h' ? rule.y0 : rule.x0;
}

function interval(rule: RawRule): [number, number] {
  return rule.orientation === 'h'
    ? [Math.min(rule.x0, rule.x1), Math.max(rule.x0, rule.x1)]
    : [Math.min(rule.y0, rule.y1), Math.max(rule.y0, rule.y1)];
}

function intervalGap(left: RawRule, right: RawRule): number {
  const [leftStart, leftEnd] = interval(left);
  const [rightStart, rightEnd] = interval(right);
  return Math.max(leftStart, rightStart) - Math.min(leftEnd, rightEnd);
}

function compareRules(left: RawRule, right: RawRule): number {
  return left.page - right.page
    || left.orientation.localeCompare(right.orientation)
    || axis(left) - axis(right)
    || interval(left)[0] - interval(right)[0]
    || left.id.localeCompare(right.id);
}

function isStrokeOperator(operator: string): boolean {
  return operator.toLowerCase().includes('stroke');
}

function rawRuleId(page: number, index: number): string {
  return `p${page}_r${String(index).padStart(4, '0')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
