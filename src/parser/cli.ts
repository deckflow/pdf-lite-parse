#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { toMarkdown } from '../api.ts';
import type { ResultArtifact } from '../schema/artifacts.ts';
import { defaultRunConfig } from './config.ts';
import { runParsePipeline, PdfOpenError } from './pipeline.ts';
import { directorySnapshot, firstDifference } from './determinism.ts';
import { ResourceIsolationError } from './worker/supervisor.ts';
import { InvariantViolationError } from './invariants.ts';
import { assertMarkdownOutputSafe } from './emit/path-safety.ts';

const HELP = `pdf-lite-parse — 完全离线的数字型 PDF 解析器（无 OCR / 模型）

用法：
  pdf-lite-parse [parse] <pdf> [选项]
  pdf-lite-parse convert <pdf|result.json> [-o output.md] [选项]
  pdf-lite-parse check-determinism <pdf> [选项]

选项：
  --out <dir>                    工件目录（默认 <pdf名>.parsed）
  --password <pw>                加密文档口令
  --page-furniture off|drop|extract  页面家具取舍（默认 off）
  --overlaid-text auto|keep|drop  图上叠字取舍（默认 auto）
  --render                       同时输出 output.md
  --debug                        保存探测、版面、原始对象和账本
  --include-source-path          将源文件绝对路径写入结果
  --no-isolate                   关闭子进程隔离和默认资源限额
  -h, --help                     显示帮助
  --version                      显示版本

退出码：0 成功或显式 degraded；1 页面失败/资源限额/不变量失败；2 参数或文档打开失败。
`;
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    out: { type: 'string' }, output: { type: 'string', short: 'o' }, password: { type: 'string' },
    'page-furniture': { type: 'string' }, 'overlaid-text': { type: 'string' }, render: { type: 'boolean' },
    debug: { type: 'boolean' }, 'include-source-path': { type: 'boolean' }, 'no-isolate': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  const args = [...positionals];
  const command = ['parse', 'convert', 'check-determinism'].includes(args[0]) ? args.shift()! : 'parse';
  if (args.length !== 1) throw new TypeError('请指定一个本地 PDF 或 result.json；使用 --help 查看用法。');
  if (values.output !== undefined && command !== 'convert') throw new TypeError('-o 仅用于 convert；工件目录使用 --out。');
  const input = resolve(args[0]);
  const config = defaultRunConfig({
    pageFurniture: values['page-furniture'] as 'off' | 'drop' | 'extract' | undefined,
    overlaidText: values['overlaid-text'] as 'auto' | 'keep' | 'drop' | undefined,
    isolate: !values['no-isolate'], includeSourcePath: values['include-source-path'] ?? false,
    debug: values.debug ?? false, render: values.render ?? command === 'convert',
  });
  if (command === 'check-determinism') {
    if (values.out !== undefined) throw new TypeError('check-determinism 使用自动清理的临时目录，不接受 --out。');
    const root = mkdtempSync(join(tmpdir(), 'pdf-lite-parse-determinism-'));
    try {
      const first = await runParsePipeline(input, join(root, 'a'), { config: { ...config, debug: true, render: true }, password: values.password });
      const second = await runParsePipeline(input, join(root, 'b'), { config: { ...config, debug: true, render: true }, password: values.password });
      const difference = firstDifference(directorySnapshot(first.outputDirectory), directorySnapshot(second.outputDirectory));
      if (difference !== null) { process.stderr.write(`确定性检查失败：${difference}\n`); process.exitCode = 1; }
      else { process.stdout.write('确定性检查通过：两次完整解析的 JSON、Markdown 和图片一致（仅排除耗时）。\n'); process.exitCode = first.hasErrorWarnings || second.hasErrorWarnings ? 1 : 0; }
    } finally { rmSync(root, { recursive: true, force: true }); }
    return;
  }
  if (command === 'convert' && extname(input).toLowerCase() === '.json') {
    if (values.out !== undefined) throw new TypeError('result.json 转换使用 -o 指定 Markdown 文件。');
    const output = resolve(values.output ?? join(dirname(input), 'output.md'));
    assertMarkdownOutputSafe(input, dirname(input), output);
    const document = JSON.parse(readFileSync(input, 'utf8')) as ResultArtifact;
    writeMarkdown(document, input, dirname(input), output);
    process.stdout.write(`${output}\n`);
    return;
  }
  const outputDirectory = resolve(values.out ?? join(values.output ? dirname(resolve(values.output)) : dirname(input), `${basename(input, extname(input))}.parsed`));
  if (command === 'convert' && values.output) assertMarkdownOutputSafe(input, outputDirectory, resolve(values.output));
  const result = await runParsePipeline(input, outputDirectory, { config, password: values.password });
  if (command === 'convert' && values.output) writeMarkdown(result.artifacts.result, input, outputDirectory, resolve(values.output));
  const degraded = result.artifacts.result.pages.filter(p => p.status === 'degraded').length;
  const failed = result.artifacts.result.pages.filter(p => p.status === 'failed').length;
  process.stdout.write(`${result.pages} 页，${result.elements} 个元素，${degraded} 页 degraded，${failed} 页 failed → ${outputDirectory}\n`);
  process.exitCode = result.hasErrorWarnings ? 1 : 0;
}
function writeMarkdown(result: ResultArtifact, input: string, assetRoot: string, output: string): void {
  const document = structuredClone(result);
  // Markdown 换目录时必须重定位资产，否则输出有正文却满是断图。
  for (const element of [...document.elements, ...(document.furniture ?? [])]) {
    if ((element.type === 'figure' || element.type === 'chart') && element.figure.assetPath !== null) {
      element.figure.assetPath = relative(dirname(output), resolve(assetRoot, element.figure.assetPath)).split('\\').join('/');
    }
  }
  const markdown = toMarkdown(document);
  assertMarkdownOutputSafe(input, assetRoot, output);
  mkdirSync(dirname(output), { recursive: true });
  // rename 替换目录项，不跟随输出文件的链接，也不在写入失败时截断旧 Markdown。
  const staging = mkdtempSync(join(dirname(output), '.markdown-'));
  try {
    const file = join(staging, 'output.md');
    writeFileSync(file, markdown);
    renameSync(file, output);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
main().catch(error => {
  const code = error instanceof PdfOpenError ? error.code : error instanceof ResourceIsolationError ? 'RESOURCE_LIMIT_EXCEEDED' : 'ERROR';
  process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ResourceIsolationError || error instanceof InvariantViolationError ? 1 : 2;
});
