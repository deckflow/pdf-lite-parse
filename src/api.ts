import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result } from './schema/element.ts';
import type { MetadataArtifact, ResultArtifact, SourceIndexArtifact, SourceLedgerArtifact, WarningsArtifact } from './schema/artifacts.ts';
import { runParsePipeline } from './parser/pipeline.ts';
import { renderMarkdown, type MarkdownRenderOptions } from './parser/render/markdown.ts';
import { MissingFieldError } from './parser/render/strict.ts';
export { defaultRunConfig } from './parser/config.ts';

export interface ParseOptions {
  password?: string;
  pageFurniture?: 'off' | 'drop' | 'extract';
  overlaidText?: 'auto' | 'keep' | 'drop';
  isolate?: boolean;
  includeSourcePath?: boolean;
}
export interface ParseArtifacts {
  document: ResultArtifact;
  warnings: WarningsArtifact;
  metadata: MetadataArtifact;
  sourceIndex: SourceIndexArtifact;
  sourceLedger: SourceLedgerArtifact;
  /** figure.assetPath 是逻辑相对路径；无输出目录时从本映射取图片字节。 */
  assets: ReadonlyMap<string, Uint8Array>;
}
export async function parse(input: string | Uint8Array, options: ParseOptions = {}): Promise<ResultArtifact> {
  return (await run(input, options, false)).document;
}
export async function parseArtifacts(input: string | Uint8Array, options: ParseOptions = {}): Promise<ParseArtifacts> {
  return run(input, options, true);
}
async function run(input: string | Uint8Array, options: ParseOptions, withAssets: boolean): Promise<ParseArtifacts> {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new TypeError('input 必须是本地路径或 Uint8Array');
  const allowed = ['password', 'pageFurniture', 'overlaidText', 'isolate', 'includeSourcePath'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new TypeError('包含不支持的 ParseOptions');
  if (options.password !== undefined && typeof options.password !== 'string') throw new TypeError('password 必须是字符串');
  const workspace = mkdtempSync(join(tmpdir(), `pdf-lite-parse-api-${process.pid}-`));
  try {
    const sourcePath = typeof input === 'string' ? input : join(workspace, 'input.pdf');
    if (typeof input !== 'string') writeFileSync(sourcePath, input, { mode: 0o600 });
    const { password, ...config } = options;
    // 字节输入不存在用户路径，不能把内部临时文件路径当作来源对外交付。
    const parsed = await runParsePipeline(sourcePath, join(workspace, 'out'), {
      config: { ...config, ...(typeof input !== 'string' ? { includeSourcePath: false } : {}) }, password,
    });
    const assets = new Map<string, Uint8Array>();
    if (withAssets) for (const name of readdirSync(join(parsed.outputDirectory, 'assets')).sort()) {
      assets.set(`assets/${name}`, new Uint8Array(readFileSync(join(parsed.outputDirectory, 'assets', name))));
    }
    return { document: parsed.artifacts.result, metadata: parsed.artifacts.metadata,
      warnings: parsed.artifacts.warnings, sourceIndex: parsed.artifacts.sourceIndex,
      sourceLedger: parsed.artifacts.sourceLedger, assets };
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}
/** 严格模式：缺字段直接抛错，不交付外观像成功的占位正文。 */
export function toMarkdown(result: Result, options: MarkdownRenderOptions = {}): string {
  if ((result as ResultArtifact).schemaVersion !== 'result.v3' || result.version !== 'result.v3') {
    throw new TypeError('SCHEMA_VERSION_MISMATCH：只接受 result.v3 文档');
  }
  const rendered = renderMarkdown(result, options);
  const missing = rendered.missingFields[0];
  if (missing !== undefined) throw new MissingFieldError(missing.elementId ?? missing.path, missing.field, missing.message);
  return rendered.markdown;
}
