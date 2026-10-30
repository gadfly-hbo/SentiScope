import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SentiscopeConfig } from '../core/config.ts';
import { ObservationStore } from '../core/observation-store.ts';
import type { RunSummary } from '../core/types.ts';
import { runObservationRound } from './observe.ts';
import { probeSession, type ProbeResult } from './session-probe.ts';

export type HostOptions = {
  port: number;
  dataDir: string;
  config: SentiscopeConfig;
  skillsDir: string;
};

export type StartedHost = {
  server: Server;
  url: string;
  observe: () => Promise<RunSummary>;
  probe: () => Promise<ProbeResult>;
};

const UI_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

/** 阶段 1 宿主：loopback 只读管理界面 + JSON API。写操作（触发观察）需本机来源或专用头。 */
export function startHost(options: HostOptions): Promise<StartedHost> {
  const { port, dataDir, config, skillsDir } = options;
  let lastProbe: ProbeResult | null = null;

  const probe = async () => {
    lastProbe = await probeSession(skillsDir);
    return lastProbe;
  };
  const observe = () => runObservationRound({ config, dataDir, now: new Date() });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/health' && method === 'GET') return send(200, { ok: true });

    if (method !== 'GET' && req.headers['x-sentiscope-client'] !== '1' && !isLocalOrigin(req.headers.origin)) {
      return send(403, { error: 'client_rejected' });
    }

    try {
      if (url.pathname === '/' && method === 'GET') {
        return send(200, readFileSync(UI_FILE, 'utf8'), 'text/html; charset=utf-8');
      }
      if (url.pathname === '/api/overview' && method === 'GET') {
        const store = new ObservationStore(dataDir);
        const runs = store.listRuns();
        const latestRun = runs[0] ?? null;
        const observations = latestRun ? store.listObservations(latestRun.runId) : [];
        const latestGap = [...observations].reverse().find((o) => o.status === 'gap') ?? null;
        const body = {
          counts: store.statusCounts(),
          latestRun,
          latestGap,
          session: lastProbe,
        };
        store.close();
        return send(200, body);
      }
      if (url.pathname === '/api/runs' && method === 'GET') {
        const store = new ObservationStore(dataDir);
        const runs = store.listRuns();
        store.close();
        return send(200, { runs });
      }
      const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
      if (runMatch && method === 'GET') {
        const store = new ObservationStore(dataDir);
        const observations = store.listObservations(runMatch[1]!);
        store.close();
        if (!observations.length) return send(404, { error: 'run_not_found' });
        return send(200, { runId: runMatch[1], observations });
      }
      if (url.pathname === '/api/evidence' && method === 'GET') {
        const store = new ObservationStore(dataDir);
        const runs = store.listRuns();
        const latest = runs[0] ? store.listObservations(runs[0].runId).filter((o) => o.evidenceSha256) : [];
        store.close();
        return send(200, { evidence: latest.map((o) => ({
          ruleId: o.ruleId, metricName: o.metricName, sha256: o.evidenceSha256,
          sourceRefreshedAt: o.sourceRefreshedAt, capturedAt: o.capturedAt, locator: o.locator,
        })) });
      }
      if (url.pathname === '/api/sources' && method === 'GET') {
        return send(200, { sources: config.sources, rules: config.rules });
      }
      if (url.pathname === '/api/observe' && method === 'POST') {
        const summary = await observe();
        return send(200, summary);
      }
      if (url.pathname === '/api/session' && method === 'GET') {
        if (url.searchParams.get('refresh') === '1') await probe();
        return send(200, { session: lastProbe });
      }
      return send(404, { error: 'not_found' });
    } catch (e) {
      return send(500, { error: 'host_error', message: (e as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, observe, probe });
    });
  });
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try { return new URL(origin).hostname === '127.0.0.1' || new URL(origin).hostname === 'localhost'; }
  catch { return false; }
}
