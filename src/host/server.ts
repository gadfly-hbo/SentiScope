import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from '../core/workspace-store.ts';
import { importFile, ImportError } from '../core/import.ts';
import { standardizeDataset } from '../core/cleaning.ts';
import { fetchPublicSnapshot, publicTableToRawRows, WebError, type PublicTableMapping } from '../source/public-web.ts';
import type { CandidateStatus, DatasetVersion } from '../core/mvp-types.ts';
import { runExploration, type ExplorationRuntime, type PublicFetchRequest } from '../agent/exploration-service.ts';
import { createDemoRuntime, ensureDemoWorkspace } from './demo.ts';
import { probeSession, type ProbeResult } from './session-probe.ts';

export type HostOptions = {
  port: number;
  dataDir: string;
  skillsDir: string;
  fixturesDir?: string;
  seedDemo?: boolean;
  runtimeFactory?: (dataset: DatasetVersion, mode: string) => ExplorationRuntime;
  enablePublicWeb?: boolean;
  allowedPublicHosts?: string[];
  publicMappings?: Record<string, PublicTableMapping>;
};

export type StartedHost = {
  server: Server;
  url: string;
  probe: () => Promise<ProbeResult>;
};

const UI_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const UI_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'app.js');

export async function startHost(options: HostOptions): Promise<StartedHost> {
  const store = new WorkspaceStore(options.dataDir);
  for (const run of store.listRuns().filter(item => item.status === 'running')) {
    run.status = 'failed'; run.stopReason = 'interrupted_by_restart'; run.finishedAt = new Date().toISOString();
    run.events.push({ type: 'failed', at: run.finishedAt, summary: run.stopReason });
    store.saveRun(run);
  }
  let lastProbe: ProbeResult | null = null;
  const probe = async () => {
    lastProbe = await probeSession(options.skillsDir);
    return lastProbe;
  };
  let dataset = options.fixturesDir ? await ensureDemoWorkspace(store, options.fixturesDir, new Date().toISOString()) : store.listDatasets()[0] ?? null;
  const runtimeFactory = options.runtimeFactory ?? ((data: DatasetVersion, mode: string) => createDemoRuntime(data, mode === 'zero'));
  const controllers = new Map<string, AbortController>();
  const inFlight = new Map<string, Promise<unknown>>();
  const fetchAndStandardize = async (request: PublicFetchRequest) => {
    const result = await fetchPublicSnapshot({ rootDir: options.dataDir, url: request.url, allowedHosts: options.allowedPublicHosts ?? [], termsConfirmed: true, now: new Date().toISOString() });
    store.insertAsset(result.asset);
    let next: DatasetVersion | undefined;
    if (request.mapping) {
      const publicRows = publicTableToRawRows(result.tables, result.asset, request.mapping);
      if (!publicRows.length) throw new WebError('public_table_empty');
      next = standardizeDataset({
        name: `${request.mapping.entity} · ${request.mapping.period} · 公网对比`, version: Math.max(0, ...store.listDatasets().map(item => item.version)) + 1,
        now: new Date().toISOString(), sourceAssetIds: [...new Set([...(dataset?.sourceAssetIds ?? []), result.asset.id])],
        rawRows: [...(dataset?.rawRows ?? []), ...publicRows],
      });
      store.insertDataset(next); dataset = next;
    }
    return { asset: result.asset, tables: result.tables, dataset: next };
  };
  const startRun = async (data: DatasetVersion, mode: string) => {
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    controllers.set(runId, controller);
    const pending = runExploration({ store, dataset: data, runtime: runtimeFactory(data, mode), runId, now: new Date().toISOString(), maxToolCalls: 25, signal: controller.signal,
      publicFetcher: options.enablePublicWeb ? async request => {
        const mapping = request.mappingId ? options.publicMappings?.[request.mappingId] : undefined;
        if (request.mappingId && !mapping) throw new WebError('approved_mapping_required');
        return fetchAndStandardize({ url: request.url, ...(mapping ? { mapping } : {}) });
      } : undefined })
      .finally(() => { controllers.delete(runId); inFlight.delete(runId); });
    inFlight.set(runId, pending);
    return runId;
  };
  if (options.seedDemo && dataset && !store.listRuns().length) {
    const runId = `run-demo-${randomUUID().slice(0, 8)}`;
    await runExploration({ store, dataset, runtime: runtimeFactory(dataset, 'qualified'), runId, now: new Date().toISOString(), maxToolCalls: 25 });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const send = (status: number, body: unknown, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (url.pathname === '/health' && method === 'GET') return send(200, { ok: true });
    if (method !== 'GET' && req.headers['x-sentiscope-client'] !== '1' && !isLocalOrigin(req.headers.origin)) return send(403, { error: 'client_rejected' });
    try {
      if (url.pathname === '/' && method === 'GET') return send(200, readFileSync(UI_FILE), 'text/html; charset=utf-8');
      if (url.pathname === '/app.js' && method === 'GET') return send(200, readFileSync(UI_JS), 'text/javascript; charset=utf-8');
      if (url.pathname === '/api/candidates' && method === 'GET') return send(200, { candidates: store.listCandidates() });
      if (url.pathname === '/api/datasets' && method === 'GET') return send(200, { datasets: store.listDatasets() });
      if (url.pathname === '/api/sources' && method === 'GET') return send(200, { sources: store.listAssets().map(asset => ({ ...asset, path: undefined })) });
      if (url.pathname === '/api/runs' && method === 'GET') return send(200, { runs: store.listRuns() });
      if (url.pathname === '/api/session' && method === 'GET') {
        if (url.searchParams.get('refresh') === '1') await probe();
        return send(200, { session: lastProbe });
      }
      const cancelMatch = /^\/api\/runs\/([\w.-]+)\/cancel$/.exec(url.pathname);
      if (cancelMatch && method === 'POST') {
        const controller = controllers.get(cancelMatch[1]!);
        if (!controller) return send(409, { error: 'run_not_running' });
        controller.abort();
        return send(202, { runId: cancelMatch[1], status: 'cancelling' });
      }
      const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
      if (runMatch && method === 'GET') {
        const run = store.getRun(runMatch[1]!);
        if (!run) return send(404, { error: 'run_not_found' });
        return send(200, { run, observations: store.listObservations(run.id) });
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        if (!dataset) return send(409, { error: 'dataset_required' });
        const body = await readJson(req);
        const mode = body.mode === 'zero' ? 'zero' : 'qualified';
        const runId = await startRun(dataset, mode);
        return send(202, { runId });
      }
      const reviewMatch = /^\/api\/candidates\/([\w.-]+)\/review$/.exec(url.pathname);
      if (reviewMatch && method === 'POST') {
        const body = await readJson(req);
        if (!['review', 'retained', 'excluded'].includes(String(body.status))) return send(400, { error: 'invalid_review_status' });
        if (typeof body.note !== 'string' || body.note.length > 2000) return send(400, { error: 'invalid_review_note' });
        const candidate = store.reviewCandidate(reviewMatch[1]!, body.status as CandidateStatus, body.note, new Date().toISOString());
        return send(200, { candidate });
      }
      if (url.pathname === '/api/imports' && method === 'POST') {
        const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'import.csv'));
        const bytes = await readBody(req, 20 * 1024 * 1024);
        const imported = await importFile({ rootDir: options.dataDir, name, bytes, now: new Date().toISOString() });
        const version = Math.max(0, ...store.listDatasets().map(item => item.version)) + 1;
        const next = standardizeDataset({ name, version, now: new Date().toISOString(), sourceAssetIds: [imported.asset.id], rawRows: imported.rawRows });
        store.insertAsset(imported.asset);
        store.insertDataset(next);
        dataset = next;
        return send(201, { asset: { ...imported.asset, path: undefined }, dataset: next });
      }
      if (url.pathname === '/api/public-sources' && method === 'POST') {
        if (!options.enablePublicWeb) return send(403, { error: 'public_web_disabled' });
        const body = await readJson(req);
        if (body.termsConfirmed !== true) return send(403, { error: 'terms_required' });
        const mapping = parsePublicMapping(body.mapping);
        const result = await fetchAndStandardize({ url: String(body.url), ...(mapping ? { mapping } : {}) });
        return send(201, { asset: { ...result.asset, path: undefined }, tables: result.tables, dataset: result.dataset ?? null });
      }
      const evidenceTextMatch = /^\/api\/evidence-text\/([a-f0-9]{64})$/.exec(url.pathname);
      if (evidenceTextMatch && method === 'GET') {
        const asset = store.listAssets().find(item => item.sha256 === evidenceTextMatch[1]);
        if (!asset) return send(404, { error: 'evidence_not_found' });
        const bytes = readFileSync(asset.path);
        return send(200, { text: bytes.subarray(0, 1024 * 1024).toString('utf8'), truncated: bytes.length > 1024 * 1024 });
      }
      const evidenceMatch = /^\/api\/evidence\/([a-f0-9]{64})$/.exec(url.pathname);
      if (evidenceMatch && method === 'GET') {
        const asset = store.listAssets().find(item => item.sha256 === evidenceMatch[1]);
        if (!asset) return send(404, { error: 'evidence_not_found' });
        res.writeHead(200, {
          'content-type': asset.mediaType,
          'content-disposition': `attachment; filename="evidence-${asset.sha256.slice(0, 12)}"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        });
        return res.end(readFileSync(asset.path));
      }
      return send(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof ImportError || error instanceof WebError) return send(400, { error: error.code });
      if (error instanceof Error && ['candidate_not_found', 'too_large', 'invalid_json'].includes(error.message)) return send(400, { error: error.message });
      return send(500, { error: 'host_error', message: (error as Error).message });
    }
  });
  server.on('close', () => { void Promise.allSettled([...inFlight.values()]).then(() => store.close()); });
  return new Promise(resolve => {
    server.listen(options.port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, probe }));
  });
}

function parsePublicMapping(value: unknown): PublicTableMapping | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new WebError('invalid_public_mapping');
  const input = value as Record<string, unknown>;
  if (['metricId', 'entity', 'period', 'unit', 'valueHeader', 'scope', 'currency', 'region'].every(key => typeof input[key] === 'string' && String(input[key]).trim())
    && typeof input.periodClosed === 'boolean' && ['primary', 'secondary'].includes(String(input.sourceType))) {
    return {
      metricId: String(input.metricId), entity: String(input.entity), period: String(input.period), unit: String(input.unit),
      valueHeader: String(input.valueHeader), periodClosed: input.periodClosed, scope: String(input.scope), currency: String(input.currency), region: String(input.region), sourceType: String(input.sourceType) as 'primary' | 'secondary',
    };
  }
  throw new WebError('invalid_public_mapping');
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try { return ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname); }
  catch { return false; }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, 1024 * 1024);
  try { return JSON.parse(bytes.toString('utf8') || '{}') as Record<string, unknown>; }
  catch { throw new Error('invalid_json'); }
}
