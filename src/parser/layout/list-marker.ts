import {
  PRIVATE_USE_AREA_FIRST,
  PRIVATE_USE_AREA_LAST,
  STANDALONE_LIST_MARKER,
  SYMBOL_BULLET_CHARACTER_CODES,
  SYMBOL_BULLET_FONT_NAME,
} from '../params/layout.ts';

/**
 * 判断一段文字是不是"只承载项目符号"的源对象。
 *
 * PowerPoint / Word 的项目符号来自 Wingdings 这类符号字体，ToUnicode 只能给出
 * U+F0A7 这种私用区码位 —— 它既不是 `•` 也不是任何有语义的字符，纯按 Unicode 匹配
 * 一定漏。私用区没有标准，唯一能解释这个码位的信息是字体名，所以两者必须一起看。
 *
 * 这里不改写文字本身，以保留原始内容和溯源关系，
 * marker 原样进 `list_item.marker`，要不要渲染成 `-` 是 Markdown 渲染器的事。
 */
export function isListMarkerText(text: string, fontName: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (STANDALONE_LIST_MARKER.test(trimmed)) return true;
  const characters = [...trimmed];
  if (characters.length !== 1) return false;
  if (!SYMBOL_BULLET_FONT_NAME.test(fontName)) return false;
  const codepoint = characters[0].codePointAt(0);
  if (codepoint === undefined) return false;
  if (codepoint < PRIVATE_USE_AREA_FIRST || codepoint > PRIVATE_USE_AREA_LAST) return false;
  return SYMBOL_BULLET_CHARACTER_CODES.has(codepoint & 0xff);
}
