import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 按路径分量判断；..source.pdf 是子文件，只有独立的 .. 分量才表示父目录。 */
export function containsPath(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** 尚未创建的输出也解析其已有父目录，避免父目录符号链接绕过保护。 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (lstatSync(absolute, { throwIfNoEntry: false })) return realpathSync(absolute);
  return join(canonicalPath(dirname(absolute)), basename(absolute));
}

const ARTIFACT_ENTRIES = [
  'result.json', 'source_index.json', 'warnings.json', 'metadata.json',
  'source_ledger.json', 'probe_document.json', 'probe_pages.json', 'probe_cross.json',
  'document_model.json', 'parse_raw', 'layout_pages', 'assets', '.input.pdf',
];

export function assertMarkdownOutputSafe(input: string, artifactRoot: string, output: string): void {
  const target = canonicalPath(output);
  const source = canonicalPath(input);
  const sourceStat = statSync(input);
  const outputStat = existsSync(output) ? statSync(output) : undefined;
  if (target === source || (outputStat?.dev === sourceStat.dev && outputStat.ino === sourceStat.ino)) {
    throw new TypeError('Markdown 输出不能覆盖源文件（含符号链接与硬链接）');
  }
  if (outputStat && !outputStat.isFile()) throw new TypeError('Markdown 输出必须是文件');
  const root = canonicalPath(artifactRoot);
  if (containsPath(target, root) || ARTIFACT_ENTRIES.some(name => containsPath(join(root, name), target))) {
    throw new TypeError('Markdown 输出不能覆盖 JSON 工件或资产目录；请使用 output.md 或独立文件');
  }
}
