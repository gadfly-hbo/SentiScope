import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.ts';
import { startHost } from '../src/host/server.ts';
import { startSyntheticSource } from '../src/source/synthetic-server.ts';
import type { RunSummary } from '../src/core/types.ts';
import { makeConfigDir, makeDataDir, repoRoot } from './helpers.ts';

test('宿主 loopback API：健康、界面、鉴权与观察触发', async () => {
  const { server: srcServer, url: srcUrl } = await startSyntheticSource(0, join(repoRoot, 'fixtures'));
  const dataDir = makeDataDir();
  const configDir = makeConfigDir(srcUrl);
  const config = loadConfig(configDir);
  config.sources[0]!.baseUrl = srcUrl;
  const host = await startHost({ port: 0, dataDir, config, skillsDir: join(repoRoot, 'skills') });
  const headers = { 'x-sentiscope-client': '1' };
  try {
    const health = await fetch(`${host.url}/health`).then((r) => r.json());
    assert.deepEqual(health, { ok: true });

    const html = await fetch(`${host.url}/`).then((r) => r.text());
    assert.match(html, /SentiScope/);
    assert.match(html, /切片一/);

    const rejected = await fetch(`${host.url}/api/observe`, { method: 'POST' });
    assert.equal(rejected.status, 403);

    const summary = await fetch(`${host.url}/api/observe`, { method: 'POST', headers }).then((r) => r.json() as Promise<RunSummary>);
    assert.equal(summary.observations.length, 9);
    assert.deepEqual(summary.counts, { ok: 2, gap: 2, insufficient: 4, failed: 1 });

    const runs = await fetch(`${host.url}/api/runs`).then((r) => r.json() as Promise<{ runs: { runId: string }[] }>);
    assert.equal(runs.runs.length, 1);

    const detail = await fetch(`${host.url}/api/runs/${runs.runs[0]!.runId}`).then((r) => r.json() as Promise<RunSummary>);
    assert.equal(detail.observations.length, 9);
    assert.ok(detail.observations.every((o) => o.unknownNote.length > 0));

    const evidence = await fetch(`${host.url}/api/evidence`).then((r) => r.json() as Promise<{ evidence: unknown[] }>);
    assert.equal(evidence.evidence.length, 8);

    const sources = await fetch(`${host.url}/api/sources`).then((r) => r.json() as Promise<{ sources: { readOnly: boolean }[]; rules: unknown[] }>);
    assert.equal(sources.rules.length, 9);
    assert.equal(sources.sources[0]!.readOnly, true);

    const missing = await fetch(`${host.url}/api/runs/no-such-run`);
    assert.equal(missing.status, 404);
  } finally {
    host.server.close();
    srcServer.close();
  }
});
