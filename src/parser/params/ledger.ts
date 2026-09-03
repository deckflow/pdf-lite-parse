/** RFC D13 定义的页级源对象守恒下限。 */
export const MIN_SOURCE_OBJECT_COVERAGE = 0.995;

/**
 * 只忽略真正的空字符串。空白字符可能是 PDF 文本层的原始内容，
 * 把 trim 后为空也扫掉会违反原文保真约束。
 */
export function isIgnorableTextSource(text: string): boolean {
  return text.length === 0;
}

/**
 * 纯空白的文本项只推进笔位、不落墨。它仍然是原文的一部分（照常入元素与账本），
 * 但 pdf.js 给这类 chunk 的 width 是 advance 累积量而非视觉宽度——实测一个
 * 单空格 chunk 报到 1022pt，远超页宽——所以它的几何不可信，只能记笔位。
 */
export function isInkFreeText(text: string): boolean {
  return text.trim().length === 0;
}
