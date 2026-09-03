#!/usr/bin/env node
import { executeWorkerTask, ResourceLimitError, enforceLimit } from './task.ts';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { WORKER_RSS_SAMPLE_INTERVAL_MS } from '../params/limits.ts';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerFailure,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.ts';

const WORKER_TASK_FAILED_EXIT = 20;
const RESPONSE_FILE_MODE = 0o600;

const rssReporter = setInterval(() => {
  if (process.send !== undefined && process.connected) {
    process.send({ type: 'rss', rssBytes: process.memoryUsage.rss() });
  }
}, WORKER_RSS_SAMPLE_INTERVAL_MS);
rssReporter.unref();

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  const responsePath = process.argv[3];
  if (requestPath === undefined || responsePath === undefined) {
    process.stderr.write('worker entry 需要 request 与 response 路径\n');
    process.exitCode = WORKER_TASK_FAILED_EXIT;
    return;
  }

  const cpuStarted = process.cpuUsage();
  let response: WorkerResponse<unknown>;
  try {
    const request = readRequest(requestPath);
    const value = await executeWorkerTask(request);
    const cpuMs = cpuElapsedMs(cpuStarted);
    enforceLimit('maxPageCpuMs', cpuMs, request.limits.maxPageCpuMs);
    response = { protocolVersion: WORKER_PROTOCOL_VERSION, ok: true, value, cpuMs };
  } catch (error) {
    response = {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      ok: false,
      failure: workerFailure(error),
      cpuMs: cpuElapsedMs(cpuStarted),
    };
    process.exitCode = WORKER_TASK_FAILED_EXIT;
  }
  writeResponse(responsePath, response);
}

function readRequest(path: string): WorkerRequest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    throw new TypeError('worker request 协议版本无效');
  }
  if (
    parsed.kind !== 'probe_document'
    && parsed.kind !== 'inspect_pdf'
    && parsed.kind !== 'parse_page'
    && parsed.kind !== 'page_geometry'
    && parsed.kind !== 'extract_page_images'
    && parsed.kind !== 'raster_page'
    && parsed.kind !== 'raster_region'
  ) {
    throw new TypeError('worker request kind 无效');
  }
  return parsed as unknown as WorkerRequest;
}

function workerFailure(error: unknown): WorkerFailure {
  if (error instanceof ResourceLimitError) {
    return {
      kind: 'resource_limit',
      message: error.message,
      limit: error.limit,
      actual: error.actual,
      maximum: error.maximum,
      errorType: error.name,
    };
  }
  return {
    kind: error instanceof Error && error.name === 'MalformedPageError'
      ? 'malformed_page'
      : 'task_error',
    message: errorMessage(error),
    errorType: error instanceof Error ? error.name : 'UnknownError',
  };
}

function writeResponse(path: string, response: WorkerResponse<unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(response)}\n`, { mode: RESPONSE_FILE_MODE });
  renameSync(temporary, path);
}

function cpuElapsedMs(started: NodeJS.CpuUsage): number {
  const usage = process.cpuUsage(started);
  return (usage.user + usage.system) / 1_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
