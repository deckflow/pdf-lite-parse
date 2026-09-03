import type { ProbeDocumentArtifact } from '../../schema/artifacts.ts';
import type { Bbox } from '../../schema/element.ts';
import type { Warning } from '../../schema/warnings.ts';
import type { DocumentProperties, PageImageAsset, ParsedPage } from '../parse/pdfjs.ts';
import type { PageRaster } from '../parse/raster.ts';
import type { ResourceLimits } from '../params/limits.ts';

export const WORKER_PROTOCOL_VERSION = 'pdf-worker.v2' as const;

interface PdfTaskBase {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  inputPath: string;
  password?: string;
  limits: ResourceLimits;
}

export type PdfWorkerRequest =
  | (PdfTaskBase & { kind: 'probe_document'; sourceSha256: string })
  | (PdfTaskBase & { kind: 'inspect_pdf' })
  | (PdfTaskBase & { kind: 'parse_page'; page: number })
  | (PdfTaskBase & { kind: 'page_geometry'; page: number })
  | (PdfTaskBase & { kind: 'extract_page_images'; page: number })
  | (PdfTaskBase & { kind: 'raster_page'; page: number })
  | (PdfTaskBase & { kind: 'raster_region'; page: number; bbox: Bbox });

export type WorkerRequest = PdfWorkerRequest;

export interface InspectedPdf {
  pages: number;
  encrypted: boolean;
  properties: DocumentProperties;
}

export type SerializedPageRasterResult =
  | {
      status: 'ok';
      raster: Omit<PageRaster, 'bytes'> & { bytesBase64: string };
      warnings: [];
    }
  | { status: 'degraded'; raster: null; warnings: [Warning] };

/** 图像字节走响应文件（与 raster_page 同一条通路），不进 parse_raw 工件。 */
export type SerializedPageImageAsset =
  Omit<PageImageAsset, 'bytes'> & { bytesBase64: string };

export interface WorkerTaskValues {
  probe_document: ProbeDocumentArtifact;
  inspect_pdf: InspectedPdf;
  parse_page: ParsedPage;
  page_geometry: { width: number; height: number; rotation: number };
  extract_page_images: SerializedPageImageAsset[];
  raster_page: SerializedPageRasterResult;
  raster_region: SerializedPageRasterResult;
}

export type WorkerFailureKind =
  | 'resource_limit'
  | 'malformed_page'
  | 'task_error';

export interface WorkerFailure {
  kind: WorkerFailureKind;
  message: string;
  limit?: keyof ResourceLimits;
  actual?: number;
  maximum?: number;
  errorType?: string;
}

export type WorkerResponse<T> =
  | {
      protocolVersion: typeof WORKER_PROTOCOL_VERSION;
      ok: true;
      value: T;
      cpuMs: number;
    }
  | {
      protocolVersion: typeof WORKER_PROTOCOL_VERSION;
      ok: false;
      failure: WorkerFailure;
      cpuMs: number;
    };
