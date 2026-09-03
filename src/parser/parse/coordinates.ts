import type { Bbox } from '../../schema/element.ts';
import { BBOX_DECIMAL_PLACES, MIN_BBOX_EXTENT_PT } from '../params/geometry.ts';

export type Point = readonly [number, number];

export interface ViewportCoordinates {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}

/**
 * pdf.js 的文本与操作符坐标仍处在 PDF 用户空间。本函数是 parse 出口唯一的
 * 坐标系转换点：把任意四角转换到项目统一的左上原点页面空间。
 */
export function pdfPointsToTopLeftBbox(
  viewport: ViewportCoordinates,
  points: readonly Point[],
): Bbox {
  if (points.length === 0) throw new TypeError('bbox 至少需要一个 PDF 坐标点');
  return topLeftBbox(points.map(([x, y]) => viewport.convertToViewportPoint(x, y)));
}

/** 已经在左上原点页面空间里的点 → 落盘 bbox；转换过的坐标不能再转一次。 */
export function topLeftBbox(points: readonly Point[]): Bbox {
  if (points.length === 0) throw new TypeError('bbox 至少需要一个页面坐标点');
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return ensureVisibleBbox([
    quantizeCoordinate(Math.min(...xs)),
    quantizeCoordinate(Math.min(...ys)),
    quantizeCoordinate(Math.max(...xs)),
    quantizeCoordinate(Math.max(...ys)),
  ]);
}

export function quantizeCoordinate(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError(`坐标必须是有限数值：${value}`);
  const factor = 10 ** BBOX_DECIMAL_PLACES;
  return Math.round(value * factor) / factor;
}

function ensureVisibleBbox(bbox: Bbox): Bbox {
  const [x0, y0, x1, y1] = bbox;
  return [
    x0,
    y0,
    x1 > x0 ? x1 : quantizeCoordinate(x0 + MIN_BBOX_EXTENT_PT),
    y1 > y0 ? y1 : quantizeCoordinate(y0 + MIN_BBOX_EXTENT_PT),
  ];
}
