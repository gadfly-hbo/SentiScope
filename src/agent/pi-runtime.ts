import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, defineTool, loadSkillsFromDir, SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { DatasetVersion } from '../core/mvp-types.ts';
import type { ComparisonRequest, ExplorationRuntime, ExplorationTools, ProposalRequest, RuntimeContext, RuntimeOutcome } from './exploration-service.ts';
import { assertEgressAllowed, DEFAULT_EGRESS, projectDatasetForModel, projectRowForModel, sanitizeEgressPayload, type EgressPolicy } from './egress.ts';

type SessionLike = {
  prompt: (text: string) => Promise<void>;
  getLastAssistantText: () => string | undefined;
  subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => () => void;
  abort: () => Promise<void>;
  dispose: () => void;
  sessionManager?: { getSessionId: () => string };
  agent?: { state: { model?: { id?: string; provider?: string } } };
};
type SessionFactory = (options: Record<string, unknown>) => Promise<{ session: SessionLike }>;

export function guardProviderPayload(payload: unknown, policy: EgressPolicy): unknown {
  return sanitizeEgressPayload(payload, policy);
}

type PiOptions = {
  skillsDir: string;
  cwd: string;
  sessionDir?: string;
  model?: string;
  egress?: EgressPolicy;
  sessionFactory?: SessionFactory;
};

export class PiAgentRuntime implements ExplorationRuntime {
  readonly model: string;
  private readonly options: PiOptions;
  private readonly egress: EgressPolicy;
  constructor(options: PiOptions) {
    this.options = options;
    this.model = options.model ?? 'pi-default';
    this.egress = options.egress ?? DEFAULT_EGRESS;
  }

  async run(context: RuntimeContext & { dataset?: DatasetVersion }): Promise<RuntimeOutcome> {
    const dataset = context.dataset;
    if (!dataset) throw new Error('dataset_required');
    if (context.signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
    const factory = this.options.sessionFactory ?? (createAgentSession as unknown as SessionFactory);
    const tools = buildPiTools(context.tools, this.egress);
    const { skills, diagnostics } = loadSkillsFromDir({ dir: this.options.skillsDir, source: 'sentiscope' });
    const loader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir: join(this.options.cwd, '.sentiscope-agent'),
      skillsOverride: current => ({ skills: [...current.skills, ...skills], diagnostics: [...current.diagnostics, ...diagnostics] }),
      extensionFactories: [pi => { pi.on('before_provider_request', event => { return guardProviderPayload(event.payload, this.egress); }); }],
    });
    await loader.reload();
    const { session } = await factory({
      cwd: this.options.cwd,
      sessionManager: SessionManager.create(this.options.cwd, this.options.sessionDir ?? join(this.options.cwd, '.sentiscope-sessions')),
      tools: Object.keys(tools),
      customTools: Object.values(tools),
      resourceLoader: loader,
    });
    const actualModel = session.agent?.state.model;
    context.onSession?.({ sessionId: session.sessionManager?.getSessionId(), model: actualModel?.id ? `${actualModel.provider ?? 'provider'}:${actualModel.id}` : this.model });
    const abort = () => { void session.abort(); };
    context.signal?.addEventListener('abort', abort, { once: true });
    const unsubscribe = session.subscribe(event => context.onSdkEvent?.(sanitizeEgressPayload(event, this.egress)));
    try {
      const prompt = `你是 SentiScope 描述性数据分析 Agent。数据集 ${dataset.id}（版本 ${dataset.version}）有 ${dataset.rows.length} 行，质量 ${JSON.stringify(dataset.quality)}。\n只能使用 sentiscope_* 工具查询标准行、执行比较和提交候选；需要外部基准时可自主使用 web_search／fetch_page／read_snapshot／record_web_fact，搜索摘要只是线索，候选数字必须来自快照原文。你必须自主选择与目标、历史、竞对、行业有关的比较，检查反证和搜索覆盖，允许零候选或以待补证收束。不得编造数值、基准、证据或根因；候选只能引用 compare 返回的 id。`;
      assertEgressAllowed(prompt, this.egress);
      await session.prompt(prompt);
      return {
        stopReason: (session.getLastAssistantText() ?? '').slice(0, 500) || 'Agent run completed',
        model: actualModel?.id ? `${actualModel.provider ?? 'provider'}:${actualModel.id}` : this.model,
        sessionId: session.sessionManager?.getSessionId(),
      };
    } finally {
      context.signal?.removeEventListener('abort', abort);
      unsubscribe();
      session.dispose();
    }
  }
}

function buildPiTools(tools: ExplorationTools, egress: EgressPolicy) {
  const result = (value: unknown) => {
    assertEgressAllowed(value, egress);
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: undefined };
  };
  return {
    sentiscope_profile: defineTool({
      name: 'sentiscope_profile', label: '数据画像', description: '读取当前标准数据集的质量、字段和清洗步骤数量。', parameters: Type.Object({}),
      execute: async () => result(await tools.profile()),
    }),
    sentiscope_query: defineTool({
      name: 'sentiscope_query', label: '查询标准数据', description: '按指标和实体查询标准行。返回允许进入模型的字段与 rowId。',
      parameters: Type.Object({ metricId: Type.Optional(Type.String()), entity: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params: { metricId?: string; entity?: string; limit?: number }) => { assertEgressAllowed(params, egress); return result((await tools.query(params)).map(row => projectRowForModel(row, egress))); },
    }),
    sentiscope_clean: defineTool({
      name: 'sentiscope_clean', label: '重放清洗', description: '按显式实体别名映射重放清洗，生成新数据集版本并保留原始资产与血缘。',
      parameters: Type.Object({ entityAliases: Type.Optional(Type.Record(Type.String(), Type.String())) }),
      execute: async (_toolCallId, params: { entityAliases?: Record<string, string> }) => { assertEgressAllowed(params, egress); return result(projectDatasetForModel(await tools.clean(params))); },
    }),
    sentiscope_web_search: defineTool({
      name: 'sentiscope_web_search', label: '公网搜索', description: '按自主研究需要搜索公开资料。命中只是线索，不是证据；配额耗尽时按返回值收束。',
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_toolCallId, params: { query: string }) => { assertEgressAllowed(params, egress); return result(await tools.webSearch(params)); },
    }),
    sentiscope_fetch_page: defineTool({
      name: 'sentiscope_fetch_page', label: '读取公开页面', description: '从搜索命中中选择一个公开 URL；Host 做 SSRF／robots／大小校验并保存快照，返回快照摘要。',
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_toolCallId, params: { url: string }) => { assertEgressAllowed(params, egress); return result(await tools.fetchPage(params)); },
    }),
    sentiscope_read_snapshot: defineTool({
      name: 'sentiscope_read_snapshot', label: '读取快照', description: '分页核对已保存快照原文；引用必须来自该原文，不能来自搜索摘要。',
      parameters: Type.Object({ snapshotId: Type.String(), offset: Type.Optional(Type.Number()), length: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params: { snapshotId: string; offset?: number; length?: number }) => { assertEgressAllowed(params, egress); return result(await tools.readSnapshot(params)); },
    }),
    sentiscope_record_web_fact: defineTool({
      name: 'sentiscope_record_web_fact', label: '登记外部数字', description: '用快照中的逐字引用登记外部数字；Host 校验引用、数字与口径后生成标准数据行。closed／comparable 必须按原文口径如实声明，Host 仍会在比较门禁复核。',
      parameters: Type.Object({
        snapshotId: Type.String(), quote: Type.String(), valueText: Type.String(), metricId: Type.String(), entity: Type.String(), period: Type.String(), unit: Type.String(),
        dimensions: Type.Object({
          scope: Type.String(), currency: Type.String(), region: Type.String(), sourceType: Type.Union([Type.Literal('primary'), Type.Literal('secondary')]), publishedAt: Type.String(),
          closed: Type.Union([Type.Literal('true'), Type.Literal('false')]), comparable: Type.Union([Type.Literal('true'), Type.Literal('false')]),
        }),
      }),
      execute: async (_toolCallId, params: import('../source/web-research.ts').WebFactInput) => { assertEgressAllowed(params, egress); return result(await tools.recordWebFact(params)); },
    }),
    sentiscope_compare: defineTool({
      name: 'sentiscope_compare', label: '描述性比较', description: '使用 actualRowId 与 benchmarkRowId 进行目标、历史、竞对或行业比较；Host 负责取值、计算与证据。',
      parameters: Type.Object({
        definitionId: Type.String(), actualRowId: Type.String(), benchmarkRowId: Type.String(),
        actualPreviousRowId: Type.Optional(Type.String()), benchmarkPreviousRowId: Type.Optional(Type.String()), selectionContext: Type.String(),
      }),
      execute: async (_toolCallId, params: ComparisonRequest) => { assertEgressAllowed(params, egress); return result(await tools.compare(params)); },
    }),
    sentiscope_propose: defineTool({
      name: 'sentiscope_propose', label: '提交 Case 候选', description: '提交已执行比较形成候选；必须通过证据、反证、描述性标题与未知项门禁。',
      parameters: Type.Object({
        comparisonId: Type.String(), title: Type.String(), interpretation: Type.String(), nextStep: Type.String(),
        unknown: Type.String(), refutationObservationId: Type.String(),
      }),
      execute: async (_toolCallId, params: ProposalRequest) => { assertEgressAllowed(params, egress); return result(await tools.propose(params)); },
    }),
    sentiscope_observe: defineTool({
      name: 'sentiscope_observe', label: '记录观察或补证项', description: '记录无候选、数据质量或待补证结果，不进入候选看板。',
      parameters: Type.Object({ summary: Type.String(), status: Type.Optional(Type.Union([Type.Literal('observed'), Type.Literal('needs_evidence'), Type.Literal('rejected')])), comparisonId: Type.Optional(Type.String()), role: Type.Optional(Type.Union([Type.Literal('support'), Type.Literal('refutation'), Type.Literal('quality')])), evidence: Type.Optional(Type.Array(Type.Object({ assetSha256: Type.String(), kind: Type.Union([Type.Literal('raw'), Type.Literal('web'), Type.Literal('standard'), Type.Literal('calculation')]), locator: Type.String(), note: Type.Optional(Type.String()) }))) }),
      execute: async (_toolCallId, params: { summary: string; status?: 'observed' | 'needs_evidence' | 'rejected'; comparisonId?: string; role?: 'support' | 'refutation' | 'quality'; evidence?: import('../core/mvp-types.ts').EvidenceRef[] }) => { assertEgressAllowed(params, egress); return result(await tools.observe(params)); },
    }),
    sentiscope_coverage: defineTool({
      name: 'sentiscope_coverage', label: '保存搜索覆盖', description: '记录本次检查过的指标、实体、切片、基准与舍弃原因。',
      parameters: Type.Object({ coverage: Type.Array(Type.String(), { minItems: 1 }) }),
      execute: async (_toolCallId, params: { coverage: string[] }) => { assertEgressAllowed(params, egress); await tools.setCoverage(params.coverage); return result({ ok: true }); },
    }),
  };
}
