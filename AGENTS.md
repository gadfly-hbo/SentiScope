# SentiScope 工程入口

开始任务、修改规范或准备交付时，先读 [工程规范](docs/engineering-workflow.md)；涉及产品方向与首期范围时，再读 [自主探索 Agent 产品讨论稿 v0.1](OptraCall_自主探索Agent_产品讨论稿_v0.1.md)；涉及 pi-coding-agent 能力复用、自建清单或部署拓扑时，读 [技术盘点 v0.1](SentiScope_技术盘点_pi-coding-agent与部署拓扑_v0.1.md)。工程规范是开发流程的唯一详细来源。

当前无已启动的 openspec 变更：仓库处于工程初始化阶段（规范与结构已建立，尚无可运行代码）。首个变更候选为讨论稿 §7 切片一"证明读得准"，启动时在工程规范 §1 登记规格与授权。未获用户显式授权前不连接真实业务系统。

已确认的工程边界（详见工程规范 §1）：

- skill 宿主与 OptraCall 使用同一个 pi-coding-agent，使用其官方全部能力；Host 不重复造轮子，只建 pi-coding-agent 没有的领域件。
- Host 只管环境（上下文、权限、工具边界、预算），Agent 自主运行；Host 不控制 Agent 内部的执行步骤与决策。
- 与 OptraCall 的耦合收敛为一条 Case 投递契约；对 OptraCall 的任何修改走其 openspec 变更流程。
- 部署两阶段：阶段 1 同机（MacBook）、非常驻可开关；阶段 2 跨机、SentiScope 常驻。阶段 1 验证全部核心机制。

执行者分工：Qoder 为单执行者（Host、pi-coding-agent 接入、skills 与全部领域件），独立复核 Agent 检查固定候选且不得是作者；Mac mini 开发，MacBook 用户试用与阶段 1 联动测试（不开发、不回推）；用户负责方向、边界与验收。引入新执行者须用户确认并更新本入口与规范。

每次执行以已授权范围和实际证据为准；历史参考资料不覆盖本项目最新确认，也不授予旧任务权限。治理谱系：JuanerAI → OptraCall 工程规范 v0.9 → 本项目工程规范 v0.1。
