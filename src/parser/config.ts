import type { ResolvedRunConfig } from '../schema/artifacts.ts';
export function defaultRunConfig(overrides: Partial<ResolvedRunConfig> = {}): ResolvedRunConfig {
  const config: ResolvedRunConfig = {
    pageFurniture: 'off', overlaidText: 'auto', isolate: true,
    includeSourcePath: false, debug: false, render: false,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };
  const keys = ['pageFurniture', 'overlaidText', 'isolate', 'includeSourcePath', 'debug', 'render'];
  if (Object.keys(config).some(key => !keys.includes(key))) throw new TypeError('包含不支持的运行配置');
  if (!['off', 'drop', 'extract'].includes(config.pageFurniture)) throw new TypeError('pageFurniture 必须是 off、drop 或 extract');
  if (!['auto', 'keep', 'drop'].includes(config.overlaidText)) throw new TypeError('overlaidText 必须是 auto、keep 或 drop');
  for (const key of ['isolate', 'includeSourcePath', 'debug', 'render'] as const) {
    if (typeof config[key] !== 'boolean') throw new TypeError(`${key} 必须是布尔值`);
  }
  return Object.freeze(config);
}
