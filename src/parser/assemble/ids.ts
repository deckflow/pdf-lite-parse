import { createHash } from 'node:crypto';
import type { Bbox, SourceObjectId } from '../../schema/element.ts';

/**
 * 元素 / 批注 id 的生成规则（rfc § 3.3）。
 *
 * 单独成文件是因为它必须**在 M1 行块合并落地之前**定死：合并之后一个元素含多个源
 * 对象，"拿哪个源对象做哈希"若到那时才定，合并边界一变 id 就全变，而 id 是 extract
 * 场景寻址的锚 —— 事后改要么破坏已发出的 id，要么永久背一个兼容补丁。
 *
 * anchorKey 取**首尾两端**而非全集：中间多合进一个尾注标记不该换 id；只取首个则
 * 相邻两个元素容易共享 anchor。首尾同时相同的两个不同元素实际上不存在。
 */

export interface IdentifiableDraft {
  page: number;
  bbox: Bbox;
  sourceObjectIds: readonly SourceObjectId[];
}


/**
 * id 是内容派生而非位置派生：绝不能掺入 order 或数组下标，否则第 3 页多认出一个
 * 脚注就会让其后所有 id 平移，跨版本抽取全部失效（rfc § 3.3 的 D1）。
 */
export function assignStableIds(
  prefix: 'e' | 'a',
  drafts: readonly IdentifiableDraft[],
): string[] {
  const byBaseId = new Map<string, number[]>();
  const baseIds = drafts.map((draft) => baseId(prefix, draft));
  for (let index = 0; index < baseIds.length; index += 1) {
    const bucket = byBaseId.get(baseIds[index]);
    if (bucket) bucket.push(index);
    else byBaseId.set(baseIds[index], [index]);
  }

  const ids = [...baseIds];
  for (const [base, indexes] of byBaseId) {
    if (indexes.length === 1) continue;
    // 冲突后缀按元素自身 bbox 左上角升序分配，与 order、与插入顺序都无关 ——
    // 依赖顺序的话，冲突组里插进一个元素会让后面所有 id 平移。
    const ordered = [...indexes].sort((left, right) => compareBbox(drafts[left].bbox, drafts[right].bbox));
    for (let rank = 0; rank < ordered.length; rank += 1) {
      ids[ordered[rank]] = `${base}_${rank + 1}`;
    }
  }
  return ids;
}

function baseId(prefix: 'e' | 'a', draft: IdentifiableDraft): string {
  return `${prefix}_p${draft.page}_${hash8(anchorKey(draft.sourceObjectIds))}`;
}

/**
 * 源对象 id 形如 `p12_t0007`，序号零填充，因此字典序等于该页该类的内容流顺序。
 * 跨类别（文本 / 图形 / 图像 / 批注）之间不存在统一的内容流序，字典序在那里只是
 * 一个稳定约定 —— 稳定就够了，anchorKey 要的是可重现，不是可解释。
 */
export function anchorKey(sourceObjectIds: readonly SourceObjectId[]): string {
  if (sourceObjectIds.length === 0) {
    throw new TypeError('anchorKey 需要至少一个源对象');
  }
  const sorted = [...sourceObjectIds].sort();
  return `${sorted[0]}~${sorted[sorted.length - 1]}`;
}

function hash8(anchor: string): string {
  return createHash('sha1').update(anchor).digest('hex').slice(0, 8);
}

function compareBbox(left: Bbox, right: Bbox): number {
  for (let index = 0; index < 4; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
