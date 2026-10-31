import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../core/import.ts';
import { standardizeDataset } from '../core/cleaning.ts';
import { storeRawBytes } from '../core/raw-evidence.ts';
import type { DatasetVersion, SourceAsset, StandardRow } from '../core/mvp-types.ts';
import type { WorkspaceStore } from '../core/workspace-store.ts';
import { ControlledRuntime } from '../agent/exploration-service.ts';

export async function ensureDemoWorkspace(store: WorkspaceStore, fixturesDir: string, now: string): Promise<DatasetVersion> {
  const existing = store.listDatasets()[0];
  if (existing) return existing;
  const file = await importFile({ rootDir: store.rootDir, name: '经营数据_2026Q3.csv', bytes: readFileSync(join(fixturesDir, '经营数据_2026Q3.csv')), now });
  const competitor = snapshotAsset(store.rootDir, fixturesDir, '竞对A_公开披露.html', '2026-10-01', now);
  const industry = snapshotAsset(store.rootDir, fixturesDir, '行业_公开统计.html', '2026-10-02', now);
  store.insertAsset(file.asset);
  store.insertAsset(competitor);
  store.insertAsset(industry);
  const rawRows = file.rawRows.map(row => {
    const rowIndex = String(row.values.period).startsWith('2025') ? 3 : 2;
    return row.values.entity === '竞对A'
      ? { ...row, source: { assetSha256: competitor.sha256, kind: 'web' as const, locator: `table#benchmark tr:nth-child(${rowIndex})` } }
      : row.values.entity === '行业'
        ? { ...row, source: { assetSha256: industry.sha256, kind: 'web' as const, locator: `table#industry tr:nth-child(${rowIndex})` } }
        : row;
  });
  const dataset = standardizeDataset({ name: '合成经营数据集', version: 1, now, sourceAssetIds: [file.asset.id, competitor.id, industry.id], rawRows });
  store.insertDataset(dataset);
  return dataset;
}

function snapshotAsset(rootDir: string, fixturesDir: string, name: string, publishedAt: string, now: string): SourceAsset {
  const bytes = readFileSync(join(fixturesDir, name));
  const stored = storeRawBytes(rootDir, bytes, 'html');
  return {
    id: `asset-${stored.sha256.slice(0, 16)}`, kind: 'web', name: `合成公网快照 · ${name.replace('.html', '')}`,
    sha256: stored.sha256, mediaType: 'text/html', bytes: bytes.length, importedAt: now, publishedAt, capturedAt: now,
    locator: `synthetic://${name}`, path: stored.path, metadata: { synthetic: true, finalUrl: null },
  };
}

export function createDemoRuntime(dataset: DatasetVersion, zero = false): ControlledRuntime {
  return new ControlledRuntime(async tools => {
    const find = (metricId: string, entity: string, period: string): StandardRow => {
      const row = dataset.rows.find(item => item.metricId === metricId && item.entity === entity && item.period === period);
      if (!row) throw new Error(`demo_row_missing:${metricId}:${entity}:${period}`);
      return row;
    };
    const coverage = ['已检查目标、历史、竞对、行业，以及正常与不可比近失样例'];
    await tools.profile();
    await tools.setCoverage(coverage);
    if (zero) {
      await tools.compare({ definitionId: 'revenue-target', actualRowId: find('revenue', '华北', '2026-09').rowId, benchmarkRowId: find('revenue.target', '华北', '2026-09').rowId, selectionContext: coverage[0]! });
      return { stopReason: '没有合格候选；本次为正常零候选运行' };
    }
    const target = await tools.compare({ definitionId: 'revenue-target', actualRowId: find('revenue', '华东', '2026-09').rowId, benchmarkRowId: find('revenue.target', '华东', '2026-09').rowId, selectionContext: coverage[0]! });
    const history = await tools.compare({ definitionId: 'revenue-history', actualRowId: find('revenue', '西南', '2026-09').rowId, benchmarkRowId: find('revenue', '西南', '2025-09').rowId, selectionContext: coverage[0]! });
    const competitor = await tools.compare({ definitionId: 'growth-competitor', actualRowId: find('revenue', '自身', '2026Q3').rowId, benchmarkRowId: find('revenue', '竞对A', '2026Q3').rowId, actualPreviousRowId: find('revenue', '自身', '2025Q3').rowId, benchmarkPreviousRowId: find('revenue', '竞对A', '2025Q3').rowId, selectionContext: coverage[0]! });
    const industry = await tools.compare({ definitionId: 'growth-industry', actualRowId: find('revenue', '自身', '2026Q3').rowId, benchmarkRowId: find('revenue', '行业', '2026Q3').rowId, actualPreviousRowId: find('revenue', '自身', '2025Q3').rowId, benchmarkPreviousRowId: find('revenue', '行业', '2025Q3').rowId, selectionContext: coverage[0]! });
    await tools.compare({ definitionId: 'revenue-target', actualRowId: find('revenue', '华北', '2026-09').rowId, benchmarkRowId: find('revenue.target', '华北', '2026-09').rowId, selectionContext: coverage[0]! });
    await tools.compare({ definitionId: 'revenue-history', actualRowId: find('orders', '线上', '2026-09').rowId, benchmarkRowId: find('orders', '线上', '2025-09').rowId, selectionContext: coverage[0]! });
    const propose = async (comparisonId: string, title: string, interpretation: string, nextStep: string, unknown: string, refutationText: string) => {
      const comparison = [target, history, competitor, industry].find(item => item.id === comparisonId);
      const refutation = await tools.observe({ summary: refutationText, role: 'refutation', comparisonId, evidence: comparison?.evidence ?? [] });
      await tools.propose({ comparisonId, title, interpretation, nextStep, unknown, refutationObservationId: refutation.id });
    };
    await propose(target.id, '华东区域 9 月收入低于目标 120 万元', '已结期目标差距成立，原因未知', '复核目标来源与区域拆分', '原因未知', '已检查单位换算、区域拆分和近失样例');
    await propose(history.id, '西南区域收入同比下降 6.2%', '同期历史差距成立，原因未知', '复核同期范围与历史证据', '原因未知', '已检查部分期间和基数异常');
    await propose(competitor.id, '自身收入增速低于竞对 A 12.3 个百分点', '同期增速差成立，不代表竞对导致自身下滑', '复核双方披露口径', '不能证明客户或份额变化原因', '已检查披露范围和并表口径');
    await propose(industry.id, '自身收入增速低于细分行业 8.2 个百分点', '同期行业增速差成立，不代表行业造成自身变化', '复核行业分类与统计范围', '行业平均不代表每个参与者', '已检查行业范围和数据发布时间');
    return { stopReason: '四类比较完成；4 个候选通过门禁，近失项仅留观察' };
  });
}
