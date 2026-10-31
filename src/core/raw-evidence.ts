import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function storeRawBytes(rootDir: string, bytes: Buffer, extension: string): { path: string; sha256: string; alreadyPresent: boolean } {
  const hash = sha256(bytes);
  const dir = join(rootDir, 'assets');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash}.${extension.replace(/^\./, '')}`);
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new Error('evidence_hash_collision');
    return { path, sha256: hash, alreadyPresent: true };
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes, { flag: 'wx' });
  renameSync(tmp, path);
  return { path, sha256: hash, alreadyPresent: false };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}
