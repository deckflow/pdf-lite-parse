import type {
  DocumentPageProbe,
  ParseRawPageArtifact,
  TextLayerEvidence,
} from '../../../schema/artifacts.ts';
import type { SourceObjectId } from '../../../schema/element.ts';
import {
  TEXT_LAYER_CID_ESCAPE_RATE,
  TEXT_LAYER_CONSONANT_RUN,
  TEXT_LAYER_DOCUMENT_CJK_SHARE,
  TEXT_LAYER_EN_GIBBERISH_WORD_SHARE,
  TEXT_LAYER_LANGUAGE_MIN_CHARACTERS,
  TEXT_LAYER_LANGUAGE_MIN_WORDS,
  TEXT_LAYER_LANGUAGE_WORD_MIN_CHARACTERS,
  TEXT_LAYER_MIN_SUSPICIOUS_CHARACTERS,
  PROBE_AREA_DECIMAL_PLACES,
  TEXT_LAYER_REPLACEMENT_RATE,
  TEXT_LAYER_SUSPICIOUS_CODEPOINT_RATE,
  TEXT_LAYER_UNMAPPABLE_FONT_SHARE,
  TEXT_LAYER_ZH_PROFILE_CJK_SHARE,
  TEXT_LAYER_ZH_PROFILE_LATIN_SHARE,
} from '../../params/l1.ts';

export type LanguageProfile = 'zh' | 'en' | 'unknown';

export interface TextLayerProbeResult {
  verdict: 'trusted' | 'partial' | 'broken' | 'absent';
  evidence: TextLayerEvidence[];
  fontMappable: boolean | null;
}

/** 文档语言字典优先；缺失时只在 CJK 份额足够明确时推断中文，否则保守按英文画像。 */
export function inferLanguageProfile(
  pages: readonly ParseRawPageArtifact[],
  documentLanguage: string | null,
): LanguageProfile {
  const declared = documentLanguage?.toLowerCase() ?? '';
  if (/^(?:zh|zho|chi)(?:-|$)/u.test(declared)) return 'zh';
  if (/^(?:en|eng)(?:-|$)/u.test(declared)) return 'en';
  const text = pages.flatMap(textObjects).map((object) => object.text).join('');
  const characters = visibleCharacters(text);
  if (characters.length === 0) return 'unknown';
  const cjkShare = characters.filter(isCjk).length / characters.length;
  return cjkShare >= TEXT_LAYER_DOCUMENT_CJK_SHARE ? 'zh' : 'en';
}

export function probeTextLayer(
  rawPage: ParseRawPageArtifact,
  documentPage: DocumentPageProbe | undefined,
  language: LanguageProfile,
): TextLayerProbeResult {
  const objects = textObjects(rawPage);
  const text = objects.map((object) => object.text).join('');
  const characters = visibleCharacters(text);
  if (characters.length === 0) {
    return {
      verdict: 'absent',
      evidence: [],
      fontMappable: fontMappability(documentPage),
    };
  }

  const evidence: TextLayerEvidence[] = [];
  const structural = structuralFontEvidence(objects, documentPage, characters.length);
  if (structural !== null) evidence.push(structural);
  addCodepointEvidence(evidence, objects, characters.length);
  addLanguageEvidence(evidence, objects, characters, language);

  const structuralCount = evidence.filter((item) => item.hardness === 'structural').length;
  const statisticalCount = evidence.filter((item) => item.hardness === 'statistical').length;
  const verdict = structuralCount >= 1 || statisticalCount >= 2
    ? 'broken'
    : statisticalCount === 1
      ? 'partial'
      : 'trusted';
  return { verdict, evidence, fontMappable: fontMappability(documentPage) };
}

function structuralFontEvidence(
  objects: ReturnType<typeof textObjects>,
  documentPage: DocumentPageProbe | undefined,
  visibleCharacterCount: number,
): TextLayerEvidence | null {
  const fonts = documentPage?.fonts ?? [];
  const unsafeFonts = fonts.filter((font) =>
    font.subtype === 'Type0'
    && font.encoding?.toLowerCase() === 'identity-h'
    && font.hasToUnicode === false
  );
  if (unsafeFonts.length === 0) return null;

  const allFontsUnsafe = fonts.length > 0 && unsafeFonts.length === fonts.length;
  const matching = objects.filter((object) =>
    allFontsUnsafe || unsafeFonts.some((font) => fontNamesMatch(object.fontName, font.fontName))
  );
  const unsafeCharacters = matching.reduce(
    (total, object) => total + visibleCharacters(object.text).length,
    0,
  );
  const score = unsafeCharacters / visibleCharacterCount;
  if (score <= TEXT_LAYER_UNMAPPABLE_FONT_SHARE) return null;
  return evidenceItem(
    'structure',
    'structural',
    'font_missing_tounicode',
    score,
    matching.map((object) => object.id),
  );
}

function addCodepointEvidence(
  evidence: TextLayerEvidence[],
  objects: ReturnType<typeof textObjects>,
  visibleCharacterCount: number,
): void {
  const replacement = evidenceForObjects(objects, (text) => countMatches(text, /\uFFFD/gu));
  maybeAddStatisticalEvidence(
    evidence,
    'replacement_character_rate',
    replacement,
    visibleCharacterCount,
    TEXT_LAYER_REPLACEMENT_RATE,
  );

  const escapedCid = evidenceForObjects(
    objects,
    (text) => matchedCharacterCount(text, /\(cid:\d+\)|\/\d+/giu),
  );
  maybeAddStatisticalEvidence(
    evidence,
    'cid_escape_rate',
    escapedCid,
    visibleCharacterCount,
    TEXT_LAYER_CID_ESCAPE_RATE,
  );

  const suspicious = evidenceForObjects(objects, countSuspiciousCodepoints);
  maybeAddStatisticalEvidence(
    evidence,
    'suspicious_codepoint_rate',
    suspicious,
    visibleCharacterCount,
    TEXT_LAYER_SUSPICIOUS_CODEPOINT_RATE,
  );
}

function addLanguageEvidence(
  evidence: TextLayerEvidence[],
  objects: ReturnType<typeof textObjects>,
  characters: readonly string[],
  language: LanguageProfile,
): void {
  if (characters.length < TEXT_LAYER_LANGUAGE_MIN_CHARACTERS) return;
  if (language === 'zh') {
    const cjkShare = characters.filter(isCjk).length / characters.length;
    const latinShare = characters.filter(isLatin).length / characters.length;
    if (cjkShare < TEXT_LAYER_ZH_PROFILE_CJK_SHARE
      && latinShare >= TEXT_LAYER_ZH_PROFILE_LATIN_SHARE) {
      evidence.push(evidenceItem(
        'linguistic',
        'statistical',
        'zh_profile_mismatch',
        latinShare,
        objects.map((object) => object.id),
      ));
    }
    return;
  }
  if (language !== 'en') return;

  const wordPattern = new RegExp(`[A-Za-z]{${TEXT_LAYER_LANGUAGE_WORD_MIN_CHARACTERS},}`, 'gu');
  const words = objects.flatMap((object) => object.text.match(wordPattern) ?? []);
  if (words.length < TEXT_LAYER_LANGUAGE_MIN_WORDS) return;
  const suspiciousWords = words.filter(isConsonantGibberish);
  const score = suspiciousWords.length / words.length;
  if (score >= TEXT_LAYER_EN_GIBBERISH_WORD_SHARE) {
    evidence.push(evidenceItem(
      'linguistic',
      'statistical',
      'en_consonant_gibberish',
      score,
      objects.filter((object) =>
        (object.text.match(wordPattern) ?? []).some(isConsonantGibberish)
      ).map((object) => object.id),
    ));
  }
}

function isConsonantGibberish(word: string): boolean {
  const lower = word.toLowerCase();
  const consonantRun = new RegExp(`[^aeiouy\\W\\d_]{${TEXT_LAYER_CONSONANT_RUN},}`, 'u');
  return consonantRun.test(lower);
}

function maybeAddStatisticalEvidence(
  evidence: TextLayerEvidence[],
  code: Extract<TextLayerEvidence['code'],
    'replacement_character_rate' | 'cid_escape_rate' | 'suspicious_codepoint_rate'>,
  observed: { count: number; sourceObjectIds: SourceObjectId[] },
  denominator: number,
  threshold: number,
): void {
  const score = observed.count / denominator;
  if (observed.count < TEXT_LAYER_MIN_SUSPICIOUS_CHARACTERS || score < threshold) return;
  evidence.push(evidenceItem('codepoint', 'statistical', code, score, observed.sourceObjectIds));
}

function evidenceForObjects(
  objects: ReturnType<typeof textObjects>,
  count: (text: string) => number,
): { count: number; sourceObjectIds: SourceObjectId[] } {
  let total = 0;
  const sourceObjectIds: SourceObjectId[] = [];
  for (const object of objects) {
    const observed = count(object.text);
    if (observed === 0) continue;
    total += observed;
    sourceObjectIds.push(object.id);
  }
  return { count: total, sourceObjectIds };
}

function evidenceItem(
  kind: TextLayerEvidence['kind'],
  hardness: TextLayerEvidence['hardness'],
  code: TextLayerEvidence['code'],
  score: number,
  sourceObjectIds: SourceObjectId[],
): TextLayerEvidence {
  return { kind, hardness, code, score: round(score), sourceObjectIds };
}

function textObjects(page: ParseRawPageArtifact) {
  return page.objects.filter((object) => object.kind === 'text');
}

function fontMappability(page: DocumentPageProbe | undefined): boolean | null {
  const fonts = page?.fonts ?? [];
  if (fonts.some((font) => font.verdict === 'not_mappable')) return false;
  if (fonts.length > 0 && fonts.every((font) => font.verdict === 'mappable')) return true;
  return null;
}

function fontNamesMatch(extracted: string, resource: string): boolean {
  const resourceLeaf = resource.split('/').at(-1) ?? resource;
  return extracted === resource
    || extracted.endsWith(`+${resourceLeaf}`)
    || extracted.includes(resourceLeaf);
}

function visibleCharacters(text: string): string[] {
  return [...text].filter((character) => !/\s/u.test(character));
}

function isCjk(character: string): boolean {
  return /\p{Script=Han}/u.test(character);
}

function isLatin(character: string): boolean {
  return /\p{Script=Latin}/u.test(character);
}

function countSuspiciousCodepoints(text: string): number {
  return [...text].filter((character) => {
    const codepoint = character.codePointAt(0);
    if (codepoint === undefined) return false;
    const isControl = (codepoint <= 0x1f && codepoint !== 0x09 && codepoint !== 0x0a
      && codepoint !== 0x0d) || (codepoint >= 0x7f && codepoint <= 0x9f);
    const isPrivateUse = codepoint >= 0xe000 && codepoint <= 0xf8ff;
    return isControl || isPrivateUse;
  }).length;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function matchedCharacterCount(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].reduce((total, match) => total + match[0].length, 0);
}

function round(value: number): number {
  const scale = 10 ** PROBE_AREA_DECIMAL_PLACES;
  return Math.round(value * scale) / scale;
}
