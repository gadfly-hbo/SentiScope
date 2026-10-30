import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchReading, SourceError } from '../src/source/adapter.ts';
import { startSyntheticSource } from '../src/source/synthetic-server.ts';
import type { SourceConfig } from '../src/core/types.ts';
import { baseSource, repoRoot } from './helpers.ts';

const source: SourceConfig = { ...baseSource };

test('正常读取：返回完整 Reading', async () => {
  const { server, url } = await startSyntheticSource(0, join(repoRoot, 'fixtures'));
  try {
    source.baseUrl = url;
    const reading = await fetchReading(source, '/dashboards/dash-east-ops/metrics/obs01-ok-revenue', 2000);
    assert.equal(reading.entity, '华南');
    assert.equal(reading.value, 1050);
    assert.equal(reading.unit, '万元');
  } finally { server.close(); }
});

test('未知路径返回 HTTP 失败', async () => {
  const { server, url } = await startSyntheticSource(0, join(repoRoot, 'fixtures'));
  try {
    source.baseUrl = url;
    await assert.rejects(
      () => fetchReading(source, '/dashboards/dash-east-ops/metrics/no-such-case', 2000),
      (e: unknown) => e instanceof SourceError && e.kind === 'http' && e.statusCode === 404,
    );
  } finally { server.close(); }
});

test('挂起端点触发超时失败（一等结果）', async () => {
  const { server, url } = await startSyntheticSource(0, join(repoRoot, 'fixtures'));
  try {
    source.baseUrl = url;
    await assert.rejects(
      () => fetchReading(source, '/dashboards/dash-east-ops/metrics/slow', 300),
      (e: unknown) => e instanceof SourceError && e.kind === 'timeout',
    );
  } finally { server.close(); }
});

test('非 JSON 响应触发解析失败', async () => {
  const bad = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not json'); });
  await new Promise<void>((resolve) => bad.listen(0, '127.0.0.1', resolve));
  try {
    const port = (bad.address() as { port: number }).port;
    await assert.rejects(
      () => fetchReading({ ...source, baseUrl: `http://127.0.0.1:${port}` }, '/x', 2000),
      (e: unknown) => e instanceof SourceError && e.kind === 'parse',
    );
  } finally { bad.close(); }
});
