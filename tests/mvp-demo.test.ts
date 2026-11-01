import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createDemoResearch, createDemoRuntime, ensureDemoWorkspace } from '../src/host/demo.ts';
import { runExploration } from '../src/agent/exploration-service.ts';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import { canonicalJson, sha256 } from '../src/core/raw-evidence.ts';
import { makeDataDir, repoRoot } from './helpers.ts';

const FIXTURES = join(repoRoot, 'fixtures', 'mvp');
const NOW = '2026-11-01T00:00:00.000Z';

async function workspace() {
  const store = new WorkspaceStore(makeDataDir());
  const dataset = await ensureDemoWorkspace(store, FIXTURES, NOW);
  return { store, dataset };
}

test('演示工作区只播种用户文件，哈希与最终清洗输出一致', async () => {
  const { store, dataset } = await workspace();
  const fingerprint = canonicalJson({ name: dataset.name, version: dataset.version, sourceAssetIds: dataset.sourceAssetIds, rows: dataset.rows, steps: dataset.steps, quality: dataset.quality });
  assert.equal(dataset.sha256, sha256(fingerprint));
  assert.equal(dataset.steps.at(-1)!.outputHash, sha256(canonicalJson(dataset.rows)));
  assert.deepEqual(dataset.sourceAssetIds.length, 1);
  assert.ok(store.listAssets().every(asset => asset.kind === 'file'));
  assert.equal(dataset.rows.some(row => ['竞对A', '行业'].includes(row.entity)), false);
  store.close();
});

test('DEMO/E2E：qualified 演示经本地 fixture Provider 走通搜索→快照→外部数字→候选', async () => {
  const { store, dataset } = await workspace();
  const run = await runExploration({
    store, dataset, runtime: createDemoRuntime(dataset, 'qualified'), runId: 'run-demo-qualified', now: NOW, maxToolCalls: 40,
    research: createDemoResearch(store, FIXTURES),
  });
  assert.equal(run.status, 'completed', run.stopReason);
  assert.equal(run.candidateIds.length, 5);
  assert.deepEqual([run.budget.usedSearches, run.budget.usedFetches, run.budget.usedSnapshotReads], [2, 2, 2]);
  const industrySnapshot = store.listSnapshots(run.id).find(snapshot => snapshot.contentType === 'application/pdf')!;
  assert.equal(industrySnapshot.pdfPages?.count, 3);
  assert.match(industrySnapshot.text, /30900 wan yuan/);
  assert.equal(store.listSnapshots(run.id).length, 2);
  assert.equal(store.listSearchEvents(run.id).filter(event => event.kind === 'search').length, 2);
  assert.equal(store.listSnapshotReads(run.id).length, 2);
  const final = store.getDataset(run.datasetId)!;
  const webRows = final.rows.filter(row => row.source.kind === 'web');
  assert.equal(webRows.length, 4);
  assert.ok(webRows.every(row => row.quality === 'usable' && /^snapshot:.+:quote:\d+-\d+$/.test(row.source.locator)));
  const industry = store.listCandidates().find(candidate => candidate.comparison.comparisonType === 'industry')!;
  assert.ok(industry.comparison.evidence.some(ref => ref.kind === 'web' && ref.locator.startsWith('snapshot:')));
  assert.match(industry.singleSourceLimitation ?? '', /1 个搜索快照/);
  const target = store.listCandidates().find(candidate => candidate.comparison.comparisonType === 'target')!;
  assert.equal(target.singleSourceLimitation, undefined);
  assert.equal(store.getDataset(dataset.id)!.rows.some(row => row.source.kind === 'web'), false);
  store.close();
});

test('DEMO：未配置搜索 Provider 时降级为待补证，不伪造外部基准', async () => {
  const { store, dataset } = await workspace();
  const run = await runExploration({ store, dataset, runtime: createDemoRuntime(dataset, 'qualified'), runId: 'run-demo-offline', now: NOW, maxToolCalls: 40 });
  assert.equal(run.status, 'completed', run.stopReason);
  assert.equal(run.candidateIds.length, 3);
  assert.equal(store.listObservations(run.id).filter(observation => observation.status === 'needs_evidence' && observation.summary.includes('未取得快照')).length, 2);
  assert.equal(store.listSnapshots(run.id).length, 0);
  assert.equal(store.getDataset(run.datasetId)!.rows.some(row => row.source.kind === 'web'), false);
  store.close();
});

test('DEMO/UI-04：limited 演示如实呈现被拒请求与配额耗尽', async () => {
  const { store, dataset } = await workspace();
  const run = await runExploration({
    store, dataset, runtime: createDemoRuntime(dataset, 'limited'), runId: 'run-demo-limited', now: NOW, maxToolCalls: 40,
    research: createDemoResearch(store, FIXTURES, { maxSearches: 1, maxFetches: 1, maxSnapshotReads: 2 }),
  });
  assert.equal(run.status, 'completed', run.stopReason);
  assert.equal(run.candidateIds.length, 1);
  assert.deepEqual([run.budget.usedSearches, run.budget.usedFetches, run.budget.usedSnapshotReads], [1, 1, 1]);
  assert.ok(store.listSearchEvents(run.id).some(event => event.error === 'search_quota_exhausted'));
  assert.ok(store.listObservations(run.id).some(observation => observation.status === 'needs_evidence' && observation.summary.includes('竞对')));
  store.close();
});
