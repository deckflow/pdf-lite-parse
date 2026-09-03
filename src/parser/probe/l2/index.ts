import type {
  CrossPageContinuationCandidate,
  CrossPageFurnitureCandidate,
  PageProbe,
  ParseRawPageArtifact,
  ProbeCrossArtifact,
  ProbePagesArtifact,
  RawSourceObject,
} from '../../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../../schema/artifacts.ts';
import type { Bbox, SourceObjectId } from '../../../schema/element.ts';
import {
  CONTINUATION_EDGE_BAND_SHARE,
  CONTINUATION_LIST_CONFIDENCE,
  CONTINUATION_LIST_PREFIX,
  CONTINUATION_MIN_TEXT_CHARACTERS,
  CONTINUATION_PARAGRAPH_CONFIDENCE,
  CONTINUATION_TABLE_CONFIDENCE,
  CONTINUATION_TERMINAL_PUNCTUATION,
  FURNITURE_CONTENT_WEIGHT,
  FURNITURE_DIGIT_SHARE_FOR_PAGE_NUMBER,
  FURNITURE_EDGE_BAND_SHARE,
  FURNITURE_MAX_TEXT_CHARACTERS,
  FURNITURE_MIN_DOCUMENT_SHARE,
  FURNITURE_MIN_REPEAT_PAGES,
  FURNITURE_MIN_TEXT_CHARACTERS,
  FURNITURE_POSITION_BIN_SHARE,
  FURNITURE_POSITION_WEIGHT,
  PROBE_CROSS_DECIMAL_PLACES,
} from '../../params/l2.ts';

type TextObject = Extract<RawSourceObject, { kind: 'text' }>;

interface FurnitureObservation {
  page: number;
  pageWidth: number;
  pageHeight: number;
  type: CrossPageFurnitureCandidate['type'];
  bbox: Bbox;
  sourceObjectId: SourceObjectId;
  contentKey: string;
  positionX: number;
  positionY: number;
}

/** 阶段⑤：先跨页聚家具与续接，再让后续 layout 消费；这里不删除任何源对象。 */
export function probeCrossPage(
  rawPages: readonly ParseRawPageArtifact[],
  pageProbes: ProbePagesArtifact,
): ProbeCrossArtifact {
  const probes = new Map(pageProbes.pages.map((page) => [page.page, page]));
  const furniture = furnitureCandidates(rawPages, probes);
  const furnitureIds = new Set(furniture.flatMap((candidate) => candidate.sourceObjectIds));
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.probeCross,
    furniture,
    continuations: continuationCandidates(rawPages, probes, furnitureIds),
  };
}

function furnitureCandidates(
  rawPages: readonly ParseRawPageArtifact[],
  probes: ReadonlyMap<number, PageProbe>,
): CrossPageFurnitureCandidate[] {
  const observations = rawPages.flatMap((page) => {
    const tableAnchors = new Set(probes.get(page.page)?.anchorObjectIds ?? []);
    return visibleTexts(page).filter((text) => !tableAnchors.has(text.id)).flatMap((text) => {
      const textLength = visibleLength(text.text);
      if (textLength < FURNITURE_MIN_TEXT_CHARACTERS
        || textLength > FURNITURE_MAX_TEXT_CHARACTERS) return [];
      const centerY = (text.bbox[1] + text.bbox[3]) / 2;
      const inHeader = centerY <= page.height * FURNITURE_EDGE_BAND_SHARE;
      const inFooter = centerY >= page.height * (1 - FURNITURE_EDGE_BAND_SHARE);
      if (!inHeader && !inFooter) return [];
      const type = furnitureType(text.text, inHeader);
      const positionX = ((text.bbox[0] + text.bbox[2]) / 2) / page.width;
      const positionY = centerY / page.height;
      return [{
        page: page.page,
        pageWidth: page.width,
        pageHeight: page.height,
        type,
        bbox: text.bbox,
        sourceObjectId: text.id,
        contentKey: furnitureContentKey(text.text, type),
        positionX,
        positionY,
      } satisfies FurnitureObservation];
    });
  });
  const clusters = new Map<string, FurnitureObservation[]>();
  for (const observation of observations) {
    const xBin = Math.round(observation.positionX / FURNITURE_POSITION_BIN_SHARE);
    const yBin = Math.round(observation.positionY / FURNITURE_POSITION_BIN_SHARE);
    const key = `${observation.type}:${xBin}:${yBin}:${observation.contentKey}`;
    const cluster = clusters.get(key);
    if (cluster) cluster.push(observation);
    else clusters.set(key, [observation]);
  }

  const minimumPages = Math.max(
    FURNITURE_MIN_REPEAT_PAGES,
    Math.ceil(rawPages.length * FURNITURE_MIN_DOCUMENT_SHARE),
  );
  return [...clusters.values()].flatMap((cluster) => {
    const byPage = new Map<number, FurnitureObservation>();
    for (const observation of cluster) {
      if (!byPage.has(observation.page)) byPage.set(observation.page, observation);
    }
    const members = [...byPage.values()].sort((left, right) => left.page - right.page);
    if (members.length < minimumPages) return [];
    const repeatShare = rawPages.length === 0 ? 0 : members.length / rawPages.length;
    const positionConfidence = positionConsistency(members);
    return [{
      type: members[0].type,
      pages: members.map((member) => member.page),
      bboxes: members.map((member) => ({ page: member.page, bbox: member.bbox })),
      sourceObjectIds: members.map((member) => member.sourceObjectId),
      confidence: round(
        repeatShare * FURNITURE_CONTENT_WEIGHT
        + positionConfidence * FURNITURE_POSITION_WEIGHT,
      ),
    } satisfies CrossPageFurnitureCandidate];
  }).sort((left, right) => left.pages[0] - right.pages[0]
    || left.type.localeCompare(right.type));
}

function continuationCandidates(
  rawPages: readonly ParseRawPageArtifact[],
  probes: ReadonlyMap<number, PageProbe>,
  furnitureIds: ReadonlySet<SourceObjectId>,
): CrossPageContinuationCandidate[] {
  const ordered = [...rawPages].sort((left, right) => left.page - right.page);
  const candidates: CrossPageContinuationCandidate[] = [];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const from = ordered[index];
    const to = ordered[index + 1];
    if (to.page !== from.page + 1) continue;
    const tail = visibleTexts(from).filter((text) =>
      !furnitureIds.has(text.id)
      && visibleLength(text.text) >= CONTINUATION_MIN_TEXT_CHARACTERS
      && text.bbox[3] >= from.height * (1 - CONTINUATION_EDGE_BAND_SHARE)
    );
    const head = visibleTexts(to).filter((text) =>
      !furnitureIds.has(text.id)
      && visibleLength(text.text) >= CONTINUATION_MIN_TEXT_CHARACTERS
      && text.bbox[1] <= to.height * CONTINUATION_EDGE_BAND_SHARE
    );
    if (tail.length === 0 || head.length === 0) continue;
    const tailText = tail.map((text) => text.text).join('');
    const headText = head.map((text) => text.text).join('');
    const fromProbe = probes.get(from.page);
    const toProbe = probes.get(to.page);
    let kind: CrossPageContinuationCandidate['kind'];
    let confidence: number;
    if (fromProbe?.hasTable === true && toProbe?.hasTable === true) {
      kind = 'table';
      confidence = CONTINUATION_TABLE_CONFIDENCE;
    } else if (CONTINUATION_LIST_PREFIX.test(tailText)
      || CONTINUATION_LIST_PREFIX.test(headText)) {
      kind = 'list';
      confidence = CONTINUATION_LIST_CONFIDENCE;
    } else {
      if (CONTINUATION_TERMINAL_PUNCTUATION.test(tailText.trimEnd())) continue;
      kind = 'paragraph';
      confidence = CONTINUATION_PARAGRAPH_CONFIDENCE;
    }
    candidates.push({
      fromPage: from.page,
      toPage: to.page,
      kind,
      sourceObjectIds: [...tail, ...head].map((text) => text.id),
      confidence,
    });
  }
  return candidates;
}

function furnitureType(
  text: string,
  inHeader: boolean,
): CrossPageFurnitureCandidate['type'] {
  const visible = [...text].filter((character) => !/\s/u.test(character));
  const digits = visible.filter((character) => /\p{Number}/u.test(character)).length;
  if (visible.length > 0 && digits / visible.length >= FURNITURE_DIGIT_SHARE_FOR_PAGE_NUMBER) {
    return 'page_number';
  }
  return inHeader ? 'header' : 'footer';
}

function furnitureContentKey(
  text: string,
  type: CrossPageFurnitureCandidate['type'],
): string {
  const whitespaceCollapsed = text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
  return type === 'page_number'
    ? whitespaceCollapsed.replace(/\p{Number}+/gu, '#')
    : whitespaceCollapsed;
}

function positionConsistency(members: readonly FurnitureObservation[]): number {
  const meanX = mean(members.map((member) => member.positionX));
  const meanY = mean(members.map((member) => member.positionY));
  const deviation = mean(members.map((member) =>
    Math.hypot(member.positionX - meanX, member.positionY - meanY)
  ));
  return clamp(1 - deviation / FURNITURE_POSITION_BIN_SHARE);
}

function visibleTexts(page: ParseRawPageArtifact): TextObject[] {
  return page.objects.filter((object): object is TextObject =>
    object.kind === 'text'
    && visibleLength(object.text) > 0
  );
}

function visibleLength(text: string): number {
  return [...text].filter((character) => !/\s/u.test(character)).length;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  const scale = 10 ** PROBE_CROSS_DECIMAL_PLACES;
  return Math.round(value * scale) / scale;
}
