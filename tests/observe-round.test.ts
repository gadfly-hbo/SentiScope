import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.ts';
import { ObservationStore } from '../src/core/observation-store.ts';
import { runObservationRound } from '../src/host/observe.ts';
import { startSyntheticSource } from '../src/source/synthetic-server.ts';
import { makeConfigDir, makeDataDir, NOW, repoRoot } from './helpers.ts';

const EXPECTED: Record<string, string> = {
  'rule-south-revenue': 'ok',
  'rule-east-revenue': 'gap',
  'rule-sw-costratio': 'insufficient',
  'rule-hz-revenue': 'insufficient',
  'rule-co-revenue': 'ok',
  'rule-wait-time': 'gap',
  'rule-conversion': 'insufficient',
  'rule-east-revenue-filter': 'insufficient',
  'rule-hu-north-revenue': 'failed',
};

async function runRound(dataDir: string, configDir: string, runId: string) {
  return runObservationRound({ config: loadConfig(configDir), dataDir, now: NOW, runId, timeoutMs: 400 });
}

test('端到端一轮观察：九条规则四态齐备，可重复验证', async () => {
  const { server, url } = await startSyntheticSource(0, join(repoRoot, 'fixtures'), { anchorNow: NOW });
  const dataDir = makeDataDir();
  const configDir = makeConfigDir(url);
  try {
    const round1 = await runRound(dataDir, configDir, 'run-1');
    assert.equal(round1.observations.length, 9);
    assert.deepEqual(round1.counts, { ok: 2, gap: 2, insufficient: 4, failed: 1 });
    for (const o of round1.observations) {
      assert.equal(o.status, EXPECTED[o.ruleId], `${o.ruleId} → ${o.status}`);
      assert.ok(o.checks.length > 0);
      assert.ok(o.unknownNote.length > 0);
      if (o.status === 'failed') {
        assert.equal(o.evidenceSha256, null);
      } else {
        assert.ok(o.evidenceSha256, `${o.ruleId} 应有证据`);
        assert.ok(o.locator);
        assert.ok(o.sourceRefreshedAt);
      }
    }
    const evidenceFiles1 = readdirSync(join(dataDir, 'evidence')).length;
    assert.equal(evidenceFiles1, 8);

    const round2 = await runRound(dataDir, configDir, 'run-2');
    const byRule = (obs: typeof round1.observations) => Object.fromEntries(obs.map((o) => [o.ruleId, o.status]));
    assert.deepEqual(byRule(round2.observations), byRule(round1.observations));

    const valid1 = round1.observations.filter((o) => o.status !== 'failed').map((o) => o.identity).sort();
    const valid2 = round2.observations.filter((o) => o.status !== 'failed').map((o) => o.identity).sort();
    assert.deepEqual(valid2, valid1, '同输入重复运行观察身份稳定');

    assert.equal(readdirSync(join(dataDir, 'evidence')).length, evidenceFiles1, '重复读取幂等引用快照');
    const store = new ObservationStore(dataDir);
    assert.equal(store.listObservations('run-1').length, 9);
    assert.equal(store.listObservations('run-2').length, 9);
    store.close();
  } finally { server.close(); }
});

test('失败观察的校验链与事实留痕', async () => {
  const { server, url } = await startSyntheticSource(0, join(repoRoot, 'fixtures'), { anchorNow: NOW });
  const dataDir = makeDataDir();
  const configDir = makeConfigDir(url);
  try {
    const round = await runRound(dataDir, configDir, 'run-timeout');
    const failed = round.observations.find((o) => o.status === 'failed');
    assert.ok(failed);
    assert.match(failed.reason, /超时/);
    assert.ok(failed.checks.some((c) => c.mark === 'block'));
  } finally { server.close(); }
});
