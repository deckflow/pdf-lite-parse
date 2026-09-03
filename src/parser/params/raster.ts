/**
 * T3/T4/T5 共用的页面渲染分辨率。
 *
 * 200 DPI 与 recovered_content 的冻结契约一致；集中在这里，避免不同模型路径各自
 * 选一个缩放比，导致同一页产生不同缓存 key。
 */
export const PAGE_RASTER_DPI = 200;

/** PDF 用户空间的标准单位是 1/72 英寸。 */
export const PDF_POINTS_PER_INCH = 72;

/** 透明页会让不同模型服务使用不同底色合成，入口统一铺成白底。 */
export const PAGE_RASTER_BACKGROUND = '#ffffff';

export const PAGE_RASTER_MIME_TYPE = 'image/png' as const;

/**
 * 页面区域裁剪允许 bbox 超出视觉页边界的最大浮点误差。
 *
 * pdf.js 的 viewport 与源对象坐标都经历矩阵换算，小于半个 PDF point 的越界通常只是
 * 浮点抖动；再大就更像上游给错了区域，不能靠裁边静默掩盖。
 */
export const PAGE_RASTER_BBOX_TOLERANCE_PT = 0.5;

/**
 * 抽出的图像资源用固定的 deflate 级别编码。级别一旦随环境变化，同一张图就会
 * 产出不同字节，--check-determinism 与阶段缓存立刻失效 —— 所以它必须是常量。
 */
export const ASSET_PNG_DEFLATE_LEVEL = 9;

/** 图像资源在输出目录下的固定子目录（rfc 输出契约表里的 `assets/`）。 */
export const ASSET_DIRECTORY = 'assets';

/**
 * 判定图像 CTM"轴对齐"的最小主轴占比。0.98 允许排版软件常见的千分之几抖动
 * （实测一张 90° 摆放的图，副轴仍有 3.3/189 ≈ 1.7% 的残量），
 * 但拒绝真正的斜切 —— 那必须重采样，而重采样出来的就不是原图了。
 */
export const IMAGE_AXIS_ALIGNMENT_MIN_RATIO = 0.98;
