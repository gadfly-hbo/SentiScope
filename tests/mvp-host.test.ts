import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startHost } from '../src/host/server.ts';
import { createDemoResearch } from '../src/host/demo.ts';
import { applyBenchmarkConfig } from '../src/core/benchmarks.ts';
import { ControlledRuntime } from '../src/agent/exploration-service.ts';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import type { CaseCandidate, DatasetVersion, ExplorationRun, SourceAsset } from '../src/core/mvp-types.ts';
import { makeDataDir, repoRoot } from './helpers.ts';

test('切片二宿主：合成端到端 API、零候选、复核、导入与本机写保护', async () => {
  const host = await startHost({
    port: 0, dataDir: makeDataDir(), skillsDir: join(repoRoot, 'skills'), fixturesDir: join(repoRoot, 'fixtures', 'mvp'), seedDemo: true, maxToolCalls: 40,
    researchFactory: ({ store, mode }) => mode === 'zero' ? undefined : createDemoResearch(store, join(repoRoot, 'fixtures', 'mvp')),
  });
  const headers = { 'x-sentiscope-client': '1' };
  try {
    assert.equal((await fetch(`${host.url}/health`)).status, 200);
    const candidates = await (await fetch(`${host.url}/api/candidates`)).json() as { candidates: CaseCandidate[] };
    assert.equal(candidates.candidates.length, 5);
    const datasets = await (await fetch(`${host.url}/api/datasets`)).json() as { datasets: DatasetVersion[] };
    assert.equal(datasets.datasets.length, 5);
    assert.ok(datasets.datasets[0].rows.length >= 10);
    const runs = await (await fetch(`${host.url}/api/runs`)).json() as { runs: ExplorationRun[] };
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].candidateIds.length, 5);
    const detail = await (await fetch(`${host.url}/api/runs/${runs.runs[0].id}`)).json() as { run: ExplorationRun; searchEvents: Array<{ kind: string }>; snapshots: Array<{ id: string; text?: string; contentType: string; pdfPages?: { count: number } }>; snapshotReads: unknown[] };
    assert.equal(detail.searchEvents.filter(event => event.kind === 'search').length, 2);
    assert.equal(detail.snapshots.length, 2);
    assert.equal(detail.snapshots[0].text, undefined);
    assert.equal(detail.snapshotReads.length, 2);
    const pdfSnapshot = detail.snapshots.find(snapshot => snapshot.contentType === 'application/pdf')!;
    assert.equal(pdfSnapshot.pdfPages?.count, 3);
    const firstPage = await (await fetch(`${host.url}/api/snapshots/${pdfSnapshot.id}/text?offset=0&length=40`)).json() as { page?: number };
    assert.equal(firstPage.page, 1);
    const secondPage = await (await fetch(`${host.url}/api/snapshots/${pdfSnapshot.id}/text?offset=120&length=40`)).json() as { page?: number };
    assert.equal(secondPage.page, 2);
    const snapshotText = await (await fetch(`${host.url}/api/snapshots/${detail.snapshots[0].id}/text?offset=0&length=80`)).json() as { text: string; totalLength: number };
    assert.equal(snapshotText.text.length <= 80, true);
    assert.ok(snapshotText.totalLength > 80);
    assert.equal((await fetch(`${host.url}/api/snapshots/snap-missing/text`)).status, 404);
    const zeroResponse = await fetch(`${host.url}/api/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'zero' }) });
    assert.equal(zeroResponse.status, 202);
    const accepted = await zeroResponse.json() as { runId: string };
    let zero: { run: ExplorationRun } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      zero = await (await fetch(`${host.url}/api/runs/${accepted.runId}`)).json() as { run: ExplorationRun };
      if (zero.run.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(zero);
    assert.equal(zero.run.candidateIds.length, 0);
    const reviewed = await (await fetch(`${host.url}/api/candidates/${candidates.candidates[0].id}/review`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'retained', note: '口径已核对' }) })).json() as { candidate: CaseCandidate };
    assert.equal(reviewed.candidate.status, 'retained');
    assert.equal(reviewed.candidate.reviews[0].note, '口径已核对');
    const rejected = await fetch(`${host.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(rejected.status, 403);
    const limited = await (await fetch(`${host.url}/api/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'limited' }) })).json() as { runId: string };
    let limitedRun: { run: ExplorationRun } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      limitedRun = await (await fetch(`${host.url}/api/runs/${limited.runId}`)).json() as { run: ExplorationRun };
      if (limitedRun.run.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(limitedRun);
    assert.equal(limitedRun.run.status, 'completed', limitedRun.run.stopReason);
    assert.equal(limitedRun.run.candidateIds.length, 1);
    const sources = await (await fetch(`${host.url}/api/sources`)).json() as { sources: SourceAsset[]; searchEvents: unknown[]; snapshots: Array<{ excerpt: string; text?: string }>; webResearch: { enabled: boolean; providers: string[] } };
    assert.equal(sources.sources.filter(source => source.kind === 'web').length, 2);
    assert.ok(sources.searchEvents.length >= 4);
    assert.equal(sources.snapshots[0].text, undefined);
    assert.equal(sources.snapshots[0].excerpt.length <= 500, true);
    assert.deepEqual(sources.webResearch, { enabled: false, providers: [], preferredDomains: [], budget: null });
    const evidence = await fetch(`${host.url}/api/evidence/${sources.sources[0].sha256}`);
    assert.equal(evidence.status, 200);
    assert.match(evidence.headers.get('content-disposition') ?? '', /attachment/);
    const imported = await fetch(`${host.url}/api/imports`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('新增.csv') }, body: 'metric,entity,period,value,unit\nrevenue,华北,2026-09,1000,万元\n' });
    assert.equal(imported.status, 201);
    const importedBody = await imported.json() as { dataset: DatasetVersion };
    assert.equal(importedBody.dataset.rows.length, 1);
    const afterImport = await (await fetch(`${host.url}/api/datasets`)).json() as { datasets: DatasetVersion[] };
    assert.equal(afterImport.datasets.length, 7);
    assert.equal((await fetch(`${host.url}/api/public-sources`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 404);
  } finally {
    await new Promise<void>(resolve => host.server.close(() => resolve()));
  }
});

test('宿主取消：运行中可中止并持久化 cancelled', async () => {
  const host = await startHost({
    port: 0, dataDir: makeDataDir(), skillsDir: join(repoRoot, 'skills'), fixturesDir: join(repoRoot, 'fixtures', 'mvp'), seedDemo: false,
    runtimeFactory: () => new ControlledRuntime(async tools => {
      await tools.profile();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await tools.profile();
      return { stopReason: '不应完成' };
    }),
  });
  try {
    const acceptedResponse = await fetch(`${host.url}/api/runs`, { method: 'POST', headers: { 'x-sentiscope-client': '1', 'content-type': 'application/json' }, body: '{}' });
    const accepted = await acceptedResponse.json() as { runId: string };
    const cancel = await fetch(`${host.url}/api/runs/${accepted.runId}/cancel`, { method: 'POST', headers: { 'x-sentiscope-client': '1' } });
    assert.equal(cancel.status, 202);
    let detail: { run: ExplorationRun } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await (await fetch(`${host.url}/api/runs/${accepted.runId}`)).json() as { run: ExplorationRun };
      if (detail.run.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(detail);
    assert.equal(detail.run.status, 'cancelled');
  } finally {
    await new Promise<void>(resolve => host.server.close(() => resolve()));
  }
});

test('宿主重启：遗留 running 标记为 interrupted_by_restart', async () => {
  const dataDir = makeDataDir();
  const store = new WorkspaceStore(dataDir);
  store.createRun({ id: 'run-interrupted', datasetId: 'dataset-test', model: 'controlled', status: 'running', startedAt: '2026-10-30T00:00:00Z', finishedAt: null, budget: { maxToolCalls: 5, usedToolCalls: 1, maxSearches: 8, maxFetches: 6, maxSnapshotReads: 20, usedSearches: 0, usedFetches: 0, usedSnapshotReads: 0 }, coverage: [], candidateIds: [], stopReason: '', events: [] });
  store.close();
  const host = await startHost({ port: 0, dataDir, skillsDir: join(repoRoot, 'skills'), fixturesDir: join(repoRoot, 'fixtures', 'mvp'), seedDemo: false });
  try {
    const detail = await (await fetch(`${host.url}/api/runs/run-interrupted`)).json() as { run: ExplorationRun };
    assert.equal(detail.run.status, 'failed');
    assert.equal(detail.run.stopReason, 'interrupted_by_restart');
  } finally {
    await new Promise<void>(resolve => host.server.close(() => resolve()));
  }
});

test('切片三宿主：阈值配置生效、排除原因、指定数据集运行、统计与试用报告', async () => {
  const dataDir = makeDataDir();
  writeFileSync(join(dataDir, 'benchmarks.json'), JSON.stringify({ definitions: [{ id: 'wait-target', threshold: 40, version: 2, reason: '试用期等待时长口径偏松', approvedAt: '2026-11-05' }] }));
  const host = await startHost({
    port: 0, dataDir, skillsDir: join(repoRoot, 'skills'), fixturesDir: join(repoRoot, 'fixtures', 'mvp'), seedDemo: true, maxToolCalls: 40,
    researchFactory: ({ store, mode }) => mode === 'zero' ? undefined : createDemoResearch(store, join(repoRoot, 'fixtures', 'mvp')),
  });
  const headers = { 'x-sentiscope-client': '1' };
  type Stats = { candidates: { total: number; review: number; retained: number; excluded: number }; hitRate: number | null; exclusionReasons: Record<string, number>; byType: Record<string, { review: number; retained: number; excluded: number }>; byDataset: Record<string, { review: number; retained: number; excluded: number }>; runs: Array<{ id: string; datasetId: string; datasetName: string | null; candidates: number; usage: unknown }>; config: { loaded: boolean; current: Array<{ id: string; thresholdVersion: string; threshold: number }>; overrides: Array<{ id: string }> }; configHistory: Array<{ id: string; version: number; threshold: number; reason: string }> };
  try {
    const first = await (await fetch(`${host.url}/api/trial-stats`)).json() as Stats;
    assert.equal(first.candidates.total, 5);
    assert.equal(first.config.loaded, true);
    assert.equal(first.config.current.find(def => def.id === 'wait-target')!.threshold, 40);
    assert.equal(first.config.current.find(def => def.id === 'wait-target')!.thresholdVersion, 'wait-target@v2');
    assert.equal(first.config.current.find(def => def.id === 'revenue-target')!.thresholdVersion, 'revenue-target@v1');
    assert.deepEqual(first.configHistory.map(entry => `${entry.id}@v${entry.version}:${entry.threshold}:${entry.reason}`), ['wait-target@v2:40:试用期等待时长口径偏松']);
    assert.equal(first.runs.length, 1);
    assert.ok(first.runs[0]!.datasetName?.startsWith('合成经营数据集'), `unexpected ${first.runs[0]!.datasetName}`);
    const candidates = await (await fetch(`${host.url}/api/candidates`)).json() as { candidates: Array<{ id: string }> };
    assert.equal((await fetch(`${host.url}/api/candidates/${candidates.candidates[0]!.id}/review`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'excluded', note: '' }) })).status, 400);
    const rejected = await (await fetch(`${host.url}/api/candidates/${candidates.candidates[0]!.id}/review`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'excluded', note: '缺原因' }) })).json() as { error: string };
    assert.equal(rejected.error, 'exclusion_reason_required');
    const reviewed = await (await fetch(`${host.url}/api/candidates/${candidates.candidates[0]!.id}/review`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'excluded', note: '口径不符', reason: '口径不符' }) })).json() as { candidate: { reviews: Array<{ reason?: string }> } };
    assert.equal(reviewed.candidate.reviews[0]!.reason, '口径不符');
    assert.equal((await fetch(`${host.url}/api/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ datasetId: 'nope' }) })).status, 404);
    const datasets = await (await fetch(`${host.url}/api/datasets`)).json() as { datasets: Array<{ id: string; name: string }> };
    const base = datasets.datasets.find(item => item.name === '合成经营数据集')!;
    const accepted = await (await fetch(`${host.url}/api/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'zero', datasetId: base.id }) })).json() as { runId: string };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await (await fetch(`${host.url}/api/runs/${accepted.runId}`)).json() as { run: ExplorationRun };
      if (detail.run.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const second = await (await fetch(`${host.url}/api/trial-stats`)).json() as Stats;
    assert.equal(second.runs.length, 2);
    assert.equal(second.runs[0]!.datasetId, base.id);
    assert.equal(second.runs[0]!.candidates, 0);
    assert.equal(second.exclusionReasons['口径不符'], 1);
    assert.equal(second.hitRate, 0);
    assert.ok((second.byType.target?.review ?? 0) + (second.byType.target?.excluded ?? 0) >= 1, 'byType 缺少状态拆分');
    assert.ok(Object.keys(second.byDataset).length >= 1, 'byDataset 缺失');
    const report = await (await fetch(`${host.url}/api/trial-report`)).json() as { report: string };
    assert.match(report.report, /SentiScope 试用报告/);
    assert.match(report.report, /wait-target@v2/);
    assert.match(report.report, /口径不符 ×1/);
    assert.match(report.report, /回链/);
    assert.match(report.report, /只陈述统计与建议/);
  } finally {
    await new Promise<void>(resolve => host.server.close(() => resolve()));
    applyBenchmarkConfig({ loaded: false, overrides: [] });
  }
});
