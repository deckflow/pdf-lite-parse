import type { ParseRawPageArtifact, RawSourceObject } from '../../schema/artifacts.ts';
import type { Style } from '../../schema/element.ts';
import {
  BODY_FONT_SIZE_MIN_SHARE,
  FONT_SIZE_BUCKET_PT,
  HEADING_FONT_SIZE_MAX_LEVELS,
  HEADING_FONT_SIZE_MAX_SHARE,
  HEADING_FONT_SIZE_MIN_CHARACTERS,
  HEADING_FONT_SIZE_MIN_RATIO,
} from '../params/layout.ts';

/**
 * 文档级字号画像。
 *
 * 标题层级必须全文一致（rfc § 7.2），而版面阶段是逐页跑的 —— 逐页重新估计正文字号，
 * 同一层标题在正文密度不同的页上就会拿到不同 level。所以画像只由 parse 产物算，
 * 是一个纯函数：版面阶段与装配阶段各自调用一次，结果必然相同，不必再走工件传递。
 */
export interface DocumentTextProfile {
  /** 覆盖字符最多的字号桶；没有稳定正文（如纯封面）时为 null。 */
  bodyFontSize: number | null;
  /** 字号桶 → heading.level（从 1 起）。只收明显大于正文的字号。 */
  headingLevelByFontSize: ReadonlyMap<number, number>;
}

const EMPTY_PROFILE: DocumentTextProfile = {
  bodyFontSize: null,
  headingLevelByFontSize: new Map(),
};

/** 归桶后的字号；画像的键与查询都必须过这一层，否则 0.02pt 的抖动就查不中。 */
export function fontSizeBucket(fontSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) return 0;
  return Math.round(fontSize / FONT_SIZE_BUCKET_PT) * FONT_SIZE_BUCKET_PT;
}

export function documentTextProfile(
  pages: readonly ParseRawPageArtifact[],
): DocumentTextProfile {
  const charactersByFontSize = new Map<number, number>();
  let total = 0;
  for (const page of pages) {
    for (const object of page.objects) {
      if (object.kind !== 'text') continue;
      const characters = visibleLength(object.text);
      if (characters === 0) continue;
      const bucket = fontSizeBucket(object.fontSize);
      if (bucket === 0) continue;
      charactersByFontSize.set(bucket, (charactersByFontSize.get(bucket) ?? 0) + characters);
      total += characters;
    }
  }
  if (total === 0) return EMPTY_PROFILE;

  const ranked = [...charactersByFontSize.entries()]
    .sort(([leftSize, leftCount], [rightSize, rightCount]) =>
      rightCount - leftCount || leftSize - rightSize);
  const [bodyFontSize, bodyCharacters] = ranked[0];
  if (bodyCharacters / total < BODY_FONT_SIZE_MIN_SHARE) return EMPTY_PROFILE;

  const headingSizes = ranked
    .filter(([size, count]) =>
      size >= bodyFontSize * HEADING_FONT_SIZE_MIN_RATIO
      && count >= HEADING_FONT_SIZE_MIN_CHARACTERS
      && count / total <= HEADING_FONT_SIZE_MAX_SHARE)
    .map(([size]) => size)
    .sort((left, right) => right - left)
    .slice(0, HEADING_FONT_SIZE_MAX_LEVELS);

  return {
    bodyFontSize,
    headingLevelByFontSize: new Map(headingSizes.map((size, index) => [size, index + 1])),
  };
}

/** 只看字号能不能把这一块判成标题；块的形状判据（行数、长度、收尾）在版面阶段。 */
export function headingLevelForFontSize(
  profile: DocumentTextProfile,
  fontSize: number,
): number | null {
  return profile.headingLevelByFontSize.get(fontSizeBucket(fontSize)) ?? null;
}

/**
 * C17：元素级主导样式按**覆盖字符数**选，不是取第一个 chunk —— 行块合并后一个元素
 * 含多种字号是常态，取第一个会让整段的样式由一个标点决定。
 *
 * 版面阶段判"这块是不是标题"与装配阶段定 `heading.level` 必须看同一个字号，
 * 所以两边共用这一个实现。
 */
export function dominantTextStyle(
  objects: readonly Extract<RawSourceObject, { kind: 'text' }>[],
): Style {
  const coverage = new Map<string, { style: Style; characters: number; firstIndex: number }>();
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    const style: Style = { fontFamily: object.fontName, fontSize: object.fontSize };
    const key = `${style.fontFamily}\u0000${style.fontSize}`;
    const existing = coverage.get(key);
    if (existing) existing.characters += object.text.length;
    else coverage.set(key, { style, characters: object.text.length, firstIndex: index });
  }
  const dominant = [...coverage.values()].sort((left, right) =>
    right.characters - left.characters || left.firstIndex - right.firstIndex)[0];
  if (dominant === undefined) throw new TypeError('文字区域没有文字源对象');
  return dominant.style;
}

function visibleLength(text: string): number {
  return [...text].filter((character) => !/\s/u.test(character)).length;
}
