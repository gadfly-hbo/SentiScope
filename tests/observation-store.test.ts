import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationStore } from '../src/core/observation-store.ts';
import type { Observation } from '../src/core/types.ts';
import { makeDataDir } from './helpers.ts';

function obs(runId: string, identity: string, status: Observation['status']): Observation {
  return {
    runId, identity, ruleId: 'rule-east-revenue', ruleVersion: 1,
    metricId: 'metric.revenue.monthly', metricName: '月收入', entity: '华东', periodLabel: '2026-09',
    status, reason: 'r', checks: [{ mark: 'pass', name: '实体一致', note: 'n' }], facts: { a: 'b' },
    evidenceSha256: 'sha', locator: 'loc', capturedAt: '2026-10-02T08:10:00+08:00',
    sourceRefreshedAt: '2026-10-02T08:00:00+08:00', unknownNote: 'u',
  };
}

test('append-only：同 run 追加保序，不更新旧行', () => {
  const dir = makeDataDir();
  const store = new ObservationStore(dir);
  store.append([obs('run-1', 'id-a', 'ok')]);
  store.append([obs('run-1', 'id-b', 'gap'), obs('run-1', 'id-a', 'ok')]);
  const list = store.listObservations('run-1');
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((o) => o.identity), ['id-a', 'id-b', 'id-a']);
  store.close();
});

test('四态计数与跨 run 查询', () => {
  const dir = makeDataDir();
  const store = new ObservationStore(dir);
  store.append([obs('run-1', 'id-a', 'ok'), obs('run-1', 'id-b', 'gap'), obs('run-1', 'id-c', 'insufficient'), obs('run-2', 'id-d', 'failed')]);
  assert.deepEqual(store.statusCounts(), { ok: 1, gap: 1, insufficient: 1, failed: 1 });
  assert.equal(store.listRuns().length, 2);
  assert.deepEqual(store.latestObservations(2).map((o) => o.identity), ['id-c', 'id-d']);
  store.close();
});
