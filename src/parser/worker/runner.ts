import type { PdfWorkerRequest } from './protocol.ts';
import { runSupervisedWorker, type SupervisedWorkerResult } from './supervisor.ts';
/** 不隔离是显式逃生门：仍复用抽取实现，但不再创建任何子进程。 */
export async function runPdfTask<T>(request: PdfWorkerRequest, isolate: boolean): Promise<SupervisedWorkerResult<T>> {
  if (isolate) return runSupervisedWorker<T>(request);
  const started = performance.now();
  try {
    const { executeWorkerTask } = await import('./task.ts');
    const value = await executeWorkerTask(request) as T;
    return { ok: true, value, exitCode: 0, pid: null, durationMs: performance.now() - started, peakRssBytes: 0, stderr: '' };
  } catch (error) {
    return {
      ok: false, exitCode: 2, pid: null, durationMs: performance.now() - started, peakRssBytes: 0, stderr: '',
      failure: { kind: 'task_error', message: error instanceof Error ? error.message : String(error), exitCode: null, signal: null,
        workerFailure: { kind: 'task_error', message: error instanceof Error ? error.message : String(error), errorType: error instanceof Error ? error.name : 'UnknownError' } },
    };
  }
}
