/** 2026-09-03 上游 2026-08-14.g32 balanced 快照。
 * 原三项权重总和 0.69；删去四项后按总和归一，保留相对权重与 0.30 阈值。
 * 上游快照标记 insufficient_data_prior_retained，不能声称这些值经过充分标定。
 */
export const VERDICT_WEIGHTS = Object.freeze({ objectCoverage: 0.28, readingOrderStability: 0.22, tableGridResidual: 0.19 });
export const VERDICT_LOCAL_MAX = 0.30;
export const VERDICT_SCORE_DECIMAL_PLACES = 6;
