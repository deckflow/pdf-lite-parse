import type {
  CrossPageFurnitureCandidate,
  ParseRawPageArtifact,
  ProbeCrossArtifact,
  Region,
} from '../../../schema/artifacts.ts';
import type { FurnitureType, SourceObjectId } from '../../../schema/element.ts';
import {
  LOCAL_PAGE_NUMBER_CONFIDENCE,
  LOCAL_PAGE_NUMBER_EDGE_BAND_SHARE,
  LOCAL_PAGE_NUMBER_HORIZONTAL_ZONE_SHARE,
  LOCAL_PAGE_NUMBER_MAX_CHARACTERS,
} from '../../params/l2.ts';

export type FurnitureRegion = Omit<Region, 'readingOrder'>;

/**
 * L2 已经用跨页位置与内容聚类作出判定；阶段⑥只负责把判定投影回逐页区域。
 * 这里不复算阈值，避免 probe_cross.json 与最终元素各自声称一套家具结论。
 */
export function furnitureRegionsForPage(
  page: ParseRawPageArtifact,
  crossProbe: Pick<ProbeCrossArtifact, 'furniture'> | undefined,
): FurnitureRegion[] {
  const objectsById = new Map(page.objects.map((object) => [object.id, object]));
  const claimed = new Set<SourceObjectId>();
  const regions: FurnitureRegion[] = [];

  for (const candidate of crossProbe?.furniture ?? []) {
    for (let index = 0; index < candidate.pages.length; index += 1) {
      if (candidate.pages[index] !== page.page) continue;
      const sourceObjectId = candidate.sourceObjectIds[index];
      const positioned = candidate.bboxes[index];
      if (sourceObjectId === undefined || positioned === undefined) {
        throw new TypeError(`第 ${page.page} 页家具候选的页、bbox 与源锚不等长`);
      }
      const object = objectsById.get(sourceObjectId);
      if (object === undefined || object.page !== page.page || positioned.page !== page.page) {
        throw new TypeError(`第 ${page.page} 页家具候选无法解引用：${sourceObjectId}`);
      }
      if (claimed.has(sourceObjectId)) {
        throw new TypeError(`源对象 ${sourceObjectId} 被多个家具候选重复认领`);
      }
      claimed.add(sourceObjectId);
      regions.push(regionFor(candidate, page.page, sourceObjectId, positioned.bbox));
    }
  }

  // 页码是少数能在单页上由位置 + 词法双证据确定的家具；其余类型仍必须依赖 L2 跨页聚类。
  for (const object of page.objects) {
    if (object.kind !== 'text' || claimed.has(object.id)) continue;
    const text = object.text.trim();
    if (text.length === 0
      || text.length > LOCAL_PAGE_NUMBER_MAX_CHARACTERS
      || !/^\d+$/u.test(text)
      || object.bbox[1] < page.height * (1 - LOCAL_PAGE_NUMBER_EDGE_BAND_SHARE)
      || !inPageNumberHorizontalZone(object.bbox, page.width)) {
      continue;
    }
    claimed.add(object.id);
    regions.push({
      id: `region_${object.id}`,
      page: page.page,
      type: 'page_number',
      bbox: object.bbox,
      confidence: LOCAL_PAGE_NUMBER_CONFIDENCE,
      sourceObjectIds: [object.id],
      classificationEngine: 'local-page-number-v1',
    });
  }

  return regions.sort((left, right) =>
    left.bbox[1] - right.bbox[1]
    || left.bbox[0] - right.bbox[0]
    || left.id.localeCompare(right.id));
}

function inPageNumberHorizontalZone(bbox: Region['bbox'], pageWidth: number): boolean {
  const centerShare = ((bbox[0] + bbox[2]) / 2) / pageWidth;
  const zone = LOCAL_PAGE_NUMBER_HORIZONTAL_ZONE_SHARE;
  return centerShare <= zone
    || centerShare >= 1 - zone
    || Math.abs(centerShare - 0.5) <= zone / 2;
}

export function isFurnitureType(type: string): type is FurnitureType {
  return FURNITURE_TYPES.has(type as FurnitureType);
}

function regionFor(
  candidate: CrossPageFurnitureCandidate,
  page: number,
  sourceObjectId: SourceObjectId,
  bbox: Region['bbox'],
): FurnitureRegion {
  return {
    id: `region_${sourceObjectId}`,
    page,
    type: candidate.type,
    bbox,
    confidence: candidate.confidence,
    sourceObjectIds: [sourceObjectId],
    classificationEngine: 'l2-cross-page-furniture-v1',
  };
}

const FURNITURE_TYPES = new Set<FurnitureType>([
  'header',
  'footer',
  'gutter',
  'watermark',
  'page_number',
  'stamp',
]);
