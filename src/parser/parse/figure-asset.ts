import { createHash } from 'node:crypto';
import type {
  LayoutPageArtifact,
  OverlaidTextMode,
  ParseRawPageArtifact,
  RawSourceObject,
} from '../../schema/artifacts.ts';
import type { Bbox, SourceObjectId } from '../../schema/element.ts';
import { FIGURE_OWNED_TEXT_CONTAINMENT_RATIO } from '../params/layout.ts';
import { ASSET_DIRECTORY } from '../params/raster.ts';

type ImageObject = Extract<RawSourceObject, { kind: 'image' }>;
type TextObject = Extract<RawSourceObject, { kind: 'text' }>;

/** 12 个十六进制字符足够避免同页区域名碰撞，同时不把内部 region id 暴露到路径里。 */
const FIGURE_ASSET_ID_HASH_LENGTH = 12;

export interface CompositeFigureAssetRequest {
  regionId: string;
  page: number;
  bbox: Bbox;
  sourceObjectIds: SourceObjectId[];
  assetPath: string;
}

export interface MaterializedFigureAsset extends CompositeFigureAssetRequest {
  renderDpi: number;
}

/**
 * 找出必须从整页视觉结果裁剪的图。
 *
 * 这里不看文件名、页码或模型原因，只认最终版面区域里的客观关系：figure/chart 同时引用
 * 图像源对象和落在图像画布内的文字。caption 即使被顾问误并进 region，也因不在图像
 * bbox 内而不会扩大裁剪范围。
 */
export function compositeFigureAssetRequests(
  rawPages: readonly ParseRawPageArtifact[],
  layoutPages: readonly LayoutPageArtifact[],
  overlaidText: OverlaidTextMode,
): CompositeFigureAssetRequest[] {
  if (overlaidText !== 'auto') return [];
  const rawByPage = new Map(rawPages.map((page) => [page.page, page]));
  const requests: CompositeFigureAssetRequest[] = [];

  for (const layout of [...layoutPages].sort((left, right) => left.page - right.page)) {
    const rawPage = rawByPage.get(layout.page);
    if (rawPage === undefined) throw new TypeError(`第 ${layout.page} 页版面没有 parse_raw 输入`);
    const objectsById = new Map(rawPage.objects.map((object) => [object.id, object]));
    for (const region of [...layout.regions].sort((left, right) => left.readingOrder - right.readingOrder)) {
      if (region.type !== 'figure' && region.type !== 'chart') continue;
      const objects = region.sourceObjectIds.flatMap((id) => {
        const object = objectsById.get(id);
        return object === undefined ? [] : [object];
      });
      const images = objects.filter((object): object is ImageObject => object.kind === 'image');
      if (images.length === 0) continue;
      const imageBbox = unionBboxes(images.map((image) => image.bbox));
      const overlays = objects.filter((object): object is TextObject => (
        object.kind === 'text'
        && containmentRatio(object.bbox, imageBbox) >= FIGURE_OWNED_TEXT_CONTAINMENT_RATIO
      ));
      if (overlays.length === 0) continue;
      const visualContentBbox = unionBboxes([imageBbox, ...overlays.map((object) => object.bbox)]);
      const bbox = intersectBboxes(visualContentBbox, region.bbox);
      if (bbox === null) continue;
      requests.push({
        regionId: region.id,
        page: layout.page,
        bbox,
        sourceObjectIds: [...region.sourceObjectIds],
        assetPath: compositeAssetPath(layout.page, region.id),
      });
    }
  }
  return requests;
}

function compositeAssetPath(page: number, regionId: string): string {
  const digest = createHash('sha1').update(regionId, 'utf8').digest('hex')
    .slice(0, FIGURE_ASSET_ID_HASH_LENGTH);
  return `${ASSET_DIRECTORY}/p${page}_figure_${digest}.png`;
}

function containmentRatio(target: Bbox, container: Bbox): number {
  const area = bboxArea(target);
  if (area <= 0) return 0;
  const width = Math.max(0, Math.min(target[2], container[2]) - Math.max(target[0], container[0]));
  const height = Math.max(0, Math.min(target[3], container[3]) - Math.max(target[1], container[1]));
  return width * height / area;
}

function bboxArea(bbox: Bbox): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function unionBboxes(bboxes: readonly Bbox[]): Bbox {
  if (bboxes.length === 0) throw new TypeError('不能合并空 bbox 集合');
  return [
    Math.min(...bboxes.map((bbox) => bbox[0])),
    Math.min(...bboxes.map((bbox) => bbox[1])),
    Math.max(...bboxes.map((bbox) => bbox[2])),
    Math.max(...bboxes.map((bbox) => bbox[3])),
  ];
}

function intersectBboxes(left: Bbox, right: Bbox): Bbox | null {
  const bbox: Bbox = [
    Math.max(left[0], right[0]),
    Math.max(left[1], right[1]),
    Math.min(left[2], right[2]),
    Math.min(left[3], right[3]),
  ];
  return bbox[2] > bbox[0] && bbox[3] > bbox[1] ? bbox : null;
}
