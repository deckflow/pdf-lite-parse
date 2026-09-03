/** 跨页表格的列边界容差（pt）；比正文栏宽容差更严格，避免把不同列义的表拼起来。 */
export const CROSS_TABLE_COLUMN_TOLERANCE_PT = 2;
/** 只有页末和下一页页首的表才可能是续表。 */
export const CROSS_TABLE_EDGE_SHARE = 0.2;
/** 列表项邻接容差，单位为主导字号。超过此空白视作两份列表。 */
export const LIST_MAX_GAP_FONT_RATIO = 2.5;
