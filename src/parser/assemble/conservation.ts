import type {
  ContentKindCounts,
  LedgerEntry,
  SourceLedgerPage,
} from '../../schema/artifacts.ts';

/**
 * 账本页级汇总。assemble 生产它、invariants 复算它，两处必须走同一个函数，
 * 否则"汇总与明细不一致"就会变成两套算法的分歧而不是真实缺口。
 */
export function summarizeLedgerPage(
  page: number,
  entries: readonly LedgerEntry[],
  contentOperators: ContentKindCounts,
  sourceObjectsByKind: ContentKindCounts,
): SourceLedgerPage {
  const coveredObjects = entries.filter(
    (entry) => entry.disposition !== 'unrepresentable',
  ).length;
  return {
    page,
    sourceObjects: entries.length,
    coveredObjects,
    sourceObjectCoverage: entries.length === 0 ? 1 : coveredObjects / entries.length,
    contentOperators,
    sourceObjectsByKind,
  };
}

/**
 * 逐类比对"操作符普查"与"实际产出的源对象"，返回人类可读的缺口描述。
 *
 * 文本只查有无，不查数量：pdf.js 的 showText 与 textContent item 是合法的 N:M
 * 关系（一次 showText 可被拆成多个 chunk，多次 showText 也可能合成一个），
 * 拿数量做判据必然误报。图形、图像与批注是 1:1，可以直接查差额。
 */
export function describeLostKinds(
  contentOperators: ContentKindCounts,
  sourceObjectsByKind: ContentKindCounts,
): string[] {
  const lost: string[] = [];
  if (contentOperators.text > 0 && sourceObjectsByKind.text === 0) {
    lost.push(`文本操作符 ${contentOperators.text} 个但没有任何文本源对象`);
  }
  for (const kind of ['path', 'image', 'annotation'] as const) {
    const census = contentOperators[kind];
    const emitted = sourceObjectsByKind[kind];
    if (emitted < census) {
      lost.push(`${KIND_LABELS[kind]}普查 ${census} 个，实际产出 ${emitted} 个`);
    }
  }
  return lost;
}

const KIND_LABELS = { path: '矢量路径', image: '图像', annotation: '批注' } as const;
