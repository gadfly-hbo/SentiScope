import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 合成 BI 模拟源：loopback HTTP，只读，数据来自仓库内 fixture 目录。
 * 路径约定：GET /dashboards/<dashboard>/metrics/<case> 返回对应 JSON；
 * 特例 /metrics/slow 挂起 30 秒，用于超时采集失败样例。
 *
 * 时间锚点：fixture 中 refreshedAt 可写 "@fresh"（锚点前 10 分钟）或 "@stale"（锚点前 4 天），
 * 锚点默认为服务启动时的真实时间，测试可传 anchorNow 固定。全部数据为合成示例。
 */
export function startSyntheticSource(
  port: number,
  fixtureDir: string,
  options: { anchorNow?: Date; host?: string } = {},
): Promise<{ server: Server; url: string }> {
  const anchor = options.anchorNow ?? new Date();
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const match = /^\/dashboards\/([\w.-]+)\/metrics\/([\w.-]+)$/.exec(url.pathname);
    if (req.method !== 'GET' || !match) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
    const [, dashboard, metricCase] = match;
    if (metricCase === 'slow') { setTimeout(() => { try { res.writeHead(504); res.end(); } catch { /* aborted */ } }, 30_000); return; }
    const file = join(fixtureDir, dashboard, `${metricCase}.json`);
    if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'metric_not_found' })); return; }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const body = Buffer.from(JSON.stringify(resolveTimeMarkers(parsed, anchor)), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'x-sentiscope-source': 'synthetic' });
      res.end(body);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'read_error' }));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${(server.address() as { port: number }).port}` }));
  });
}

function resolveTimeMarkers(value: unknown, anchor: Date): unknown {
  if (value === '@fresh') return new Date(anchor.getTime() - 10 * 60 * 1000).toISOString();
  if (value === '@stale') return new Date(anchor.getTime() - 4 * 24 * 3600 * 1000).toISOString();
  if (Array.isArray(value)) return value.map((v) => resolveTimeMarkers(v, anchor));
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveTimeMarkers(v, anchor)]));
  }
  return value;
}
