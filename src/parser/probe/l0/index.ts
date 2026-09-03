import type {
  DocumentPageProbe,
  FontMappingProbe,
  ProbeDocumentArtifact,
} from '../../../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../../../schema/artifacts.ts';
import type { Warning } from '../../../schema/warnings.ts';
import { L0_MAX_PAGE_TREE_DEPTH, L0_MAX_STRUCTURAL_OBJECTS } from '../../params/l0.ts';
import {
  buildObjectStore,
  type PdfObjectRecord,
  type PdfObjectStore,
} from './object-store.ts';
import {
  isPdfDictionary,
  isPdfName,
  isPdfRef,
  pdfNameValue,
  pdfRefKey,
  type PdfDictionary,
  type PdfRef,
  type PdfValue,
} from './value-parser.ts';

interface PageNode {
  page: number;
  dictionary: PdfDictionary;
  resources: PdfValue | undefined;
  rotation: number;
}

interface PageTreeResult {
  declaredPages: number;
  pages: PageNode[];
  issues: string[];
}

interface ResourceEvidence {
  fonts: FontMappingProbe[];
  imageXObjectCount: number;
  formStreams: PdfObjectRecord[];
  issues: string[];
}

interface OperatorEvidence {
  hasText: boolean;
  hasDo: boolean;
}

/**
 * L0 是 pdf.js 前面的 best-effort 证据通路。任何输入都只能得到工件，异常不得穿透。
 */
export function probeDocument(input: Uint8Array, sourceSha256: string): ProbeDocumentArtifact {
  try {
    return inspectPdfStructure(input, sourceSha256);
  } catch (error) {
    return unavailableArtifact(sourceSha256, false, [`L0 未捕获子阶段异常：${errorMessage(error)}`]);
  }
}

/** 名称更显式的别名，供独立调用方使用。 */
export const scanL0Structure = probeDocument;

function inspectPdfStructure(input: Uint8Array, sourceSha256: string): ProbeDocumentArtifact {
  const built = buildObjectStore(input);
  const encrypted = built.trailer?.has('Encrypt') ?? false;
  const structuralIssues = [...built.issues];
  let catalog: PdfDictionary | null = null;
  if (built.trailer?.has('Root')) {
    try {
      catalog = built.store.resolveDictionary(built.trailer.get('Root'));
    } catch (error) {
      structuralIssues.push(`trailer /Root 无法读取：${errorMessage(error)}`);
    }
  }
  if (catalog === null) {
    try {
      catalog = built.store.findDictionaryByType('Catalog');
      if (catalog !== null) structuralIssues.push('trailer /Root 缺失，已通过对象扫描恢复 Catalog');
    } catch (error) {
      structuralIssues.push(`Catalog 恢复扫描失败：${errorMessage(error)}`);
    }
  }
  if (catalog === null) {
    return unavailableArtifact(sourceSha256, encrypted, [...structuralIssues, '找不到 Catalog']);
  }

  let tree: PageTreeResult;
  try {
    tree = readPageTree(catalog, built.store);
  } catch (error) {
    return unavailableArtifact(
      sourceSha256,
      encrypted,
      [...structuralIssues, `页树整体无法读取：${errorMessage(error)}`],
    );
  }
  structuralIssues.push(...tree.issues);
  if (tree.pages.length === 0) {
    return unavailableArtifact(sourceSha256, encrypted, [...structuralIssues, '页树没有可用页面']);
  }

  const pageProbes: DocumentPageProbe[] = [];
  const warnings: Warning[] = [];
  for (const page of tree.pages) {
    const pageIssues: string[] = [];
    let resources: ResourceEvidence = {
      fonts: [],
      imageXObjectCount: 0,
      formStreams: [],
      issues: [],
    };
    try {
      resources = readResourceEvidence(page.resources, built.store);
      pageIssues.push(...resources.issues);
    } catch (error) {
      pageIssues.push(`资源字典无法读取：${errorMessage(error)}`);
    }

    let hasTextOperators: boolean | null = null;
    try {
      const records = readContentStreams(page.dictionary.get('Contents'), built.store);
      records.push(...resources.formStreams);
      let sawText = false;
      let failedStream = false;
      for (const record of uniqueRecords(records)) {
        try {
          const evidence = scanContentOperators(built.store.decodeRecordStream(record));
          sawText ||= evidence.hasText;
          // Do 的存在性由资源图中的 Image XObject 数量承载；这里仍扫描它，确保内容
          // tokenizer 会越过字符串而不是对原始字节做正则误判。
          void evidence.hasDo;
        } catch (error) {
          failedStream = true;
          pageIssues.push(`内容流 ${record.objectNumber} 无法读取：${errorMessage(error)}`);
        }
      }
      hasTextOperators = sawText ? true : failedStream ? null : false;
    } catch (error) {
      pageIssues.push(`页面内容流无法枚举：${errorMessage(error)}`);
    }

    pageProbes.push({
      page: page.page,
      rotation: page.rotation,
      hasTextOperators,
      imageXObjectCount: resources.imageXObjectCount,
      fonts: resources.fonts,
    });
    if (pageIssues.length > 0) warnings.push(partialWarning(page.page, pageIssues));
  }

  if (tree.declaredPages !== pageProbes.length) {
    structuralIssues.push(
      `页树声明 ${tree.declaredPages} 页，但只恢复 ${pageProbes.length} 页`,
    );
  }
  if (structuralIssues.length > 0) {
    for (const page of pageProbes) {
      if (warnings.some((warning) => warning.scope !== 'doc' && warning.page === page.page)) continue;
      warnings.push(partialWarning(page.page, structuralIssues));
    }
  }
  const status = warnings.length === 0 ? 'complete' : 'partial';
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.probeDocument,
    sourceSha256,
    pages: tree.declaredPages,
    encrypted,
    status,
    pageProbes,
    warnings,
  };
}

function readPageTree(catalog: PdfDictionary, store: PdfObjectStore): PageTreeResult {
  const root = catalog.get('Pages');
  if (root === undefined) throw new Error('Catalog 缺少 /Pages');
  const rootDictionary = store.resolveDictionary(root);
  const declared = optionalResolvedInteger(rootDictionary.get('Count'), store, 0);
  const pages: PageNode[] = [];
  const issues: string[] = [];
  const active = new Set<string>();
  let nextPage = 1;
  let visitedNodes = 0;

  function visit(
    rawNode: PdfValue,
    inheritedResources: PdfValue | undefined,
    inheritedRotation: number,
    depth: number,
  ): void {
    if (depth > L0_MAX_PAGE_TREE_DEPTH) throw new Error('页树深度超过 L0 安全上限');
    if (visitedNodes >= L0_MAX_STRUCTURAL_OBJECTS) throw new Error('页树节点超过 L0 安全上限');
    visitedNodes += 1;
    const identity = isPdfRef(rawNode) ? pdfRefKey(rawNode) : null;
    if (identity !== null && active.has(identity)) throw new Error(`页树形成环：${identity} R`);
    if (identity !== null) active.add(identity);
    try {
      const node = store.resolveDictionary(rawNode);
      const resources = node.has('Resources') ? node.get('Resources') : inheritedResources;
      const rotation = node.has('Rotate')
        ? optionalResolvedInteger(node.get('Rotate'), store, inheritedRotation)
        : inheritedRotation;
      if (isPdfName(node.get('Type'), 'Page') || !node.has('Kids')) {
        pages.push({ page: nextPage, dictionary: node, resources, rotation });
        nextPage += 1;
        return;
      }
      const kids = store.resolve(node.get('Kids'));
      if (!Array.isArray(kids)) throw new Error('/Pages 节点的 /Kids 不是数组');
      for (const kid of kids) {
        try {
          visit(kid, resources, rotation, depth + 1);
        } catch (error) {
          const skipped = pageTreeCount(kid, store);
          issues.push(`页树子节点无法读取：${errorMessage(error)}`);
          nextPage += skipped;
        }
      }
    } finally {
      if (identity !== null) active.delete(identity);
    }
  }

  visit(root, undefined, 0, 0);
  return { declaredPages: declared > 0 ? declared : nextPage - 1, pages, issues };
}

function pageTreeCount(rawNode: PdfValue, store: PdfObjectStore): number {
  try {
    const node = store.resolveDictionary(rawNode);
    if (isPdfName(node.get('Type'), 'Page') || !node.has('Kids')) return 1;
    return Math.max(0, optionalResolvedInteger(node.get('Count'), store, 0));
  } catch {
    return 0;
  }
}

function readResourceEvidence(
  rawResources: PdfValue | undefined,
  store: PdfObjectStore,
): ResourceEvidence {
  if (rawResources === undefined) {
    return { fonts: [], imageXObjectCount: 0, formStreams: [], issues: [] };
  }
  const fonts: FontMappingProbe[] = [];
  const formStreams: PdfObjectRecord[] = [];
  const issues: string[] = [];
  const visitedForms = new Set<string | PdfDictionary>();
  const imageObjects = new Set<string | PdfDictionary>();

  function visit(current: PdfValue, path: string): void {
    const resources = store.resolveDictionary(current);
    if (resources.has('Font')) {
      const fontDictionary = store.resolveDictionary(resources.get('Font'));
      for (const [resourceName, rawFont] of fontDictionary) {
        try {
          fonts.push(readFont(`${path}${resourceName}`, rawFont, store));
        } catch (error) {
          fonts.push({
            fontName: `${path}${resourceName}`,
            subtype: 'unknown',
            encoding: null,
            hasToUnicode: null,
            verdict: 'unknown',
          });
          issues.push(`字体 /${path}${resourceName} 无法读取：${errorMessage(error)}`);
        }
      }
    }
    if (!resources.has('XObject')) return;
    const xObjects = store.resolveDictionary(resources.get('XObject'));
    for (const [resourceName, rawXObject] of xObjects) {
      const identity = isPdfRef(rawXObject) ? pdfRefKey(rawXObject) : null;
      try {
        const record = isPdfRef(rawXObject) ? store.getRecord(rawXObject) : null;
        const xObject = store.resolveDictionary(rawXObject);
        if (isPdfName(xObject.get('Subtype'), 'Image')) {
          imageObjects.add(identity ?? xObject);
          continue;
        }
        if (!isPdfName(xObject.get('Subtype'), 'Form')) continue;
        const formIdentity: string | PdfDictionary = identity ?? xObject;
        if (visitedForms.has(formIdentity)) continue;
        visitedForms.add(formIdentity);
        if (record !== null && record.stream !== null) formStreams.push(record);
        if (xObject.has('Resources')) visit(xObject.get('Resources') as PdfValue, `${path}${resourceName}/`);
      } catch (error) {
        issues.push(`XObject /${path}${resourceName} 无法读取：${errorMessage(error)}`);
      }
    }
  }

  visit(rawResources, '');
  fonts.sort((left, right) => compareText(left.fontName, right.fontName));
  return { fonts, imageXObjectCount: imageObjects.size, formStreams, issues };
}

function readFont(fontName: string, rawFont: PdfValue, store: PdfObjectStore): FontMappingProbe {
  const font = store.resolveDictionary(rawFont);
  const subtype = pdfNameValue(resolveOptional(font.get('Subtype'), store)) ?? 'unknown';
  const encoding = font.has('Encoding') ? readEncoding(font.get('Encoding') as PdfValue, store) : null;
  const hasToUnicode = font.has('ToUnicode');
  const verdict = subtype === 'unknown'
    ? 'unknown'
    : subtype === 'Type0' && encoding === 'Identity-H' && !hasToUnicode
      ? 'not_mappable'
      : 'mappable';
  return { fontName, subtype, encoding, hasToUnicode, verdict };
}

function readEncoding(rawEncoding: PdfValue, store: PdfObjectStore): string {
  const resolved = store.resolve(rawEncoding);
  if (isPdfName(resolved)) return resolved.value;
  if (isPdfDictionary(resolved)) {
    const cMapName = pdfNameValue(resolveOptional(resolved.get('CMapName'), store));
    return cMapName ?? 'dictionary';
  }
  return 'other';
}

function readContentStreams(
  rawContents: PdfValue | undefined,
  store: PdfObjectStore,
): PdfObjectRecord[] {
  if (rawContents === undefined) return [];
  if (isPdfRef(rawContents)) {
    const record = store.getRecord(rawContents);
    if (record.stream !== null) return [record];
    return readContentStreams(record.value, store);
  }
  const resolved = store.resolve(rawContents);
  if (Array.isArray(resolved)) {
    return resolved.flatMap((value) => readContentStreams(value, store));
  }
  if (isPdfDictionary(resolved)) throw new Error('直接内容流没有可定位的 stream 字节');
  throw new Error('/Contents 既不是 stream 引用也不是数组');
}

function uniqueRecords(records: readonly PdfObjectRecord[]): PdfObjectRecord[] {
  const seen = new Set<string>();
  const unique: PdfObjectRecord[] = [];
  for (const record of records) {
    const key = `${record.objectNumber} ${record.generation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique;
}

/** 只识别 operator token；literal/hex string 中恰好出现 "Tj" 不算证据。 */
function scanContentOperators(data: Buffer): OperatorEvidence {
  let hasText = false;
  let hasDo = false;
  let cursor = 0;
  while (cursor < data.length) {
    const byte = data[cursor];
    if (isContentWhitespace(byte)) {
      cursor += 1;
      continue;
    }
    if (byte === 0x25) {
      cursor = skipComment(data, cursor + 1);
      continue;
    }
    if (byte === 0x28) {
      cursor = skipLiteralString(data, cursor + 1);
      continue;
    }
    if (byte === 0x3c && data[cursor + 1] !== 0x3c) {
      const end = data.indexOf(0x3e, cursor + 1);
      cursor = end < 0 ? data.length : end + 1;
      continue;
    }
    if (byte === 0x2f) {
      cursor = skipName(data, cursor + 1);
      continue;
    }
    if (isContentDelimiter(byte)) {
      cursor += data[cursor + 1] === byte && (byte === 0x3c || byte === 0x3e) ? 2 : 1;
      continue;
    }
    const start = cursor;
    while (cursor < data.length
      && !isContentWhitespace(data[cursor])
      && !isContentDelimiter(data[cursor])) cursor += 1;
    const token = data.subarray(start, cursor).toString('latin1');
    if (token === 'Tj' || token === 'TJ' || token === "'" || token === '"') hasText = true;
    else if (token === 'Do') hasDo = true;
    if (hasText && hasDo) return { hasText, hasDo };
  }
  return { hasText, hasDo };
}

function skipLiteralString(data: Buffer, start: number): number {
  let cursor = start;
  let depth = 1;
  while (cursor < data.length && depth > 0) {
    const byte = data[cursor];
    cursor += 1;
    if (byte === 0x5c) {
      if (data[cursor] === 0x0d && data[cursor + 1] === 0x0a) cursor += 2;
      else if (cursor < data.length) cursor += 1;
    } else if (byte === 0x28) depth += 1;
    else if (byte === 0x29) depth -= 1;
  }
  return cursor;
}

function skipComment(data: Buffer, start: number): number {
  let cursor = start;
  while (cursor < data.length && data[cursor] !== 0x0a && data[cursor] !== 0x0d) cursor += 1;
  return cursor;
}

function skipName(data: Buffer, start: number): number {
  let cursor = start;
  while (cursor < data.length
    && !isContentWhitespace(data[cursor])
    && !isContentDelimiter(data[cursor])) cursor += 1;
  return cursor;
}

function isContentWhitespace(byte: number): boolean {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isContentDelimiter(byte: number): boolean {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e
    || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d
    || byte === 0x2f || byte === 0x25;
}

function optionalResolvedInteger(
  value: PdfValue | undefined,
  store: PdfObjectStore,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const resolved = store.resolve(value);
  if (typeof resolved !== 'number' || !Number.isInteger(resolved)) {
    throw new Error('PDF 值不是整数');
  }
  return resolved;
}

function resolveOptional(value: PdfValue | undefined, store: PdfObjectStore): PdfValue | undefined {
  return value === undefined ? undefined : store.resolve(value);
}

function partialWarning(page: number, issues: readonly string[]): Warning {
  return {
    code: 'L0_PARTIAL',
    severity: 'info',
    scope: 'page',
    page,
    message: 'L0 仅产出部分结构证据；该页后续应退回统计证据',
    detail: { issues: [...new Set(issues)] },
  };
}

function unavailableArtifact(
  sourceSha256: string,
  encrypted: boolean,
  issues: readonly string[],
): ProbeDocumentArtifact {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.probeDocument,
    sourceSha256,
    pages: 0,
    encrypted,
    status: 'unavailable',
    pageProbes: [],
    warnings: [{
      code: 'L0_UNAVAILABLE',
      severity: 'warn',
      scope: 'doc',
      message: 'L0 无法读取文档结构；主解析流程继续且 Gate A 退回统计证据',
      detail: { issues: [...new Set(issues)] },
    }],
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
