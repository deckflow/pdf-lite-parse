/**
 * 字距噪声：pdf.js 用字距推断补出的空格。
 *
 * pdf.js 把"真的有一个空格字形"和"两个字之间的位移够宽"送进同一条 `addFakeSpaces`
 * 分支，出口都是 str 里的一个 U+0020，调用方分辨不出来。但中日韩排版里字与字之间
 * 本来就不写空格，所以夹在两个中日韩字之间的那个空格只可能来自字距——加宽字距是
 * 版式，不是内容。其余位置一律保留：拉丁词间空格、中西文之间的空格都是真内容。
 */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
  + '\\u3000-\\u303F\\uFF01-\\uFF60';
const CJK_TRACKING_SPACE = new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, 'gu');

export function stripCjkTrackingSpaces(text: string): string {
  return text.replace(CJK_TRACKING_SPACE, '');
}
