import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { ensureDemoWorkspace } from '../src/host/demo.ts';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import { canonicalJson, sha256 } from '../src/core/raw-evidence.ts';
import { makeDataDir, repoRoot } from './helpers.ts';

test('默认数据集哈希、最终清洗输出与网页血缘一致', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const dataset = await ensureDemoWorkspace(store, join(repoRoot, 'fixtures', 'mvp'), '2026-10-30T00:00:00.000Z');
  const fingerprint = canonicalJson({ name: dataset.name, version: dataset.version, sourceAssetIds: dataset.sourceAssetIds, rows: dataset.rows, steps: dataset.steps, quality: dataset.quality });
  assert.equal(dataset.sha256, sha256(fingerprint));
  assert.equal(dataset.steps.at(-1)!.outputHash, sha256(canonicalJson(dataset.rows)));
  for (const entity of ['竞对A', '行业']) {
    const rows = dataset.rows.filter(row => row.entity === entity);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map(row => row.rowId)).size, 2);
    assert.ok(rows.every(row => row.source.kind === 'web'));
    const raw = dataset.rawRows.filter(row => row.values.entity === entity);
    assert.deepEqual(raw.map(row => row.source.locator).sort(), rows.map(row => row.source.locator).sort());
  }
  store.close();
});
