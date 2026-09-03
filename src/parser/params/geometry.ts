/** bbox 落盘精度；低于该精度的浮点差异没有版面意义。 */
export const BBOX_DECIMAL_PLACES = 2;

/** 元素 bbox 必须有面积；线条扩成这个最小可见宽度后才进入元素层。 */
export const MIN_BBOX_EXTENT_PT = 0.01;

/** RFC I7 允许 pdf.js 的字体度量越过页面裁切框少量距离。 */
export const PAGE_BBOX_TOLERANCE_PT = 1;

/**
 * 描边路径判定为轴对齐直线时允许的垂直方向漂移。取值等于 bbox 落盘精度：
 * 比它更小的偏差在产品坐标里根本表示不出来，当成斜线只会让表格边线整条丢失。
 */
export const RULE_AXIS_ALIGNMENT_TOLERANCE_PT = 0.01;

/** 内容流没有显式 setLineWidth 时的线宽；PDF 规范的图形状态默认值就是 1.0。 */
export const DEFAULT_STROKE_LINE_WIDTH_PT = 1;
