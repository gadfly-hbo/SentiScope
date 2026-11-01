import { compareDescriptive } from '../core/comparison.ts';
import { createCandidate } from '../core/candidates.ts';
import { standardizeDataset } from '../core/cleaning.ts';
import { getBenchmarkDefinition, isPreviousYear } from '../core/benchmarks.ts';
import type { CaseCandidate, ComparisonResult, DatasetVersion, EvidenceRef, ExplorationRun, Observation, QualityState, StandardRow } from '../core/mvp-types.ts';
import type { WorkspaceStore } from '../core/workspace-store.ts';
import { WebResearchError, type WebFactInput, type WebResearchService } from '../source/web-research.ts';
import { WebError } from '../source/public-web.ts';

export type ComparisonRequest = {
  definitionId: string;
  actualRowId: string;
  benchmarkRowId: string;
  actualPreviousRowId?: string;
  benchmarkPreviousRowId?: string;
  selectionContext: string;
};

export type ProposalRequest = {
  comparisonId: string;
  title: string;
  interpretation: string;
  nextStep: string;
  unknown: string;
  refutationObservationId: string;
};

export type ExplorationTools = {
  profile: () => Promise<{ rows: number; quality: DatasetVersion['quality']; fields: string[]; steps: number }>;
  query: (filter?: { metricId?: string; entity?: string; limit?: number }) => Promise<StandardRow[]>;
  clean: (input: { entityAliases?: Record<string, string> }) => Promise<DatasetVersion>;
  webSearch: (input: { query: string }) => Promise<Record<string, unknown>>;
  fetchPage: (input: { url: string }) => Promise<Record<string, unknown>>;
  readSnapshot: (input: { snapshotId: string; offset?: number; length?: number }) => Promise<Record<string, unknown>>;
  recordWebFact: (input: WebFactInput) => Promise<Record<string, unknown>>;
  compare: (request: ComparisonRequest) => Promise<ComparisonResult & { id: string }>;
  propose: (request: ProposalRequest) => Promise<CaseCandidate>;
  observe: (input: { summary: string; status?: 'observed' | 'needs_evidence' | 'rejected'; evidence?: EvidenceRef[]; quality?: QualityState; comparisonId?: string; role?: 'support' | 'refutation' | 'quality' }) => Promise<Observation>;
  setCoverage: (coverage: string[]) => Promise<void>;
};

export type RuntimeContext = {
  tools: ExplorationTools;
  signal?: AbortSignal;
  dataset?: DatasetVersion;
  onSdkEvent?: (event: { type: string; [key: string]: unknown }) => void;
  onSession?: (identity: { sessionId?: string; model?: string }) => void;
};
export type RuntimeOutcome = { stopReason: string; model?: string; sessionId?: string };
export type ExplorationRuntime = {
  model: string;
  run: (context: RuntimeContext) => Promise<RuntimeOutcome>;
};

export class ControlledRuntime implements ExplorationRuntime {
  readonly model = 'controlled-fixture';
  private readonly script: (tools: ExplorationTools) => Promise<RuntimeOutcome>;
  constructor(script: (tools: ExplorationTools) => Promise<RuntimeOutcome>) { this.script = script; }
  run(context: RuntimeContext): Promise<RuntimeOutcome> { return this.script(context.tools); }
}

type RunOptions = {
  store: WorkspaceStore;
  dataset: DatasetVersion;
  runtime: ExplorationRuntime;
  runId: string;
  now: string;
  maxToolCalls?: number;
  signal?: AbortSignal;
  research?: WebResearchService;
};

export async function runExploration(options: RunOptions): Promise<ExplorationRun> {
  const { store, dataset, runtime, runId, now } = options;
  const maxToolCalls = options.maxToolCalls ?? 25;
  const researchLimits = options.research?.limits() ?? { maxSearches: 0, maxFetches: 0, maxSnapshotReads: 0 };
  const run: ExplorationRun = {
    id: runId, datasetId: dataset.id, model: runtime.model, status: 'running', startedAt: now, finishedAt: null,
    budget: { maxToolCalls, usedToolCalls: 0, ...researchLimits, usedSearches: 0, usedFetches: 0, usedSnapshotReads: 0 }, coverage: [], candidateIds: [], stopReason: '', events: [],
  };
  store.createRun(run);
  const comparisons = new Map<string, ComparisonResult>();
  let workingDataset = dataset;
  let sequence = 0;
  const persist = () => store.saveRun(run);
  const finishEarly = (status: 'cancelled' | 'failed', reason: string): ExplorationRun => {
    run.status = status; run.stopReason = reason; run.finishedAt = now;
    run.events.push({ type: status, at: now, summary: reason }); persist();
    return run;
  };
  if (options.signal?.aborted) return finishEarly('cancelled', 'aborted');

  const charge = (type: string, summary: string) => {
    if (options.signal?.aborted) throw abortError();
    if (run.budget.usedToolCalls >= maxToolCalls) throw new Error('budget_exceeded');
    run.budget.usedToolCalls += 1;
    run.events.push({ type, at: now, summary, details: { toolCall: run.budget.usedToolCalls } });
    persist();
  };
  const syncResearchUsage = () => {
    if (!options.research) return;
    const usage = options.research.usage();
    run.budget.usedSearches = usage.searches;
    run.budget.usedFetches = usage.fetches;
    run.budget.usedSnapshotReads = usage.reads;
    persist();
  };
  const researchCall = async <T>(type: string, summary: string, call: (research: WebResearchService) => Promise<T>): Promise<T | { ok: false; error: string; note: string }> => {
    charge(type, summary);
    const research = options.research;
    if (!research) return { ok: false, error: 'search_provider_unavailable', note: 'wrap up' };
    try {
      const outcome = await call(research);
      syncResearchUsage();
      return outcome;
    } catch (error) {
      syncResearchUsage();
      const code = error instanceof WebError || error instanceof WebResearchError ? error.code : 'research_failed';
      run.events.push({ type: 'research_error', at: now, summary: `${type} 被 Host 拒绝：${code}`, details: { tool: type, error: code } });
      persist();
      return { ok: false, error: code, note: 'Host 拒绝并留事件；可调整参数重试或收束，不得把失败当作证据' };
    }
  };
  const appendObservation = (observation: Observation) => {
    store.appendObservations([observation]);
    run.events.push({ type: 'observation', at: now, summary: observation.summary, details: { observationId: observation.id, status: observation.status, role: observation.role } });
    persist();
    return observation;
  };
  const tools: ExplorationTools = {
    profile: async () => {
      charge('profile', '读取数据画像与质量报告');
      return { rows: workingDataset.rows.length, quality: workingDataset.quality, fields: workingDataset.fields, steps: workingDataset.steps.length };
    },
    query: async (filter = {}) => {
      charge('query', '查询标准数据行');
      return workingDataset.rows.filter(row => (!filter.metricId || row.metricId === filter.metricId) && (!filter.entity || row.entity === filter.entity)).slice(0, Math.min(filter.limit ?? 100, 100));
    },
    clean: async input => {
      charge('clean', '按显式实体映射重放清洗并生成新数据版本');
      const next = standardizeDataset({
        name: `${workingDataset.name} · Agent 清洗`, version: workingDataset.version + 1, now,
        sourceAssetIds: workingDataset.sourceAssetIds, rawRows: workingDataset.rawRows, entityAliases: input.entityAliases,
      });
      store.insertDataset(next); workingDataset = next; run.datasetId = next.id; persist();
      return next;
    },
    webSearch: async input => researchCall('web_search', `搜索外部基准：${input.query}`, research => research.search(runId, input.query)),
    fetchPage: async input => researchCall('fetch_page', '选择性读取公开页面', research => research.fetchPage(runId, input.url, `${runId}:fetch_page:${run.budget.usedToolCalls}`)),
    readSnapshot: async input => researchCall('read_snapshot', '分页核对快照原文', research => research.readSnapshot(runId, input.snapshotId, input.offset ?? 0, input.length ?? 6000, `${runId}:read_snapshot:${run.budget.usedToolCalls}`)),
    recordWebFact: async input => researchCall('record_web_fact', `登记快照外部数字：${input.metricId} ${input.entity} ${input.period}`, async research => {
      const fact = await research.recordWebFact(runId, input);
      if (!fact.ok) return fact;
      const next = standardizeDataset({
        name: `${workingDataset.name} · 快照事实`, version: workingDataset.version + 1, now,
        sourceAssetIds: [...new Set([...workingDataset.sourceAssetIds, fact.assetId])],
        rawRows: [...workingDataset.rawRows, fact.rawRow],
      });
      const row = next.rows.find(item => item.source.assetSha256 === fact.assetSha256 && item.source.locator === fact.rawRow.source.locator);
      if (!row) throw new Error('external_fact_row_not_found');
      store.insertDataset(next); workingDataset = next; run.datasetId = next.id; persist();
      return { ok: true as const, dataset: { id: next.id, version: next.version }, row: { rowId: row.rowId, metricId: row.metricId, entity: row.entity, period: row.period, value: row.value, unit: row.unit, quality: row.quality } };
    }),
    compare: async request => {
      charge('comparison', `执行基准 ${request.definitionId} 描述性比较`);
      const definition = getBenchmarkDefinition(request.definitionId);
      const actual = requiredRow(workingDataset, request.actualRowId);
      const benchmark = requiredRow(workingDataset, request.benchmarkRowId);
      const actualPrevious = request.actualPreviousRowId ? requiredRow(workingDataset, request.actualPreviousRowId) : undefined;
      const benchmarkPrevious = request.benchmarkPreviousRowId ? requiredRow(workingDataset, request.benchmarkPreviousRowId) : undefined;
      const scope = validateRows(definition, actual, benchmark, actualPrevious, benchmarkPrevious);
      if (definition.comparisonType === 'competitor' || definition.comparisonType === 'industry') {
        const publishedAt = benchmark.dimensions.publishedAt || store.listAssets().find(asset => asset.sha256 === benchmark.source.assetSha256)?.publishedAt || '';
        scope.comparable = scope.comparable && benchmark.dimensions.sourceType !== 'secondary' && benchmarkPrevious?.dimensions.sourceType !== 'secondary' && Boolean(publishedAt) && publishedAt >= periodEnd(actual.period);
      }
      let actualValue = actual.value ?? Number.NaN;
      let benchmarkValue = benchmark.value ?? Number.NaN;
      let formula: string | undefined;
      const evidence = [actual.source, benchmark.source];
      if (definition.comparisonType === 'competitor' || definition.comparisonType === 'industry') {
        if (!actualPrevious || !benchmarkPrevious) throw new Error('growth_previous_rows_required');
        actualValue = growth(actual, actualPrevious);
        benchmarkValue = growth(benchmark, benchmarkPrevious);
        evidence.push(actualPrevious.source, benchmarkPrevious.source);
        formula = `自身增速 = (${actual.value} − ${actualPrevious.value}) ÷ ${actualPrevious.value} = ${actualValue}%；基准增速 = (${benchmark.value} − ${benchmarkPrevious.value}) ÷ ${benchmarkPrevious.value} = ${benchmarkValue}%`;
      }
      const result = compareDescriptive({
        comparisonType: definition.comparisonType,
        metricId: actual.metricId,
        entity: actual.entity,
        period: actual.period,
        actual: actualValue,
        benchmark: benchmarkValue,
        unit: definition.comparisonType === 'competitor' || definition.comparisonType === 'industry' ? '%' : actual.unit,
        direction: definition.direction,
        threshold: definition.threshold,
        periodClosed: scope.periodClosed,
        comparable: scope.comparable,
        benchmarkLabel: definition.label,
        benchmarkPeriod: benchmark.period,
        actualLabel: actual.dimensions.label,
        evidence,
        selectionContext: request.selectionContext,
      });
      result.definitionId = definition.id;
      result.thresholdVersion = definition.thresholdVersion;
      result.calculationVersion = 'compare-v2';
      if (formula) result.formula = `${formula}；${result.formula}`;
      const id = `cmp-${runId}-${++sequence}`;
      comparisons.set(id, result);
      appendObservation({
        id: `obs-${runId}-${sequence}`, runId, kind: 'comparison',
        status: result.status === 'needs_evidence' ? 'needs_evidence' : 'observed',
        summary: `${definition.comparisonType}: ${result.gapDisplay} · ${result.reason}`,
        comparison: result, comparisonId: id, evidence: result.evidence, createdAt: now,
      });
      return { ...result, id };
    },
    propose: async request => {
      charge('candidate', '提交 Case 候选门禁');
      const comparison = comparisons.get(request.comparisonId);
      if (!comparison?.thresholdVersion) throw new Error('comparison_not_found');
      if (!run.coverage.includes(comparison.selectionContext)) throw new Error('search_coverage_required');
      const refutation = store.listObservations(runId).find(item => item.id === request.refutationObservationId && item.role === 'refutation' && item.comparisonId === request.comparisonId && item.evidence.length > 0);
      if (!refutation) throw new Error('refutation_observation_required');
      const webSources = new Set(comparison.evidence.filter(ref => ref.kind === 'web').map(ref => ref.assetSha256));
      const candidate = createCandidate({
        runId, datasetId: workingDataset.id, comparison, title: request.title, interpretation: request.interpretation, nextStep: request.nextStep,
        unknown: request.unknown, support: 'Host 已验证基准定义、数据行、计算与证据引用', refutation: refutation.summary,
        refutationObservationId: refutation.id, thresholdVersion: comparison.thresholdVersion, calculationLocator: `comparison:${request.comparisonId};revision:1`,
        ...(webSources.size === 1 ? { singleSourceLimitation: '外部基准仅来自 1 个搜索快照，未做第二独立来源交叉验证；复核时应补充或替换来源' } : {}),
      }, now);
      const committed = store.commitCandidate(candidate, {
        id: `obs-${runId}-candidate-${++sequence}`, runId, kind: 'decision', status: 'candidate',
        summary: `候选通过门禁：${candidate.title}`, comparison, comparisonId: request.comparisonId, evidence: candidate.comparison.evidence, createdAt: now,
      });
      if (!run.candidateIds.includes(committed.id)) run.candidateIds.push(committed.id);
      run.events.push({ type: 'candidate_committed', at: now, summary: committed.title, details: { candidateId: committed.id, revision: committed.revision } });
      persist();
      return committed;
    },
    observe: async input => {
      charge('observation', input.summary);
      return appendObservation({ id: `obs-${runId}-note-${++sequence}`, runId, kind: input.quality ? 'quality' : 'decision', status: input.status ?? 'observed', summary: input.summary, comparisonId: input.comparisonId, role: input.role, evidence: input.evidence ?? [], createdAt: now });
    },
    setCoverage: async coverage => {
      charge('coverage', '保存搜索覆盖与候选选择上下文');
      run.coverage = [...new Set([...run.coverage, ...coverage])];
      persist();
    },
  };

  try {
    const outcome = await runtime.run({
      tools, signal: options.signal, dataset,
      onSdkEvent: event => { run.events.push({ type: `sdk:${event.type}`, at: now, summary: 'Pi SDK 事件', details: event }); persist(); },
      onSession: identity => { if (identity.sessionId) run.sessionId = identity.sessionId; if (identity.model) run.model = identity.model; persist(); },
    });
    if (outcome.model) run.model = outcome.model;
    if (outcome.sessionId) run.sessionId = outcome.sessionId;
    if (options.signal?.aborted) return finishEarly('cancelled', 'aborted');
    run.status = 'completed';
    run.stopReason = outcome.stopReason;
  } catch (error) {
    run.status = (error as Error).name === 'AbortError' || options.signal?.aborted ? 'cancelled' : 'failed';
    run.stopReason = (error as Error).message;
  }
  run.finishedAt = now;
  run.events.push({ type: run.status, at: now, summary: run.stopReason });
  persist();
  return run;
}

function requiredRow(dataset: DatasetVersion, id: string): StandardRow {
  const row = dataset.rows.find(item => item.rowId === id);
  if (!row) throw new Error('comparison_row_not_found');
  return row;
}

function validateRows(definition: ReturnType<typeof getBenchmarkDefinition>, actual: StandardRow, benchmark: StandardRow, actualPrevious?: StandardRow, benchmarkPrevious?: StandardRow): { comparable: boolean; periodClosed: boolean } {
  const rows = [actual, benchmark, actualPrevious, benchmarkPrevious].filter((row): row is StandardRow => Boolean(row));
  const metricScope = actual.metricId === definition.actualMetric && benchmark.metricId === definition.benchmarkMetric;
  const entityScope = definition.actualEntity ? actual.entity === definition.actualEntity : true;
  const benchmarkEntityScope = definition.benchmarkEntity ? benchmark.entity === definition.benchmarkEntity : actual.entity === benchmark.entity;
  const periodScope = definition.periodRule === 'same' ? actual.period === benchmark.period : isPreviousYear(actual.period, benchmark.period);
  const sharedScope = ['scope', 'currency', 'region'].every(key => Boolean(actual.dimensions[key]) && rows.every(row => row.dimensions[key] === actual.dimensions[key]));
  const previousScope = !actualPrevious || (actualPrevious.metricId === actual.metricId && actualPrevious.entity === actual.entity && actualPrevious.unit === actual.unit && isPreviousYear(actual.period, actualPrevious.period));
  const benchmarkPreviousScope = !benchmarkPrevious || (benchmarkPrevious.metricId === benchmark.metricId && benchmarkPrevious.entity === benchmark.entity && benchmarkPrevious.unit === benchmark.unit && isPreviousYear(actual.period, benchmarkPrevious.period));
  return {
    comparable: metricScope && entityScope && benchmarkEntityScope && periodScope && sharedScope && previousScope && benchmarkPreviousScope && actual.unit === benchmark.unit && rows.every(row => row.quality === 'usable' && row.dimensions.comparable === 'true'),
    periodClosed: rows.every(row => row.dimensions.closed === 'true'),
  };
}

function periodEnd(period: string): string {
  const quarter = /^(\d{4})Q([1-4])$/.exec(period);
  if (quarter) return ['1','2','3','4'].includes(quarter[2]!) ? `${quarter[1]}-${String(Number(quarter[2]) * 3).padStart(2, '0')}-${quarter[2] === '1' || quarter[2] === '4' ? '31' : '30'}` : period;
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const days = new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).getUTCDate();
    return `${period}-${String(days).padStart(2, '0')}`;
  }
  return period;
}

function growth(current: StandardRow, previous: StandardRow): number {
  if (current.value == null || previous.value == null || previous.value <= 0) throw new Error('growth_base_invalid');
  return Math.round(((current.value - previous.value) / previous.value * 100 + Number.EPSILON) * 10_000) / 10_000;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
