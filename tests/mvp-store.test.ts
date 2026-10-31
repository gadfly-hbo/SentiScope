import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDescriptive } from '../src/core/comparison.ts';
import { createCandidate } from '../src/core/candidates.ts';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import type { CandidateInput, Observation } from '../src/core/mvp-types.ts';
import { makeDataDir } from './helpers.ts';

const NOW = '2026-10-03T02:08:00.000Z';
function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    runId: 'run-1',
    datasetId: 'dataset-test',
    comparison: compareDescriptive({
      comparisonType: 'target', metricId: 'revenue', entity: '华东', period: '2026-09', actual: 880, benchmark: 1000,
      unit: '万元', direction: 'higher-better', threshold: 10, periodClosed: true, comparable: true,
      benchmarkLabel: '内部目标', evidence: [{ assetSha256: 'a'.repeat(64), kind: 'raw', locator: 'row:2' }, { assetSha256: 'b'.repeat(64), kind: 'raw', locator: 'row:8' }],
      selectionContext: '全部区域已检查',
    }),
    title: '华东区域 9 月收入低于目标 120 万元', interpretation: '已确认目标差距，原因未知', nextStep: '复核证据',
    unknown: '原因未知', support: '目标与收入原始记录完整', refutation: '已检查单位与区域拆分', refutationObservationId: 'obs-refutation', thresholdVersion: 'revenue-target@v1',
    ...overrides,
  };
}

function prepare(store: WorkspaceStore): void {
  for (const letter of ['a', 'b']) {
    const sha256 = letter.repeat(64);
    store.insertAsset({ id: `asset-${letter}`, kind: 'file', name: letter, sha256, mediaType: 'text/plain', bytes: 1, importedAt: NOW, publishedAt: null, capturedAt: null, locator: 'fixture', path: '/tmp/fixture', metadata: {} });
  }
  const rawRows = [
    { rowNumber: 2, values: { metric: 'revenue', entity: '华东', period: '2026-09', value: 880, unit: '万元' }, issues: [], source: { assetSha256: 'a'.repeat(64), kind: 'raw' as const, locator: 'row:2' } },
    { rowNumber: 8, values: { metric: 'revenue.target', entity: '华东', period: '2026-09', value: 1000, unit: '万元' }, issues: [], source: { assetSha256: 'b'.repeat(64), kind: 'raw' as const, locator: 'row:8' } },
  ];
  const rows = rawRows.map((raw, index) => ({ rowId: `row-${index + 1}`, metricId: String(raw.values.metric), entity: '华东', period: '2026-09', value: Number(raw.values.value), unit: '万元', dimensions: {}, quality: 'usable' as const, issues: [], source: raw.source }));
  store.insertDataset({ id: 'dataset-test', version: 1, name: 'fixture', createdAt: NOW, sourceAssetIds: ['asset-a', 'asset-b'], rows, rawRows, fields: ['metric'], steps: [], quality: { usable: 2, blocked: 0, needsEvidence: 0 }, sha256: 'fixture' });
  store.appendObservations([{ id: 'obs-refutation', runId: 'run-1', kind: 'decision', status: 'observed', role: 'refutation', comparisonId: 'cmp-1', summary: '已检查反证', evidence: [{ assetSha256: 'a'.repeat(64), kind: 'raw', locator: 'row:2' }], createdAt: NOW }]);
}

test('CAND-01/04：合格候选提交、稳定指纹、重复提交不刷板', () => {
  const store = new WorkspaceStore(makeDataDir());
  prepare(store);
  const first = createCandidate(candidateInput(), NOW);
  const second = createCandidate(candidateInput({ title: '措辞变化不应制造新候选', comparison: { ...candidateInput().comparison, selectionContext: '选择上下文措辞变化也不改变身份' } }), NOW);
  assert.equal(first.fingerprint, second.fingerprint);
  const observation: Observation = { id: 'obs-1', runId: 'run-1', kind: 'comparison', status: 'candidate', comparisonId: 'cmp-1', summary: '目标差距', evidence: first.comparison.evidence, createdAt: NOW };
  store.commitCandidate(first, observation);
  store.commitCandidate(second, { ...observation, id: 'obs-2', runId: 'run-2', comparisonId: 'cmp-1' });
  assert.equal(store.listCandidates().length, 1);
  assert.equal(store.listObservations().length, 3);
  assert.equal(store.listCandidates()[0]!.title, first.title);
  store.close();
});

test('CAND-01/02/03：缺反证、根因标题、未合格观察均被门禁拒绝', () => {
  assert.throws(() => createCandidate(candidateInput({ refutation: '' }), NOW), /refutation_required/);
  assert.throws(() => createCandidate(candidateInput({ title: '竞对导致华东收入下降' }), NOW), /non_descriptive_title/);
  const notQualified = candidateInput();
  notQualified.comparison = { ...notQualified.comparison, status: 'needs_evidence' };
  assert.throws(() => createCandidate(notQualified, NOW), /not_qualified/);
});

test('人工复核只追加状态与说明，不修改比较事实', () => {
  const store = new WorkspaceStore(makeDataDir());
  prepare(store);
  const candidate = createCandidate(candidateInput(), NOW);
  store.commitCandidate(candidate, { id: 'obs-1', runId: 'run-1', kind: 'comparison', status: 'candidate', comparisonId: 'cmp-1', summary: '目标差距', evidence: candidate.comparison.evidence, createdAt: NOW });
  store.reviewCandidate(candidate.id, 'retained', '目标口径已核对 <b>不执行HTML</b>', '2026-10-03T02:30:00.000Z');
  const reviewed = store.getCandidate(candidate.id)!;
  assert.equal(reviewed.status, 'retained');
  assert.equal(reviewed.reviews[0]!.note, '目标口径已核对 <b>不执行HTML</b>');
  assert.equal(reviewed.comparison.gap, -120);
  assert.equal(reviewed.comparison.formula, candidate.comparison.formula);
  store.close();
});

test('CAND-02：反证观察引用不存在的证据时拒绝候选', () => {
  const store = new WorkspaceStore(makeDataDir()); prepare(store);
  const candidate = createCandidate(candidateInput({ refutationObservationId: 'obs-bad-refutation' }), NOW);
  store.appendObservations([{ id: 'obs-bad-refutation', runId: 'run-1', kind: 'decision', status: 'observed', role: 'refutation', comparisonId: 'cmp-1', summary: '伪造反证', evidence: [{ assetSha256: 'c'.repeat(64), kind: 'raw', locator: 'row:999' }], createdAt: NOW }]);
  assert.throws(() => store.commitCandidate(candidate, { id: 'obs-1', runId: 'run-1', kind: 'comparison', status: 'candidate', comparisonId: 'cmp-1', summary: '目标差距', evidence: candidate.comparison.evidence, createdAt: NOW }), /evidence_not_found/);
  store.close();
});

test('CAND-02：反证不得使用无法定位的计算引用代替原始证据', () => {
  const store = new WorkspaceStore(makeDataDir()); prepare(store);
  const candidate = createCandidate(candidateInput({ refutationObservationId: 'obs-calc-refutation' }), NOW);
  store.appendObservations([{ id: 'obs-calc-refutation', runId: 'run-1', kind: 'decision', status: 'observed', role: 'refutation', comparisonId: 'cmp-1', summary: '伪造计算反证', evidence: [{ assetSha256: 'f'.repeat(64), kind: 'calculation', locator: 'comparison:not-found' }], createdAt: NOW }]);
  assert.throws(() => store.commitCandidate(candidate, { id: 'obs-1', runId: 'run-1', kind: 'comparison', status: 'candidate', comparisonId: 'cmp-1', summary: '目标差距', evidence: candidate.comparison.evidence, createdAt: NOW }), /calculation_evidence_not_allowed/);
  store.close();
});

test('CAND-04：实质新证据形成修订并保留历史，不新增候选', () => {
  const store = new WorkspaceStore(makeDataDir()); prepare(store);
  const first = createCandidate(candidateInput(), NOW);
  store.commitCandidate(first, { id: 'obs-1', runId: 'run-1', kind: 'comparison', status: 'candidate', comparisonId: 'cmp-1', summary: '第一版', evidence: first.comparison.evidence, createdAt: NOW });
  const changedInput = candidateInput();
  changedInput.comparison = { ...changedInput.comparison, actual: 900, gap: -100, gapRate: -10, formula: '修订后的确定性计算', evidence: [...changedInput.comparison.evidence] };
  const second = createCandidate(changedInput, '2026-10-04T02:08:00.000Z');
  store.commitCandidate(second, { id: 'obs-2', runId: 'run-1', kind: 'comparison', status: 'candidate', comparisonId: 'cmp-1', summary: '第二版', evidence: second.comparison.evidence, createdAt: '2026-10-04T02:08:00.000Z' });
  const candidates = store.listCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.revision, 2);
  assert.equal(candidates[0]!.revisions.length, 1);
  assert.equal(candidates[0]!.comparison.actual, 900);
  assert.equal(candidates[0]!.revisions[0]!.comparison.actual, 880);
  store.close();
});
