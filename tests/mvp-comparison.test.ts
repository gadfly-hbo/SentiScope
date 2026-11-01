import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDescriptive } from '../src/core/comparison.ts';
import type { ComparisonInput, EvidenceRef } from '../src/core/mvp-types.ts';

const evidence: EvidenceRef[] = [{ assetSha256: 'a'.repeat(64), kind: 'raw', locator: 'row:2' }];
function base(overrides: Partial<ComparisonInput> = {}): ComparisonInput {
  return {
    comparisonType: 'target', metricId: 'revenue', entity: '华东', period: '2026-09',
    actual: 880, benchmark: 1000, unit: '万元', direction: 'higher-better', threshold: 10,
    periodClosed: true, comparable: true, benchmarkLabel: '内部目标', evidence,
    selectionContext: '全部区域与指标均已检查', ...overrides,
  };
}

test('CMP-01：越高越好目标差距，方向与差率正确', () => {
  const result = compareDescriptive(base());
  assert.equal(result.status, 'qualified');
  assert.equal(result.gap, -120);
  assert.equal(result.gapRate, -12);
  assert.match(result.gapDisplay, /−12%/);
  assert.match(result.formula, /880/);
});

test('CMP-02：越低越好与反向正常样例，不混方向', () => {
  const wait = compareDescriptive(base({ actual: 46, benchmark: 30, unit: '秒', direction: 'lower-better', threshold: 20 }));
  assert.equal(wait.status, 'qualified');
  assert.notEqual(wait.gapRate, null);
  assert.ok(wait.gapRate! > 50);
  const normal = compareDescriptive(base({ actual: 1050 }));
  assert.equal(normal.status, 'observation');
});

test('CMP-03/04：零或负目标、未结期与部分期间不得伪造结论', () => {
  const zero = compareDescriptive(base({ benchmark: 0 }));
  assert.equal(zero.status, 'needs_evidence');
  assert.equal(zero.gapRate, null);
  const negative = compareDescriptive(base({ benchmark: -100 }));
  assert.equal(negative.gapRate, null);
  const open = compareDescriptive(base({ periodClosed: false }));
  assert.equal(open.status, 'needs_evidence');
  const partial = compareDescriptive(base({ comparisonType: 'history', periodClosed: false }));
  assert.equal(partial.status, 'needs_evidence');
});

test('CMP-05：历史正基数、零与负基数', () => {
  const history = compareDescriptive(base({ comparisonType: 'history', actual: 938, benchmark: 1000, threshold: 5, benchmarkPeriod: '2025-09' }));
  assert.equal(history.status, 'qualified');
  assert.equal(history.gapRate, -6.2);
  for (const benchmark of [0, -1000]) {
    const result = compareDescriptive(base({ comparisonType: 'history', benchmark }));
    assert.equal(result.status, 'needs_evidence');
    assert.equal(result.gapRate, null);
  }
});

test('CMP-06/08：竞对与行业分别算增速差，单位为百分点', () => {
  const competitor = compareDescriptive(base({ comparisonType: 'competitor', actual: -5.2, benchmark: 7.1, unit: '%', threshold: 8, benchmarkLabel: '竞对A公开披露' }));
  assert.equal(competitor.status, 'qualified');
  assert.equal(competitor.gap, -12.3);
  assert.match(competitor.gapDisplay, /12.3/);
  const industry = compareDescriptive(base({ comparisonType: 'industry', actual: -5.2, benchmark: 3, unit: '%', threshold: 8, benchmarkLabel: '行业公开统计', benchmarkPeriod: '2026-09' }));
  assert.equal(industry.status, 'qualified');
  assert.equal(industry.gap, -8.2);
});

test('CMP-07/09/10：不可比、缺证据和缺搜索覆盖被拦截', () => {
  assert.equal(compareDescriptive(base({ comparable: false })).status, 'needs_evidence');
  assert.equal(compareDescriptive(base({ evidence: [] })).status, 'needs_evidence');
  assert.equal(compareDescriptive(base({ selectionContext: '' })).status, 'needs_evidence');
  assert.equal(compareDescriptive(base({ benchmarkPeriod: '2026-08' })).status, 'needs_evidence');
});
