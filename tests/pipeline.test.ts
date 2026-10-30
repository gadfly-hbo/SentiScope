import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeGapPct, observationIdentity, runPipeline } from '../src/core/pipeline.ts';
import type { Reading } from '../src/core/types.ts';
import { baseRule, NOW } from './helpers.ts';

function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    metricId: 'metric.revenue.monthly',
    entity: '华东',
    period: { kind: 'month', label: '2026-09', closed: true },
    value: 880,
    unit: '万元',
    filters: { region: ['华东'] },
    refreshedAt: '2026-10-02T08:00:00+08:00',
    ...overrides,
  };
}

test('OBS-01 正常达标：不产生差距，记录正常观察', () => {
  const rule = baseRule({ id: 'rule-south-revenue', entity: '华南', expectedFilters: { region: ['华南'] } });
  const result = runPipeline(reading({ entity: '华南', value: 1050, filters: { region: ['华南'] } }), rule, { now: NOW });
  assert.equal(result.status, 'ok');
  assert.match(result.reason, /无差距/);
  assert.equal(result.facts['达成率'], '105.0%');
  assert.ok(result.checks.every((c) => c.mark !== 'block'));
});

test('OBS-02 明确越界：已结期低于目标超阈值形成合格差距', () => {
  const result = runPipeline(reading(), baseRule(), { now: NOW });
  assert.equal(result.status, 'gap');
  assert.match(result.reason, /12\.0%/);
  assert.match(result.facts['差距'] ?? '', /\+12\.0%/);
  assert.match(result.facts['规则'] ?? '', /rule-east-revenue@v1/);
  assert.match(result.unknownNote, /不自动建 Project/);
});

test('OBS-03 数据过期：拦截在刷新有效，不当作经营差距', () => {
  const result = runPipeline(reading({ refreshedAt: '2026-09-28T08:00:00+08:00' }), baseRule(), { now: NOW });
  assert.equal(result.status, 'insufficient');
  const blocked = result.checks.find((c) => c.mark === 'block');
  assert.equal(blocked?.name, '刷新有效');
  assert.match(result.facts['实际 / 目标'] ?? '', /不比较/);
  assert.equal(result.facts['达成率'], undefined);
});

test('OBS-04 单位与周期不一致：拒绝直接比较，双拦截', () => {
  const result = runPipeline(
    reading({ entity: '华中', value: 8800000, unit: '元', period: { kind: 'week', label: '2026-W40', closed: true }, filters: { region: ['华中'] } }),
    baseRule({ entity: '华中', expectedFilters: { region: ['华中'] } }),
    { now: NOW },
  );
  assert.equal(result.status, 'insufficient');
  const blockedNames = result.checks.filter((c) => c.mark === 'block').map((c) => c.name);
  assert.ok(blockedNames.includes('周期一致'));
  assert.ok(blockedNames.includes('单位一致'));
});

test('OBS-05 未结期无轨迹：仅记录现状，不判不达标、不算达成率', () => {
  const result = runPipeline(
    reading({ entity: '全公司', value: 6200, period: { kind: 'month', label: '2026-10', closed: false }, filters: { region: ['全公司'] } }),
    baseRule({ entity: '全公司', target: 9000, expectedFilters: { region: ['全公司'] } }),
    { now: NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.facts['达成率'], '不计算（未结期、无目标轨迹）');
  assert.ok(result.checks.some((c) => c.mark === 'hold' && c.name === '触发判定'));
});

test('OBS-06a 越低越好：等待时长超阈值形成合格差距', () => {
  const rule = baseRule({ id: 'rule-wait-time', metricId: 'metric.support.wait_seconds', metricName: '客服平均等待时长', direction: 'lower-better', unit: '秒', target: 30, thresholdPct: 20 });
  const result = runPipeline(reading({ metricId: rule.metricId, value: 46, unit: '秒' }), rule, { now: NOW });
  assert.equal(result.status, 'gap');
  assert.match(result.facts['差距'] ?? '', /\+53\.3%/);
});

test('OBS-06b 零分母：不除零、不产生伪达成率', () => {
  const rule = baseRule({ id: 'rule-conversion', metricId: 'metric.conversion.rate', metricName: '转化率', unit: '%', target: 5, thresholdPct: 20, denominatorMetric: true });
  const result = runPipeline(reading({ metricId: rule.metricId, value: 0, unit: '%', denominator: 0 }), rule, { now: NOW });
  assert.equal(result.status, 'insufficient');
  assert.match(result.reason, /零分母/);
  assert.match(result.facts['实际 / 目标'] ?? '', /不可计算/);
});

test('目标为零：禁止套用普通达成率，标为不可计算', () => {
  const rule = baseRule({ target: 0 });
  const result = runPipeline(reading({ value: 12 }), rule, { now: NOW });
  assert.equal(result.status, 'insufficient');
  assert.match(result.reason, /目标为零/);
});

test('OBS-07 筛选漂移：暂停比较待核实', () => {
  const result = runPipeline(reading({ value: 870, filters: { region: ['华东', '华中'] } }), baseRule(), { now: NOW });
  assert.equal(result.status, 'insufficient');
  const blocked = result.checks.find((c) => c.mark === 'block');
  assert.equal(blocked?.name, '过滤条件');
});

test('稳定观察身份：相同输入一致，实体不同则不同', () => {
  const rule = baseRule();
  const a = observationIdentity(rule, '2026-09');
  const b = observationIdentity(rule, '2026-09');
  const c = observationIdentity(baseRule({ entity: '华南' }), '2026-09');
  assert.equal(a, b);
  assert.notEqual(a, c);
  // 抓取时间、运行次数不参与身份
  const otherPeriod = observationIdentity(rule, '2026-10');
  assert.notEqual(a, otherPeriod);
});

test('差距百分比方向计算', () => {
  const hi = computeGapPct(880, 1000, 'higher-better');
  const lo = computeGapPct(46, 30, 'lower-better');
  assert.ok(Math.abs(hi - 12) < 1e-9, `got ${hi}`);
  assert.ok(Math.abs(lo - 53.333333333333) < 1e-6, `got ${lo}`);
  assert.equal(computeGapPct(0, 0, 'higher-better'), Number.POSITIVE_INFINITY);
});
