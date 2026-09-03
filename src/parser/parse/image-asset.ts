import { deflateSync } from 'node:zlib';
import { ASSET_PNG_DEFLATE_LEVEL, IMAGE_AXIS_ALIGNMENT_MIN_RATIO } from '../params/raster.ts';

/**
 * pdf.js 解码后的位图形态。这三种是 `ImageKind` 的全部取值；
 * 出现别的取值只能显式放弃，不能猜着解释字节流。
 */
export const PDFJS_IMAGE_KIND_GRAYSCALE_1BPP = 1;
export const PDFJS_IMAGE_KIND_RGB_24BPP = 2;
export const PDFJS_IMAGE_KIND_RGBA_32BPP = 3;

export interface DecodedImage {
  width: number;
  height: number;
  kind: number;
  data: ArrayBufferView;
}

/** 位图某个轴在页面上的朝向（屏幕坐标，y 向下）。 */
export type AxisDirection = 'right' | 'left' | 'down' | 'up';

export interface ImageOrientation {
  /** 列号增大时在页面上的走向。 */
  column: AxisDirection;
  /** 行号增大时在页面上的走向。 */
  row: AxisDirection;
}

export const UPRIGHT_ORIENTATION: ImageOrientation = { column: 'right', row: 'down' };

export interface EncodedImageAsset {
  width: number;
  height: number;
  mimeType: 'image/png';
  bytes: Uint8Array;
}

/**
 * 从图像的 CTM 求出位图朝向。
 *
 * PDF 把图像画进单位正方形，位图第 0 行对应 v = 1，所以行方向是 -(c, d)、
 * 列方向是 (a, b)；再把 PDF 的 y 向上翻成屏幕的 y 向下。
 * 只处理轴对齐（含 90° 整数倍旋转与镜像）的情形：任意角度旋转要重采样，
 * 重采样就不再是"原图"了，那超出解析器该做的事。
 */
export function imageOrientationFromMatrix(
  matrix: readonly [number, number, number, number, number, number],
): ImageOrientation | null {
  const [a, b, c, d] = matrix;
  const column = axisDirection(a, -b);
  const row = axisDirection(-c, d);
  if (column === null || row === null) return null;
  // 一条轴横、一条轴竖才是轴对齐；两条同向说明矩阵退化或被斜切。
  if (isHorizontal(column) === isHorizontal(row)) return null;
  return { column, row };
}

function axisDirection(x: number, y: number): AxisDirection | null {
  const horizontal = Math.abs(x);
  const vertical = Math.abs(y);
  const dominant = Math.max(horizontal, vertical);
  if (dominant === 0) return null;
  if (Math.min(horizontal, vertical) / dominant > 1 - IMAGE_AXIS_ALIGNMENT_MIN_RATIO) return null;
  if (horizontal >= vertical) return x >= 0 ? 'right' : 'left';
  return y >= 0 ? 'down' : 'up';
}

function isHorizontal(direction: AxisDirection): boolean {
  return direction === 'right' || direction === 'left';
}

/**
 * 把 pdf.js 的解码位图编成 PNG。
 *
 * 自己编而不借 canvas：① 栅格化的可选依赖不可用时图像资源不该跟着一起消失；
 * ② PNG 必须逐字节确定（§ 6.4 的缓存 key 与 --check-determinism 都按字节比），
 * 而画布后端的编码参数不在我们手里。
 */
export function encodePng(
  image: DecodedImage,
  orientation: ImageOrientation = UPRIGHT_ORIENTATION,
): EncodedImageAsset | null {
  const samples = samplesOf(image);
  if (samples === null) return null;
  const { width, height, channels, pixels } = samples;
  const rotated = !isHorizontal(orientation.column);
  const outputWidth = rotated ? height : width;
  const outputHeight = rotated ? width : height;

  // PNG 每行前置一个 filter 字节；固定用 0（None），编码结果只取决于像素。
  const stride = outputWidth * channels;
  const raw = new Uint8Array((stride + 1) * outputHeight);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = axisOffset(orientation.column, column, width, true)
        + axisOffset(orientation.row, row, height, true);
      const y = axisOffset(orientation.column, column, width, false)
        + axisOffset(orientation.row, row, height, false);
      const from = (row * width + column) * channels;
      const to = y * (stride + 1) + 1 + x * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        raw[to + channel] = pixels[from + channel];
      }
    }
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, outputWidth);
  headerView.setUint32(4, outputHeight);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return {
    width: outputWidth,
    height: outputHeight,
    mimeType: 'image/png',
    bytes: concat([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', new Uint8Array(deflateSync(raw, { level: ASSET_PNG_DEFLATE_LEVEL }))),
      pngChunk('IEND', new Uint8Array(0)),
    ]),
  };
}

/** 某条源轴对输出坐标的贡献；横轴只贡献 x，竖轴只贡献 y，两者必有其一为 0。 */
function axisOffset(
  direction: AxisDirection,
  index: number,
  extent: number,
  wantHorizontal: boolean,
): number {
  if (isHorizontal(direction) !== wantHorizontal) return 0;
  return direction === 'right' || direction === 'down' ? index : extent - 1 - index;
}

interface ImageSamples {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}

/**
 * 统一成每通道 8 位的像素数组。1bpp 灰度在这里展开成 8 位：位级旋转的代码
 * 复杂度换不来那点体积，而 deflate 会把展开后的重复字节压回去。
 */
function samplesOf(image: DecodedImage): ImageSamples | null {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);

  if (image.kind === PDFJS_IMAGE_KIND_GRAYSCALE_1BPP) {
    const sourceStride = Math.ceil(width / 8);
    if (data.length < sourceStride * height) return null;
    const pixels = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const byte = data[row * sourceStride + (column >> 3)];
        pixels[row * width + column] = (byte >> (7 - (column & 7))) & 1 ? 0xff : 0x00;
      }
    }
    return { width, height, channels: 1, pixels };
  }

  const channels = image.kind === PDFJS_IMAGE_KIND_RGB_24BPP
    ? 3
    : image.kind === PDFJS_IMAGE_KIND_RGBA_32BPP ? 4 : 0;
  if (channels === 0 || data.length < width * height * channels) return null;
  return { width, height, channels, pixels: data };
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(payload.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(payload, 8);
  view.setUint32(payload.length + 8, crc32(chunk.subarray(4, payload.length + 8)));
  return chunk;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
