import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from '../core/workspace-store.ts';
import { applyBenchmarkConfig, benchmarkConfigStatus, loadBenchmarkConfig } from '../core/benchmarks.ts';
import { readSessionUsage } from './session-usage.ts';
import { importFile, ImportError } from '../core/import.ts';
import { standardizeDataset } from '../core/cleaning.ts';
import { loadWebResearchConfig, WebResearchService, type SearchProvider } from '../source/web-research.ts';
import { verifyEvidenceLink } from './trial.ts';
import type { CandidateStatus, CaseCandidate, DatasetVersion } from '../core/mvp-types.ts';
import { runExploration, type ExplorationRuntime } from '../agent/exploration-service.ts';
import { createDemoRuntime, ensureDemoWorkspace, type DemoMode } from './demo.ts';
import { probeSession, type ProbeResult } from './session-probe.ts';

export type HostOptions = {
  port: number;
  dataDir: string;
  skillsDir: string;
  fixturesDir?: string;
  seedDemo?: boolean;
  runtimeFactory?: (dataset: DatasetVersion, mode: string) => ExplorationRuntime;
  researchFactory?: (context: { store: WorkspaceStore; dataset: DatasetVersion; mode: string }) => WebResearchService | undefined;
  maxToolCalls?: number;
  searchProviders?: SearchProvider[];
  preferredDomains?: string[];
  researchBudget?: { maxSearches: number; maxFetches: number; maxSnapshotReads: number };
  forbiddenValues?: string[];
};

export type StartedHost = {
  server: Server;
  url: string;
  probe: () => Promise<ProbeResult>;
  research: { enabled: boolean; providers: string[]; preferredDomains: string[]; budget: { maxSearches: number; maxFetches: number; maxSnapshotReads: number } | null };
  benchmarks: ReturnType<typeof benchmarkConfigStatus>;
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
  const runtimeFactory = options.runtimeFactory ?? ((data: DatasetVersion, mode: string) => createDemoRuntime(data, mode as DemoMode));
  const controllers = new Map<string, AbortController>();
  const inFlight = new Map<string, Promise<unknown>>();
  const fileConfig = loadWebResearchConfig(join(options.dataDir, 'search.json'));
  const providers = options.searchProviders ?? fileConfig.providers;
  const preferredDomains = options.preferredDomains ?? fileConfig.preferredDomains;
  const researchBudget = options.researchBudget ?? fileConfig.budget;
  const createResearch = () => new WebResearchService({
    store, rootDir: options.dataDir, providers, preferredDomains, forbiddenValues: options.forbiddenValues ?? [], ...(researchBudget ? { budget: researchBudget } : {}),
  });
  const researchStatus = { enabled: providers.length > 0, providers: providers.map(provider => provider.name), preferredDomains, budget: researchBudget ?? null };
  const benchmarkConfig = loadBenchmarkConfig(join(options.dataDir, 'benchmarks.json'));
  applyBenchmarkConfig(benchmarkConfig);
  store.recordBenchmarkVersions(benchmarkConfig.overrides.map(override => ({ id: override.id, version: override.version, threshold: override.threshold, reason: override.reason ?? '', approvedAt: override.approvedAt ?? '' })), new Date().toISOString());
  const maxToolCalls = options.maxToolCalls ?? 25;
  const startRun = async (data: DatasetVersion, mode: string) => {
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    controllers.set(runId, controller);
    const research = options.researchFactory?.({ store, dataset: data, mode }) ?? (providers.length ? createResearch() : undefined);
    const pending = runExploration({ store, dataset: data, runtime: runtimeFactory(data, mode), runId, now: new Date().toISOString(), maxToolCalls, signal: controller.signal, research })
      .then(run => {
        try {
          const usage = readSessionUsage(join(options.dataDir, '.sentiscope-sessions'), run.sessionId);
          if (usage) { run.usage = usage; store.saveRun(run); }
        } catch (usageError) {
          console.warn(`[SentiScope] 会话用量读取失败（不影响运行结果）：${(usageError as Error).message}`);
        }
        return run;
      })
      .finally(() => { controllers.delete(runId); inFlight.delete(runId); });
    inFlight.set(runId, pending);
    return runId;
  };
  if (options.seedDemo && dataset && !store.listRuns().length) {
    await inFlight.get(await startRun(dataset, 'qualified'));
  }

  const trialStats = () => {
    const candidates = store.listCandidates();
    const byStatus: Record<string, number> = { review: 0, retained: 0, excluded: 0 };
    const byType: Record<string, { review: number; retained: number; excluded: number }> = {};
    const byDataset: Record<string, { review: number; retained: number; excluded: number }> = {};
    const exclusionReasons: Record<string, number> = {};
    const bump = (bucket: Record<string, { review: number; retained: number; excluded: number }>, key: string, status: string) => {
      const entry = bucket[key] ?? (bucket[key] = { review: 0, retained: 0, excluded: 0 });
      entry[status as 'review' | 'retained' | 'excluded'] += 1;
    };
    for (const candidate of candidates) {
      byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
      bump(byType, candidate.comparison.comparisonType, candidate.status);
      bump(byDataset, candidate.datasetId, candidate.status);
      if (candidate.status === 'excluded') {
        const reason = candidate.reviews[0]?.reason ?? '未标注';
        exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
      }
    }
    const decided = (byStatus.retained ?? 0) + (byStatus.excluded ?? 0);
    return {
      candidates: { total: candidates.length, review: byStatus.review ?? 0, retained: byStatus.retained ?? 0, excluded: byStatus.excluded ?? 0 },
      hitRate: decided ? Math.round((byStatus.retained! / decided) * 10000) / 100 : null,
      byType, byDataset, exclusionReasons,
      runs: store.listRuns().map(run => ({
        id: run.id, datasetId: run.datasetId, datasetName: store.getDataset(run.datasetId)?.name ?? null,
        model: run.model, status: run.status, startedAt: run.startedAt, candidates: run.candidateIds.length,
        toolCalls: run.budget.usedToolCalls, searches: run.budget.usedSearches, fetches: run.budget.usedFetches, reads: run.budget.usedSnapshotReads,
        usage: run.usage ?? null, sessionId: run.sessionId ?? null,
      })),
      config: benchmarkConfigStatus(),
      configHistory: store.listBenchmarkVersions(),
    };
  };
  const evidenceLinkFailures = (candidate: CaseCandidate): string[] => verifyEvidenceLink(candidate, {
    dataset: store.getDataset(candidate.datasetId),
    assetExists: sha256 => store.listAssets().some(asset => asset.sha256 === sha256),
    observations: store.listObservations(candidate.runId),
  });
  const buildTrialReport = () => {
    const stats = trialStats();
    const reasons = Object.entries(stats.exclusionReasons).map(([reason, count]) => `${reason} ×${count}`).join(' · ') || '无';
    const runs = stats.runs.map(run => `| ${run.id} | ${run.datasetName ?? run.datasetId} | ${run.model} | ${run.candidates} | ${run.searches}/${run.fetches}/${run.reads} | ${run.usage ? `${Math.round(run.usage.totalTokens / 100) / 10}k` : '—'} | ${run.usage?.costTotal != null ? String(Math.round(run.usage.costTotal * 1e6) / 1e6) : '不可得'} |`).join('\n');
    const config = stats.config.current.map(def => `- ${def.id}：阈值 ${def.threshold}（默认 ${stats.config.defaults.find(item => item.id === def.id)?.threshold ?? '?'}）· ${def.thresholdVersion}`).join('\n');
    const history = stats.configHistory.length ? stats.configHistory.map(entry => `- ${entry.id}@v${entry.version}：阈值 ${entry.threshold}${entry.reason ? `，理由「${entry.reason}」` : ''}${entry.approvedAt ? `，批准 ${entry.approvedAt}` : ''}`).join('\n') : '- 无用户批准的变更记录（使用代码默认）';
    const sampled = store.listCandidates().slice(0, 5);
    const linkFailures: string[] = [];
    const sample = sampled.map(candidate => {
      const failures = evidenceLinkFailures(candidate);
      if (failures.length) linkFailures.push(`${candidate.title}：${failures.join('；')}`);
      return `- [${candidate.comparison.comparisonType}] ${candidate.title}（${candidate.status} · ${candidate.comparison.gapDisplay} · ${candidate.comparison.thresholdVersion}）\n  证据：${candidate.comparison.evidence.map(ref => `${ref.kind}:${ref.locator}`).join(' ｜ ')}\n  运行 ${candidate.runId}`;
    }).join('\n') || '- 暂无候选';
    return [
      '# SentiScope 试用报告（本机生成）',
      '',
      `候选 ${stats.candidates.total}：待复核 ${stats.candidates.review} · 保留 ${stats.candidates.retained} · 排除 ${stats.candidates.excluded}；命中率 ${stats.hitRate ?? '—'}%。`,
      `排除原因：${reasons}。`,
      '',
      '## 运行与成本（token 取自 Pi 会话记录，费用为会话记录金额）',
      '',
      '| 运行 | 数据集 | 模型 | 候选 | 搜索/抓取/读取 | token | 费用 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      runs || '| — | — | — | — | — | — | — |',
      '',
      '## 阈值配置',
      '',
      config,
      '',
      '变更记录：',
      history,
      '',
      '## 证据抽查（最近 5 个候选，含回链校验）',
      '',
      sample,
      linkFailures.length ? `\n## 回链失败（如实列出）\n\n${linkFailures.map(item => `- ${item}`).join('\n')}` : '\n抽查证据回链全部通过。',
      '',
      '> 本报告只陈述统计与建议，不自动修改任何配置；不含用户原始数据行。',
    ].join('\n');
  };

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
      if (url.pathname === '/api/sources' && method === 'GET') return send(200, {
        sources: store.listAssets().map(asset => ({ ...asset, path: undefined })),
        searchEvents: store.listSearchEvents(),
        snapshots: store.listSnapshots().map(snapshot => ({ ...snapshot, text: undefined, excerpt: snapshot.excerpt.slice(0, 500) })),
        snapshotReads: store.listSnapshotReads(),
        webResearch: researchStatus,
      });
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
        return send(200, {
          run,
          observations: store.listObservations(run.id),
          searchEvents: store.listSearchEvents(run.id),
          snapshots: store.listSnapshots(run.id).map(snapshot => ({ ...snapshot, text: undefined })),
          snapshotReads: store.listSnapshotReads(run.id),
        });
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        if (!dataset) return send(409, { error: 'dataset_required' });
        const body = await readJson(req);
        const mode = ['zero', 'limited'].includes(String(body.mode)) ? String(body.mode) : 'qualified';
        if (body.datasetId !== undefined && typeof body.datasetId !== 'string') return send(400, { error: 'invalid_dataset_id' });
        const selected = body.datasetId ? store.getDataset(body.datasetId) : dataset;
        if (body.datasetId && !selected) return send(404, { error: 'dataset_not_found' });
        const runId = await startRun(selected ?? dataset, mode);
        return send(202, { runId });
      }
      const reviewMatch = /^\/api\/candidates\/([\w.-]+)\/review$/.exec(url.pathname);
      if (reviewMatch && method === 'POST') {
        const body = await readJson(req);
        if (!['review', 'retained', 'excluded'].includes(String(body.status))) return send(400, { error: 'invalid_review_status' });
        if (typeof body.note !== 'string' || body.note.length > 2000) return send(400, { error: 'invalid_review_note' });
        if (body.reason !== undefined && typeof body.reason !== 'string') return send(400, { error: 'invalid_exclusion_reason' });
        const candidate = store.reviewCandidate(reviewMatch[1]!, body.status as CandidateStatus, body.note, new Date().toISOString(), body.reason ?? '');
        return send(200, { candidate });
      }
      if (url.pathname === '/api/trial-stats' && method === 'GET') return send(200, trialStats());
      if (url.pathname === '/api/trial-report' && method === 'GET') return send(200, { report: buildTrialReport(), generatedAt: new Date().toISOString() });
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
      const snapshotTextMatch = /^\/api\/snapshots\/([\w.-]+)\/text$/.exec(url.pathname);
      if (snapshotTextMatch && method === 'GET') {
        const snapshot = store.getSnapshot(snapshotTextMatch[1]!);
        if (!snapshot) return send(404, { error: 'snapshot_not_found' });
        const requestedOffset = Number(url.searchParams.get('offset') ?? 0);
        const requestedLength = Number(url.searchParams.get('length') ?? 600);
        const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0;
        const length = Number.isFinite(requestedLength) && requestedLength > 0 ? Math.min(6000, Math.floor(requestedLength)) : 600;
        return send(200, { snapshotId: snapshot.id, offset, length, text: snapshot.text.slice(offset, offset + length), totalLength: snapshot.text.length });
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
      if (error instanceof ImportError) return send(400, { error: error.code });
      if (error instanceof Error && ['candidate_not_found', 'too_large', 'invalid_json', 'exclusion_reason_required', 'invalid_exclusion_reason'].includes(error.message)) return send(400, { error: error.message });
      return send(500, { error: 'host_error', message: (error as Error).message });
    }
  });
  server.on('close', () => { void Promise.allSettled([...inFlight.values()]).then(() => store.close()); });
  return new Promise(resolve => {
    server.listen(options.port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, probe, research: researchStatus, benchmarks: benchmarkConfigStatus() }));
  });
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
