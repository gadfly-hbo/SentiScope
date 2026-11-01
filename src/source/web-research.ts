import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'node-html-parser';
import type { RawRow, SearchEventRecord, SearchHit, SourceAsset, SourceTier, WebSnapshotRecord } from '../core/mvp-types.ts';
import { storeRawBytes } from '../core/raw-evidence.ts';
import type { WorkspaceStore } from '../core/workspace-store.ts';
import { defaultTransport, secureGet, validatePublicUrl, WebError, type Lookup, type Transport } from './public-web.ts';

export class WebResearchError extends Error {
  readonly code: string;
  readonly transient: boolean;
  constructor(code: string, message = code, transient = /429|5\d\d|rate.?limit|quota/i.test(code)) {
    super(message);
    this.name = 'WebResearchError';
    this.code = code;
    this.transient = transient;
  }
}

export type SearchProvider = {
  name: string;
  search(query: string, callKey: string): Promise<SearchHit[]>;
};

export type HttpSearchProviderConfig = {
  name: string;
  endpoint: string;
  queryField: string;
  hitsPath: string;
  urlField: string;
  titleField: string;
  snippetField: string;
  apiKeyEnv?: string;
  apiKeyHeader?: string;
};

type SearchOutcome = {
  ok: true;
  id: string;
  runId: string;
  query: string;
  provider: string;
  callKey: string;
  hits: SearchHit[];
} | {
  ok: false;
  error: string;
  note?: string;
};

type FetchOutcome = {
  ok: true;
  snapshotId: string;
  assetId: string;
  assetSha256: string;
  url: string;
  finalUrl: string;
  title: string;
  publishedAt: string | null;
  capturedAt: string;
  contentType: string;
  sourceTier: SourceTier;
  excerpt: string;
} | { ok: false; error: string; note?: string };

type ReadOutcome = {
  ok: true;
  snapshotId: string;
  offset: number;
  length: number;
  text: string;
  totalLength: number;
} | { ok: false; error: string; note?: string };

export type WebFactInput = {
  snapshotId: string;
  quote: string;
  valueText: string;
  metricId: string;
  entity: string;
  period: string;
  unit: string;
  dimensions: Record<string, string>;
};

export type WebResearchServiceOptions = {
  store: WorkspaceStore;
  rootDir: string;
  providers: SearchProvider[];
  now?: string;
  budget?: { maxSearches: number; maxFetches: number; maxSnapshotReads: number };
  maxBytes?: number;
  timeoutMs?: number;
  lookup?: Lookup;
  transport?: Transport;
  preferredDomains?: string[];
  forbiddenValues?: string[];
};

export function createStaticSearchProvider(name: string, hits: SearchHit[]): SearchProvider {
  return { name, search: async () => hits.map(hit => ({ ...hit })) };
}

export function createHttpSearchProvider(config: HttpSearchProviderConfig): SearchProvider {
  return {
    name: config.name,
    async search(query: string, callKey: string): Promise<SearchHit[]> {
      const url = new URL(config.endpoint);
      if (url.protocol !== 'https:') throw new WebResearchError('insecure_search_endpoint');
      url.searchParams.set(config.queryField, query);
      const headers: Record<string, string> = { accept: 'application/json' };
      const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
      if (config.apiKeyEnv && config.apiKeyHeader && apiKey) headers[config.apiKeyHeader] = apiKey;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new WebResearchError(`http_${response.status}`, `HTTP ${response.status}`, response.status === 429 || response.status >= 500);
      const body = await response.text();
      if (body.length > 1024 * 1024) throw new WebResearchError('search_response_too_large');
      const payload = JSON.parse(body || 'null') as unknown;
      if (payload == null) throw new WebResearchError('invalid_search_response');
      const hits = getPath(payload, config.hitsPath);
      if (!Array.isArray(hits)) throw new WebResearchError('invalid_search_hits');
      return hits.map(hit => {
        const record = hit as Record<string, unknown>;
        const link = String(record[config.urlField] ?? '');
        const title = String(record[config.titleField] ?? '');
        const snippet = String(record[config.snippetField] ?? '');
        if (!link || !title) throw new WebResearchError('invalid_search_hit');
        return { url: link, title, snippet, tier: tierOfSource(new URL(link).hostname) };
      });
    },
  };
}

export function isTransientSearchError(error: unknown): boolean {
  if (error instanceof WebResearchError) return error.transient;
  return /429|402|rate.?limit|quota|2067|HTTP 5\d\d/i.test(String((error as Error)?.message ?? error));
}

export async function searchWithFallback(providers: SearchProvider[], query: string, callKey: string): Promise<{ provider: string; hits: SearchHit[]; attempts: Array<{ provider: string; error: string }> }> {
  if (!providers.length) throw new WebResearchError('search_provider_unavailable');
  const attempts: Array<{ provider: string; error: string }> = [];
  let lastError: unknown;
  for (const provider of providers) {
    try {
      const hits = await provider.search(query, callKey);
      return { provider: provider.name, hits: hits.map(hit => ({ ...hit, tier: hit.tier ?? tierOfSource(new URL(hit.url).hostname) })), attempts };
    } catch (error) {
      if (!isTransientSearchError(error)) throw error;
      attempts.push({ provider: provider.name, error: String((error as Error)?.message ?? error).slice(0, 120) });
      lastError = error;
    }
  }
  if (lastError instanceof Error) (lastError as Error & { attempts?: Array<{ provider: string; error: string }> }).attempts = attempts;
  throw lastError ?? new WebResearchError('search_provider_unavailable');
}

export type WebResearchConfig = {
  providers: SearchProvider[];
  preferredDomains: string[];
  budget?: { maxSearches: number; maxFetches: number; maxSnapshotReads: number };
};

export function loadWebResearchConfig(path: string): WebResearchConfig {
  if (!existsSync(path)) return { providers: [], preferredDomains: [] };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch { throw new WebResearchError('invalid_search_config'); }
  const providerConfigs = Array.isArray(parsed.providers) ? parsed.providers : [];
  const providers = providerConfigs.map(entry => {
    const record = entry as Record<string, unknown>;
    if (record.type !== 'http') throw new WebResearchError('unsupported_search_provider');
    for (const key of ['name', 'endpoint', 'queryField', 'hitsPath', 'urlField', 'titleField', 'snippetField']) {
      if (typeof record[key] !== 'string' || !String(record[key]).trim()) throw new WebResearchError('invalid_search_config');
    }
    return createHttpSearchProvider({
      name: String(record.name), endpoint: String(record.endpoint), queryField: String(record.queryField), hitsPath: String(record.hitsPath),
      urlField: String(record.urlField), titleField: String(record.titleField), snippetField: String(record.snippetField),
      ...(typeof record.apiKeyEnv === 'string' ? { apiKeyEnv: record.apiKeyEnv } : {}),
      ...(typeof record.apiKeyHeader === 'string' ? { apiKeyHeader: record.apiKeyHeader } : {}),
    });
  });
  return {
    providers,
    preferredDomains: Array.isArray(parsed.preferredDomains) ? parsed.preferredDomains.map(String) : [],
    ...(parsed.budget && typeof parsed.budget === 'object' ? { budget: parsed.budget as WebResearchConfig['budget'] } : {}),
  };
}

export class WebResearchService {
  private readonly store: WorkspaceStore;
  private readonly rootDir: string;
  private readonly providers: SearchProvider[];
  private readonly now: () => string;
  private readonly budget: { maxSearches: number; maxFetches: number; maxSnapshotReads: number };
  private readonly used = { searches: 0, fetches: 0, reads: 0 };
  private readonly attempts = { searches: 0, fetches: 0, reads: 0 };
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly lookup: Lookup;
  private readonly transport: Transport;
  private readonly preferredDomains: Set<string>;
  private readonly forbiddenValues: string[];

  constructor(options: WebResearchServiceOptions) {
    this.store = options.store;
    this.rootDir = options.rootDir;
    this.providers = options.providers;
    const now = options.now ? () => options.now! : () => new Date().toISOString();
    this.now = now;
    this.budget = options.budget ?? { maxSearches: 8, maxFetches: 6, maxSnapshotReads: 20 };
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.lookup = options.lookup ?? (async (hostname: string) => {
      const { lookup } = await import('node:dns/promises');
      return lookup(hostname, { all: true, verbatim: true });
    });
    this.transport = options.transport ?? defaultTransport;
    this.preferredDomains = new Set(options.preferredDomains ?? []);
    this.forbiddenValues = options.forbiddenValues ?? [];
  }

  async search(runId: string, query: string): Promise<SearchOutcome> {
    const createdAt = this.now();
    if (containsForbidden(query, this.forbiddenValues)) {
      const event = this.event(runId, 'search', query, 'blocked', `${runId}:web_search:${this.attempts.searches + 1}`, [], createdAt, 'egress_blocked');
      this.store.appendSearchEvent(event);
      return { ok: false, error: 'egress_blocked', note: 'query contained forbidden value' };
    }
    if (this.used.searches >= this.budget.maxSearches) {
      const event = this.event(runId, 'search', query, 'host', `${runId}:web_search:${this.attempts.searches + 1}`, [], createdAt, 'search_quota_exhausted');
      this.store.appendSearchEvent(event);
      return { ok: false, error: 'search_quota_exhausted', note: 'wrap up' };
    }
    const callKey = `${runId}:web_search:${this.attempts.searches + 1}`;
    try {
      const result = await searchWithFallback(this.providers, query, callKey);
      this.attempts.searches += 1;
      this.used.searches += 1;
      const id = `search-${runId}-${this.store.listSearchEvents(runId).length + 1}`;
      const event: SearchEventRecord = { id, runId, kind: 'search', query, provider: result.provider, callKey, hits: result.hits.map(hit => ({ ...hit, tier: this.tier(safeHostname(hit.url)), status: 'hit' as const })), createdAt, ...(result.attempts.length ? { attempts: result.attempts } : {}) };
      this.store.appendSearchEvent(event);
      return { ok: true, id, runId, query, provider: result.provider, callKey, hits: event.hits };
    } catch (error) {
      this.attempts.searches += 1;
      const code = error instanceof WebResearchError ? error.code : error instanceof WebError ? error.code : 'search_failed';
      const failedAttempts = (error as Error & { attempts?: Array<{ provider: string; error: string }> }).attempts;
      const event: SearchEventRecord = { ...this.event(runId, 'search', query, 'host', callKey, [], createdAt, code), ...(failedAttempts?.length ? { attempts: failedAttempts } : {}) };
      this.store.appendSearchEvent(event);
      return { ok: false, error: code, note: 'provider error; wrap up' };
    }
  }

  async fetchPage(runId: string, rawUrl: string, callKey: string): Promise<FetchOutcome> {
    if (containsForbidden(rawUrl, this.forbiddenValues)) throw new WebError('egress_blocked');
    if (this.used.fetches >= this.budget.maxFetches) {
      this.store.appendSearchEvent(this.event(runId, 'selection', '', 'host', callKey, [], this.now(), 'fetch_quota_exhausted'));
      return { ok: false, error: 'fetch_quota_exhausted', note: 'wrap up' };
    }
    const url = validatePublicUrl(rawUrl);
    const result = await secureGet(url, [], this.lookup, this.transport, this.maxBytes, this.timeoutMs, true);
    if (result.response.status !== 200) throw new WebError('http_error');
    const contentType = result.response.headers['content-type'] ?? '';
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new WebError('content_type_rejected');
    this.used.fetches += 1;
    this.attempts.fetches += 1;
    const capturedAt = this.now();
    const html = result.response.body.toString('utf8');
    const document = parse(html);
    const title = document.querySelector('title')?.text.trim() || result.url.hostname;
    const publishedAt = document.querySelector('time')?.getAttribute('datetime') ?? null;
    const text = normalize(document.text);
    const stored = storeRawBytes(this.rootDir, result.response.body, 'html');
    const sourceTier = tierOfSource(result.url.hostname, this.preferredDomains);
    const snapshotId = `snap-${createHash('sha256').update(`${runId}:${result.url}:${callKey}`).digest('hex').slice(0, 16)}`;
    const asset: SourceAsset = {
      id: `asset-${stored.sha256.slice(0, 16)}`, kind: 'web', name: title, sha256: stored.sha256, mediaType: contentType || 'text/html',
      bytes: result.response.body.length, importedAt: capturedAt, publishedAt, capturedAt, locator: result.url.toString(), path: stored.path,
      metadata: { snapshotId, finalUrl: result.url.toString(), sourceTier, callKey, parser: 'node-html-parser@v1' },
    };
    const snapshot: WebSnapshotRecord = {
      id: snapshotId, runId, assetId: asset.id, assetSha256: stored.sha256, url: rawUrl, finalUrl: result.url.toString(), title, publishedAt, capturedAt,
      contentType: contentType || 'text/html', sourceTier, callKey, text, excerpt: text.slice(0, 6000), parseStatus: 'parsed',
    };
    this.store.insertAsset(asset);
    this.store.insertSnapshot(snapshot);
    this.store.appendSearchEvent({
      id: `select-${runId}-${this.store.listSearchEvents(runId).length + 1}`, runId, kind: 'selection', query: '', provider: 'host', callKey,
      hits: [{ url: result.url.toString(), title, snippet: '', tier: sourceTier, status: 'fetched' }], createdAt: capturedAt,
    });
    return { ok: true, snapshotId, assetId: asset.id, assetSha256: stored.sha256, url: rawUrl, finalUrl: result.url.toString(), title, publishedAt, capturedAt, contentType: contentType || 'text/html', sourceTier, excerpt: snapshot.excerpt };
  }

  async readSnapshot(runId: string, snapshotId: string, offset: number, length: number, callKey = `${runId}:read_snapshot:${this.attempts.reads + 1}`): Promise<ReadOutcome> {
    if (this.used.reads >= this.budget.maxSnapshotReads) {
      this.store.appendSearchEvent(this.event(runId, 'selection', '', 'host', callKey, [], this.now(), 'snapshot_read_quota_exhausted'));
      return { ok: false, error: 'snapshot_read_quota_exhausted', note: 'wrap up' };
    }
    const snapshot = this.store.getSnapshot(snapshotId);
    if (!snapshot || snapshot.runId !== runId) throw new WebError('snapshot_not_found');
    if (offset < 0 || length <= 0 || length > 6000) throw new WebError('invalid_snapshot_window');
    this.used.reads += 1;
    this.attempts.reads += 1;
    const text = snapshot.text.slice(offset, offset + length);
    const createdAt = this.now();
    this.store.appendSnapshotRead({
      id: `read-${runId}-${this.store.listSnapshotReads(runId).length + 1}`, runId, snapshotId, offset, length: text.length, text, callKey, createdAt,
    });
    return { ok: true, snapshotId, offset, length: text.length, text, totalLength: snapshot.text.length };
  }

  async recordWebFact(runId: string, input: WebFactInput): Promise<{ ok: true; rawRow: RawRow; assetId: string; assetSha256: string; snapshotId: string } | { ok: false; error: string }> {
    const snapshot = this.store.getSnapshot(input.snapshotId);
    if (!snapshot || snapshot.runId !== runId) throw new WebError('snapshot_not_found');
    const quote = normalize(input.quote);
    const start = snapshot.text.indexOf(quote);
    if (!quote || quote.length > 500 || start < 0) throw new WebError('quote_not_in_snapshot');
    const valueText = normalize(input.valueText);
    if (!quote.includes(valueText)) throw new WebError('value_not_in_quote');
    const cleanedValue = valueText.replace(/[,，％%\s]/g, '');
    const value = Number(cleanedValue);
    if (!cleanedValue || !Number.isFinite(value)) throw new WebError('invalid_external_value');
    for (const key of ['metricId', 'entity', 'period', 'unit']) if (!String((input as unknown as Record<string, string>)[key]).trim()) throw new WebError('invalid_external_fact');
    const dimensions = input.dimensions;
    if (!['primary', 'secondary'].includes(dimensions.sourceType ?? '')) throw new WebError('invalid_source_type');
    for (const key of ['scope', 'currency', 'region', 'publishedAt']) if (!dimensions[key]) throw new WebError(`missing_${key}`);
    for (const key of ['closed', 'comparable']) if (!['true', 'false'].includes(dimensions[key] ?? '')) throw new WebError(`invalid_${key}`);
    const parsedPublishedAt = snapshot.publishedAt?.slice(0, 10) ?? '';
    if (parsedPublishedAt && parsedPublishedAt !== dimensions.publishedAt.slice(0, 10)) throw new WebError('published_at_conflict');
    const sourceType = snapshot.sourceTier === 'C' ? 'secondary' : dimensions.sourceType;
    const issues = sourceType === 'secondary' ? (snapshot.sourceTier === 'C' ? ['secondary_source', 'tier_c_source'] : ['secondary_source']) : [];
    if (!parsedPublishedAt) issues.push('published_at_unverified');
    const locator = `snapshot:${snapshot.id}:quote:${start}-${start + quote.length}`;
    const rawRow: RawRow = {
      rowNumber: 2,
      values: {
        metric: input.metricId, entity: input.entity, period: input.period, value: cleanedValue, unit: input.unit,
        label: snapshot.title, closed: dimensions.closed, comparable: dimensions.comparable, scope: dimensions.scope, currency: dimensions.currency,
        region: dimensions.region, sourceType, publishedAt: parsedPublishedAt || dimensions.publishedAt,
      },
      issues,
      source: { assetSha256: snapshot.assetSha256, kind: 'web', locator, note: quote },
    };
    return { ok: true, rawRow, assetId: snapshot.assetId, assetSha256: snapshot.assetSha256, snapshotId: snapshot.id };
  }

  usage(): { searches: number; fetches: number; reads: number } {
    return { ...this.used };
  }

  limits(): { maxSearches: number; maxFetches: number; maxSnapshotReads: number } {
    return { ...this.budget };
  }

  private tier(hostname: string): SourceTier {
    return tierOfSource(hostname, this.preferredDomains);
  }

  private event(runId: string, kind: SearchEventRecord['kind'], query: string, provider: string, callKey: string, hits: SearchHit[], createdAt: string, error?: string): SearchEventRecord {
    return { id: `search-${runId}-${randomUUID().slice(0, 8)}`, runId, kind, query, provider, callKey, hits, createdAt, ...(error ? { error } : {}) };
  }
}

function safeHostname(raw: string): string {
  try { return new URL(raw).hostname; } catch { return ''; }
}

function tierOfSource(hostname: string, preferredDomains?: Set<string>): SourceTier {
  const host = hostname.toLowerCase();
  if (preferredDomains?.size) for (const domain of preferredDomains) if (host === domain || host.endsWith(`.${domain}`)) return 'A';
  if (/\.(gov|edu)(\.[a-z]{2})?$/i.test(host)) return 'A';
  if (/\.(org|int)(\.[a-z]{2})?$/i.test(host)) return 'B';
  return 'C';
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function containsForbidden(value: string, forbiddenValues: string[]): boolean {
  return forbiddenValues.some(secret => secret && value.includes(secret));
}

function getPath(payload: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current != null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, payload);
}
