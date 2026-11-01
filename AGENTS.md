# SentiScope 工程入口

开始任务、修改规范或准备交付时，先读 [工程规范](docs/engineering-workflow.md)；涉及产品方向与首期范围时，再读 [自主探索 Agent 产品讨论稿 v0.1](OptraCall_自主探索Agent_产品讨论稿_v0.1.md)；涉及 pi-coding-agent 能力复用、自建清单或部署拓扑时，读 [技术盘点 v0.1](SentiScope_技术盘点_pi-coding-agent与部署拓扑_v0.1.md)。工程规范是开发流程的唯一详细来源。

上一变更 [slice1-observation-core](openspec/changes/slice1-observation-core/spec.md)（切片一"证明读得准"）已完成：用户验收通过，2026-10-30 squash 合并 main（提交 987ef9c，PR #1），规格与[结果记录](openspec/changes/slice1-observation-core/result.md)保留。当前变更 [slice2-exploration-candidates](openspec/changes/slice2-exploration-candidates/spec.md)（切片二“真实探索，形成可信候选”）的前一候选已在分支 `work/qoder/slice2-exploration-candidates` 完成本地受控实施并推送；EVAL-2026-001 真实验收中止，10 个真实模型 trial＋1 个边界元用例执行层均为 FAIL，公网／预算／UI 用例 NOT_RUN（[中止记录](projects/EVAL-2026-001-sentiscope-slice2/closeout.md)）。2026-11-01 用户将公网获取修订为 deepresearch 模式 `web_search`／`fetch_page`／`read_snapshot`，暂不做爬虫；上位方案升级为 [整体产品方案 v0.3](docs/SentiScope_整体产品方案_v0.3.md)。同日已按该模式完成本地受控实施：Provider 链、快照证据、配额错误值、搜索事件与 UI 搜索面均已落地，旧单 URL 抓取、`/api/public-sources` 与 `sentiscope_public_fetch` 已退出；真实模型与真实搜索 Provider 的验收仍待用户分别授权。Host 与 Agent 职责边界及复用检查仍为待验证（[记录](openspec/changes/slice2-exploration-candidates/boundary-review.md)）。候选 `5e9ac73`／`51e3125` 已推送，未创建 PR。原 slice2-delivery 草案不再实施，OptraCall 投递后置。

已确认的工程边界（详见工程规范 §1）：

- skill 宿主与 OptraCall 使用同一个 pi-coding-agent，使用其官方全部能力；Host 不重复造轮子，只建 pi-coding-agent 没有的领域件。
- Host 只管环境（上下文、权限、工具边界、预算），Agent 自主运行；Host 不控制 Agent 内部的执行步骤与决策。
- 与 OptraCall 的耦合收敛为一条 Case 投递契约；对 OptraCall 的任何修改走其 openspec 变更流程。
- 部署两阶段：阶段 1 在 MacBook 本机非常驻、可开关，独立验证导入／公网、清洗、真实探索与候选，不要求 OptraCall 联动；阶段 2 仅在确有部署需要时增加跨机、常驻与真认证。

## Host 与 Agent 架构原则

本项目遵循“Host 管环境，Agent 自主执行”的架构原则。Host 负责提供任务目标、业务上下文、资源与工具访问、权限边界、预算与取消控制，以及状态展示、日志和成果持久化；Agent 在授权范围内自主理解任务、选择方法与工具、安排分析步骤、检查结果并修正错误。Host 不通过硬编码流程、固定步骤、方法配额或无必要的确认门槛干涉 Agent 的内部运行，不替 Agent 作业务判断或编排其推理过程。优先复用既有 Agent SDK／Runtime 提供的循环、工具调用、上下文管理、压缩、恢复与重试能力，仅在存在已验证的缺口时增加最小适配，不重复建设平行机制。Host 对越权、资源超限和破坏性操作实施必要约束，保护原始材料与历史成果；校验失败应尽可能将具体问题反馈给 Agent 自主修正，而不是在 Host 中另造分析流程。所有新增设计均应检查：是否属于环境与治理职责、是否侵入 Agent 自主执行、是否重复已有能力；不满足上述原则的设计，应先简化或调整。

执行者分工：Qoder 为单执行者（Host、pi-coding-agent 接入、skills 与全部领域件），独立复核 Agent 检查固定候选且不得是作者；开发与试用均在 MacBook 本机（阶段 1 同机拓扑，Mac mini 不参与）；用户负责方向、边界与验收。引入新执行者须用户确认并更新本入口与规范。

每次执行以已授权范围和实际证据为准；历史参考资料不覆盖本项目最新确认，也不授予旧任务权限。治理谱系：JuanerAI → OptraCall 工程规范 v0.9 → 本项目工程规范 v0.1。
