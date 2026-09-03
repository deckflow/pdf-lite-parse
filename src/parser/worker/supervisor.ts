import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Warning } from '../../schema/warnings.ts';
import {
  WORKER_DIAGNOSTIC_BYTES,
  WORKER_KILL_GRACE_MS,
} from '../params/limits.ts';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerFailure,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.ts';

export type SupervisorFailureKind =
  | 'timeout'
  | 'memory'
  | 'abnormal_exit'
  | 'resource_limit'
  | 'malformed_page'
  | 'task_error'
  | 'protocol_error'
  | 'spawn_error';

export interface SupervisorFailure {
  kind: SupervisorFailureKind;
  message: string;
  workerFailure?: WorkerFailure;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface SupervisorMetrics {
  pid: number | null;
  durationMs: number;
  peakRssBytes: number;
  stderr: string;
}

export type SupervisedWorkerResult<T> =
  | (SupervisorMetrics & { ok: true; value: T; exitCode: 0 })
  | (SupervisorMetrics & { ok: false; failure: SupervisorFailure; exitCode: 1 | 2 });

/** 文档级限额无法产出合法页集合时，CLI 仍按 §11.4 的 BLOCK=1 稳定退出。 */
export class ResourceIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceIsolationError';
  }
}

/**
 * worker 入口的扩展名跟随本模块自身：源码态是 `.ts`，编译发布态是 `.js`。
 * 不能写死 `.ts`——`rewriteRelativeImportExtensions` 只改 import 语句，不碰这里的字符串。
 */
const defaultEntryPath = fileURLToPath(
  new URL(`./entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** 每个调用恰好创建一个新进程组；任何结束路径都会清理整组而非只杀直接子进程。 */
export function runSupervisedWorker<T>(
  request: WorkerRequest,
): Promise<SupervisedWorkerResult<T>> {
  const startedAt = performance.now();
  const privateRoot = mkdtempSync(join(tmpdir(), 'pdf-lite-parse-worker-'));
  chmodSync(privateRoot, 0o700);
  const requestPath = join(privateRoot, 'request.json');
  const responsePath = join(privateRoot, 'response.json');
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  const heapArgument = request.limits.maxOldSpaceMb === null
    ? []
    : [`--max-old-space-size=${request.limits.maxOldSpaceMb}`];
  const child = spawn(
    process.execPath,
    [...heapArgument, defaultEntryPath, requestPath, responsePath],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: restrictedWorkerEnvironment(),
    },
  );

  return new Promise((resolve) => {
    let settled = false;
    let forcedFailure: Extract<SupervisorFailureKind, 'timeout' | 'memory'> | null = null;
    let peakRssBytes = 0;
    let stderr = Buffer.alloc(0);
    let hardKillTimer: NodeJS.Timeout | undefined;
    const deadlineTimer = request.limits.maxPageWallMs === null
      ? undefined
      : setTimeout(() => terminate('timeout'), request.limits.maxPageWallMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= WORKER_DIAGNOSTIC_BYTES) return;
      stderr = Buffer.concat([stderr, chunk]).subarray(0, WORKER_DIAGNOSTIC_BYTES);
    });
    child.on('message', (message: unknown) => {
      if (!isRssSample(message) || settled) return;
      peakRssBytes = Math.max(peakRssBytes, message.rssBytes);
      const maximum = request.limits.maxProcessRssBytes;
      if (maximum !== null && message.rssBytes > maximum) terminate('memory');
    });

    child.once('error', (error) => finish(null, null, {
      kind: 'spawn_error',
      message: error.message,
      exitCode: null,
      signal: null,
    }));
    child.once('close', (code, signal) => finish(code, signal, null));

    function terminate(kind: Extract<SupervisorFailureKind, 'timeout' | 'memory'>): void {
      if (forcedFailure !== null || settled) return;
      forcedFailure = kind;
      signalProcessGroup(child.pid, 'SIGTERM');
      hardKillTimer = setTimeout(() => signalProcessGroup(child.pid, 'SIGKILL'), WORKER_KILL_GRACE_MS);
      hardKillTimer.unref();
    }

    function finish(
      code: number | null,
      signal: NodeJS.Signals | null,
      immediateFailure: SupervisorFailure | null,
    ): void {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      // leader 已退出时组内后代仍可能活着；负 pid 对整个独立进程组补一记 SIGKILL。
      signalProcessGroup(child.pid, 'SIGKILL');
      const metrics: SupervisorMetrics = {
        pid: child.pid ?? null,
        durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
        peakRssBytes,
        stderr: stderr.toString('utf8'),
      };

      let outcome: SupervisedWorkerResult<T>;
      if (immediateFailure !== null) {
        outcome = { ...metrics, ok: false, exitCode: 2, failure: immediateFailure };
      } else if (forcedFailure !== null) {
        outcome = {
          ...metrics,
          ok: false,
          exitCode: 1,
          failure: {
            kind: forcedFailure,
            message: forcedFailure === 'timeout' ? 'worker 超过墙钟 deadline' : 'worker RSS 超限',
            exitCode: code,
            signal,
          },
        };
      } else {
        outcome = responseOutcome<T>(responsePath, code, signal, metrics);
      }
      rmSync(privateRoot, { recursive: true, force: true });
      resolve(outcome);
    }
  });
}

/** failed 页使用 warn 级资源告警；父 CLI 另以 failed 页把退出码稳定映射为 1。 */
export function resourceLimitWarning(
  page: number,
  failure: SupervisorFailure,
): Extract<Warning, { scope: 'page' }> {
  return {
    code: 'RESOURCE_LIMIT_EXCEEDED',
    severity: 'warn',
    scope: 'page',
    page,
    message: '受限 PDF worker 未能处理本页，已标记 failed 并继续其余页面',
    detail: {
      failureKind: failure.kind,
      workerExitCode: failure.exitCode,
      signal: failure.signal,
      ...(failure.workerFailure?.limit === undefined
        ? {}
        : {
            limit: failure.workerFailure.limit,
            actual: failure.workerFailure.actual,
            maximum: failure.workerFailure.maximum,
          }),
    },
  };
}

function responseOutcome<T>(
  responsePath: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  metrics: SupervisorMetrics,
): SupervisedWorkerResult<T> {
  if (existsSync(responsePath)) {
    try {
      const response = JSON.parse(readFileSync(responsePath, 'utf8')) as WorkerResponse<T>;
      if (response.protocolVersion !== WORKER_PROTOCOL_VERSION || typeof response.ok !== 'boolean') {
        throw new TypeError('response envelope 无效');
      }
      if (response.ok && code === 0) return { ...metrics, ok: true, value: response.value, exitCode: 0 };
      if (!response.ok) {
        return {
          ...metrics,
          ok: false,
          exitCode: response.failure.kind === 'task_error' ? 2 : 1,
          failure: {
            kind: response.failure.kind,
            message: response.failure.message,
            workerFailure: response.failure,
            exitCode: code,
            signal,
          },
        };
      }
    } catch (error) {
      return {
        ...metrics,
        ok: false,
        exitCode: 2,
        failure: {
          kind: 'protocol_error',
          message: `worker response 无法验收：${errorMessage(error)}`,
          exitCode: code,
          signal,
        },
      };
    }
  }
  const inferredMemoryFailure = /heap out of memory|allocation failed|ineffective mark-compacts/iu
    .test(metrics.stderr);
  return {
    ...metrics,
    ok: false,
    exitCode: 1,
    failure: {
      kind: inferredMemoryFailure ? 'memory' : 'abnormal_exit',
      message: inferredMemoryFailure ? 'worker OOM 退出' : 'worker 异常退出且没有完整响应',
      exitCode: code,
      signal,
    },
  };
}

function restrictedWorkerEnvironment(): NodeJS.ProcessEnv {
  // 仍隔离 Node 预加载参数，避免宿主注入代码改变受限 worker 行为。
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_OPTIONS'));
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if (!isUnavailableProcessGroupError(error)) throw error;
  }
}

function isRssSample(value: unknown): value is { type: 'rss'; rssBytes: number } {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'rss'
    && 'rssBytes' in value
    && typeof value.rssBytes === 'number'
    && Number.isFinite(value.rssBytes);
}

function isUnavailableProcessGroupError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    // leader 退出后 pgid 可能立刻被系统复用；此时向负 pid 发信号会因目标不再
    // 属于当前用户而返回 EPERM。继续向正 pid 重试反而可能误杀复用该 pid 的进程。
    && ['ESRCH', 'EPERM'].includes(String((error as { code?: unknown }).code));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
