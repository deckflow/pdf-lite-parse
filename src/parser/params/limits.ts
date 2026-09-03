/** 不可信输入的资源限额。null 表示关闭该维度，CLI 仅支持默认限额或关闭隔离。 */
export interface ResourceLimits {
  maxInputBytes: number | null;
  maxPages: number | null;
  maxObjects: number | null;
  maxObjectDepth: number | null;
  maxStreamBytes: number | null;
  maxTotalDecompressedBytes: number | null;
  maxCompressionRatio: number | null;
  /** 直接对应 pdf.js getDocument 的 maxImageSize 语义：像素总数。 */
  maxImageSize: number | null;
  maxOperatorsPerPage: number | null;
  maxPageCpuMs: number | null;
  maxPageWallMs: number | null;
  maxProcessRssBytes: number | null;
  maxOldSpaceMb: number | null;
}

/** RSS 采样只负责兜住堆外增长；50 ms 足够在 8 MiB 合成分配步长内及时止损。 */
export const WORKER_RSS_SAMPLE_INTERVAL_MS = 50;
/** SIGTERM 后很快升级 SIGKILL，避免恶意 worker 用信号处理器拖过 deadline。 */
export const WORKER_KILL_GRACE_MS = 250;
/** 崩溃诊断有界保留，不能让攻击者用 stderr 反向耗尽父进程。 */
export const WORKER_DIAGNOSTIC_BYTES = 64 * 1024;
const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
    maxInputBytes: 512 * MEBIBYTE,
    maxPages: 5_000,
    maxObjects: 5_000_000,
    maxObjectDepth: 64,
    maxStreamBytes: 256 * MEBIBYTE,
    maxTotalDecompressedBytes: 2 * GIBIBYTE,
    maxCompressionRatio: 200,
    maxImageSize: 100_000_000,
    maxOperatorsPerPage: 2_000_000,
    maxPageCpuMs: 10_000,
    maxPageWallMs: 30_000,
    maxProcessRssBytes: 4 * GIBIBYTE,
    maxOldSpaceMb: 3_584,

});
