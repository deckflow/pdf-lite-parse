import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  DocumentModelArtifact, LayoutPageArtifact, MetadataArtifact, PageProbe, ParseRawPageArtifact,
  ProbeDocumentArtifact, ProbePagesArtifact, ResolvedRunConfig, ResultArtifact,
  SourceIndexArtifact, WarningsArtifact, SourceLedgerArtifact,
} from '../schema/artifacts.ts';
import { ARTIFACT_SCHEMA_VERSIONS } from '../schema/artifacts.ts';
import { SCHEMA_VERSION, type PageProbeSummary } from '../schema/element.ts';
import type { Warning } from '../schema/warnings.ts';
import { defaultRunConfig } from './config.ts';
import { assembleWithPageIsolation } from './assemble/index.ts';
import { layoutPage } from './layout/index.ts';
import { documentTextProfile } from './layout/text-profile.ts';
import { checkOutputInvariants } from './invariants.ts';
import { probePages } from './probe/l1/index.ts';
import { probeCrossPage } from './probe/l2/index.ts';
import { evaluatePageVerdict, verdictWarnings, type PageVerdict } from './verdict.ts';
import type { ParsedPage } from './parse/pdfjs.ts';
import { compositeFigureAssetRequests, type MaterializedFigureAsset } from './parse/figure-asset.ts';
import { ASSET_DIRECTORY } from './params/raster.ts';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from './params/limits.ts';
import { WORKER_PROTOCOL_VERSION, type InspectedPdf, type SerializedPageImageAsset, type SerializedPageRasterResult } from './worker/protocol.ts';
import { runPdfTask } from './worker/runner.ts';
import { ResourceIsolationError, resourceLimitWarning, type SupervisorFailure } from './worker/supervisor.ts';
import { createPrivateArtifactDirectory, discardArtifactStaging, publishArtifactDirectory, validateArtifactStaging } from './emit/atomic-directory.ts';
import { renderMarkdown } from './render/markdown.ts';
import { MissingFieldError } from './render/strict.ts';
import { canonicalPath, containsPath } from './emit/path-safety.ts';

export interface ParsePipelineOptions {
  config?: Partial<ResolvedRunConfig>;
  password?: string;
}
export interface EmittedArtifacts {
  result: ResultArtifact;
  warnings: WarningsArtifact;
  metadata: MetadataArtifact;
  sourceIndex: SourceIndexArtifact;
  sourceLedger: SourceLedgerArtifact;
}
export interface ParsePipelineResult {
  outputDirectory: string;
  artifacts: EmittedArtifacts;
  pages: number;
  elements: number;
  warnings: number;
  hasErrorWarnings: boolean;
}
export class PdfOpenError extends Error {
  readonly code: 'ENCRYPTED_PDF_PASSWORD_REQUIRED' | 'LOCAL_PARSE_FAILED';
  constructor(message: string, code: PdfOpenError['code']) {
    super(message); this.name = 'PdfOpenError'; this.code = code;
  }
}

/** 输出先在私有目录完成校验，再整体替换旧结果，失败不会留下看似成功的半成品。 */
export async function runParsePipeline(inputPath: string, outputDirectory: string, options: ParsePipelineOptions = {}): Promise<ParsePipelineResult> {
  const sourcePath = resolve(inputPath);
  const target = resolve(outputDirectory);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new TypeError('输出路径必须是目录');
    if (readdirSync(target).length > 0) {
      const marker = join(target, 'result.json');
      if (!existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).schemaVersion !== SCHEMA_VERSION) {
        throw new TypeError('输出目录非空且不是 result.v3 工件目录，拒绝覆盖');
      }
    }
  }
  if (containsPath(target, sourcePath) || containsPath(canonicalPath(target), realpathSync(sourcePath))) {
    throw new TypeError('输出目录不能包含源 PDF，否则发布工件会覆盖输入');
  }
  const config = defaultRunConfig(options.config);
  const staging = createPrivateArtifactDirectory(target);
  try {
    const parsed = await runInStaging(sourcePath, staging, config, options);
    validateArtifactStaging(staging);
    publishArtifactDirectory(staging, target);
    return { ...parsed, outputDirectory: target };
  } catch (error) {
    discardArtifactStaging(staging);
    throw error;
  }
}

async function runInStaging(sourcePath: string, out: string, config: ResolvedRunConfig, options: ParsePipelineOptions): Promise<ParsePipelineResult> {
  const started = performance.now();
  const timings: Record<string, number> = {};
  const limits = config.isolate ? { ...DEFAULT_RESOURCE_LIMITS }
    : Object.fromEntries(Object.keys(DEFAULT_RESOURCE_LIMITS).map(key => [key, null])) as unknown as ResourceLimits;
  const inputBytes = statSync(sourcePath).size;
  if (limits.maxInputBytes !== null && inputBytes > limits.maxInputBytes) throw new ResourceIsolationError('输入超过 512 MB 默认资源限额');
  const bytes = readFileSync(sourcePath);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  // 所有 worker 读取同一份不可变快照，源文件在运行中被替换不会污染溯源哈希。
  const snapshotPath = join(out, '.input.pdf');
  writeFileSync(snapshotPath, bytes, { mode: 0o600 });
  const base = { protocolVersion: WORKER_PROTOCOL_VERSION, inputPath: snapshotPath, limits, ...(options.password === undefined ? {} : { password: options.password }) };
  let tick = performance.now();
  const inspectedOutcome = await runPdfTask<InspectedPdf>({ ...base, kind: 'inspect_pdf' }, config.isolate);
  if (!inspectedOutcome.ok) {
    if (inspectedOutcome.failure.workerFailure?.errorType === 'PasswordException') {
      throw new PdfOpenError('PDF 已加密，请使用正确的 --password 口令。', 'ENCRYPTED_PDF_PASSWORD_REQUIRED');
    }
    if (['timeout', 'memory', 'resource_limit'].includes(inspectedOutcome.failure.kind)) throw new ResourceIsolationError(inspectedOutcome.failure.message);
    throw new PdfOpenError(inspectedOutcome.failure.message, 'LOCAL_PARSE_FAILED');
  }
  const inspected = inspectedOutcome.value;
  timings.open = elapsed(tick);
  tick = performance.now();
  const probed = await runPdfTask<ProbeDocumentArtifact>({ ...base, kind: 'probe_document', sourceSha256 }, config.isolate);
  let documentProbe = probed.ok ? probed.value : unavailableProbe(sourceSha256, probed.failure);
  // pdf.js 是页集合的权威；best-effort L0 的不一致不能使成功抽出的正文无法交付。
  if (documentProbe.status === 'complete' && (documentProbe.pages !== inspected.pages || documentProbe.encrypted !== inspected.encrypted)) {
    documentProbe = { ...documentProbe, status: 'partial', pages: inspected.pages, encrypted: inspected.encrypted,
      pageProbes: documentProbe.pageProbes.filter(p => p.page <= inspected.pages),
      warnings: [{ code: 'L0_PARTIAL', severity: 'info', scope: 'doc', message: 'L0 与 pdf.js 文档结构不一致，已采用 pdf.js 页集合。' }] };
  }
  timings.probeDocument = elapsed(tick);
  const warnings: Warning[] = [...documentProbe.warnings, ...inspected.properties.warnings];
  if (inspected.encrypted) warnings.push({ code: 'ENCRYPTED_PDF_OPENED', severity: 'info', scope: 'doc', message: '已使用口令打开加密 PDF；口令不会写入输出。' });
  mkdirSync(join(out, ASSET_DIRECTORY));
  tick = performance.now();
  const parsedPages: ParsedPage[] = [];
  const pageCosts: number[] = [];
  let acceptedObjects = 0;
  let acceptedBytes = 0;
  for (let page = 1; page <= inspected.pages; page++) {
    const pageStarted = performance.now();
    const outcome = await runPdfTask<ParsedPage>({ ...base, kind: 'parse_page', page }, config.isolate);
    if (!outcome.ok) {
      const warning = failureWarning(page, outcome.failure);
      const failed = failedParsedPage(page, warning);
      const geometry = await runPdfTask<{ width: number; height: number; rotation: number }>({ ...base, kind: 'page_geometry', page }, config.isolate);
      if (geometry.ok) Object.assign(failed.artifact, geometry.value);
      parsedPages.push(failed);
    } else {
      const nextObjects = acceptedObjects + outcome.value.artifact.objects.length;
      const nextBytes = acceptedBytes + Buffer.byteLength(JSON.stringify(outcome.value));
      const exceeded = (limits.maxObjects !== null && nextObjects > limits.maxObjects)
        || (limits.maxTotalDecompressedBytes !== null && nextBytes > limits.maxTotalDecompressedBytes)
        || (limits.maxCompressionRatio !== null && nextBytes / Math.max(inputBytes, 1) > limits.maxCompressionRatio);
      if (exceeded) parsedPages.push(failedParsedPage(page, {
        code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', scope: 'page', page,
        message: '文档累计对象或解压字节超过默认资源限额，已隔离本页。',
      }));
      else { acceptedObjects = nextObjects; acceptedBytes = nextBytes; parsedPages.push(outcome.value); }
    }
    pageCosts.push(elapsed(pageStarted));
  }
  const rawPages = parsedPages.map(p => p.artifact);
  for (const raw of rawPages) {
    const images = raw.objects.filter(object => object.kind === 'image');
    if (images.length === 0) continue;
    const extracted = await runPdfTask<SerializedPageImageAsset[]>({ ...base, kind: 'extract_page_images', page: raw.page }, config.isolate);
    const byId = new Map(extracted.ok ? extracted.value.map(asset => [asset.sourceObjectId, asset]) : []);
    for (const object of images) {
      const asset = byId.get(object.id);
      if (asset === undefined) {
        warnings.push({ code: 'UNREPRESENTABLE_CONTENT', severity: 'warn', scope: 'page', page: raw.page, message: `图像 ${object.id} 无法抽成资源，已保留源锚且 assetPath 为 null。` });
      } else {
        object.assetPath = `${ASSET_DIRECTORY}/${object.id}.png`;
        writeFileSync(join(out, object.assetPath), Buffer.from(asset.bytesBase64, 'base64'));
      }
    }
  }
  const sourceIndex: SourceIndexArtifact = { schemaVersion: ARTIFACT_SCHEMA_VERSIONS.sourceIndex, sourceSha256, entries: parsedPages.flatMap(p => p.sourceIndexEntries) };
  timings.parse = elapsed(tick);
  tick = performance.now();
  const pageProbe = probePages(rawPages, documentProbe, inspected.properties.info.lang);
  timings.probePage = elapsed(tick);
  tick = performance.now();
  const crossProbe = probeCrossPage(rawPages, pageProbe);
  timings.probeCross = elapsed(tick);
  tick = performance.now();
  const context = { textProfile: documentTextProfile(rawPages), overlaidText: config.overlaidText };
  const layouts = rawPages.map((raw, index): LayoutPageArtifact => {
    try { return layoutPage(raw, pageProbe.pages[index], crossProbe, context); }
    catch {
      // 局部版面异常时原生对象仍可交付，不让一页坏版面阻断其余页。
      const warning: Warning = { code: 'LOCAL_PARSE_FAILED', severity: 'error', scope: 'page', page: raw.page, message: '本页版面解析异常，保留逐源对象结果并继续后续页。' };
      return { schemaVersion: ARTIFACT_SCHEMA_VERSIONS.layoutPage, page: raw.page, width: raw.width, height: raw.height, rotation: raw.rotation,
        warnings: [warning], regions: raw.objects.filter(o => o.kind === 'image' || (o.kind === 'text' && o.text.length > 0)).map((o, i) => ({
          id: `fallback_${o.id}`, page: raw.page, type: o.kind === 'image' ? 'figure' : 'unknown', bbox: o.bbox,
          readingOrder: i + 1, confidence: 0.5, sourceObjectIds: [o.id], classificationEngine: 'local-source-fallback',
        })) };
    }
  });
  timings.layout = elapsed(tick);
  tick = performance.now();
  const verdicts = rawPages.map((raw, index) => evaluatePageVerdict({ rawPage: raw, layoutPage: layouts[index], pageProbe: pageProbe.pages[index], crossProbe, overlaidText: config.overlaidText }, inspected.encrypted));
  for (let i = 0; i < verdicts.length; i++) {
    const verdict = verdicts[i];
    pageProbe.pages[i].structuralUncertainty = verdict.layoutUncertainty;
    pageProbe.pages[i].recommendedEngines = verdict.wouldEscalateInFullVersion === false ? ['pdfjs'] : ['pdfjs', verdict.wouldEscalateInFullVersion];
    warnings.push(...verdictWarnings(i + 1, verdict));
  }
  timings.verdict = elapsed(tick);
  tick = performance.now();
  const figureAssets: MaterializedFigureAsset[] = [];
  for (const request of compositeFigureAssetRequests(rawPages, layouts, config.overlaidText)) {
    const crop = await runPdfTask<SerializedPageRasterResult>({ ...base, kind: 'raster_region', page: request.page, bbox: request.bbox }, config.isolate);
    if (crop.ok && crop.value.status === 'ok') {
      writeFileSync(join(out, request.assetPath), Buffer.from(crop.value.raster.bytesBase64, 'base64'));
      figureAssets.push({ ...request, renderDpi: crop.value.raster.renderDpi });
    } else warnings.push({ code: 'PAGE_RENDER_FAILED', severity: 'warn', scope: 'page', page: request.page,
      message: '复合图裁剪不可用，已退回原始图像并保留图内文字溯源。',
      detail: { regionId: request.regionId, causes: crop.ok ? crop.value.warnings.map(w => w.code) : [crop.failure.kind] } });
  }
  const assembly = assembleWithPageIsolation({ sourceSha256, encrypted: inspected.encrypted, rawPages, layoutPages: layouts,
    probeCross: crossProbe, pageFurniture: config.pageFurniture, overlaidText: config.overlaidText, figureAssets,
    docInfo: inspected.properties.info, outline: inspected.properties.outline });
  layouts.splice(0, layouts.length, ...assembly.layoutPages);
  warnings.push(...assembly.warnings);
  for (const element of [...assembly.documentModel.elements, ...(assembly.documentModel.furniture ?? [])]) {
    if ((element.type === 'figure' || element.type === 'chart') && element.figure.assetPath === null) {
      warnings.push({ code: 'UNREPRESENTABLE_CONTENT', severity: 'warn', scope: 'page', page: element.page,
        message: '图形未能导出为图片，已保留可提取文字与源锚；文字占位不代表完整视觉内容。',
        detail: { elementId: element.id, kind: element.figure.kind, sourceObjectIds: element.sourceObjectIds } });
    }
  }
  for (const page of assembly.documentModel.pages) {
    const pageWarnings = warnings.filter(w => w.scope !== 'doc' && w.page === page.index);
    if (pageWarnings.some(w => w.severity === 'error')) page.status = 'failed';
    else if (page.status !== 'failed' && (pageWarnings.some(w => w.severity === 'warn') || verdicts[page.index - 1].status === 'degraded')) page.status = 'degraded';
  }
  timings.assemble = elapsed(tick);
  tick = performance.now();
  const result = makeResult(sourcePath, assembly.documentModel, warnings, pageProbe, verdicts, pageCosts, config, elapsed(started));
  result.warnings.push(...checkOutputInvariants({ result, probeDocument: documentProbe, probePages: pageProbe, probeCross: crossProbe,
    layoutPages: layouts, sourceIndex, sourceLedger: assembly.sourceLedger, pageFurniture: config.pageFurniture }));
  for (const warning of result.warnings) if (warning.scope !== 'doc' && warning.severity !== 'info') {
    const page = result.pages[warning.page - 1];
    if (warning.severity === 'error') page.status = 'failed';
    else if (page.status === 'ok') page.status = 'degraded';
    page.route.disposition = 'degraded_no_model';
    assembly.documentModel.pages[warning.page - 1].status = page.status;
  }
  if (config.render) {
    const rendered = renderMarkdown(result);
    if (rendered.missingFields.length) throw new MissingFieldError('result', 'render', '结果缺字段，无法严格渲染');
    writeFileSync(join(out, 'output.md'), rendered.markdown);
  }
  rmSync(snapshotPath);
  const metadata: MetadataArtifact = {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.metadata, parserVersion: '0.1.0', sourceSha256,
    runConfig: config, resolvedConfigSha256: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    artifactVersions: { ...ARTIFACT_SCHEMA_VERSIONS }, timingsMs: timings, stats: result.stats,
  };
  const artifacts: EmittedArtifacts = { result, warnings: { schemaVersion: ARTIFACT_SCHEMA_VERSIONS.warnings, warnings: result.warnings }, metadata, sourceIndex, sourceLedger: assembly.sourceLedger };
  if (config.debug) {
    writeJson(join(out, 'source_ledger.json'), assembly.sourceLedger);
    writeJson(join(out, 'probe_document.json'), documentProbe);
    writeJson(join(out, 'probe_pages.json'), pageProbe);
    writeJson(join(out, 'probe_cross.json'), crossProbe);
    writeJson(join(out, 'document_model.json'), assembly.documentModel);
    for (const [directory, pages] of [['parse_raw', rawPages], ['layout_pages', layouts]] as const) {
      mkdirSync(join(out, directory));
      for (const page of pages) writeJson(join(out, directory, `${String(page.page).padStart(4, '0')}.json`), page);
    }
  }
  timings.emit = elapsed(tick);
  result.stats.totalMs = elapsed(started);
  writeJson(join(out, 'result.json'), result);
  writeJson(join(out, 'warnings.json'), artifacts.warnings);
  writeJson(join(out, 'metadata.json'), metadata);
  writeJson(join(out, 'source_index.json'), sourceIndex);
  return { outputDirectory: out, artifacts, pages: result.pages.length, elements: result.elements.length, warnings: result.warnings.length,
    hasErrorWarnings: result.pages.some(p => p.status === 'failed') || result.warnings.some(w => w.severity === 'error') };
}

function makeResult(sourcePath: string, document: DocumentModelArtifact, warnings: Warning[], probes: ProbePagesArtifact,
  verdicts: PageVerdict[], pageCosts: number[], config: ResolvedRunConfig, totalMs: number): ResultArtifact {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSIONS.result, version: SCHEMA_VERSION,
    source: { ...document.source, ...(config.includeSourcePath ? { path: sourcePath } : {}) }, profile: 'balanced',
    docInfo: document.docInfo, outline: document.outline, elements: document.elements,
    ...(document.furniture === undefined ? {} : { furniture: document.furniture }), annotations: document.annotations,
    pages: document.pages.map((page, i) => ({ ...page, probe: probeSummary(probes.pages[i]), route: {
      plan: { role: 'parser', tier: 'local' }, disposition: page.status === 'ok' ? 'executed_as_planned' : 'degraded_no_model',
      planned: ['local'], actual: ['local'], fallbackFrom: null, oracleAccepted: null, reason: verdicts[i].reasons,
    }, cost: { ms: pageCosts[i], inputTokens: 0, outputTokens: 0, usd: 0 } })),
    warnings, stats: { totalMs, byEngine: { local: { pages: document.pages.length } }, usd: 0, weakAnchorShare: 0 },
  };
}
function failureWarning(page: number, failure: SupervisorFailure): Warning {
  return ['timeout', 'memory', 'resource_limit'].includes(failure.kind)
    ? { ...resourceLimitWarning(page, failure), severity: 'error' }
    : { code: 'LOCAL_PARSE_FAILED', severity: 'error', scope: 'page', page, message: '本地解析异常，已隔离本页并继续其余页面。', detail: { failureKind: failure.kind } };
}
function failedParsedPage(page: number, warning: Warning): ParsedPage {
  return { artifact: { schemaVersion: ARTIFACT_SCHEMA_VERSIONS.parseRaw, page, width: 0, height: 0, rotation: 0,
    objects: [], contentOperators: { text: 0, path: 0, image: 0, annotation: 0 }, warnings: [warning] }, sourceIndexEntries: [] };
}
function unavailableProbe(sourceSha256: string, failure: SupervisorFailure): ProbeDocumentArtifact {
  return { schemaVersion: ARTIFACT_SCHEMA_VERSIONS.probeDocument, sourceSha256, pages: 0, encrypted: false,
    status: 'unavailable', pageProbes: [], warnings: [{ code: 'L0_UNAVAILABLE', severity: 'warn', scope: 'doc', message: 'L0 结构扫描不可用，已退回页级统计证据。', detail: { failureKind: failure.kind } }] };
}
function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function elapsed(started: number): number { return Math.round((performance.now() - started) * 1000) / 1000; }

function probeSummary(probe: PageProbe): PageProbeSummary {
  return {
    layoutType: probe.layoutType,
    textLayerVerdict: probe.textLayerVerdict,
    hasBrokenTextLayer: probe.hasBrokenTextLayer,
    hasOverlaidTextOnImage: probe.hasOverlaidTextOnImage,
    textDensity: probe.textDensity,
    columns: probe.columns,
    imageAreaRatio: probe.imageAreaRatio,
    hasTable: probe.hasTable,
    tableKind: probe.tableKind,
    hasFormula: probe.hasFormula,
    hasChart: probe.hasChart,
    hasRotatedText: probe.hasRotatedText,
    riskLevel: probe.riskLevel,
    structuralUncertainty: probe.structuralUncertainty,
    recommendedEngines: probe.recommendedEngines,
  };
}
