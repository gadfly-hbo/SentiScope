import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { startHost } from '../src/host/server.ts';
import { ControlledRuntime } from '../src/agent/exploration-service.ts';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import type { CaseCandidate, DatasetVersion, ExplorationRun, SourceAsset } from '../src/core/mvp-types.ts';
import { makeDataDir, repoRoot } from './helpers.ts';

test('切片二宿主：合成端到端 API、零候选、复核、导入与本机写保护', async () => {
  const host = await startHost({ port: 0, dataDir: makeDataDir(), skillsDir: join(repoRoot, 'skills'), fixturesDir: join(repoRoot, 'fixtures', 'mvp'), seedDemo: true });
  const headers = { 'x-sentiscope-client': '1' };
  try {
    assert.equal((await fetch(`${host.url}/health`)).status, 200);
    const candidates = await (await fetch(`${host.url}/api/candidates`)).json() as { candidates: CaseCandidate[] };
    assert.equal(candidates.candidates.length, 4);
    const datasets = await (await fetch(`${host.url}/api/datasets`)).json() as { datasets: DatasetVersion[] };
    assert.equal(datasets.datasets.length, 1);
    assert.ok(datasets.datasets[0].rows.length >= 10);
    const runs = await (await fetch(`${host.url}/api/runs`)).json() as { runs: ExplorationRun[] };
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].candidateIds.length, 4);
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
    const sources = await (await fetch(`${host.url}/api/sources`)).json() as { sources: SourceAsset[] };
    assert.equal(sources.sources.filter(source => source.kind === 'web').length, 2);
    const evidence = await fetch(`${host.url}/api/evidence/${sources.sources[0].sha256}`);
    assert.equal(evidence.status, 200);
    assert.match(evidence.headers.get('content-disposition') ?? '', /attachment/);
    const imported = await fetch(`${host.url}/api/imports`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('新增.csv') }, body: 'metric,entity,period,value,unit\nrevenue,华北,2026-09,1000,万元\n' });
    assert.equal(imported.status, 201);
    const importedBody = await imported.json() as { dataset: DatasetVersion };
    assert.equal(importedBody.dataset.rows.length, 1);
    const afterImport = await (await fetch(`${host.url}/api/datasets`)).json() as { datasets: DatasetVersion[] };
    assert.equal(afterImport.datasets.length, 2);
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
  store.createRun({ id: 'run-interrupted', datasetId: 'dataset-test', model: 'controlled', status: 'running', startedAt: '2026-10-30T00:00:00Z', finishedAt: null, budget: { maxToolCalls: 5, usedToolCalls: 1 }, coverage: [], candidateIds: [], stopReason: '', events: [] });
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
