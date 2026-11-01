# Host 与 Agent 职责边界及复用检查

日期：2026-10-31　范围：`slice2-exploration-candidates` 当前工作树、真实入口调用链与受控运行记录　补充：2026-11-01 公网范围修订为 deepresearch 搜索模式

**总体结论：待验证。** 代码与受控运行证据支持“Host 职责边界及 SDK 复用合理”，未发现 Host 编排真实 Agent 推理、另建模型循环或隐藏修复层。2026-10-31 的真实执行已产生实际 sessionId 与 SDK 事件，但执行层候选、覆盖与自主纠错断言均为 FAIL，且用户中止审核，因此仍不能据此证明真实 Agent 的方法选择、执行顺序与纠错自主性。2026-11-01 起公网形态改为 `web_search`／`fetch_page`／`read_snapshot`，当前单 URL 工具只能作为被重构的历史实现，不能按新范围判定通过。按工程规范 §4，本项不得标记全部完成，也不得作为合并／发布依据。

## 检查范围与调用链

### 真实 SDK 路径（已建，未做真实模型验收）

```
scripts/start.mjs（SENTISCOPE_REAL_MODEL=1）
  → startHost 注入 PiAgentRuntime
  → PiAgentRuntime.run
  → createAgentSession / SessionManager.create / DefaultResourceLoader
  → session.prompt（单次主 Agent 循环）
  → Agent 自主调用 sentiscope_* 工具
  → exploration-service 执行确定性工具与 Host 门禁
  → WorkspaceStore 保存运行、观察、候选、证据与复核
```

证据：[scripts/start.mjs:16](file:///Users/huangbo/Dev/SentiScope/scripts/start.mjs#L16)、[scripts/start.mjs:28](file:///Users/huangbo/Dev/SentiScope/scripts/start.mjs#L28)、[pi-runtime.ts:58](file:///Users/huangbo/Dev/SentiScope/src/agent/pi-runtime.ts#L58)、[pi-runtime.ts:71](file:///Users/huangbo/Dev/SentiScope/src/agent/pi-runtime.ts#L71)、[exploration-service.ts:217](file:///Users/huangbo/Dev/SentiScope/src/agent/exploration-service.ts#L217)、[workspace-store.ts:17](file:///Users/huangbo/Dev/SentiScope/src/core/workspace-store.ts#L17)。

### 合成受控路径（仅工程演示，不是自主性证据）

默认入口明确使用 `ControlledRuntime(model='controlled-fixture')`，其固定调用序列只用于演示和测试。真实模型模式没有失败回退到该脚本的逻辑。

证据：[demo.ts:42](file:///Users/huangbo/Dev/SentiScope/src/host/demo.ts#L42)、[demo.ts:50](file:///Users/huangbo/Dev/SentiScope/src/host/demo.ts#L50)、[exploration-service.ts:53](file:///Users/huangbo/Dev/SentiScope/src/agent/exploration-service.ts#L53)、[scripts/start.mjs:28](file:///Users/huangbo/Dev/SentiScope/scripts/start.mjs#L28)。

## 逐项检查

| 检查项 | 证据与判断 | 结论 |
| --- | --- | --- |
| Host 只提供环境、上下文、权限、资源控制、状态与持久化 | 启动配置和 runtime 注入在 `start.mjs`；loopback 写保护在 `src/host/server.ts:95`；取消控制器在 `server.ts:50,107-112`；预算在 `exploration-service.ts:91-96`；运行／观察／候选／复核在 `workspace-store.ts:17-24,54,153` 持久化。未发现 Host 生成业务候选结论或代替模型解释数据。 | 通过（代码与运行记录） |
| Agent 自主选择方法、工具、执行顺序和纠错方式 | `session.prompt()` 由 SDK 执行；工具只声明能力，未写死目标→历史→竞对→行业的执行顺序；`sentiscope_compare` 由调用方给 `definitionId` 与行 ID；Host 不决定 Agent 下一个工具或修正文本。工具校验错误通过 SDK 工具错误返回，可由 Agent 修正。测试还验证受控调用顺序可不同于默认脚本（`tests/mvp-exploration.test.ts:76`）。 | 代码结构通过；真实行为待验证 |
| 无硬编码分析流程、固定步骤、方法配额或不必要确认门槛 | 唯一固定序列在 `src/host/demo.ts`，已明确为合成受控 fixture，不能当作真实 Agent。`maxToolCalls=25` 是资源预算，不是分析方法配额；`getBenchmarkDefinition` 只提供经批准的业务基准，不指定探索步骤；候选和证据门禁属于权限与成果质量控制。 | 通过（限定 demo 范围）；真实模型待验证 |
| 会话循环与工具调用复用 SDK | `createAgentSession` 只在真实 runtime 与无模型探针使用；主循环为 `session.prompt()`；工具有 `defineTool` 注册；没有另建 prompt→模型→工具循环、第二模型调用或隐藏 repair agent。 | 通过（代码） |
| 上下文、会话、恢复与重试复用 SDK | `DefaultResourceLoader` 加载资源与 skills；`SessionManager.create` 使用官方持久会话；`session.subscribe` 使用官方事件；`session.abort()` 使用官方取消；官方文档说明 prompt、持久 SessionManager、压缩、自动重试及 abort（`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:20,38,64,70,98-105`）。没有另建压缩／重试／会话格式。当前宿主重启仅将遗留 running 标为 interrupted_by_restart，尚未证明真实会话续接恢复。 | 通过（代码）；真实会话事件与续接恢复待验证 |
| 新增机制有已验证缺口与最小适配理由 | 技术盘点 §2 明确 SDK 无通用应用 DB、任务队列与运行预算（`SentiScope_技术盘点...md:36`），§4 明确预算可经 abort＋事件自实现（同文件 `:84`）。因此仅新增：SQLite 领域持久化、Host 预算／取消映射、领域工具与候选门禁、数据／网络出口控制；未复制 SDK 会话与 Agent 循环。 | 通过 |
| 必要权限、安全、预算、取消和原件保护不被误判为干涉 | 公网白名单、DNS／IP、robots、出口投影、候选证据与反证校验均属于安全与数据质量边界；原始文件不可变，数据版本追加；取消和预算只终止或标记运行，不替 Agent 修正答案。 | 通过 |
| 无隐藏修复、二次推理或输出改写层 | 全树仅有 `createAgentSession` 的真实 runtime 与无模型探针；未发现 `chat.create`、`messages.create`、`llm.invoke`、第二模型调用、修复 prompt 或输出二次生成。分析性文案由 Agent 提交；Host 仅生成确定性 support／提交观察元数据与计算证据，不构成隐藏语义改写。 | 通过（代码）；真实日志待验证 |

## 运行记录证据

证据目录（被 `.gitignore` 忽略，不进入公开仓库）：

- [startup.log](file:///Users/huangbo/Dev/SentiScope/.local/slice2-boundary-review/startup.log)：真实 `npm start` 启动，明确“合成受控演示（不调用模型）”、公网禁用、会话探针通过。
- [health.json](file:///Users/huangbo/Dev/SentiScope/.local/slice2-boundary-review/health.json)：本机健康检查返回。
- [runs.json](file:///Users/huangbo/Dev/SentiScope/.local/slice2-boundary-review/runs.json)：受控 `run-demo-6b953725`，`model=controlled-fixture`，预算 16/25，含搜索覆盖与 31 个持久事件。另有 2026-10-31 `projects/EVAL-2026-001-sentiscope-slice2/runs/run-001/` 的真实模型 trial，含真实 sessionId 与 `sdk:*` 事件，但其执行层结论为 FAIL，不能混写为通过。
- [candidates.json](file:///Users/huangbo/Dev/SentiScope/.local/slice2-boundary-review/candidates.json)：4 个候选，分别使用 `revenue-target`、`revenue-history`、`growth-competitor`、`growth-industry`；每个候选含 `datasetId`、`refutationObservationId`、原始／网页／计算证据定位。
- SQLite 复核（2026-10-31 同库）：每个 `refutationObservationId` 均指向同 run、同 comparisonId 的 `role=refutation` 观察；目标／历史反证各 2 个原始证据，竞对／行业反证各 2 个原始证据＋2 个网页证据。

这些记录证明 Host 的状态、预算、证据和候选持久化行为，以及受控工具链可运行；**不证明真实模型自主性**。

## 发现的问题与处置

### B-01【高】真实 Agent 自主性未通过执行验收——待验证

- **事实**：2026-10-31 的真实执行已有 `openai-codex:gpt-6.1-sol`、真实 sessionId 与 `sdk:*` 事件，但 SS2-01、SS2-04、SS2-09 等执行层候选／覆盖／纠错断言均为 FAIL；SS2-08 公网与 SS2-14 UI 为 NOT_RUN，最终独立审核被用户中止。
- **影响**：真实模型事件存在只能证明真实路径执行，不能证明自主探索质量或边界验收通过；不得把受控脚本或代码结构当作自主性结论。
- **必须补齐**：若后续恢复验收，需保留本次失败历史，修复后绑定新候选，完成 E2E-01、AGT-01～07 与 held-out，至少一次假设否定／修正及失败恢复记录，并确认 Host 没有在批准的基准上下文之外逐轮预选指标、固定工具序列或失败时回退受控脚本。

### B-02【低】合成 fixture 含固定分析序列——限定用途，持续隔离

- **事实**：[demo.ts:50-71](file:///Users/huangbo/Dev/SentiScope/src/host/demo.ts#L50) 明确按固定顺序调用比较和候选工具。
- **判断**：这是合成演示，不是职责越界；但若被用于真实自主性验收会构成证据错误。
- **处置**：保持 `controlled-fixture` 标识和启动日志说明；真实验收禁止使用它证明自主性。无需申请例外。

### B-03【低】基准定义目前为代码内置——非越界，后续配置化

- **事实**：[benchmarks.ts:18-22](file:///Users/huangbo/Dev/SentiScope/src/core/benchmarks.ts#L18) 提供固定目标／历史／竞对／行业基准。
- **判断**：这是 Host 提供业务上下文与批准阈值，不是分析流程编排；当前合成 MVP 可接受。真实用户数据扩展时需提供用户批准的版本化基准配置，Agent 可建议但不能自行批准。
- **处置**：记录为真实试用前的配置工作，不阻断本项代码边界结论。

## 2026-11-01 搜索模式补充检查（B-04～B-07）

范围：deepresearch 搜索模式本地受控实施（`web-research.ts`、`exploration-service.ts` 检索工具、`server.ts` 搜索面、`demo.ts` fixture Provider、UI 搜索面）。

### B-04【通过】检索服务属于环境与治理职责

- Provider 链、搜索／抓取／读取配额、SSRF／robots／大小／内容类型校验、出口扫描、快照不可变与逐字引用校验均由 Host 执行；搜索词完全来自模型，命中按 Provider 原序保存、不重排、不预选。来源分级与优先域是 Host 的环境配置，不是分析结论。

### B-05【通过】Host 校验失败反馈给 Agent 自主修正

- `exploration-service.ts` 的 `researchCall` 把 `WebError`／`WebResearchError` 转为 `{ok:false,error,note}` 工具返回值并写 `research_error` 运行事件；配额耗尽同样以错误值提示收束。运行状态只由 runtime 结果与异常决定，未出现把拒绝或耗尽写成成功的路径；Host 未因校验失败而另造分析流程。

### B-06【通过】外部数字资格交叉核验不是业务判断

- `recordWebFact` 用 Host 已解析的快照信号核验模型声明：`publishedAt` 与 `<time datetime>` 冲突即拒绝；C 级来源一律按二手记录并打 `tier_c_source`；外部基准仅来自 1 个快照时由 Host 写结构化 `singleSourceLimitation`。这些是证据资格与来源等级校验（WEB-03/WEB-06），Agent 仍自主决定引用哪个数字、如何解释与是否提交候选。

### B-07【限定】演示 fixture Provider 沿用 B-02 隔离

- `demo.ts` 的本地 fixture Provider／传输只在 `ControlledRuntime` 演示模式注入，启动日志与 UI 明示“合成受控演示、不出网”；真实模型模式不注入。它不得作为自主性或真实公网质量的证据。

## 最终判定与退出条件

- Host 职责、必要安全控制、领域持久化与最小适配：**通过**。
- 2026-11-01 搜索模式补充检查 B-04～B-07（检索环境职责、校验失败错误值反馈、证据资格交叉核验、fixture 隔离）：**代码通过**；非作者独立复核两轮（REJECT→PASS）确认阻断项关闭。
- SDK 循环、工具、上下文、会话、取消与重试复用：**代码通过，真实运行待验证**。
- Agent 自主选择方法、工具、顺序与纠错：**待验证**。
- **本检查总体：待验证，不得作为合并／发布完成项。** 无例外申请；B-01 的真实模型证据补齐并复核前，不得进入合并或发布。
