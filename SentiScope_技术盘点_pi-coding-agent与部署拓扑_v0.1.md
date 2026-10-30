# SentiScope 技术盘点：pi-coding-agent 能力表面与部署拓扑

版本 v0.1　盘点日期 2026年10月30日　用途 工程能力盘点，作为《OptraCall_自主探索Agent_产品讨论稿_v0.1.md》的工程输入

本稿记录四件事：pi-coding-agent 官方能力表面、OptraCall main 的 Case 现状对齐、"已有／需自建"总清单、两阶段部署拓扑。本稿是盘点与对齐记录，不构成已实现能力、系统连接授权或交付承诺；讨论稿 v0.1 的产品原则与范围约束继续有效。

## 1 盘点依据与方法

- **pi-coding-agent**：`@earendil-works/pi-coding-agent@1.4.0`，即 OptraCall `package.json` 锁定并实际安装的版本（本地路径 `/Users/huangbo/Dev/OptraCall/node_modules/@earendil-works/pi-coding-agent/`，含官方 `docs/`、`examples/`、`schemas/`）。
- **OptraCall**：以 GitHub `gadfly-hbo/OptraCall` 的 origin/main（cb178d4）为准；本地检出曾落后 6 个提交，静态看板结论曾因此误判，已在 2026-10-30 对齐纠正。
- **方法**：只认官方表面（类型导出、官方文档、源码、git 历史），不推定未实现能力；关键论断经二次抽查复核。表格中的"证据"列给出可复查的文件或导出名。

已确认的架构前提（2026-10-30 产品讨论结论）：

1. SentiScope 的 skill 宿主与 OptraCall 使用**同一个 pi-coding-agent，且使用其官方全部能力**，不裁剪、不自造子集。
2. 产品原则与 OptraCall 一致：**Host 只管环境（上下文、权限、工具边界、预算），Agent 自主运行；Host 不控制 Agent 内部的执行步骤与决策。**
3. **Host 不重复造轮子**：pi-coding-agent 已有的能力一律直接用，只建它没有的领域件。
4. 与 OptraCall 的耦合面收敛为**一条 Case 投递契约**；给 OptraCall 增加自动来源入口属新增变更，须走 OptraCall 的 openspec 流程，不在 SentiScope 侧单方面假定。

## 2 pi-coding-agent 官方能力表面（v1.4.0）

| # | 能力 | 官方件 | 证据 |
| - | --- | --- | --- |
| 1 | SDK 进程内嵌入 | `createAgentSession` / `AgentSessionRuntime`，无头驱动 Agent 循环 | `dist/index.d.ts` 导出；`docs/sdk.md`；`examples/sdk/` |
| 2 | 子进程 RPC 宿主 | `runRpcMode` / `RpcClient`（JSONL over stdio），供跨进程／隔离宿主常驻控制 | `dist/index.d.ts`；`docs/rpc.md` |
| 3 | 内置工具 | read／write／edit／bash／grep／find／ls 等（`createCodingTools`）；**官方只读工具集 `createReadOnlyTools`** | `dist/index.d.ts`；`README.md` |
| 4 | codemode 沙箱 | QuickJS 沙箱内编写并执行 JS、可并行调用其他工具——**确定性代码（口径校验、算术、幂等键）的官方落点** | `docs/codemode.md` |
| 5 | Skills 机制 | agentskills.io 规范：目录 + `SKILL.md`（frontmatter），`.pi/skills`、`.agents/skills` 递归发现；`loadSkills` / `formatSkillsForPrompt` | `docs/skills.md`；`dist/index.d.ts` |
| 6 | 自定义工具 | 扩展 API `pi.registerTool(ToolDefinition)`；SDK 层 `defineTool` / `customTools` | `docs/extensions.md`；`dist/index.d.ts` |
| 7 | MCP | `createMcpExtension`：stdio／HTTP、OAuth、工具暴露控制 | `docs/mcp.md` |
| 8 | 权限与信任（部分） | 项目信任（trust.json）、扩展 `tool_call` 事件可 block、工具开关（defaultTools／excludeTools）；**无逐调用审批、无内置 OS sandbox**（官方建议容器隔离，另有 `docs/containerization.md`） | `docs/security.md` |
| 9 | 会话持久化 | `SessionManager` JSONL 持久化、恢复、分支、fork、导入；支持 inMemory | `docs/session-format.md` |
| 10 | 事件与 hooks | `session.subscribe()` 流式事件（message_update／tool／compaction／agent_settled 等）；扩展全量 hooks（turn_start、before_provider_request、tool_call 等） | `docs/sdk.md` |
| 11 | 上下文与模型 | compaction 完整 API（compact／shouldCompact／分支摘要）；`ModelRegistry`／models.json／自定义 provider／虚拟模型 | `docs/compaction.md`、`docs/custom-provider.md` |

**官方明确没有**（盘点复核确认）：定时调度（cron／按数据刷新节奏触发）、任务队列、通用凭据保管（仅有 provider 认证存取）、任意应用数据持久化（仅有会话／settings／trust，无 KV／DB）、运行预算控制（步数／成本上限，可凭 `abort()`＋事件自实现）、内置 subagent（宿主可自建多个 AgentSession）。

## 3 OptraCall main 现状对齐（Case 能力）

讨论稿 v0.1 所述"基于 SQLite 的人工 Case 能力"已在 origin/main 落地（PR #4 `feat(case): add persistent Case and project boards`，2026-10-29 合入，openspec 标记 LOCAL_VERIFIED）。对齐结果：

**已有（可直接作为投递落点的基础）：**

- SQLite 存储：Node 内置 `node:sqlite`，`decision-cases.sqlite3`，带迁移与备份（`src/host/case-store.ts`、`src/host/case-backup.ts`、`tests/case-storage-migration.test.ts`）
- 创建 API：`POST /api/cases`（operationId＋title＋description），挂现有 loopback 服务（`src/host/case-routes.ts`）
- **操作级幂等回执**：每次变更携带 `operationId`，落 `OperationReceipt`（prepared → completed／needs_review），重放同一操作只读回执不重复执行；`GET /api/cases/operations/:id` 供发送方核对
- 审计事件：`WorkEvent`（actorKind 'user'｜'host'、before／after 变更、feedbackSource）
- Case↔Project 多对多关联；CaseArtifact 带 observedSha256／observedBytes 指纹
- 鉴权：loopback（`x-optracall-client: 1` 头＋本机 Origin 校验，`src/host/server.ts`）

**对 SentiScope 仍缺（讨论稿"不能视为现成接口"的判断依然成立，但差距比预想小）：**

1. **发现级稳定去重身份**：operationId 只幂等"单次操作"；新一轮观察（新 operationId、同一发现）会建出新 Case。"来源＋指标＋实体＋周期＋规则身份"的稳定身份及其幂等创建／更新（upsert）语义尚未存在
2. **自动来源结构化字段**：CaseRecord 仅自由文本（title／description／judgement／nextStep），无来源系统、发现身份、规则版本、业务事实（指标／实体／周期／实际／目标／单位／差距）、证据引用、三时间戳（业务观察／抓取／入板）
3. **外部投递身份**：actorKind 仅 'user'｜'host'，外部服务投递需要新增 actor 类型
4. **离线承接**：桌面端关闭即 API 不可达；补投由 SentiScope 侧持久队列＋探活实现
5. **流程边界**：OptraCall 一期 spec 明确"不涉及自动分析流程、后台观察"；为其开自动入口须按 OptraCall 治理流程提交 openspec 变更

## 4 已有／需自建总清单

### A. pi-coding-agent 已有，直接用（不重建）

Agent 循环与会话驱动（进程内 SDK 或 RPC）、内置＋只读工具集、codemode 确定性沙箱、Skills 机制、自定义工具注册、MCP、权限边界（信任＋tool_call block＋工具开关）、会话持久化／恢复／分支、事件流与 hooks、compaction、模型与 provider 配置。**"Agent 本体"零自建。**

### B. OptraCall 已有，同构复用机制形态（复用形态，不抄代码）

- skill／扩展安装机制：`PI_CODING_AGENT_DIR` 独立目录＋热重载（SentiScope 配自己的目录）
- loopback HTTP 安全形态：127.0.0.1 绑定＋专用头＋Origin 校验——Case 接入认证的模式参考
- `/api/health` 探活——补投对接点
- `.command` 双击启动／停止、无守护进程的运行形态（阶段 1 沿用）
- Case 存储、创建 API、操作级幂等回执（见第 3 节）

### C. 需自建（官方与 OptraCall 均没有）

| # | 自建件 | 说明 |
| - | ----- | --- |
| 1 | 定时调度器 | 按数据刷新节奏触发检查；SDK 无调度 |
| 2 | 持久待投递队列 | 待投递／已送达／失败原因，确认后标记；断线与重启后按同一身份补投 |
| 3 | 观察存储 | 口径元数据、观察结果（正常／发现／证据不足／采集失败）、证据引用；需稳定查询，不能塞会话 JSONL |
| 4 | BI 只读适配器 | 结构化 API／导出优先、授权页面兜底；包成 skill＋自定义工具 |
| 5 | 口径校验与比较规则引擎 | 实体／周期／单位／过滤条件可比性、方向与零分母规则、触发阈值；作为 skill 内确定性代码（codemode） |
| 6 | 证据快照库 | 不可变快照、SHA-256、双时间戳、可下钻定位（借鉴 web-crawler 思路，不复制实现） |
| 7 | 凭据保管 | 只读最小权限、与 Case 写入隔离、不进模型上下文 |
| 8 | 运行预算控制 | 步数／成本上限；凭 abort＋事件自实现 |
| 9 | **Case 接入契约扩展**（OptraCall 侧变更） | 在既有 `POST /api/cases` 与 operationId 回执之上，新增发现级去重身份、自动来源字段组、外部 actorKind；走 openspec 变更 |
| 10 | 最小管理界面 | 来源配置、运行记录（为何创建／跳过／失败）、投递积压与安全重试 |

## 5 部署拓扑：两阶段

| 维度 | 阶段 1：最小产品化 | 阶段 2：正式产品 |
| --- | --- | --- |
| 机器拓扑 | 同机（MacBook） | 跨机 |
| SentiScope 形态 | 非常驻，可开启／关闭（沿用 `.command` 启动模式） | 常驻服务 |
| OptraCall 桌面端 | 非常驻，可开启／关闭 | 有关闭时段 |
| Case 接入鉴权 | loopback 现有形态即够 | 需真认证（讨论稿"经过认证的发现"），形态待定 |
| 离线补投 | 队列＋探活＋幂等回执，同机即验证"不丢不重" | 自动补投为主＋管理界面手动补推按钮兜底 |

阶段 1 的明确产品行为：两者开关时间不同步是常态——SentiScope 开启而 OptraCall 关闭时，发现照样产生并入持久队列，OptraCall 启动后探活补投；SentiScope 关闭期间错过的数据刷新，下轮开启时补一轮观察，由幂等身份保证不重复建 Case。此为正常行为，非缺陷，需写入运行口径。

阶段 2 补推方案取舍：以 SentiScope 常驻探活＋退避重试＋幂等回执核对的**自动补投**为主（用户无需手动干预，满足"不丢失、不重复、最终进入原看板"）；管理界面投递状态区保留**手动补推按钮**作为可见性与兜底。不采用 OptraCall 启动时反向拉取／通知 SentiScope 的方案——那会使 OptraCall 感知 SentiScope，耦合方向反转，违背"单一投递契约"原则。

两阶段边界：**阶段 1 验证全部核心机制（观察、校验、发现、队列、幂等入板、补投）；阶段 2 只新增部署环境与跨机认证，不新增机制。**

## 6 待定事项

继承讨论稿 v0.1 第 8 节五项待定决策（首个驾驶舱与接入方式、首批指标与口径、触发门槛与节奏、常驻运行与数据边界、入板后评估方式），另加本轮新增：

- 阶段 2 跨机认证形态（token／mTLS 等）
- 发现级去重身份的承载方式（OptraCall 侧新增字段还是接受方 upsert 语义）——随 Case 接入契约的 openspec 变更确定
- SentiScope 阶段 1 的启动器与目录布局（对照 `~/.optracall/` 的惯例定 `~/.sentiscope/` 或另行约定）
