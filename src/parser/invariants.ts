import type {
  ContentKindCounts,
  LayoutPageArtifact,
  PageFurnitureMode,
  ProbeCrossArtifact,
  ProbeDocumentArtifact,
  ProbePagesArtifact,
  ResultArtifact,
  SourceIndexArtifact,
  SourceLedgerArtifact,
} from '../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../schema/artifacts.ts';
import type {
  Annotation,
  Element,
  Mark,
  SourceIndexEntry,
  TableCell,
} from '../schema/element.ts';
import type { Warning } from '../schema/warnings.ts';
import { ROUTE_REASONS } from '../schema/reasons.ts';
import { describeLostKinds, summarizeLedgerPage } from './assemble/conservation.ts';
import { isFurnitureType } from './layout/furniture/index.ts';
import { PAGE_BBOX_TOLERANCE_PT } from './params/geometry.ts';
import { MIN_SOURCE_OBJECT_COVERAGE } from './params/ledger.ts';

export class InvariantViolationError extends Error {
  readonly invariant: string;

  constructor(invariant: string, message: string) {
    super(`${invariant}：${message}`);
    this.name = 'InvariantViolationError';
    this.invariant = invariant;
  }
}

export interface InvariantInputs {
  result: ResultArtifact;
  probeDocument: ProbeDocumentArtifact;
  probePages: ProbePagesArtifact;
  probeCross: ProbeCrossArtifact;
  layoutPages?: readonly LayoutPageArtifact[];
  sourceIndex: SourceIndexArtifact;
  sourceLedger: SourceLedgerArtifact;
  pageFurniture?: PageFurnitureMode;
}

/** emit 的常开自检；可恢复问题返回 warning，结构性破坏直接拒绝落成成功结果。 */
export function checkOutputInvariants(inputs: InvariantInputs): Warning[] {
  const {
    result,
    probeDocument,
    probePages,
    probeCross,
    layoutPages,
    sourceIndex,
    sourceLedger,
    pageFurniture,
  } = inputs;
  const warnings: Warning[] = [];
  const elements = [...result.elements, ...(result.furniture ?? [])];
  const elementIds = new Set(elements.map((element) => element.id));
  const sourceIds = new Set(sourceIndex.entries.map((entry) => entry.id));

  checkFurnitureMode(result, pageFurniture);
  checkAnchors(elements, sourceIds, warnings);
  checkAnnotations(result, sourceIds, warnings);
  checkOrder(elements);
  checkParents(elements, elementIds);
  checkHeadingLevels(elements, warnings);
  checkPageStatusWarnings(result);
  checkPagesAndBboxes(result, elements, warnings);
  checkTables(elements);
  checkReferences(elements, elementIds);
  checkEngineIndependentShape(elements);
  checkLocalValues(result, sourceIndex);
  checkProbeConsistency(result, probeDocument);
  checkPageProbeConsistency(result, probePages, probeCross, sourceIndex);
  if (layoutPages !== undefined) checkLayoutConsistency(result, layoutPages, sourceIndex);
  checkLedger(sourceIndex, sourceLedger, result, elements);
  checkMarks(elements);
  return warnings;
}

function checkFurnitureMode(
  result: ResultArtifact,
  mode: PageFurnitureMode | undefined,
): void {
  if (mode === undefined) return;
  const furnitureInElements = result.elements.filter((element) => isFurnitureType(element.type));
  if (mode === 'extract') {
    if (result.furniture === undefined) {
      throw new InvariantViolationError('I17', 'extract 模式必须产生顶层 furniture[]');
    }
    if (furnitureInElements.length > 0) {
      throw new InvariantViolationError('I17', 'extract 模式不得把家具留在 elements');
    }
    if (result.furniture.some((element) =>
      !isFurnitureType(element.type) || element.isBodyContent)) {
      throw new InvariantViolationError('I17', 'extract 模式的 furniture[] 只能含非正文家具元素');
    }
    return;
  }
  if (result.furniture !== undefined) {
    throw new InvariantViolationError('I17', `${mode} 模式不得产生顶层 furniture[]`);
  }
  const expectedBodyContent = mode === 'off';
  if (furnitureInElements.some((element) => element.isBodyContent !== expectedBodyContent)) {
    throw new InvariantViolationError(
      'I17',
      `${mode} 模式的家具 isBodyContent 必须为 ${expectedBodyContent}`,
    );
  }
}

function checkLayoutConsistency(
  result: ResultArtifact,
  layoutPages: readonly LayoutPageArtifact[],
  sourceIndex: SourceIndexArtifact,
): void {
  const expectedPages = result.pages.map((page) => page.index).sort((left, right) => left - right);
  const actualPages = layoutPages.map((page) => page.page).sort((left, right) => left - right);
  if (new Set(actualPages).size !== actualPages.length
    || JSON.stringify(actualPages) !== JSON.stringify(expectedPages)) {
    throw new InvariantViolationError('I16', 'layout_pages 与 result.json 页面集合不一致');
  }
  const sourcePages = new Map(sourceIndex.entries.map((entry) => [entry.id, entry.page]));
  const anchored = new Set<string>();
  for (const page of layoutPages) {
    const orders = page.regions.map((region) => region.readingOrder).sort((left, right) => left - right);
    for (let index = 0; index < orders.length; index += 1) {
      if (orders[index] !== index + 1) {
        throw new InvariantViolationError('I16', `第 ${page.page} 页 readingOrder 必须连续无重复`);
      }
    }
    for (const region of page.regions) {
      if (region.page !== page.page || region.sourceObjectIds.length === 0) {
        throw new InvariantViolationError('I16', `第 ${page.page} 页版面区域页码或锚点无效`);
      }
      for (const sourceObjectId of region.sourceObjectIds) {
        if (sourcePages.get(sourceObjectId) !== page.page) {
          throw new InvariantViolationError('I16', `版面区域锚点无法在同页解引用：${sourceObjectId}`);
        }
        if (anchored.has(sourceObjectId)) {
          throw new InvariantViolationError('I16', `源对象被多个版面区域引用：${sourceObjectId}`);
        }
        anchored.add(sourceObjectId);
      }
    }
  }
}

function checkProbeConsistency(
  result: ResultArtifact,
  probe: ProbeDocumentArtifact,
): void {
  if (probe.sourceSha256 !== result.source.sha256) {
    throw new InvariantViolationError('I15', 'probe_document.json 与 result.json 的源哈希不一致');
  }
  if (!Number.isInteger(probe.pages) || probe.pages < 0) {
    throw new InvariantViolationError('I15', 'probe_document.json.pages 必须是非负整数');
  }
  const pageNumbers = probe.pageProbes.map((page) => page.page);
  const uniquePages = new Set(pageNumbers);
  if (uniquePages.size !== pageNumbers.length) {
    throw new InvariantViolationError('I15', 'probe_document.json 页面重复');
  }
  for (const page of pageNumbers) {
    if (!Number.isInteger(page) || page < 1 || page > result.source.pages) {
      throw new InvariantViolationError('I15', `probe_document.json 页码越界：${page}`);
    }
  }
  if (probe.status === 'complete') {
    const expectedPages = Array.from({ length: result.source.pages }, (_, index) => index + 1);
    const actualPages = [...pageNumbers].sort((left, right) => left - right);
    if (probe.pages !== result.source.pages
      || JSON.stringify(actualPages) !== JSON.stringify(expectedPages)) {
      throw new InvariantViolationError(
        'I15',
        '完整 probe_document.json 必须与 result.json 页面集合一致',
      );
    }
    if (probe.encrypted !== result.source.encrypted) {
      throw new InvariantViolationError(
        'I15',
        '完整 probe_document.json 与 result.json 的加密状态不一致',
      );
    }
    if (probe.warnings.length > 0) {
      throw new InvariantViolationError('I15', 'complete L0 工件不得携带降级告警');
    }
  }
  if (probe.status === 'partial' && !probe.warnings.some((warning) => warning.code === 'L0_PARTIAL')) {
    throw new InvariantViolationError('I15', 'partial L0 工件缺少 L0_PARTIAL 告警');
  }
  if (probe.status === 'unavailable') {
    if (probe.pageProbes.length > 0) {
      throw new InvariantViolationError('I15', 'unavailable L0 工件不得声称有页级证据');
    }
    if (!probe.warnings.some((warning) => warning.code === 'L0_UNAVAILABLE')) {
      throw new InvariantViolationError('I15', 'unavailable L0 工件缺少 L0_UNAVAILABLE 告警');
    }
  }
  for (const warning of probe.warnings) {
    if (warning.code !== 'L0_PARTIAL' && warning.code !== 'L0_UNAVAILABLE') {
      throw new InvariantViolationError('I15', `L0 工件含非 L0 告警：${warning.code}`);
    }
    if (!result.warnings.some((persisted) => sameWarningIdentity(persisted, warning))) {
      throw new InvariantViolationError(
        'I15',
        `result.json 没有保留 L0 告警：${warning.code} ${warning.message}`,
      );
    }
  }
}

function checkPageProbeConsistency(
  result: ResultArtifact,
  pageProbe: ProbePagesArtifact,
  crossProbe: ProbeCrossArtifact,
  sourceIndex: SourceIndexArtifact,
): void {
  const resultPages = new Map(result.pages.map((page) => [page.index, page]));
  const probePages = new Map(pageProbe.pages.map((page) => [page.page, page]));
  if (probePages.size !== pageProbe.pages.length) {
    throw new InvariantViolationError('I16', 'probe_pages.json 页面重复');
  }
  if (probePages.size !== resultPages.size
    || [...resultPages.keys()].some((page) => !probePages.has(page))) {
    throw new InvariantViolationError('I16', 'probe_pages.json 与 result.json 页面集合不一致');
  }
  const sourcePages = new Map(sourceIndex.entries.map((entry) => [entry.id, entry.page]));
  for (const [pageNumber, page] of probePages) {
    const emitted = resultPages.get(pageNumber);
    if (emitted === undefined) continue;
    for (const key of PAGE_PROBE_SUMMARY_FIELDS) {
      if (JSON.stringify(page[key]) !== JSON.stringify(emitted.probe[key])) {
        throw new InvariantViolationError(
          'I16',
          `第 ${pageNumber} 页 ${String(key)} 在 probe_pages.json 与 result.json 不一致`,
        );
      }
    }
    const anchoredIds = [
      ...page.anchorObjectIds,
      ...page.evidence.flatMap((evidence) => evidence.sourceObjectIds),
    ];
    for (const sourceObjectId of anchoredIds) {
      if (sourcePages.get(sourceObjectId) !== pageNumber) {
        throw new InvariantViolationError(
          'I16',
          `第 ${pageNumber} 页探测证据无法在同页解引用：${sourceObjectId}`,
        );
      }
    }
  }
  for (const candidate of crossProbe.furniture) {
    if (new Set(candidate.pages).size !== candidate.pages.length
      || candidate.pages.length !== candidate.bboxes.length
      || candidate.pages.length !== candidate.sourceObjectIds.length) {
      throw new InvariantViolationError('I16', 'probe_cross.json 家具候选页、bbox 与锚点不等长');
    }
    for (let index = 0; index < candidate.pages.length; index += 1) {
      const page = candidate.pages[index];
      if (candidate.bboxes[index].page !== page
        || sourcePages.get(candidate.sourceObjectIds[index]) !== page) {
        throw new InvariantViolationError('I16', 'probe_cross.json 家具候选锚点无法在对应页解引用');
      }
    }
  }
  for (const candidate of crossProbe.continuations) {
    if (candidate.toPage !== candidate.fromPage + 1) {
      throw new InvariantViolationError('I16', 'probe_cross.json 续接候选必须连接相邻页');
    }
    for (const sourceObjectId of candidate.sourceObjectIds) {
      const page = sourcePages.get(sourceObjectId);
      if (page !== candidate.fromPage && page !== candidate.toPage) {
        throw new InvariantViolationError('I16', `跨页续接锚点无法解引用：${sourceObjectId}`);
      }
    }
  }
}

const PAGE_PROBE_SUMMARY_FIELDS = [
  'layoutType',
  'textLayerVerdict',
  'hasBrokenTextLayer',
  'hasOverlaidTextOnImage',
  'textDensity',
  'columns',
  'imageAreaRatio',
  'hasTable',
  'tableKind',
  'hasFormula',
  'hasChart',
  'hasRotatedText',
  'riskLevel',
  'structuralUncertainty',
  'recommendedEngines',
] as const;

function sameWarningIdentity(left: Warning, right: Warning): boolean {
  if (left.code !== right.code || left.severity !== right.severity
    || left.scope !== right.scope || left.message !== right.message) return false;
  if (left.scope === 'doc' || right.scope === 'doc') return left.scope === right.scope;
  if (left.page !== right.page) return false;
  if (left.scope === 'element' || right.scope === 'element') {
    return left.scope === 'element'
      && right.scope === 'element'
      && left.elementId === right.elementId;
  }
  return true;
}

function checkAnchors(
  elements: readonly Element[],
  sourceIds: ReadonlySet<string>,
  warnings: Warning[],
): void {
  for (const element of elements) {
    if (!element.sourceObjectIds?.length || element.sourceRasters !== undefined) {
      throw new InvariantViolationError('I1', `${element.id} 必须且只能携带 sourceObjectIds`);
    }
    for (const sourceObjectId of element.sourceObjectIds ?? []) {
      if (sourceIds.has(sourceObjectId)) continue;
      warnings.push({
        code: 'DANGLING_SOURCE_ANCHOR',
        severity: 'error',
        scope: 'element',
        page: element.page,
        elementId: element.id,
        message: `sourceObjectId 无法在 source_index.json 解引用：${sourceObjectId}`,
      });
    }

  }
}

/**
 * 批注与元素同规格：有唯一 id、有能解引用的溯源锚、页码合法。
 *
 * 它不进 elements，所以 I1/I2/I6 都扫不到它 —— 一份"元素全都合法"的输出完全
 * 可以同时把批注丢光，这正是批注最初根本没被抽取时的形态。
 */
function checkAnnotations(
  result: ResultArtifact,
  sourceIds: ReadonlySet<string>,
  warnings: Warning[],
): void {
  const seen = new Set<string>();
  for (const annotation of result.annotations) {
    if (seen.has(annotation.id)) {
      throw new InvariantViolationError('I13', `批注 id 重复：${annotation.id}`);
    }
    seen.add(annotation.id);
    if (annotation.page < 1 || annotation.page > result.source.pages) {
      throw new InvariantViolationError('I6', `批注 ${annotation.id}.page 越界：${annotation.page}`);
    }
    if (annotation.sourceObjectIds.length === 0) {
      warnings.push(annotationWarning(
        'NO_SOURCE_ANCHOR',
        annotation,
        '批注没有 sourceObjectIds 溯源锚',
      ));
    }
    for (const sourceObjectId of annotation.sourceObjectIds) {
      if (sourceIds.has(sourceObjectId)) continue;
      warnings.push(annotationWarning(
        'DANGLING_SOURCE_ANCHOR',
        annotation,
        `sourceObjectId 无法在 source_index.json 解引用：${sourceObjectId}`,
      ));
    }
  }
}

/** 批注不是元素，scope 只能到页；elementId 留给真正的元素，不许拿批注 id 冒充。 */
function annotationWarning(
  code: 'NO_SOURCE_ANCHOR' | 'DANGLING_SOURCE_ANCHOR',
  annotation: Annotation,
  message: string,
): Warning {
  return {
    code,
    severity: 'error',
    scope: 'page',
    page: annotation.page,
    message: `${annotation.id}：${message}`,
  };
}

function checkOrder(elements: readonly Element[]): void {
  const orders = elements.map((element) => element.order).sort((left, right) => left - right);
  for (let index = 0; index < orders.length; index += 1) {
    if (orders[index] !== index + 1) {
      throw new InvariantViolationError('I2', 'order 必须从 1 开始全局连续且无重复');
    }
  }
}

function checkParents(elements: readonly Element[], elementIds: ReadonlySet<string>): void {
  const parents = new Map(elements.map((element) => [element.id, element.parentId]));
  for (const element of elements) {
    if (element.parentId !== null && !elementIds.has(element.parentId)) {
      throw new InvariantViolationError('I3', `${element.id}.parentId 指向不存在元素`);
    }
    const visited = new Set<string>([element.id]);
    let cursor = element.parentId;
    while (cursor !== null) {
      if (visited.has(cursor)) throw new InvariantViolationError('I3', `${element.id} 的父链成环`);
      visited.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }
}

function checkHeadingLevels(elements: readonly Element[], warnings: Warning[]): void {
  let previousLevel = 0;
  for (const element of [...elements].sort((left, right) => left.order - right.order)) {
    if (element.type !== 'heading') continue;
    if (element.level > previousLevel + 1) {
      warnings.push({
        code: 'LOCAL_PARSE_FAILED',
        severity: 'warn',
        scope: 'element',
        page: element.page,
        elementId: element.id,
        message: `heading.level 从 ${previousLevel} 跳到 ${element.level}`,
      });
    }
    previousLevel = element.level;
  }
}

function checkPageStatusWarnings(result: ResultArtifact): void {
  for (const page of result.pages) {
    if (page.status === 'ok') continue;
    const explained = result.warnings.some((warning) => warning.scope !== 'doc' && warning.page === page.index);
    if (!explained) {
      throw new InvariantViolationError('I5', `第 ${page.index} 页为 ${page.status} 但没有页级告警`);
    }
  }
}

function checkPagesAndBboxes(
  result: ResultArtifact,
  elements: readonly Element[],
  warnings: Warning[],
): void {
  const pages = new Map(result.pages.map((page) => [page.index, page]));
  if (result.pages.length !== result.source.pages || result.pages.some((page, i) => page.index !== i + 1)) {
    throw new InvariantViolationError('I6', '页面集合必须从 1 连续到 source.pages');
  }
  for (const element of elements) {
    if (element.page < 1 || element.page > result.source.pages) {
      throw new InvariantViolationError('I6', `${element.id}.page 越界：${element.page}`);
    }
    const page = pages.get(element.page);
    if (!page) throw new InvariantViolationError('I6', `${element.id} 引用了缺失页面 ${element.page}`);
    if (isBboxValid(element.bbox, page.width, page.height)) continue;
    warnings.push({
      code: 'LOCAL_PARSE_FAILED',
      severity: 'warn',
      scope: 'element',
      page: element.page,
      elementId: element.id,
      message: `bbox 超出页面或没有面积：${JSON.stringify(element.bbox)}`,
    });
  }
}

function isBboxValid(
  bbox: readonly [number, number, number, number],
  width: number,
  height: number,
): boolean {
  const [x0, y0, x1, y1] = bbox;
  return [x0, y0, x1, y1].every(Number.isFinite)
    && x1 > x0
    && y1 > y0
    && x0 >= -PAGE_BBOX_TOLERANCE_PT
    && y0 >= -PAGE_BBOX_TOLERANCE_PT
    && x1 <= width + PAGE_BBOX_TOLERANCE_PT
    && y1 <= height + PAGE_BBOX_TOLERANCE_PT;
}

function checkTables(elements: readonly Element[]): void {
  for (const element of elements) {
    if (element.type !== 'table') continue;
    const { rows, cols, headerRows, headerCols, cells } = element.table;
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new InvariantViolationError('I8', `${element.id} 的表格行列数无效`);
    }
    if (!Number.isInteger(headerRows) || headerRows < 0 || headerRows > rows
      || !Number.isInteger(headerCols) || headerCols < 0 || headerCols > cols) {
      throw new InvariantViolationError('I8', `${element.id} 的表头行列数无效`);
    }
    const occupied = new Set<string>();
    for (const cell of cells) occupyCell(element.id, cell, rows, cols, occupied);
    if (occupied.size !== rows * cols) {
      throw new InvariantViolationError('I8', `${element.id} 的表格网格存在空洞`);
    }
    checkHeaderRows(element.id, rows, cols, headerRows, cells);
  }
}

function occupyCell(
  elementId: string,
  cell: TableCell,
  rows: number,
  cols: number,
  occupied: Set<string>,
): void {
  if (![cell.r, cell.c, cell.rowSpan, cell.colSpan].every(Number.isInteger)
    || cell.rowSpan <= 0 || cell.colSpan <= 0
    || cell.r < 0 || cell.c < 0
    || cell.r + cell.rowSpan > rows || cell.c + cell.colSpan > cols) {
    throw new InvariantViolationError('I8', `${elementId} 的单元格越界`);
  }
  if (typeof cell.text !== 'string') {
    throw new InvariantViolationError('I8', `${elementId} 的空单元格必须以空字符串表示`);
  }
  if (cell.isHeader !== (cell.role !== 'data')) {
    throw new InvariantViolationError('I8', `${elementId} 的单元格表头标记与 role 不一致`);
  }
  for (let row = cell.r; row < cell.r + cell.rowSpan; row += 1) {
    for (let col = cell.c; col < cell.c + cell.colSpan; col += 1) {
      const key = `${row}:${col}`;
      if (occupied.has(key)) throw new InvariantViolationError('I8', `${elementId} 的单元格重叠`);
      occupied.add(key);
    }
  }
}

/** C1：headerRows 恰好等于从第 0 行起连续的顶部表头行，表内 section header 不计。 */
function checkHeaderRows(
  elementId: string,
  rows: number,
  cols: number,
  headerRows: number,
  cells: readonly TableCell[],
): void {
  const topHeaderRows: boolean[] = [];
  for (let row = 0; row < rows; row += 1) {
    let topHeader = true;
    for (let col = 0; col < cols; col += 1) {
      const owner = cells.find((cell) =>
        row >= cell.r && row < cell.r + cell.rowSpan
        && col >= cell.c && col < cell.c + cell.colSpan);
      if (owner === undefined
        || !owner.isHeader
        || (owner.role !== 'column_header' && owner.role !== 'section_header')) {
        topHeader = false;
        break;
      }
    }
    topHeaderRows.push(topHeader);
  }
  let continuous = 0;
  while (continuous < topHeaderRows.length && topHeaderRows[continuous]) continuous += 1;
  if (continuous !== headerRows) {
    throw new InvariantViolationError(
      'I8',
      `${elementId}.headerRows 必须只计顶部连续表头行，期望 ${continuous}，实际 ${headerRows}`,
    );
  }
}

function checkReferences(elements: readonly Element[], elementIds: ReadonlySet<string>): void {
  for (const element of elements) {
    if (element.type === 'caption' && !elementIds.has(element.captionOf)) {
      throw new InvariantViolationError('I9', `${element.id}.captionOf 指向不存在元素`);
    }
    if (element.continuesFrom !== undefined
      && element.continuesFrom !== null
      && !elementIds.has(element.continuesFrom)) {
      throw new InvariantViolationError('I9', `${element.id}.continuesFrom 指向不存在元素`);
    }
  }
}

function checkEngineIndependentShape(elements: readonly Element[]): void {
  for (const element of elements) {
    for (const key of Object.keys(element)) {
      if (!ELEMENT_FIELDS.has(key)) {
        throw new InvariantViolationError('I11', `${element.id} 含引擎特有字段 ${key}`);
      }
    }
  }
}

const ELEMENT_FIELDS = new Set([
  'id', 'page', 'order', 'text', 'marks', 'style', 'bbox', 'bboxes', 'parentId', 'provenance',
  'confidence', 'continuesFrom', 'isBodyContent', 'sourceObjectIds', 'sourceRasters', 'type',
  'level', 'list', 'marker', 'depth', 'table', 'figure', 'captionOf', 'formula', 'code',
  'furnitureKind',
]);

function checkLedger(
  sourceIndex: SourceIndexArtifact,
  sourceLedger: SourceLedgerArtifact,
  result: ResultArtifact,
  elements: readonly Element[],
): void {
  const indexed = new Map(sourceIndex.entries.map((entry) => [entry.id, entry]));
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  const annotationsById = new Map(result.annotations.map((annotation) => [annotation.id, annotation]));
  const extractedFurnitureSourceIds = new Set(
    (result.furniture ?? []).flatMap((element) => element.sourceObjectIds ?? []),
  );
  const seen = new Set<string>();
  for (const entry of sourceLedger.entries) {
    const indexedEntry = indexed.get(entry.sourceObjectId);
    if (!indexedEntry) {
      throw new InvariantViolationError('I13', `账本包含未知源对象 ${entry.sourceObjectId}`);
    }
    if (indexedEntry.page !== entry.page) {
      throw new InvariantViolationError('I13', `源对象 ${entry.sourceObjectId} 入账页码错误`);
    }
    if (seen.has(entry.sourceObjectId)) {
      throw new InvariantViolationError('I13', `源对象重复入账 ${entry.sourceObjectId}`);
    }
    if (entry.disposition === 'represented') {
      const element = elementsById.get(entry.elementId);
      if (!element || !(element.sourceObjectIds ?? []).includes(entry.sourceObjectId)) {
        throw new InvariantViolationError(
          'I13',
          `源对象 ${entry.sourceObjectId} 的 represented 目标无法反向解引用`,
        );
      }
    }
    if (entry.disposition === 'recorded') {
      const annotation = annotationsById.get(entry.annotationId);
      if (!annotation || !annotation.sourceObjectIds.includes(entry.sourceObjectId)) {
        throw new InvariantViolationError(
          'I13',
          `源对象 ${entry.sourceObjectId} 的 recorded 目标无法反向解引用`,
        );
      }
    }
    if (entry.disposition === 'suppressed'
      && !extractedFurnitureSourceIds.has(entry.sourceObjectId)) {
      throw new InvariantViolationError(
        'I13',
        `源对象 ${entry.sourceObjectId} 被 suppressed 但不属于顶层 furniture[]`,
      );
    }
    if (entry.disposition === 'unrepresentable') {
      const warned = result.warnings.some(
        (warning) => warning.code === 'UNREPRESENTABLE_CONTENT'
          && warning.scope !== 'doc'
          && warning.page === entry.page,
      );
      if (!warned) {
        throw new InvariantViolationError(
          'I13',
          `源对象 ${entry.sourceObjectId} 不可表示但没有 UNREPRESENTABLE_CONTENT 告警`,
        );
      }
    }
    seen.add(entry.sourceObjectId);
  }
  for (const sourceObjectId of indexed.keys()) {
    if (!seen.has(sourceObjectId)) {
      throw new InvariantViolationError('I13', `源对象没有入账 ${sourceObjectId}`);
    }
  }
  const ledgerBySource = new Map(sourceLedger.entries.map((entry) => [entry.sourceObjectId, entry]));
  for (const sourceObjectId of extractedFurnitureSourceIds) {
    if (ledgerBySource.get(sourceObjectId)?.disposition !== 'suppressed') {
      throw new InvariantViolationError(
        'I13',
        `顶层家具源对象 ${sourceObjectId} 必须以 suppressed 入账`,
      );
    }
  }
  const ledgerPageNumbers = sourceLedger.pages.map((page) => page.page).sort((left, right) => left - right);
  const expectedPageNumbers = Array.from(
    { length: result.source.pages },
    (_, index) => index + 1,
  );
  if (JSON.stringify(ledgerPageNumbers) !== JSON.stringify(expectedPageNumbers)) {
    throw new InvariantViolationError('I13', '账本页级汇总必须逐页存在且无重复');
  }
  // 逐页 filter 是页数 × 源对象数的二次方扫描；先按页分桶再逐页取。
  const entriesByPage = groupByPage(sourceLedger.entries, (entry) => entry.page);
  const indexedByPage = groupByPage(sourceIndex.entries, (entry) => entry.page);
  const resultPages = new Map(result.pages.map((page) => [page.index, page]));
  for (const page of sourceLedger.pages) {
    const pageEntries = entriesByPage.get(page.page) ?? [];
    const indexedObjects = (indexedByPage.get(page.page) ?? []).length;
    const expected = summarizeLedgerPage(
      page.page,
      pageEntries,
      page.contentOperators,
      page.sourceObjectsByKind,
    );
    if (page.sourceObjects !== indexedObjects
      || page.sourceObjects !== expected.sourceObjects
      || page.coveredObjects !== expected.coveredObjects
      || Math.abs(page.sourceObjectCoverage - expected.sourceObjectCoverage) > Number.EPSILON) {
      throw new InvariantViolationError('I13', `第 ${page.page} 页账本汇总与明细不一致`);
    }
    if (resultPages.get(page.page)?.sourceObjectCoverage !== page.sourceObjectCoverage) {
      throw new InvariantViolationError('I13', `第 ${page.page} 页 result 覆盖率与账本不一致`);
    }
    const emittedByKind = countByKind(indexedByPage.get(page.page) ?? []);
    if (!sameKindCounts(page.sourceObjectsByKind, emittedByKind)) {
      throw new InvariantViolationError(
        'I13',
        `第 ${page.page} 页账本的分类计数与 source_index.json 不符`,
      );
    }
    const lost = describeLostKinds(page.contentOperators, page.sourceObjectsByKind);
    if (lost.length > 0) {
      requireLossRecorded(result, resultPages, page.page, `整类缺失：${lost.join('；')}`);
    }
    if (page.sourceObjectCoverage < MIN_SOURCE_OBJECT_COVERAGE) {
      requireLossRecorded(result, resultPages, page.page, '覆盖率低于阈值');
    }
  }
}

/** 缺口必须同时体现在页状态和告警上，只发其一等于把内容丢失藏进报告里。 */
function requireLossRecorded(
  result: ResultArtifact,
  resultPages: ReadonlyMap<number, ResultArtifact['pages'][number]>,
  page: number,
  what: string,
): void {
  const resultPage = resultPages.get(page);
  const warned = result.warnings.some(
    (warning) => warning.code === 'SOURCE_OBJECT_LOSS'
      && warning.scope !== 'doc'
      && warning.page === page,
  );
  if (!resultPage || resultPage.status === 'ok' || !warned) {
    throw new InvariantViolationError(
      'I13',
      `第 ${page} 页${what}，但未 degraded 并记录 SOURCE_OBJECT_LOSS`,
    );
  }
}

function groupByPage<T>(items: readonly T[], pageOf: (item: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const item of items) {
    const page = pageOf(item);
    const bucket = grouped.get(page);
    if (bucket) bucket.push(item);
    else grouped.set(page, [item]);
  }
  return grouped;
}

function countByKind(entries: readonly SourceIndexEntry[]): ContentKindCounts {
  const counts: ContentKindCounts = { text: 0, path: 0, image: 0, annotation: 0 };
  for (const entry of entries) {
    if (entry.kind === 't') counts.text += 1;
    else if (entry.kind === 'i') counts.image += 1;
    else if (entry.kind === 'a') counts.annotation += 1;
    else counts.path += 1;
  }
  return counts;
}

function sameKindCounts(left: ContentKindCounts, right: ContentKindCounts): boolean {
  return left.text === right.text
    && left.path === right.path
    && left.image === right.image
    && left.annotation === right.annotation;
}

function checkMarks(elements: readonly Element[]): void {
  for (const element of elements) {
    const byType = new Map<Mark['type'], Mark[]>();
    for (const mark of element.marks ?? []) {
      if (!Number.isInteger(mark.start) || !Number.isInteger(mark.end)
        || mark.start < 0 || mark.start >= mark.end || mark.end > element.text.length
        || splitsSurrogatePair(element.text, mark.start)
        || splitsSurrogatePair(element.text, mark.end)) {
        throw new InvariantViolationError('I14', `${element.id} 的 marks 区间无效`);
      }
      const existing = byType.get(mark.type);
      if (existing) existing.push(mark);
      else byType.set(mark.type, [mark]);
    }
    for (const marks of byType.values()) {
      marks.sort((left, right) => left.start - right.start || left.end - right.end);
      for (let index = 1; index < marks.length; index += 1) {
        if (marks[index].start < marks[index - 1].end) {
          throw new InvariantViolationError('I14', `${element.id} 有同类型重叠 marks`);
        }
      }
    }
  }
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** IL5 收紧值域，同时对弱锚、付费计数与遗留模型血缘做硬拒绝。 */
function checkLocalValues(result: ResultArtifact, sourceIndex: SourceIndexArtifact): void {
  if (sourceIndex.sourceSha256 !== result.source.sha256
    || new Set(sourceIndex.entries.map(e => e.id)).size !== sourceIndex.entries.length) {
    throw new InvariantViolationError('I10', '源索引哈希不一致或 id 重复');
  }
  if (result.stats.usd !== 0 || result.stats.weakAnchorShare !== 0 || result.profile !== 'balanced') {
    throw new InvariantViolationError('IL5', '本地版只允许零费用、零弱锚和固定 balanced 兼容值');
  }
  for (const page of result.pages) {
    const route = page.route;
    if (route.plan.role !== 'parser' || route.plan.tier !== 'local'
      || JSON.stringify(route.planned) !== '["local"]' || JSON.stringify(route.actual) !== '["local"]'
      || route.oracleAccepted !== null || route.fallbackFrom !== null
      || route.disposition !== (page.status === 'ok' ? 'executed_as_planned' : 'degraded_no_model')
      || page.cost.usd !== 0 || page.cost.inputTokens !== 0 || page.cost.outputTokens !== 0
      || route.reason.some(reason => !ROUTE_REASONS.includes(reason))) {
      throw new InvariantViolationError('IL5', `第 ${page.index} 页不满足本地版固定值`);
    }
  }
  const sourceIds = new Set(sourceIndex.entries.map(e => e.id));
  const elements = [...result.elements, ...(result.furniture ?? [])];
  if (new Set(elements.map(e => e.id)).size !== elements.length) {
    throw new InvariantViolationError('I3', '元素 id 重复');
  }
  for (const element of elements) {
    if (element.provenance.content.role !== 'parser'
      || element.provenance.content.engine !== 'pdfjs-6.2.108'
      || element.provenance.layout.modelCallId !== undefined
      || (!element.provenance.layout.engine.startsWith('local-')
        && element.provenance.layout.engine !== 'l2-cross-page-furniture-v1')
      || element.sourceRasters !== undefined
      || (element.type === 'formula' && element.formula.latex !== undefined)) {
      throw new InvariantViolationError('IL5', `${element.id} 携带非本地值`);
    }
    for (const box of element.bboxes ?? []) {
      const page = result.pages[box.page - 1];
      if (!page || !isBboxValid(box.bbox, page.width, page.height)) throw new InvariantViolationError('I7', `${element.id} 跨页 bbox 无效`);
    }
    if (element.type === 'table') for (const cell of element.table.cells) {
      if (cell.sourceRasters !== undefined || cell.sourceObjectIds?.some(id => !sourceIds.has(id))) {
        throw new InvariantViolationError('I10', `${element.id} 单元格溯源无效`);
      }
      const page = result.pages[(cell.page ?? element.page) - 1];
      if (!page || !isBboxValid(cell.bbox, page.width, page.height)) throw new InvariantViolationError('I7', `${element.id} 单元格 bbox 无效`);
    }
  }
}
