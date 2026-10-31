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
      const prompt = `你是 SentiScope 描述性数据分析 Agent。数据集 ${dataset.id}（版本 ${dataset.version}）有 ${dataset.rows.length} 行，质量 ${JSON.stringify(dataset.quality)}。\n只能使用 sentiscope_* 工具查询标准行、执行比较和提交候选。你必须自主选择与目标、历史、竞对、行业有关的比较，检查反证和搜索覆盖，允许零候选。不得编造数值、基准、证据或根因；候选只能引用 compare 返回的 id。`;
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
    sentiscope_public_fetch: defineTool({
      name: 'sentiscope_public_fetch', label: '公网补证', description: '经 Host 白名单、robots、公网 IP 和出口校验读取公开对比数据；禁止内网地址与内部数据外发。',
      parameters: Type.Object({ url: Type.String(), mappingId: Type.Optional(Type.String()) }),
      execute: async (_toolCallId, params: import('./exploration-service.ts').PublicFetchRequest) => {
        assertEgressAllowed(params, egress);
        const fetched = await tools.fetchPublic(params);
        return result({
          asset: { id: fetched.asset.id, kind: fetched.asset.kind, sha256: fetched.asset.sha256, publishedAt: fetched.asset.publishedAt, capturedAt: fetched.asset.capturedAt },
          tableCount: fetched.tables.length,
          dataset: fetched.dataset ? projectDatasetForModel(fetched.dataset) : null,
        });
      },
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
