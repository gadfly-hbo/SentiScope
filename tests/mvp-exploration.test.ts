import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import { ControlledRuntime, runExploration } from '../src/agent/exploration-service.ts';
import { createStaticSearchProvider, WebResearchService } from '../src/source/web-research.ts';
import type { RawRow, SourceAsset, StandardRow } from '../src/core/mvp-types.ts';
import { makeDataDir } from './helpers.ts';

const NOW = '2026-10-03T02:08:00.000Z';
function dataset(rows: StandardRow[]) {
  const rawRows: RawRow[] = rows.map((row, index) => ({ rowNumber: index + 2, values: { metric: row.metricId, entity: row.entity, period: row.period, value: row.value, unit: row.unit, ...row.dimensions }, issues: [], source: row.source }));
  return {
    id: 'dataset-test', version: 1, name: '四类比较', createdAt: NOW, sourceAssetIds: ['asset-a'], rows, rawRows,
    fields: ['metric', 'entity', 'period', 'value', 'unit'], steps: [], sha256: 'fixture-hash',
    quality: { usable: rows.length, blocked: 0, needsEvidence: 0 },
  };
}
function row(metricId: string, entity: string, period: string, value: number, unit: string, index: number, dimensions: Record<string, string> = {}): StandardRow {
  const complete = { closed: 'true', comparable: 'true', scope: 'same', currency: 'CNY', region: 'same', ...dimensions };
  return { rowId: `row-${index}`, metricId, entity, period, value, unit, dimensions: complete, quality: 'usable', issues: [], source: { assetSha256: String(index).padStart(2, '0').repeat(32), kind: index % 3 === 0 ? 'web' : 'raw', locator: `row:${index + 2}` } };
}
function fourGapDataset() {
  return dataset([
    row('revenue', '华东', '2026-09', 880, '万元', 1),
    row('revenue.target', '华东', '2026-09', 1000, '万元', 2),
    row('revenue', '西南', '2026-09', 938, '万元', 3),
    row('revenue', '西南', '2025-09', 1000, '万元', 4),
    row('growth', '自身', '2026Q3', -5.2, '%', 5),
    row('growth', '竞对A', '2026Q3', 7.1, '%', 6),
    row('growth', '行业', '2026Q3', 3, '%', 7),
    row('revenue', '华南', '2026-09', 1050, '万元', 8),
    row('revenue.target', '华南', '2026-09', 1000, '万元', 9),
    row('orders', '线上', '2026-09', 8140, '单', 10, { comparable: 'false' }),
    row('orders', '线上', '2025-09', 9980, '单', 11),
    row('revenue', '自身', '2026Q3', 9480, '万元', 12),
    row('revenue', '自身', '2025Q3', 10000, '万元', 13),
    row('revenue', '竞对A', '2026Q3', 21420, '万元', 14),
    row('revenue', '竞对A', '2025Q3', 20000, '万元', 15),
    row('revenue', '行业', '2026Q3', 30900, '万元', 16),
    row('revenue', '行业', '2025Q3', 30000, '万元', 17),
  ]);
}
function seedAssets(store: WorkspaceStore, data: ReturnType<typeof dataset>): void {
  const refs = new Map(data.rows.map(row => [row.source.assetSha256, row.source]));
  for (const [sha256, ref] of refs) {
    const asset: SourceAsset = { id: `asset-${sha256.slice(0, 4)}`, kind: ref.kind === 'web' ? 'web' : 'file', name: 'fixture', sha256, mediaType: 'text/plain', bytes: 1, importedAt: NOW, publishedAt: '2026-10-02', capturedAt: NOW, locator: ref.locator, path: '/tmp/fixture', metadata: {} };
    store.insertAsset(asset);
  }
}
const coverage = '已检查目标、历史、竞对、行业及全部近失样例';
async function propose(tools: import('../src/agent/exploration-service.ts').ExplorationTools, result: import('../src/core/mvp-types.ts').ComparisonResult & { id: string }, title: string) {
  const refutation = await tools.observe({ summary: '已检查替代切片与数据质量', role: 'refutation', comparisonId: result.id, evidence: result.evidence });
  return tools.propose({ comparisonId: result.id, title, interpretation: '描述性差距成立', nextStep: '人工复核证据', unknown: '原因未知', refutationObservationId: refutation.id });
}

test('E2E/AGT-01：Agent 自主选择比较，四个应发现项全通过，近失项不入选', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const data = fourGapDataset(); store.insertDataset(data); seedAssets(store, data);
  const order: string[] = [];
  const runtime = new ControlledRuntime(async tools => {
    await tools.profile();
    await tools.setCoverage([coverage]);
    const competitor = await tools.compare({ definitionId: 'growth-competitor', actualRowId: 'row-12', benchmarkRowId: 'row-14', actualPreviousRowId: 'row-13', benchmarkPreviousRowId: 'row-15', selectionContext: coverage }); order.push(competitor.comparisonType);
    const target = await tools.compare({ definitionId: 'revenue-target', actualRowId: 'row-1', benchmarkRowId: 'row-2', selectionContext: coverage }); order.push(target.comparisonType);
    const history = await tools.compare({ definitionId: 'revenue-history', actualRowId: 'row-3', benchmarkRowId: 'row-4', selectionContext: coverage }); order.push(history.comparisonType);
    const industry = await tools.compare({ definitionId: 'growth-industry', actualRowId: 'row-12', benchmarkRowId: 'row-16', actualPreviousRowId: 'row-13', benchmarkPreviousRowId: 'row-17', selectionContext: coverage }); order.push(industry.comparisonType);
    await tools.compare({ definitionId: 'revenue-target', actualRowId: 'row-8', benchmarkRowId: 'row-9', selectionContext: coverage });
    await tools.compare({ definitionId: 'revenue-history', actualRowId: 'row-10', benchmarkRowId: 'row-11', selectionContext: coverage });
    await propose(tools, target, '华东区域 9 月收入低于目标 120 万元');
    await propose(tools, history, '西南区域收入同比下降 6.2%');
    await propose(tools, competitor, '自身收入增速低于竞对 A 12.3 个百分点');
    await propose(tools, industry, '自身收入增速低于细分行业 8.2 个百分点');
    return { stopReason: '四类比较完成' };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-four', now: NOW, maxToolCalls: 25 });
  assert.equal(run.status, 'completed', run.stopReason);
  assert.deepEqual(order, ['competitor', 'target', 'history', 'industry'], 'Host 不得重写 Agent 选择顺序');
  assert.equal(run.candidateIds.length, 4);
  assert.equal(store.listCandidates().length, 4);
  assert.equal(store.listObservations(run.id).filter(observation => observation.comparison?.status === 'needs_evidence').length, 1);
  assert.ok(run.coverage.includes(coverage));
  assert.ok(store.listCandidates().every(candidate => candidate.comparison.evidence.some(ref => ref.kind === 'calculation')));
  store.close();
});

test('AGT-02：零候选是正常完成，观察与覆盖保留', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const data = dataset([row('revenue', '华东', '2026-09', 1020, '万元', 1), row('revenue.target', '华东', '2026-09', 1000, '万元', 2)]); store.insertDataset(data); seedAssets(store, data);
  const runtime = new ControlledRuntime(async tools => {
    await tools.setCoverage(['已检查目标差距']);
    await tools.compare({ definitionId: 'revenue-target', actualRowId: 'row-1', benchmarkRowId: 'row-2', selectionContext: '已检查目标差距' });
    return { stopReason: '没有合格候选' };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-zero', now: NOW, maxToolCalls: 5 });
  assert.equal(run.status, 'completed');
  assert.equal(run.candidateIds.length, 0);
  assert.equal(store.listCandidates().length, 0);
  assert.equal(store.listObservations(run.id).length, 1);
  store.close();
});

test('Agent 清洗生成新版本，原始数据版本保持不变', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const data = dataset([row('revenue', '华东区', '2026-09', 880, '万元', 1)]); store.insertDataset(data);
  const runtime = new ControlledRuntime(async tools => {
    const cleaned = await tools.clean({ entityAliases: { '华东区': '华东' } });
    const rows = await tools.query({ entity: '华东' });
    return { stopReason: `${cleaned.id}:${rows.length}` };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-clean', now: NOW });
  assert.notEqual(run.datasetId, data.id);
  assert.equal(store.getDataset(data.id)!.rows[0]!.entity, '华东区');
  assert.equal(store.getDataset(run.datasetId)!.rows[0]!.entity, '华东');
  assert.match(run.stopReason, /:1$/);
  store.close();
});

test('未知口径与缺失搜索覆盖 fail-closed', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const data = dataset([
    row('revenue', '华东', '2026-09', 880, '万元', 1, { closed: '', comparable: '', scope: '', currency: '', region: '' }),
    row('revenue.target', '华东', '2026-09', 1000, '万元', 2),
  ]); store.insertDataset(data); seedAssets(store, data);
  const runtime = new ControlledRuntime(async tools => {
    const target = await tools.compare({ definitionId: 'revenue-target', actualRowId: 'row-1', benchmarkRowId: 'row-2', selectionContext: coverage });
    await tools.observe({ summary: '形式反证', role: 'refutation', comparisonId: target.id, evidence: target.evidence });
    await tools.propose({ comparisonId: target.id, title: '不应进入', interpretation: 'x', nextStep: 'x', unknown: 'x', refutationObservationId: 'obs-run-unknown-note-2' });
    return { stopReason: '不应到达' };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-unknown', now: NOW });
  assert.equal(run.status, 'failed');
  assert.equal(store.listCandidates().length, 0);
  assert.equal(store.listObservations(run.id)[0]!.comparison!.status, 'needs_evidence');
  store.close();
});

test('AGT-04：取消与预算状态真实保留，不写成成功', async () => {
  const store = new WorkspaceStore(makeDataDir()); const data = fourGapDataset(); store.insertDataset(data); seedAssets(store, data);
  const controller = new AbortController();
  const runtime = new ControlledRuntime(async tools => {
    await tools.compare({ definitionId: 'revenue-target', actualRowId: 'row-1', benchmarkRowId: 'row-2', selectionContext: coverage });
    controller.abort();
    await tools.profile();
    return { stopReason: '不应到达' };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-cancel', now: NOW, maxToolCalls: 5, signal: controller.signal });
  assert.equal(run.status, 'cancelled');
  assert.equal(store.getRun(run.id)!.status, 'cancelled');
  const budget = await runExploration({ store, dataset: data, runtime: new ControlledRuntime(async tools => { await tools.profile(); await tools.profile(); return { stopReason: '不应到达' }; }), runId: 'run-budget', now: NOW, maxToolCalls: 1 });
  assert.equal(budget.status, 'failed');
  assert.match(budget.stopReason, /budget_exceeded/);
  store.close();
});

test('AGT-04：预取消不得执行为 completed', async () => {
  const store = new WorkspaceStore(makeDataDir()); const data = fourGapDataset(); store.insertDataset(data); seedAssets(store, data);
  const controller = new AbortController(); controller.abort();
  let called = false;
  const runtime = new ControlledRuntime(async () => { called = true; return { stopReason: '不应到达' }; });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-pre-abort', now: NOW, signal: controller.signal });
  assert.equal(run.status, 'cancelled');
  assert.equal(called, false);
  assert.equal(store.getRun(run.id)!.status, 'cancelled');
  store.close();
});

const PUBLIC_IP = '93.184.216.34';
function researchService(store: WorkspaceStore) {
  return new WebResearchService({
    store, rootDir: store.rootDir, now: NOW,
    providers: [createStaticSearchProvider('synthetic', [{ url: 'https://example.com/industry?period=2026Q3', title: '行业披露', snippet: '行业增速 3.0%' }])],
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    transport: async (url: URL) => url.pathname === '/robots.txt'
      ? { status: 200, headers: {}, body: Buffer.from('User-agent: *\nAllow: /'), remoteAddress: PUBLIC_IP }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><head><title>行业披露</title></head><body><time datetime="2026-10-05">2026-10-05</time><p>Industry revenue grew 3.0% in 2026Q3.</p></body></html>'), remoteAddress: PUBLIC_IP },
    budget: { maxSearches: 2, maxFetches: 2, maxSnapshotReads: 3 },
    preferredDomains: ['example.com'],
  });
}

test('WEB-01/06：搜索配额、快照与外部数字同步进运行状态与新数据版本', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const data = fourGapDataset(); store.insertDataset(data); seedAssets(store, data);
  let factRowId = '';
  const runtime = new ControlledRuntime(async tools => {
    const search = await tools.webSearch({ query: '行业增速 2026Q3' }) as { ok: boolean; hits: Array<{ url: string; tier: string }> };
    assert.equal(search.hits[0]!.tier, 'A');
    const fetched = await tools.fetchPage({ url: search.hits[0]!.url }) as { ok: boolean; snapshotId: string };
    await tools.readSnapshot({ snapshotId: fetched.snapshotId, offset: 0, length: 200 });
    const fact = await tools.recordWebFact({
      snapshotId: fetched.snapshotId, quote: 'Industry revenue grew 3.0% in 2026Q3.', valueText: '3.0%', metricId: 'growth', entity: '行业披露', period: '2026Q3', unit: '%',
      dimensions: { scope: 'same', currency: 'CNY', region: 'same', sourceType: 'primary', publishedAt: '2026-10-05', closed: 'true', comparable: 'true' },
    }) as { ok: boolean; row: { rowId: string } };
    factRowId = fact.row.rowId;
    return { stopReason: '外部数字已登记' };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-web', now: NOW, research: researchService(store) });
  assert.equal(run.status, 'completed', run.stopReason);
  assert.deepEqual([run.budget.usedSearches, run.budget.usedFetches, run.budget.usedSnapshotReads], [1, 1, 1]);
  assert.deepEqual([run.budget.maxSearches, run.budget.maxFetches, run.budget.maxSnapshotReads], [2, 2, 3]);
  assert.deepEqual(run.events.map(event => event.type).filter(type => ['web_search', 'fetch_page', 'read_snapshot', 'record_web_fact'].includes(type)), ['web_search', 'fetch_page', 'read_snapshot', 'record_web_fact']);
  assert.notEqual(run.datasetId, data.id);
  const webRow = store.getDataset(run.datasetId)!.rows.find(row => row.rowId === factRowId)!;
  assert.equal(webRow.value, 3);
  assert.equal(webRow.unit, '%');
  assert.equal(webRow.quality, 'usable');
  assert.equal(webRow.source.kind, 'web');
  assert.match(webRow.source.locator, /^snapshot:/);
  assert.equal(store.getDataset(data.id)!.rows.some(row => row.rowId === factRowId), false);
  const events = store.listSearchEvents(run.id);
  assert.equal(events[0]!.kind, 'search');
  assert.equal(events[0]!.callKey, 'run-web:web_search:1');
  assert.ok(events.some(event => event.kind === 'selection' && event.hits[0]!.status === 'fetched'));
  assert.equal(store.listSnapshots(run.id).length, 1);
  assert.equal(store.listSnapshotReads(run.id).length, 1);
  store.close();
});

test('WEB-02：未配置搜索 Provider 时工具返回错误值并提示收束，运行不失败', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const data = fourGapDataset(); store.insertDataset(data); seedAssets(store, data);
  const runtime = new ControlledRuntime(async tools => {
    const outcomes = [
      await tools.webSearch({ query: '行业增速' }),
      await tools.fetchPage({ url: 'https://example.com/industry' }),
      await tools.readSnapshot({ snapshotId: 'snap-missing' }),
      await tools.recordWebFact({ snapshotId: 'snap-missing', quote: 'x', valueText: '3.0%', metricId: 'growth', entity: '行业', period: '2026Q3', unit: '%', dimensions: {} }),
    ];
    for (const outcome of outcomes) assert.equal(outcome.error, 'search_provider_unavailable');
    assert.equal(outcomes[0]!.note, 'wrap up');
    await tools.setCoverage(['外部基准不可用，本轮只使用导入数据']);
    return { stopReason: '无外部基准，零候选收束' };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-no-web', now: NOW });
  assert.equal(run.status, 'completed', run.stopReason);
  assert.deepEqual([run.budget.maxSearches, run.budget.maxFetches, run.budget.maxSnapshotReads], [0, 0, 0]);
  assert.deepEqual([run.budget.usedSearches, run.budget.usedFetches, run.budget.usedSnapshotReads], [0, 0, 0]);
  assert.equal(run.candidateIds.length, 0);
  assert.equal(store.listSnapshots(run.id).length, 0);
  store.close();
});

test('WEB-04：Host 拒绝的检索请求以错误值回到 Agent，运行可继续而不是整轮失败', async () => {
  const store = new WorkspaceStore(makeDataDir());
  const data = fourGapDataset(); store.insertDataset(data); seedAssets(store, data);
  const research = new WebResearchService({
    store, rootDir: store.rootDir, now: NOW,
    providers: [createStaticSearchProvider('synthetic', [{ url: 'https://example.com/report.pdf', title: 'PDF 报告', snippet: 'x' }])],
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    transport: async (url: URL) => url.pathname === '/robots.txt'
      ? { status: 200, headers: {}, body: Buffer.from(''), remoteAddress: PUBLIC_IP }
      : { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('pdf-bytes'), remoteAddress: PUBLIC_IP },
  });
  const runtime = new ControlledRuntime(async tools => {
    const search = await tools.webSearch({ query: '行业报告' }) as { ok: boolean; hits: Array<{ url: string }> };
    const rejected = await tools.fetchPage({ url: search.hits[0]!.url });
    assert.equal(rejected.error, 'content_type_rejected');
    const missing = await tools.readSnapshot({ snapshotId: 'snap-missing' });
    assert.equal(missing.error, 'snapshot_not_found');
    await tools.setCoverage(['外部基准不可用，仅用导入数据']);
    return { stopReason: 'Host 拒绝后如实收束' };
  });
  const run = await runExploration({ store, dataset: data, runtime, runId: 'run-rejected', now: NOW, research });
  assert.equal(run.status, 'completed', run.stopReason);
  assert.deepEqual(run.events.filter(event => event.type === 'research_error').map(event => event.details?.error), ['content_type_rejected', 'snapshot_not_found']);
  assert.equal(run.budget.usedFetches, 0);
  store.close();
});
