import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';

const REQUIRED_ARTIFACTS = ['result.json', 'source_index.json', 'warnings.json', 'metadata.json'] as const;

/** staging 与目标同文件系统，后续 rename 才是真正的目录级原子发布。 */
export function createPrivateArtifactDirectory(targetDirectory: string): string {
  const target = safeTarget(targetDirectory);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(parent, `.${basename(target)}.staging-`));
  chmodSync(staging, 0o700);
  return staging;
}

/** 最小验收即“全套 JSON 存在且完整”；完整不变量验收由 pipeline 在发布前追加。 */
export function validateArtifactStaging(directory: string): void {
  const root = resolve(directory);
  for (const filename of REQUIRED_ARTIFACTS) {
    const path = join(root, filename);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`staging 缺少完整工件：${filename}`);
    }
    JSON.parse(readFileSync(path, 'utf8')) as unknown;
  }
}

/**
 * 已有输出先移到同目录备份；新目录 rename 失败时立即回滚，失败 worker 永远碰不到旧结果。
 * 成功路径只在最后一步替换公开路径，半成品始终留在点目录下。
 */
export function publishArtifactDirectory(stagingDirectory: string, targetDirectory: string): void {
  const staging = resolve(stagingDirectory);
  const target = safeTarget(targetDirectory);
  const backup = join(dirname(target), `.${basename(target)}.backup-${randomUUID()}`);
  let backedUp = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      backedUp = true;
    }
    renameSync(staging, target);
  } catch (error) {
    if (backedUp && !existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
  if (backedUp) rmSync(backup, { recursive: true, force: true });
}

export function discardArtifactStaging(stagingDirectory: string): void {
  rmSync(resolve(stagingDirectory), { recursive: true, force: true });
}

function safeTarget(directory: string): string {
  const target = resolve(directory);
  if (target === parse(target).root || target === resolve(process.cwd())) {
    throw new Error(`拒绝把工件目录发布到宽泛路径：${target}`);
  }
  return target;
}
