import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reading } from './types.ts';

export type EvidenceRecord = {
  file: string;
  sha256: string;
  bytes: number;
  capturedAt: string;
  sourceRefreshedAt: string;
  locator: string;
  alreadyPresent: boolean;
};

/**
 * 证据快照库：原始读取字节不可变落盘（tmp + rename 原子写、同名拒绝覆盖），
 * SHA-256 防篡改，双时间戳（业务刷新 / 抓取）。只追加。
 */
export class EvidenceStore {
  readonly dir: string;

  constructor(rootDir: string) {
    this.dir = join(rootDir, 'evidence');
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 内容寻址快照：同一字节只落一份，重复读取幂等引用（alreadyPresent=true）。
   * 已存在的文件永不改写；不存在“按运行覆盖快照”的路径。
   */
  append(reading: Reading, locator: string, capturedAt: string): EvidenceRecord {
    const bytes = Buffer.from(canonicalJson(reading), 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const name = `${sha256}.json`;
    const finalPath = join(this.dir, name);
    if (existsSync(finalPath)) {
      const stored = readFileSync(finalPath);
      if (!stored.equals(bytes)) throw new Error(`证据快照内容冲突（同名不同字节）：${name}`);
      return { file: name, sha256, bytes: bytes.length, capturedAt, sourceRefreshedAt: reading.refreshedAt, locator, alreadyPresent: true };
    }
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);
    return { file: name, sha256, bytes: bytes.length, capturedAt, sourceRefreshedAt: reading.refreshedAt, locator, alreadyPresent: false };
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
