import { readFileSync, statSync } from 'node:fs';
import type { ParsedPage } from '../parse/pdfjs.ts';
import type { ResourceLimits } from '../params/limits.ts';
import type { InspectedPdf, SerializedPageImageAsset, SerializedPageRasterResult, WorkerRequest } from './protocol.ts';

export class ResourceLimitError extends Error {
  readonly limit: keyof ResourceLimits;
  readonly actual: number;
  readonly maximum: number;

  constructor(
    limit: keyof ResourceLimits,
    actual: number,
    maximum: number,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceLimitError';
    this.limit = limit;
    this.actual = actual;
    this.maximum = maximum;
  }
}

export async function executeWorkerTask(request: WorkerRequest): Promise<unknown> {
  const bytes = readLimitedInput(request.inputPath, request.limits);
  preflightPdf(bytes, request.limits);

  if (request.kind === 'probe_document') {
    const { probeDocument } = await import('../probe/l0/index.ts');
    const result = probeDocument(bytes, request.sourceSha256);
    enforceLimit('maxPages', result.pages, request.limits.maxPages);
    return result;
  }

  if (request.kind === 'raster_page' || request.kind === 'raster_region') {
    const { openPdfRasterizer } = await import('../parse/raster.ts');
    const opened = await openPdfRasterizer(new Uint8Array(bytes), {
      ...(request.password === undefined ? {} : { password: request.password }),
      maxImageSize: request.limits.maxImageSize ?? undefined,
    });
    if (!opened.available) return opened.rasterizer === null
      ? { status: 'degraded', raster: null, warnings: opened.warnings }
      : opened;
    try {
      enforceLimit('maxPages', opened.rasterizer.pages, request.limits.maxPages);
      const result = request.kind === 'raster_region'
        ? await opened.rasterizer.rasterizeRegion(request.page, request.bbox)
        : await opened.rasterizer.rasterizePage(request.page);
      if (result.status === 'ok') {
        enforceLimit(
          'maxImageSize',
          result.raster.width * result.raster.height,
          request.limits.maxImageSize,
        );
        enforceLimit('maxStreamBytes', result.raster.bytes.byteLength, request.limits.maxStreamBytes);
      }
      const serialized: SerializedPageRasterResult = result.status === 'ok'
        ? {
            status: 'ok',
            raster: {
              page: result.raster.page,
              renderDpi: result.raster.renderDpi,
              width: result.raster.width,
              height: result.raster.height,
              mimeType: result.raster.mimeType,
              bytesBase64: Buffer.from(result.raster.bytes).toString('base64'),
            },
            warnings: [],
          }
        : result;
      return serialized;
    } finally {
      await opened.rasterizer.close();
    }
  }

  const { openPdf } = await import('../parse/pdfjs.ts');
  const opened = await openPdf(new Uint8Array(bytes), request.password, request.limits.maxImageSize ?? -1);
  try {
    enforceLimit('maxPages', opened.pages, request.limits.maxPages);
    if (request.kind === 'inspect_pdf') {
      const inspected: InspectedPdf = {
        pages: opened.pages,
        encrypted: opened.encrypted,
        properties: await opened.readProperties(),
      };
      return inspected;
    }
    if (!Number.isInteger(request.page) || request.page < 1 || request.page > opened.pages) {
      throw new RangeError(`页码 ${request.page} 越界`);
    }
    if (request.kind === 'page_geometry') return opened.pageGeometry(request.page);
    if (request.kind === 'extract_page_images') {
      const assets = await opened.extractPageImages(request.page);
      const serialized: SerializedPageImageAsset[] = [];
      for (const asset of assets) {
        enforceLimit('maxImageSize', asset.width * asset.height, request.limits.maxImageSize);
        enforceLimit('maxStreamBytes', asset.bytes.byteLength, request.limits.maxStreamBytes);
        serialized.push({
          sourceObjectId: asset.sourceObjectId,
          width: asset.width,
          height: asset.height,
          mimeType: asset.mimeType,
          bytesBase64: Buffer.from(asset.bytes).toString('base64'),
        });
      }
      return serialized;
    }
    const parsed = await opened.parsePage(request.page);
    validateParsedPage(parsed, bytes.byteLength, request.limits);
    return parsed;
  } catch (error) {
    if (error instanceof ResourceLimitError) throw error;
    const malformed = new Error(errorMessage(error));
    malformed.name = 'MalformedPageError';
    throw malformed;
  } finally {
    await opened.close();
  }
}

function readLimitedInput(path: string, limits: Readonly<ResourceLimits>): Buffer {
  const inputBytes = statSync(path).size;
  enforceLimit('maxInputBytes', inputBytes, limits.maxInputBytes);
  return readFileSync(path);
}

/**
 * 这层只做无需解压的廉价拒绝；真正的解码仍在有堆/RSS/deadline 的子进程里。
 * 分块扫描避免把 512 MiB 输入再复制成一个同尺寸 JS 字符串。
 */
function preflightPdf(bytes: Buffer, limits: Readonly<ResourceLimits>): void {
  let objectCount = 0;
  let largestDeclaredStream = 0;
  let totalDeclaredStreams = 0;
  const chunkBytes = 1024 * 1024;
  let carry = '';
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const carryLength = carry.length;
    const chunk = carry + bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes))
      .toString('latin1');
    objectCount += countMatchesAfter(chunk, /\b\d+\s+\d+\s+obj\b/gu, carryLength);
    for (const match of chunk.matchAll(/\/Length\s+(\d+)\b[^]*?\bstream(?:\r\n|\r|\n)/gu)) {
      if ((match.index ?? 0) + match[0].length <= carryLength) continue;
      const length = Number(match[1]);
      if (Number.isSafeInteger(length)) {
        largestDeclaredStream = Math.max(largestDeclaredStream, length);
        totalDeclaredStreams += length;
      }
    }
    for (const match of chunk.matchAll(
      /\/Subtype\s*\/Image\b[^]{0,4096}?\/Width\s+(\d+)\b[^]{0,4096}?\/Height\s+(\d+)\b/gu,
    )) {
      if ((match.index ?? 0) + match[0].length <= carryLength) continue;
      const pixels = Number(match[1]) * Number(match[2]);
      enforceLimit('maxImageSize', pixels, limits.maxImageSize);
    }
    carry = chunk.slice(-4096);
  }
  enforceLimit('maxObjects', objectCount, limits.maxObjects);
  enforceLimit('maxStreamBytes', largestDeclaredStream, limits.maxStreamBytes);
  enforceLimit(
    'maxTotalDecompressedBytes',
    totalDeclaredStreams,
    limits.maxTotalDecompressedBytes,
  );
}

function validateParsedPage(
  parsed: ParsedPage,
  inputBytes: number,
  limits: Readonly<ResourceLimits>,
): void {
  enforceLimit('maxObjects', parsed.artifact.objects.length, limits.maxObjects);
  const operators = Object.values(parsed.artifact.contentOperators)
    .reduce((total, count) => total + count, 0);
  enforceLimit('maxOperatorsPerPage', operators, limits.maxOperatorsPerPage);
  const materializedBytes = Buffer.byteLength(JSON.stringify(parsed));
  enforceLimit('maxStreamBytes', materializedBytes, limits.maxStreamBytes);
  enforceLimit(
    'maxTotalDecompressedBytes',
    materializedBytes,
    limits.maxTotalDecompressedBytes,
  );
  if (limits.maxCompressionRatio !== null && inputBytes > 0) {
    enforceLimit(
      'maxCompressionRatio',
      materializedBytes / inputBytes,
      limits.maxCompressionRatio,
    );
  }
}

export function enforceLimit(
  name: keyof ResourceLimits,
  actual: number,
  maximum: number | null,
): void {
  if (maximum !== null && actual > maximum) {
    throw new ResourceLimitError(name, actual, maximum, `${name} 超限：${actual} > ${maximum}`);
  }
}

function countMatchesAfter(input: string, pattern: RegExp, offset: number): number {
  let count = 0;
  for (const match of input.matchAll(pattern)) {
    if ((match.index ?? 0) + match[0].length > offset) count += 1;
  }
  return count;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
