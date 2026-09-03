import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** 只删除明确的运行时字段，不以字段名递归删除，防止吞掉正文里的同名字段。 */
export function comparableJson(value: unknown, filename: string): unknown {
  const clone = structuredClone(value) as Record<string, any>;
  if (filename === 'result.json') {
    delete clone.stats.totalMs;
    for (const page of clone.pages) delete page.cost.ms;
  }
  if (filename === 'metadata.json') {
    delete clone.timingsMs;
    delete clone.stats.totalMs;
  }
  return clone;
}
export function directorySnapshot(directory: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  function visit(prefix: string): void {
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else {
        const bytes = readFileSync(join(directory, path));
        result[path] = path.endsWith('.json') ? comparableJson(JSON.parse(bytes.toString('utf8')), path)
          : createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  visit('');
  return result;
}
export function firstDifference(left: unknown, right: unknown, path = '$'): string | null {
  if (Object.is(left, right)) return null;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return path;
  if (Array.isArray(left) !== Array.isArray(right)) return path;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${path}.${key}`;
    const difference = firstDifference(a[key], b[key], `${path}.${key}`);
    if (difference !== null) return difference;
  }
  return null;
}
