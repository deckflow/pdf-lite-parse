import { chmodSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
rmSync('dist', { recursive: true, force: true });
rmSync('schemas/parser', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/gen-schema.mjs'], { stdio: 'inherit' });
assertNoSourceMaps('dist');
chmodSync('dist/parser/cli.js', 0o755);

function assertNoSourceMaps(directory) {
  const pending = [directory];
  const sourceMaps = [];
  const sourceMapReferences = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.name.endsWith('.map')) {
        sourceMaps.push(path);
      } else if (/\.(?:js|d\.ts)$/.test(entry.name)
        && readFileSync(path, 'utf8').includes('sourceMappingURL=')) {
        sourceMapReferences.push(path);
      }
    }
  }
  if (sourceMaps.length > 0 || sourceMapReferences.length > 0) {
    throw new Error([
      '构建产物禁止包含 source map。',
      ...sourceMaps.map((path) => `source map: ${path}`),
      ...sourceMapReferences.map((path) => `sourceMappingURL: ${path}`),
    ].join('\n'));
  }
}
