# SentiScope 工程入口

开始任务、修改规范或准备交付时，先读 [工程规范](docs/engineering-workflow.md)；涉及产品方向与首期范围时，再读 [自主探索 Agent 产品讨论稿 v0.1](OptraCall_自主探索Agent_产品讨论稿_v0.1.md)；涉及 pi-coding-agent 能力复用、自建清单或部署拓扑时，读 [技术盘点 v0.1](SentiScope_技术盘点_pi-coding-agent与部署拓扑_v0.1.md)。工程规范是开发流程的唯一详细来源。

上一变更 [slice1-observation-core](openspec/changes/slice1-observation-core/spec.md)（切片一"证明读得准"）已完成：用户验收通过，2026-10-30 squash 合并 main（提交 987ef9c，PR #1），规格与[结果记录](openspec/changes/slice1-observation-core/result.md)保留。下一变更候选为切片二 slice2-delivery（持久待投递队列＋Case 接入＋离线补投＋投递状态 UI），启动前按整体产品方案 §7 核对 OptraCall 侧 case-auto-source 契约扩展的前置关系。未获用户显式授权前不连接真实业务系统；真实模型调用保持未授权。

已确认的工程边界（详见工程规范 §1）：

- skill 宿主与 OptraCall 使用同一个 pi-coding-agent，使用其官方全部能力；Host 不重复造轮子，只建 pi-coding-agent 没有的领域件。
- Host 只管环境（上下文、权限、工具边界、预算），Agent 自主运行；Host 不控制 Agent 内部的执行步骤与决策。
- 与 OptraCall 的耦合收敛为一条 Case 投递契约；对 OptraCall 的任何修改走其 openspec 变更流程。
- 部署两阶段：阶段 1 同机（MacBook）、非常驻可开关；阶段 2 跨机、SentiScope 常驻。阶段 1 验证全部核心机制。

执行者分工：Qoder 为单执行者（Host、pi-coding-agent 接入、skills 与全部领域件），独立复核 Agent 检查固定候选且不得是作者；开发与试用均在 MacBook 本机（阶段 1 同机拓扑，Mac mini 不参与）；用户负责方向、边界与验收。引入新执行者须用户确认并更新本入口与规范。

每次执行以已授权范围和实际证据为准；历史参考资料不覆盖本项目最新确认，也不授予旧任务权限。治理谱系：JuanerAI → OptraCall 工程规范 v0.9 → 本项目工程规范 v0.1。
