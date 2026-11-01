import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyBenchmarkConfig, benchmarkConfigStatus, getBenchmarkDefinition, loadBenchmarkConfig } from '../src/core/benchmarks.ts';
import { compareDescriptive } from '../src/core/comparison.ts';
import { createCandidate } from '../src/core/candidates.ts';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import { readSessionUsage } from '../src/host/session-usage.ts';
import type { CandidateInput } from '../src/core/mvp-types.ts';
import { makeDataDir } from './helpers.ts';

const NOW = '2026-11-01T00:00:00.000Z';
const resetBenchmarks = () => applyBenchmarkConfig({ loaded: false, overrides: [] });

function trialCandidate(): CandidateInput {
  return {
    runId: 'run-1', datasetId: 'dataset-test',
    comparison: compareDescriptive({
      comparisonType: 'target', metricId: 'revenue', entity: '华东', period: '2026-09', actual: 880, benchmark: 1000,
      unit: '万元', direction: 'higher-better', threshold: 10, periodClosed: true, comparable: true, benchmarkLabel: '内部目标',
      evidence: [{ assetSha256: 'a'.repeat(64), kind: 'raw', locator: 'row:2' }, { assetSha256: 'b'.repeat(64), kind: 'raw', locator: 'row:8' }],
      selectionContext: '全部区域已检查',
    }),
    title: '华东区域 9 月收入低于目标 120 万元', interpretation: '目标差距，原因未知', nextStep: '复核证据',
    unknown: '原因未知', support: '目标与收入原始记录完整', refutation: '已检查单位与区域拆分', refutationObservationId: 'obs-refutation', thresholdVersion: 'revenue-target@v1', calculationLocator: 'comparison:cmp-1;revision:1',
  };
}

function prepareCandidate(store: WorkspaceStore): string {
  for (const letter of ['a', 'b']) {
    store.insertAsset({ id: `asset-${letter}`, kind: 'file', name: letter, sha256: letter.repeat(64), mediaType: 'text/plain', bytes: 1, importedAt: NOW, publishedAt: null, capturedAt: null, locator: 'fixture', path: '/tmp/fixture', metadata: {} });
  }
  const rawRows = [
    { rowNumber: 2, values: { metric: 'revenue', entity: '华东', period: '2026-09', value: 880, unit: '万元' }, issues: [], source: { assetSha256: 'a'.repeat(64), kind: 'raw' as const, locator: 'row:2' } },
    { rowNumber: 8, values: { metric: 'revenue.target', entity: '华东', period: '2026-09', value: 1000, unit: '万元' }, issues: [], source: { assetSha256: 'b'.repeat(64), kind: 'raw' as const, locator: 'row:8' } },
  ];
  const rows = rawRows.map((raw, index) => ({ rowId: `row-${index + 1}`, metricId: String(raw.values.metric), entity: '华东', period: '2026-09', value: Number(raw.values.value), unit: '万元', dimensions: {}, quality: 'usable' as const, issues: [], source: raw.source }));
  store.insertDataset({ id: 'dataset-test', version: 1, name: 'fixture', createdAt: NOW, sourceAssetIds: ['asset-a', 'asset-b'], rows, rawRows, fields: ['metric'], steps: [], quality: { usable: 2, blocked: 0, needsEvidence: 0 }, sha256: 'fixture' });
  store.appendObservations([{ id: 'obs-refutation', runId: 'run-1', kind: 'decision', status: 'observed', role: 'refutation', comparisonId: 'cmp-1', summary: '已检查反证', evidence: [{ assetSha256: 'a'.repeat(64), kind: 'raw', locator: 'row:2' }], createdAt: NOW }]);
  const candidate = createCandidate(trialCandidate(), NOW);
  const committed = store.commitCandidate(candidate, { id: 'obs-1', runId: 'run-1', kind: 'comparison', status: 'candidate', comparisonId: 'cmp-1', summary: '目标差距', comparison: candidate.comparison, evidence: candidate.comparison.evidence, createdAt: NOW });
  return committed.id;
}

test('TRI-01：缺配置回落默认；非法配置 fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trial-cfg-'));
  const path = join(dir, 'benchmarks.json');
  assert.deepEqual(loadBenchmarkConfig(path), { loaded: false, overrides: [] });
  writeFileSync(path, '{bad json');
  assert.throws(() => loadBenchmarkConfig(path), /invalid_benchmark_config/);
  writeFileSync(path, JSON.stringify({ definitions: [{ id: 'nope', threshold: 5, version: 2 }] }));
  assert.throws(() => loadBenchmarkConfig(path), /未知基准/);
  writeFileSync(path, JSON.stringify({ definitions: [{ id: 'revenue-target', threshold: -1, version: 2 }] }));
  assert.throws(() => loadBenchmarkConfig(path), /阈值必须为正数/);
  writeFileSync(path, JSON.stringify({ definitions: [{ id: 'revenue-target', threshold: 12, version: 1 }, { id: 'revenue-target', threshold: 13, version: 2 }] }));
  assert.throws(() => loadBenchmarkConfig(path), /重复基准/);
  writeFileSync(path, JSON.stringify({}));
  assert.throws(() => loadBenchmarkConfig(path), /缺少 definitions/);
});

test('TRI-02/03：覆盖生成新 thresholdVersion 并留变更记录；重置恢复默认', () => {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'trial-cfg-'));
    const path = join(dir, 'benchmarks.json');
    writeFileSync(path, JSON.stringify({ definitions: [{ id: 'revenue-target', threshold: 12, version: 3, reason: '口径不符 3 例均在 10–12%', approvedAt: '2026-11-05' }] }));
    const config = loadBenchmarkConfig(path);
    applyBenchmarkConfig(config);
    assert.equal(getBenchmarkDefinition('revenue-target').threshold, 12);
    assert.equal(getBenchmarkDefinition('revenue-target').thresholdVersion, 'revenue-target@v3');
    assert.equal(getBenchmarkDefinition('revenue-history').thresholdVersion, 'revenue-history@v1');
    const store = new WorkspaceStore(makeDataDir());
    store.recordBenchmarkVersions(config.overrides.map(override => ({ ...override, reason: override.reason ?? '', approvedAt: override.approvedAt ?? '' })), '2026-11-05T00:00:00Z');
    assert.deepEqual(store.listBenchmarkVersions().map(entry => `${entry.id}@v${entry.version}:${entry.threshold}:` + entry.reason), ['revenue-target@v3:12:口径不符 3 例均在 10–12%']);
    store.recordBenchmarkVersions([{ id: 'revenue-target', version: 3, threshold: 12, reason: '', approvedAt: '' }], '2026-11-06T00:00:00Z');
    assert.equal(store.listBenchmarkVersions().length, 1, '同版本重复登记不刷写');
    store.close();
    assert.equal(benchmarkConfigStatus().loaded, true);
    assert.equal(benchmarkConfigStatus().overrides.length, 1);
  } finally {
    resetBenchmarks();
  }
  assert.equal(getBenchmarkDefinition('revenue-target').threshold, 10);
  assert.equal(getBenchmarkDefinition('revenue-target').thresholdVersion, 'revenue-target@v1');
  assert.equal(benchmarkConfigStatus().loaded, false);
});

test('TRI-05：排除必选四类原因之一，保留不需要；复核历史只追加', () => {
  const store = new WorkspaceStore(makeDataDir());
  const candidateId = prepareCandidate(store);
  assert.throws(() => store.reviewCandidate(candidateId, 'excluded', '', NOW), /exclusion_reason_required/);
  assert.throws(() => store.reviewCandidate(candidateId, 'excluded', '', NOW, '随便写的'), /invalid_exclusion_reason/);
  const excluded = store.reviewCandidate(candidateId, 'excluded', '口径与区域分摊不符', NOW, '口径不符');
  assert.equal(excluded.reviews[0]!.reason, '口径不符');
  const retained = store.reviewCandidate(candidateId, 'retained', '复核通过', NOW);
  assert.equal(retained.reviews[0]!.reason, undefined);
  assert.equal(retained.reviews.length, 2);
  store.close();
});

test('TRI-05：旧库 reviews 缺 reason 列时自动迁移', () => {
  const dir = makeDataDir();
  const legacy = new DatabaseSync(join(dir, 'workspace.sqlite3'));
  legacy.exec("CREATE TABLE reviews (candidate_id TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL)");
  legacy.close();
  const store = new WorkspaceStore(dir);
  const candidateId = prepareCandidate(store);
  const excluded = store.reviewCandidate(candidateId, 'excluded', '', NOW, '证据不足');
  assert.equal(excluded.reviews[0]!.reason, '证据不足');
  store.close();
});

test('TRI-07：从 Pi 会话文件读取用量与费用；坏行与缺失会话按不可得处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trial-sessions-'));
  writeFileSync(join(dir, '2026-11-01T00-00-00-000Z_session-a.jsonl'), [
    JSON.stringify({ type: 'session' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'q' } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'a1', usage: { input: 100, output: 50, cacheRead: 1000, totalTokens: 1150, cost: { total: 0.001 } } } }),
    '{oops bad line',
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'a2', usage: { input: 200, output: 80, totalTokens: 280 } } }),
  ].join('\n'));
  const usage = readSessionUsage(dir, 'session-a')!;
  assert.deepEqual(usage, { modelCalls: 2, inputTokens: 300, outputTokens: 130, cacheReadTokens: 1000, totalTokens: 1430, costTotal: 0.001 });
  assert.equal(readSessionUsage(dir, 'missing-session'), null);
  const noCostDir = mkdtempSync(join(tmpdir(), 'trial-sessions-'));
  writeFileSync(join(noCostDir, '2026-11-01T00-00-00-000Z_session-b.jsonl'), JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 1, output: 1, totalTokens: 2 } } }));
  assert.equal(readSessionUsage(noCostDir, 'session-b')!.costTotal, null);
});

test('TRI-01：字符串阈值与空条目按字段级错误拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trial-cfg-'));
  const path = join(dir, 'benchmarks.json');
  writeFileSync(path, JSON.stringify({ definitions: [{ id: 'revenue-target', threshold: '40', version: 2 }] }));
  assert.throws(() => loadBenchmarkConfig(path), /阈值必须为正数/);
  writeFileSync(path, JSON.stringify({ definitions: [null] }));
  assert.throws(() => loadBenchmarkConfig(path), /条目必须是对象/);
});

test('TRI-02：同版本不同阈值冲突 fail-closed，不改写已登记版本', () => {
  const store = new WorkspaceStore(makeDataDir());
  store.recordBenchmarkVersions([{ id: 'revenue-target', version: 2, threshold: 12, reason: '', approvedAt: '' }], NOW);
  assert.throws(() => store.recordBenchmarkVersions([{ id: 'revenue-target', version: 2, threshold: 13, reason: '', approvedAt: '' }], NOW), /benchmark_version_conflict/);
  assert.deepEqual(store.listBenchmarkVersions().map(entry => entry.threshold), [12]);
  store.close();
});

test('TRI-02：新阈值版本不改写历史候选的 thresholdVersion 与比较结果', () => {
  try {
    const store = new WorkspaceStore(makeDataDir());
    const candidateId = prepareCandidate(store);
    const before = store.getCandidate(candidateId)!;
    applyBenchmarkConfig({ loaded: true, overrides: [{ id: 'revenue-target', threshold: 12, version: 2 }] });
    const after = store.getCandidate(candidateId)!;
    assert.equal(after.thresholdVersion, before.thresholdVersion);
    assert.equal(after.thresholdVersion, 'revenue-target@v1');
    assert.deepEqual(after.comparison, before.comparison);
    store.close();
  } finally {
    resetBenchmarks();
  }
});

test('TRI-09：证据回链校验的失败分支如实列出（定位缺失／资产缺失／计算事件缺失／数据集缺失）', async () => {
  const { verifyEvidenceLink } = await import('../src/host/trial.ts');
  const store = new WorkspaceStore(makeDataDir());
  const candidateId = prepareCandidate(store);
  const candidate = store.getCandidate(candidateId)!;
  const lookup = {
    dataset: store.getDataset(candidate.datasetId),
    assetExists: (sha256: string) => store.listAssets().some(asset => asset.sha256 === sha256),
    observations: store.listObservations(candidate.runId),
  };
  assert.deepEqual(verifyEvidenceLink(candidate, lookup), []);
  const badLocator = { ...candidate, comparison: { ...candidate.comparison, evidence: candidate.comparison.evidence.map(ref => ref.kind === 'calculation' ? ref : { ...ref, locator: 'row:999' }) } };
  assert.deepEqual(verifyEvidenceLink(badLocator, lookup).filter(item => item.includes('row:999')).length, 2);
  const badAsset = { ...candidate, comparison: { ...candidate.comparison, evidence: candidate.comparison.evidence.map(ref => ref.kind === 'calculation' ? ref : { ...ref, assetSha256: 'c'.repeat(64) }) } };
  assert.equal(verifyEvidenceLink(badAsset, lookup).filter(item => item.includes('不存在')).length, 2);
  const badCalculation = { ...candidate, comparison: { ...candidate.comparison, evidence: candidate.comparison.evidence.map(ref => ref.kind === 'calculation' ? { ...ref, locator: 'comparison:missing;revision:1' } : ref) } };
  assert.deepEqual(verifyEvidenceLink(badCalculation, lookup), ['计算事件 comparison:missing;revision:1 未找到']);
  assert.deepEqual(verifyEvidenceLink(candidate, { ...lookup, dataset: null }), ['数据集 dataset-test 不存在']);
  store.close();
});
