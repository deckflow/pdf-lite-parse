import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Bbox } from '../../schema/element.ts';
import type { Warning } from '../../schema/warnings.ts';
import {
  PAGE_RASTER_BACKGROUND,
  PAGE_RASTER_BBOX_TOLERANCE_PT,
  PAGE_RASTER_DPI,
  PAGE_RASTER_MIME_TYPE,
  PDF_POINTS_PER_INCH,
} from '../params/raster.ts';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

export interface RasterCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
  toBuffer(mimeType: typeof PAGE_RASTER_MIME_TYPE): Uint8Array;
}

export interface RasterCanvasModule {
  createCanvas(width: number, height: number): RasterCanvas;
}

export type RasterCanvasLoader = () => Promise<RasterCanvasModule>;

export interface OpenPdfRasterizerOptions {
  maxImageSize?: number;
  password?: string;
  /** 可选依赖的加载边界；注入点也让调用方能在受限运行时明确禁用原生模块。 */
  loadCanvas?: RasterCanvasLoader;
}

export interface PageRaster {
  page: number;
  renderDpi: typeof PAGE_RASTER_DPI;
  width: number;
  height: number;
  mimeType: typeof PAGE_RASTER_MIME_TYPE;
  bytes: Uint8Array;
}

export type PageRasterResult =
  | { status: 'ok'; raster: PageRaster; warnings: [] }
  | { status: 'degraded'; raster: null; warnings: [Warning] };

export interface PdfRasterizer {
  pages: number;
  renderDpi: typeof PAGE_RASTER_DPI;
  rasterizePage(page: number): Promise<PageRasterResult>;
  /** bbox 使用解析器统一的视觉正立、左上原点 pt 坐标。 */
  rasterizeRegion(page: number, bbox: Bbox): Promise<PageRasterResult>;
  close(): Promise<void>;
}

/**
 * 栅格化能力缺席时明确返回告警，调用方保留原始图像与源文本。
 */
export type OpenPdfRasterizerResult =
  | {
      available: true;
      rasterizer: PdfRasterizer;
      warnings: [];
    }
  | {
      available: false;
      rasterizer: null;
      warnings: [Warning];
    };

const require = createRequire(import.meta.url);

/**
 * 页面栅格化只在复合图资产路径调用，因此 pdf.js 与 canvas 都必须留在函数内
 * 惰性加载。canvas 是可选依赖；加载失败不妨碍 T1-A/T2 的基础本地路径。
 */
export async function openPdfRasterizer(
  data: Uint8Array,
  options: OpenPdfRasterizerOptions = {},
): Promise<OpenPdfRasterizerResult> {
  const loadCanvas = options.loadCanvas ?? loadOptionalCanvas;
  let canvasModule: RasterCanvasModule;
  try {
    canvasModule = await loadCanvas();
    if (typeof canvasModule.createCanvas !== 'function') {
      throw new TypeError('@napi-rs/canvas 没有导出 createCanvas');
    }
  } catch {
    return {
      available: false,
      rasterizer: null,
      warnings: [rasterizerUnavailableWarning()],
    };
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  configurePdfjsWorker(pdfjs);
  const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
  const documentParameters = {
    data,
    ...(options.password === undefined ? {} : { password: options.password }),
    isEvalSupported: false,
    maxImageSize: options.maxImageSize ?? -1,
    useSystemFonts: false,
    standardFontDataUrl: pathToFileURL(join(pdfjsRoot, 'standard_fonts/')).href,
    verbosity: 0,
  };
  // pdf.js 6 的公开 d.ts 漏掉了仍由 evaluator 读取的安全开关。
  const loadingTask = pdfjs.getDocument(
    documentParameters as Parameters<typeof pdfjs.getDocument>[0],
  );

  let document: Awaited<typeof loadingTask.promise>;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy();
    throw error;
  }

  return {
    available: true,
    rasterizer: {
      pages: document.numPages,
      renderDpi: PAGE_RASTER_DPI,
      rasterizePage: async (pageNumber) => rasterize(pageNumber),
      rasterizeRegion: async (pageNumber, bbox) => rasterize(pageNumber, bbox),
      close: async () => {
        await loadingTask.destroy();
      },
    },
    warnings: [],
  };

  async function rasterize(pageNumber: number, requestedBbox?: Bbox): Promise<PageRasterResult> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      throw new RangeError(`页码必须在 1..${document.numPages}，收到 ${pageNumber}`);
    }
    try {
      const page = await document.getPage(pageNumber);
      const scale = PAGE_RASTER_DPI / PDF_POINTS_PER_INCH;
      const viewport = page.getViewport({ scale });
      const pageWidth = viewport.width / scale;
      const pageHeight = viewport.height / scale;
      const bbox = requestedBbox === undefined
        ? [0, 0, pageWidth, pageHeight] as Bbox
        : validatedRasterBbox(requestedBbox, pageWidth, pageHeight);
      const scaledWidth = (bbox[2] - bbox[0]) * scale;
      const scaledHeight = (bbox[3] - bbox[1]) * scale;
      const width = Math.ceil(scaledWidth);
      const height = Math.ceil(scaledHeight);
      if (options.maxImageSize !== undefined && width * height > options.maxImageSize) {
        throw new RangeError('页面栅格超过 maxImageSize，拒绝分配 canvas');
      }
      const canvas = canvasModule.createCanvas(width, height);
      try {
        // bbox 与 viewport 都可能含小数像素。画布固定上取整后显式补偿缩放与位移，
        // 既不裁右/下边缘，也不把原生 canvas 的隐式取整带进确定性边界。
        const scaleX = width / scaledWidth;
        const scaleY = height / scaledHeight;
        const transform: [number, number, number, number, number, number] = [
          scaleX,
          0,
          0,
          scaleY,
          -bbox[0] * scale * scaleX,
          -bbox[1] * scale * scaleY,
        ];
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport,
          transform,
          intent: 'display',
          annotationMode: pdfjs.AnnotationMode.ENABLE,
          background: PAGE_RASTER_BACKGROUND,
        }).promise;
        // 拷贝出独立字节数组，随后才能安全释放原生画布的像素内存。
        const bytes = new Uint8Array(canvas.toBuffer(PAGE_RASTER_MIME_TYPE));
        return {
          status: 'ok',
          raster: {
            page: pageNumber,
            renderDpi: PAGE_RASTER_DPI,
            width,
            height,
            mimeType: PAGE_RASTER_MIME_TYPE,
            bytes,
          },
          warnings: [],
        };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    } catch (error) {
      return {
        status: 'degraded',
        raster: null,
        warnings: [pageRenderWarning(pageNumber, error)],
      };
    }
  }
}

function validatedRasterBbox(bbox: Bbox, pageWidth: number, pageHeight: number): Bbox {
  if (bbox.some((value) => !Number.isFinite(value)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
    throw new RangeError(`页面裁剪 bbox 非法：${bbox.join(',')}`);
  }
  if (bbox[0] < -PAGE_RASTER_BBOX_TOLERANCE_PT
    || bbox[1] < -PAGE_RASTER_BBOX_TOLERANCE_PT
    || bbox[2] > pageWidth + PAGE_RASTER_BBOX_TOLERANCE_PT
    || bbox[3] > pageHeight + PAGE_RASTER_BBOX_TOLERANCE_PT) {
    throw new RangeError(`页面裁剪 bbox 越界：${bbox.join(',')}`);
  }
  return [
    Math.max(0, bbox[0]),
    Math.max(0, bbox[1]),
    Math.min(pageWidth, bbox[2]),
    Math.min(pageHeight, bbox[3]),
  ];
}

async function loadOptionalCanvas(): Promise<RasterCanvasModule> {
  return import('@napi-rs/canvas');
}

function configurePdfjsWorker(pdfjs: PdfjsModule): void {
  // Node 没有浏览器 Worker；固定 worker 模块让 pdf.js 明确走 fake worker，避免首次调用漂移。
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;
}

function rasterizerUnavailableWarning(): Warning {
  return {
    code: 'RASTERIZER_UNAVAILABLE',
    severity: 'info',
    scope: 'doc',
    message: '页面栅格化依赖不可用，模型路径按未配置处理；运行 `npm install @napi-rs/canvas` 可启用',
    detail: { dependency: '@napi-rs/canvas', hint: 'npm install @napi-rs/canvas' },
  };
}

function pageRenderWarning(page: number, error: unknown): Warning {
  return {
    code: 'PAGE_RENDER_FAILED',
    severity: 'warn',
    scope: 'page',
    page,
    message: '页面栅格化失败，该页无法调用模型',
    detail: { error: errorMessage(error) },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
