import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../core/import.ts';
import { standardizeDataset } from '../core/cleaning.ts';
import type { DatasetVersion, StandardRow } from '../core/mvp-types.ts';
import type { WorkspaceStore } from '../core/workspace-store.ts';
import { ControlledRuntime, type ExplorationTools } from '../agent/exploration-service.ts';
import { createStaticSearchProvider, WebResearchService } from '../source/web-research.ts';
import type { WebResponse } from '../source/public-web.ts';

export type DemoMode = 'qualified' | 'zero' | 'limited';

const FIXTURE_IP = '93.184.216.34';
const FIXTURE_PAGES: Record<string, { file: string; contentType: string }> = {
  'https://disclosure.synthetic.example/competitor-a-2026q3': { file: '竞对A_公开披露.html', contentType: 'text/html; charset=utf-8' },
  'https://stats.synthetic.example/industry-2026q3': { file: '行业_公开统计.html', contentType: 'text/html; charset=utf-8' },
  'https://news.synthetic.example/industry-recap': { file: '行业_公开统计.html', contentType: 'text/html; charset=utf-8' },
  'https://reports.synthetic.example/industry-2026q3.pdf': { file: '行业_公开统计.html', contentType: 'application/pdf' },
};
const SEARCH_HITS = [
  { url: 'https://stats.synthetic.example/industry-2026q3', title: '细分行业 2026Q3 统计（合成）', snippet: '行业收入增速 3.0%' },
  { url: 'https://disclosure.synthetic.example/competitor-a-2026q3', title: '竞对 A 2026Q3 披露（合成）', snippet: '收入同比增速 7.1%' },
  { url: 'https://news.synthetic.example/industry-recap', title: '二手新闻转述（合成）', snippet: '据称行业增长约 3%' },
  { url: 'https://reports.synthetic.example/industry-2026q3.pdf', title: '行业报告 PDF（合成）', snippet: '首版不支持 PDF 解析' },
];

type ExternalFact = { quote: string; valueText: string; entity: string; period: string };
type ExternalSource = { query: string; urlPrefix: string; metricId: string; unit: string; publishedAt: string; dimensions: Record<string, string>; facts: ExternalFact[] };

const EXTERNAL_SOURCES: ExternalSource[] = [
  {
    query: '2026Q3 竞对 A 收入 公开披露', urlPrefix: 'https://disclosure.synthetic.example/', metricId: 'revenue', unit: '万元', publishedAt: '2026-10-01',
    dimensions: { scope: '同一细分市场', currency: 'CNY', region: '同一地域', sourceType: 'primary', closed: 'true', comparable: 'true' },
    facts: [
      { quote: '2026Q321420 万元7.1%同一细分市场与季度', valueText: '21420', entity: '竞对A', period: '2026Q3' },
      { quote: '2025Q320000 万元—同一细分市场与季度', valueText: '20000', entity: '竞对A', period: '2025Q3' },
    ],
  },
  {
    query: '2026Q3 细分行业 收入 统计', urlPrefix: 'https://stats.synthetic.example/', metricId: 'revenue', unit: '万元', publishedAt: '2026-10-02',
    dimensions: { scope: '同一细分市场', currency: 'CNY', region: '同一地域', sourceType: 'primary', closed: 'true', comparable: 'true' },
    facts: [
      { quote: '2026Q330900 万元3.0%同一地域、行业分类与季度', valueText: '30900', entity: '行业', period: '2026Q3' },
      { quote: '2025Q330000 万元—同一地域、行业分类与季度', valueText: '30000', entity: '行业', period: '2025Q3' },
    ],
  },
];

export async function ensureDemoWorkspace(store: WorkspaceStore, fixturesDir: string, now: string): Promise<DatasetVersion> {
  const existing = store.listDatasets()[0];
  if (existing) return existing;
  const file = await importFile({ rootDir: store.rootDir, name: '经营数据_2026Q3.csv', bytes: readFileSync(join(fixturesDir, '经营数据_2026Q3.csv')), now });
  store.insertAsset(file.asset);
  const dataset = standardizeDataset({ name: '合成经营数据集', version: 1, now, sourceAssetIds: [file.asset.id], rawRows: file.rawRows });
  store.insertDataset(dataset);
  return dataset;
}

export function createDemoResearch(store: WorkspaceStore, fixturesDir: string, budget = { maxSearches: 2, maxFetches: 2, maxSnapshotReads: 4 }): WebResearchService {
  return new WebResearchService({
    store,
    rootDir: store.rootDir,
    providers: [createStaticSearchProvider('synthetic-fixture', SEARCH_HITS)],
    preferredDomains: ['stats.synthetic.example', 'disclosure.synthetic.example'],
    budget,
    lookup: async () => [{ address: FIXTURE_IP, family: 4 }],
    transport: async (url: URL): Promise<WebResponse> => {
      if (url.pathname === '/robots.txt') return fixtureResponse('User-agent: *\nAllow: /', 'text/plain; charset=utf-8');
      const page = FIXTURE_PAGES[url.toString()];
      if (!page) return fixtureResponse('not found', 'text/plain; charset=utf-8', 404);
      return fixtureResponse(readFileSync(join(fixturesDir, page.file)).toString('utf8'), page.contentType);
    },
  });
}

export function createDemoRuntime(dataset: DatasetVersion, mode: DemoMode = 'qualified'): ControlledRuntime {
  return new ControlledRuntime(async tools => {
    const find = (metricId: string, entity: string, period: string): StandardRow => {
      const row = dataset.rows.find(item => item.metricId === metricId && item.entity === entity && item.period === period);
      if (!row) throw new Error(`demo_row_missing:${metricId}:${entity}:${period}`);
      return row;
    };
    const selectionContext = '已检查目标、历史、竞对、行业，以及正常与不可比近失样例';
    await tools.profile();
    await tools.setCoverage([selectionContext]);
    if (mode === 'zero') {
      await tools.compare({ definitionId: 'revenue-target', actualRowId: find('revenue', '华北', '2026-09').rowId, benchmarkRowId: find('revenue.target', '华北', '2026-09').rowId, selectionContext });
      return { stopReason: '没有合格候选；本次为正常零候选运行' };
    }
    if (mode === 'limited') return limitedRun(tools, find, selectionContext);

    const external = [await collectExternalRows(tools, EXTERNAL_SOURCES[0]!), await collectExternalRows(tools, EXTERNAL_SOURCES[1]!)];
    const target = await tools.compare({ definitionId: 'revenue-target', actualRowId: find('revenue', '华东', '2026-09').rowId, benchmarkRowId: find('revenue.target', '华东', '2026-09').rowId, selectionContext });
    const history = await tools.compare({ definitionId: 'revenue-history', actualRowId: find('revenue', '西南', '2026-09').rowId, benchmarkRowId: find('revenue', '西南', '2025-09').rowId, selectionContext });
    const growth = async (definitionId: string, rows: Record<string, string> | null) => rows
      ? tools.compare({ definitionId, actualRowId: find('revenue', '自身', '2026Q3').rowId, benchmarkRowId: rows['2026Q3']!, actualPreviousRowId: find('revenue', '自身', '2025Q3').rowId, benchmarkPreviousRowId: rows['2025Q3']!, selectionContext })
      : null;
    const competitor = await growth('growth-competitor', external[0]);
    const industry = await growth('growth-industry', external[1]);
    if (!competitor) await tools.observe({ summary: '竞对基准未取得快照；搜索摘要不作为证据，竞对差距保留为待补证', status: 'needs_evidence' });
    if (!industry) await tools.observe({ summary: '行业基准未取得快照；搜索摘要不作为证据，行业差距保留为待补证', status: 'needs_evidence' });
    await tools.compare({ definitionId: 'revenue-target', actualRowId: find('revenue', '华北', '2026-09').rowId, benchmarkRowId: find('revenue.target', '华北', '2026-09').rowId, selectionContext });
    await tools.compare({ definitionId: 'revenue-history', actualRowId: find('orders', '线上', '2026-09').rowId, benchmarkRowId: find('orders', '线上', '2025-09').rowId, selectionContext });
    const propose = async (comparisonId: string, title: string, interpretation: string, nextStep: string, unknown: string, refutationText: string, evidence: StandardRow['source'][]) => {
      const refutation = await tools.observe({ summary: refutationText, role: 'refutation', comparisonId, evidence });
      await tools.propose({ comparisonId, title, interpretation, nextStep, unknown, refutationObservationId: refutation.id });
    };
    await propose(target.id, '华东区域 9 月收入低于目标 120 万元', '已结期目标差距成立，原因未知', '复核目标来源与区域拆分', '原因未知', '已检查单位换算、区域拆分和近失样例', target.evidence);
    await propose(history.id, '西南区域收入同比下降 6.2%', '同期历史差距成立，原因未知', '复核同期范围与历史证据', '原因未知', '已检查部分期间和基数异常', history.evidence);
    if (competitor) await propose(competitor.id, '自身收入增速低于竞对 A 12.3 个百分点', '同期增速差成立，不代表竞对导致自身下滑', '复核双方披露口径与快照原文', '不能证明客户或份额变化原因', '已检查披露范围、发布时间与并表口径', competitor.evidence);
    if (industry) await propose(industry.id, '自身收入增速低于细分行业 8.2 个百分点', '同期行业增速差成立，不代表行业造成自身变化', '复核行业分类与统计范围', '行业平均不代表每个参与者', '已检查行业范围和数据发布时间', industry.evidence);
    const proposed = 2 + Number(Boolean(competitor)) + Number(Boolean(industry));
    return { stopReason: `四类比较完成；${proposed} 个候选通过门禁，近失项与未取得快照的基准仅留观察` };
  });
}

async function collectExternalRows(tools: ExplorationTools, source: ExternalSource): Promise<Record<string, string> | null> {
  const search = await tools.webSearch({ query: source.query }) as { ok: boolean; hits?: Array<{ url: string }> };
  if (!search.ok || !search.hits) return null;
  const hit = search.hits.find(item => item.url.startsWith(source.urlPrefix));
  if (!hit) return null;
  const fetched = await tools.fetchPage({ url: hit.url }) as { ok: boolean; snapshotId?: string };
  if (!fetched.ok || !fetched.snapshotId) return null;
  await tools.readSnapshot({ snapshotId: fetched.snapshotId, offset: 0, length: 400 });
  const rows: Record<string, string> = {};
  for (const fact of source.facts) {
    const recorded = await tools.recordWebFact({
      snapshotId: fetched.snapshotId, quote: fact.quote, valueText: fact.valueText, metricId: source.metricId, entity: fact.entity, period: fact.period, unit: source.unit,
      dimensions: { ...source.dimensions, publishedAt: source.publishedAt },
    }) as { ok: boolean; row?: { rowId: string } };
    if (!recorded.ok || !recorded.row) return null;
    rows[fact.period] = recorded.row.rowId;
  }
  return rows;
}

async function limitedRun(tools: ExplorationTools, find: (metricId: string, entity: string, period: string) => StandardRow, selectionContext: string) {
  const target = await tools.compare({ definitionId: 'revenue-target', actualRowId: find('revenue', '华东', '2026-09').rowId, benchmarkRowId: find('revenue.target', '华东', '2026-09').rowId, selectionContext });
  const refutation = await tools.observe({ summary: '已检查单位换算与区域拆分，目标差距不由缺失行造成', role: 'refutation', comparisonId: target.id, evidence: target.evidence });
  await tools.propose({ comparisonId: target.id, title: '华东区域 9 月收入低于目标 120 万元', interpretation: '已结期目标差距成立，原因未知', nextStep: '复核目标来源与区域拆分', unknown: '原因未知', refutationObservationId: refutation.id });
  const search = await tools.webSearch({ query: '2026Q3 细分行业 收入增速 统计' }) as { ok: boolean; hits?: Array<{ url: string }>; error?: string };
  if (!search.ok || !search.hits) return { stopReason: '搜索不可用；仅提交内部数据支持的目标候选' };
  const pdf = search.hits.find(hit => hit.url.endsWith('.pdf'));
  if (pdf) await tools.fetchPage({ url: pdf.url });
  const industry = search.hits.find(hit => hit.url.startsWith('https://stats.'));
  if (!industry) return { stopReason: '没有一手行业来源；不以搜索摘要补齐' };
  const fetched = await tools.fetchPage({ url: industry.url }) as { ok: boolean; snapshotId?: string };
  if (!fetched.ok || !fetched.snapshotId) return { stopReason: '行业快照读取失败；差距降为待补证' };
  await tools.readSnapshot({ snapshotId: fetched.snapshotId, offset: 0, length: 400 });
  await tools.recordWebFact({
    snapshotId: fetched.snapshotId, quote: '2026Q330900 万元3.0%同一地域、行业分类与季度', valueText: '3.0%', metricId: 'revenue.growth', entity: '行业', period: '2026Q3', unit: '%',
    dimensions: { scope: '同一细分市场', currency: 'CNY', region: '同一地域', sourceType: 'primary', publishedAt: '2026-10-02', closed: 'true', comparable: 'true' },
  });
  const exhausted = await tools.webSearch({ query: '2026Q3 竞对 A 收入披露' }) as { ok: boolean; error?: string };
  await tools.fetchPage({ url: 'https://disclosure.synthetic.example/competitor-a-2026q3' });
  await tools.observe({ summary: `竞对基准未取得快照（${exhausted.error ?? 'search_quota_exhausted'}）；搜索摘要不作为证据，竞对差距降为待补证`, status: 'needs_evidence' });
  return { stopReason: '搜索与读取配额耗尽；1 个候选通过门禁，竞对增速差保留为待补证' };
}

function fixtureResponse(body: string, contentType: string, status = 200): WebResponse {
  return { status, headers: { 'content-type': contentType }, body: Buffer.from(body), remoteAddress: FIXTURE_IP };
}
