import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EvidenceStore } from '../src/core/evidence.ts';
import type { Reading } from '../src/core/types.ts';
import { makeDataDir } from './helpers.ts';

function reading(value: number): Reading {
  return {
    metricId: 'metric.revenue.monthly', entity: '华东',
    period: { kind: 'month', label: '2026-09', closed: true },
    value, unit: '万元', filters: { region: ['华东'] }, refreshedAt: '2026-10-02T08:00:00+08:00',
  };
}

test('快照落盘：SHA-256 与字节一致，双时间戳记录', () => {
  const dir = makeDataDir();
  const store = new EvidenceStore(dir);
  const rec = store.append(reading(880), 'dash-east-ops/metrics/x', '2026-10-02T08:10:00+08:00');
  assert.equal(rec.alreadyPresent, false);
  const bytes = readFileSync(join(store.dir, rec.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), rec.sha256);
  assert.equal(rec.bytes, bytes.length);
  assert.equal(rec.sourceRefreshedAt, '2026-10-02T08:00:00+08:00');
  assert.equal(rec.capturedAt, '2026-10-02T08:10:00+08:00');
});

test('同一字节幂等引用：不重写、不改内容', () => {
  const dir = makeDataDir();
  const store = new EvidenceStore(dir);
  const first = store.append(reading(880), 'loc-a', '2026-10-02T08:10:00+08:00');
  const second = store.append(reading(880), 'loc-b', '2026-10-03T08:10:00+08:00');
  assert.equal(second.file, first.file);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.alreadyPresent, true);
  assert.equal(readdirSync(store.dir).length, 1);
});

test('不同内容得到不同快照文件，只追加', () => {
  const dir = makeDataDir();
  const store = new EvidenceStore(dir);
  store.append(reading(880), 'loc', '2026-10-02T08:10:00+08:00');
  const second = store.append(reading(870), 'loc', '2026-10-02T08:10:00+08:00');
  assert.notEqual(second.file, '880-placeholder');
  assert.equal(readdirSync(store.dir).length, 2);
});
