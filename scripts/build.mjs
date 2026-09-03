import { rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
rmSync('dist', { recursive: true, force: true });
rmSync('schemas/parser', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/gen-schema.mjs'], { stdio: 'inherit' });
chmodSync('dist/parser/cli.js', 0o755);
