import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import {
  createHttpSearchProvider,
  createStaticSearchProvider,
  isTransientSearchError,
  searchWithFallback,
  WebResearchService,
  WebResearchError,
} from '../src/source/web-research.ts';
import type { DatasetVersion } from '../src/core/mvp-types.ts';

const NOW = '2026-11-01T12:00:00.000Z';
const PUBLIC_IP = '93.184.216.34';
const lookup = async () => [{ address: PUBLIC_IP, family: 4 }];
const page = (body: string) => Buffer.from(`<!doctype html><html><head><title>官方披露</title></head><body><time datetime="2026-10-01">2026-10-01</time>${body}</body></html>`);
const response = (body: Buffer, overrides: Record<string, unknown> = {}) => ({ status: 200, headers: { 'content-type': 'text/html' }, body, remoteAddress: PUBLIC_IP, ...overrides });

function service(store: WorkspaceStore, providers = [createStaticSearchProvider('synthetic', [{ url: 'https://example.com/report?period=2026Q2', title: '官方披露', snippet: '增长 3.0%' }])], overrides: Record<string, unknown> = {}) {
  return new WebResearchService({
    store,
    rootDir: store.rootDir,
    providers,
    now: NOW,
    lookup,
    transport: async (url: URL) => url.pathname === '/robots.txt' ? response(Buffer.from('User-agent: *\nAllow: /')) : response(page('<p>Adjusted e-commerce sales growth was 3.0% in 2026Q2.</p>')),
    preferredDomains: ['example.com'],
    ...overrides,
  });
}
function baseDataset(): DatasetVersion {
  const rawRows = [{
    rowNumber: 2, values: { metric: 'revenue', entity: '自身', period: '2026Q2', value: 5000, unit: '万美元' }, issues: [],
    source: { assetSha256: 'a'.repeat(64), kind: 'raw' as const, locator: 'row:2' },
  }];
  const rows = rawRows.map((raw, index) => ({ rowId: `row-${index + 1}`, metricId: 'revenue', entity: '自身', period: '2026Q2', value: Number(raw.values.value), unit: '万美元', dimensions: { closed: 'true', comparable: 'true', scope: '美国零售电商', currency: 'USD', region: '美国' }, quality: 'usable' as const, issues: [], source: raw.source }));
  return { id: 'dataset-test', version: 1, name: 'fixture', createdAt: NOW, sourceAssetIds: ['asset-a'], rows, rawRows, fields: ['metric'], steps: [], quality: { usable: 1, blocked: 0, needsEvidence: 0 }, sha256: 'fixture' };
}

test('WEB-01/02：搜索 Provider 标准化、瞬时失败切换与永久错误保留', async () => {
  const transient = createStaticSearchProvider('transient', []);
  transient.search = async () => { throw new Error('HTTP 429 rate limit'); };
  const permanent = createStaticSearchProvider('permanent', []);
  permanent.search = async () => { throw new Error('invalid_api_key'); };
  const fallback = createStaticSearchProvider('backup', [{ url: 'https://example.com/a', title: 'A', snippet: 'a' }]);
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const research = service(store, [transient, fallback]);
  const outcome = await research.search('run-fallback', '行业增速');
  if (!outcome.ok) throw new Error('search failed');
  assert.equal(outcome.provider, 'backup');
  const event = store.listSearchEvents('run-fallback')[0]!;
  assert.deepEqual(event.attempts, [{ provider: 'transient', error: 'HTTP 429 rate limit' }]);
  assert.equal(isTransientSearchError(new Error('provider quota 2067')), true);
  assert.equal(isTransientSearchError(new Error('invalid_api_key')), false);
  await assert.rejects(searchWithFallback([permanent], '行业增速', 'call-2'), /invalid_api_key/);
  store.close();
});

test('WEB-01/04：web_search 保存命中与配额事件；fetch_page 允许查询串并做 SSRF/robots 校验', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const research = service(store);
  const search = await research.search('run-web', '2026Q2 行业增速');
  if (!search.ok) throw new Error('search failed');
  assert.equal(search.hits[0]!.tier, 'A');
  assert.equal(store.listSearchEvents('run-web')[0]!.query, '2026Q2 行业增速');
  const fetched = await research.fetchPage('run-web', search.hits[0]!.url, 'call-fetch-1');
  if (!fetched.ok) throw new Error('fetch failed');
  assert.equal(fetched.title, '官方披露');
  assert.equal(fetched.finalUrl, 'https://example.com/report?period=2026Q2');
  assert.match(fetched.excerpt, /3\.0%/);
  const snapshots = store.listSnapshots('run-web');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.sourceTier, 'A');
  assert.ok(store.listAssets().some(asset => asset.metadata.snapshotId === snapshots[0]!.id));
  const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const blocked = service(store, undefined, { lookup: privateLookup });
  await assert.rejects(blocked.fetchPage('run-web', 'https://example.com/private', 'call-fetch-2'), /private_ip_rejected/);
  store.close();
});

test('WEB-02/03：搜索与读取配额耗尽返回错误值并提示收束，不伪造无结果', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const research = service(store, undefined, { budget: { maxSearches: 1, maxFetches: 1, maxSnapshotReads: 1 } });
  assert.equal((await research.search('run-quota', 'q1')).ok, true);
  const exhausted = await research.search('run-quota', 'q2');
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.error, 'search_quota_exhausted');
  assert.equal(exhausted.note, 'wrap up');
  const fetched = await research.fetchPage('run-quota', 'https://example.com/report?period=2026Q2', 'call-fetch-1');
  if (!fetched.ok) throw new Error('fetch failed');
  const firstRead = await research.readSnapshot('run-quota', fetched.snapshotId, 0, 100);
  if (!firstRead.ok) throw new Error('read failed');
  const readExhausted = await research.readSnapshot('run-quota', fetched.snapshotId, 100, 100);
  if (readExhausted.ok) throw new Error('read should be exhausted');
  assert.equal(readExhausted.error, 'snapshot_read_quota_exhausted');
  const secondFetch = await research.fetchPage('run-quota', 'https://example.com/report?period=2026Q2', 'call-fetch-2');
  if (secondFetch.ok) throw new Error('fetch should be exhausted');
  assert.equal(secondFetch.error, 'fetch_quota_exhausted');
  const events = store.listSearchEvents('run-quota');
  assert.ok(events.some(event => event.error === 'fetch_quota_exhausted'));
  assert.ok(events.some(event => event.error === 'snapshot_read_quota_exhausted'));
  store.close();
});

test('WEB-03/06：read_snapshot 只返回有界窗口；搜索摘要不能直接成为事实', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const research = service(store);
  const search = await research.search('run-read', '行业增速');
  if (!search.ok) throw new Error('search failed');
  const fetched = await research.fetchPage('run-read', search.hits[0]!.url, 'call-fetch-1');
  if (!fetched.ok) throw new Error('fetch failed');
  const read = await research.readSnapshot('run-read', fetched.snapshotId, 20, 60);
  if (!read.ok) throw new Error('read failed');
  assert.equal(read.text.length <= 60, true);
  assert.equal(read.snapshotId, fetched.snapshotId);
  assert.equal(store.listSnapshotReads('run-read').length, 1);
  await assert.rejects(research.recordWebFact('run-read', {
    snapshotId: fetched.snapshotId, quote: '搜索摘要说增长 3.0%', valueText: '3.0%', metricId: 'revenue', entity: '行业', period: '2026Q2', unit: '%',
    dimensions: { scope: '美国零售电商', currency: 'USD', region: '美国', sourceType: 'primary', publishedAt: '2026-10-01' },
  }), /quote_not_in_snapshot/);
  store.close();
});

test('WEB-06/E2E：外部快照数字经逐字引用验证后进入标准数据行', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  store.insertDataset(baseDataset());
  const research = service(store);
  const search = await research.search('run-fact', '行业增速');
  if (!search.ok) throw new Error('search failed');
  const fetched = await research.fetchPage('run-fact', search.hits[0]!.url, 'call-fetch-1');
  if (!fetched.ok) throw new Error('fetch failed');
  const dimensions = { scope: '美国零售电商', currency: 'USD', region: '美国', sourceType: 'primary', publishedAt: '2026-10-01', closed: 'true', comparable: 'true' };
  const quote = { snapshotId: fetched.snapshotId, quote: 'Adjusted e-commerce sales growth was 3.0% in 2026Q2.', valueText: '3.0%', metricId: 'revenue', entity: '行业', period: '2026Q2', unit: '%' };
  await assert.rejects(research.recordWebFact('run-fact', { ...quote, dimensions: { ...dimensions, closed: 'yes' } }), /invalid_closed/);
  const { comparable: _comparable, ...withoutComparable } = dimensions;
  await assert.rejects(research.recordWebFact('run-fact', { ...quote, dimensions: withoutComparable }), /invalid_comparable/);
  const fact = await research.recordWebFact('run-fact', { ...quote, dimensions });
  if (!fact.ok) throw new Error('fact failed');
  assert.equal(fact.rawRow.values.value, '3.0');
  assert.equal(fact.rawRow.values.unit, '%');
  assert.equal(fact.rawRow.values.closed, 'true');
  assert.equal(fact.rawRow.source.kind, 'web');
  assert.equal(fact.rawRow.source.note, quote.quote);
  assert.match(fact.rawRow.source.locator, /^snapshot:/);
  assert.equal(fact.assetSha256, fetched.assetSha256);
  store.close();
});

test('WEB-05：搜索词与 URL 中的禁止值被 Host 阻断并留事件', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const research = service(store, undefined, { forbiddenValues: ['内部秘密'] });
  const blocked = await research.search('run-egress', '行业增速 内部秘密');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'egress_blocked');
  await assert.rejects(research.fetchPage('run-egress', 'https://example.com/search?q=内部秘密', 'call-fetch-1'), /egress_blocked/);
  store.close();
});

test('WEB-01：通用 HTTP Search Adapter 从本地配置形状读取命中且密钥仅经环境', async () => {
  const provider = createHttpSearchProvider({
    name: 'generic-http', endpoint: 'https://search.example/api', queryField: 'q', hitsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'snippet', apiKeyEnv: 'SENTISCOPE_TEST_SEARCH_KEY', apiKeyHeader: 'x-api-key',
  });
  let capturedRequest: Request | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    capturedRequest = new Request(input, init);
    return new Response(JSON.stringify({ results: [{ url: 'https://example.com/a', title: 'A', snippet: 'a' }] }), { status: 200 });
  };
  process.env.SENTISCOPE_TEST_SEARCH_KEY = 'secret-token';
  try {
    const hits = await provider.search('行业增速', 'call-http-1');
    assert.equal(hits[0]!.url, 'https://example.com/a');
    const url = new URL(capturedRequest!.url);
    assert.equal(url.searchParams.get('q'), '行业增速');
    assert.equal(capturedRequest!.headers.get('x-api-key'), 'secret-token');
  } finally {
    delete process.env.SENTISCOPE_TEST_SEARCH_KEY;
    globalThis.fetch = originalFetch;
  }
});

test('WEB-04：HTTP Provider 的 429／5xx 属于瞬时错误，401／403 不切换', () => {
  assert.equal(new WebResearchError('http_429', 'HTTP 429').transient, true);
  assert.equal(new WebResearchError('http_500', 'HTTP 500').transient, true);
  assert.equal(new WebResearchError('http_401', 'HTTP 401').transient, false);
  assert.equal(new WebResearchError('http_403', 'HTTP 403').transient, false);
});

test('WEB-04：robots 禁止、非 HTML、超过大小均 fail-closed', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const robotsDenied = service(store, undefined, { transport: async (url: URL) => url.pathname === '/robots.txt' ? response(Buffer.from('User-agent: *\nDisallow: /')) : response(page('<p>x</p>')) });
  await assert.rejects(robotsDenied.fetchPage('run-fail', 'https://example.com/report', 'call-fetch-1'), /robots_rejected/);
  const wrongType = service(store, undefined, { transport: async (url: URL) => url.pathname === '/robots.txt' ? response(Buffer.from('')) : response(page('<p>x</p>'), { headers: { 'content-type': 'image/png' } }) });
  await assert.rejects(wrongType.fetchPage('run-fail', 'https://example.com/report.pdf', 'call-fetch-2'), /content_type_rejected/);
  const tooLarge = service(store, undefined, { maxBytes: 8, transport: async (url: URL) => url.pathname === '/robots.txt' ? response(Buffer.from('')) : response(page('<p>x</p>')) });
  await assert.rejects(tooLarge.fetchPage('run-fail', 'https://example.com/report', 'call-fetch-3'), /too_large/);
  store.close();
});

test('WEB-03/06：声明发布时间与快照解析冲突被拒绝；C 级来源不得自称一手', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const unpreferred = service(store, undefined, { preferredDomains: [] });
  const search = await unpreferred.search('run-tier', '行业增速');
  if (!search.ok) throw new Error('search failed');
  assert.equal(search.hits[0]!.tier, 'C');
  const fetched = await unpreferred.fetchPage('run-tier', search.hits[0]!.url, 'call-fetch-1');
  if (!fetched.ok) throw new Error('fetch failed');
  const fact = { snapshotId: fetched.snapshotId, quote: 'Adjusted e-commerce sales growth was 3.0% in 2026Q2.', valueText: '3.0%', metricId: 'revenue', entity: '行业', period: '2026Q2', unit: '%' };
  const dimensions = { scope: '美国零售电商', currency: 'USD', region: '美国', sourceType: 'primary' as const, publishedAt: '2026-10-01', closed: 'true', comparable: 'true' };
  await assert.rejects(unpreferred.recordWebFact('run-tier', { ...fact, dimensions: { ...dimensions, publishedAt: '2026-09-15' } }), /published_at_conflict/);
  const recorded = await unpreferred.recordWebFact('run-tier', { ...fact, dimensions });
  if (!recorded.ok) throw new Error('fact failed');
  assert.equal(recorded.rawRow.values.sourceType, 'secondary');
  assert.equal(recorded.rawRow.values.publishedAt, '2026-10-01');
  assert.deepEqual(recorded.rawRow.issues, ['secondary_source', 'tier_c_source']);
  const noTime = service(store, undefined, { transport: async (url: URL) => url.pathname === '/robots.txt' ? response(Buffer.from('User-agent: *\nAllow: /')) : response(Buffer.from('<html><head><title>无时间元数据</title></head><body><p>Adjusted e-commerce sales growth was 3.0% in 2026Q2.</p></body></html>')) });
  const second = await noTime.search('run-notime', '行业增速');
  if (!second.ok) throw new Error('search failed');
  const secondFetch = await noTime.fetchPage('run-notime', second.hits[0]!.url, 'call-fetch-2');
  if (!secondFetch.ok) throw new Error('fetch failed');
  const unverified = await noTime.recordWebFact('run-notime', { snapshotId: secondFetch.snapshotId, quote: 'Adjusted e-commerce sales growth was 3.0% in 2026Q2.', valueText: '3.0%', metricId: 'revenue', entity: '行业', period: '2026Q2', unit: '%', dimensions });
  if (!unverified.ok) throw new Error('fact failed');
  assert.ok(unverified.rawRow.issues.includes('published_at_unverified'));
  store.close();
});

test('WEB-01：Provider 自报命中等级不生效，Host 分级为准；HTTP Provider 拒绝非 https 端点', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'sentiscope-research-')));
  const claimed = createStaticSearchProvider('claimed', [{ url: 'https://example.com/report?period=2026Q2', title: '官方披露', snippet: '增长 3.0%', tier: 'A' }]);
  const research = service(store, [claimed], { preferredDomains: [] });
  const search = await research.search('run-tier-claim', '行业增速');
  if (!search.ok) throw new Error('search failed');
  assert.equal(search.hits[0]!.tier, 'C');
  store.close();
  const insecure = createHttpSearchProvider({ name: 'insecure', endpoint: 'http://search.example/api', queryField: 'q', hitsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'snippet' });
  await assert.rejects(insecure.search('行业增速', 'call-1'), /insecure_search_endpoint/);
});

test('WEB-01：HTTP Provider 支持 POST 查询体与 Bearer 鉴权（MiniMax Coding Plan 形状）', async () => {
  const provider = createHttpSearchProvider({
    name: 'minimax-like', endpoint: 'https://api.minimaxi.com/v1/coding_plan/search', method: 'POST', queryField: 'q',
    hitsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'snippet',
    apiKeyEnv: 'SENTISCOPE_TEST_SEARCH_KEY', apiKeyHeader: 'Authorization', authScheme: 'bearer',
  });
  let captured: Request | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    captured = new Request(input, init);
    return new Response(JSON.stringify({ results: [{ url: 'https://example.com/a', title: 'A', snippet: 'a' }] }), { status: 200 });
  };
  process.env.SENTISCOPE_TEST_SEARCH_KEY = 'secret-token';
  try {
    const hits = await provider.search('行业增速', 'call-post-1');
    assert.equal(hits[0]!.url, 'https://example.com/a');
    assert.equal(captured!.method, 'POST');
    assert.equal(captured!.headers.get('authorization'), 'Bearer secret-token');
    assert.equal(captured!.headers.get('content-type'), 'application/json');
    const body = await captured!.json() as { q: string };
    assert.equal(body.q, '行业增速');
  } finally {
    delete process.env.SENTISCOPE_TEST_SEARCH_KEY;
    globalThis.fetch = originalFetch;
  }
});
