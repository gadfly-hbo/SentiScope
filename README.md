# SentiScope

Watch with evidence. ／ 以证据守望，把发现变成决策。

SentiScope 是独立于 OptraCall 桌面端运行的**自主探索 Agent**：在授权范围内连接企业业务系统（首期为单个 BI 驾驶舱与少量约定指标），持续观察经营数据，按约定口径校验可信度，把**有证据的发现**自动转成 OptraCall Case 推入现有看板。它只负责发现，不负责决策——不建 Project、不做根因分析、不建第二套看板。

## 当前状态

工程初始化阶段，尚无可运行代码。已建立：

- [产品讨论稿 v0.1](OptraCall_自主探索Agent_产品讨论稿_v0.1.md)——产品定位、首期最小方案、三切片与九个合成样例验收
- [技术盘点 v0.1](SentiScope_技术盘点_pi-coding-agent与部署拓扑_v0.1.md)——pi-coding-agent 官方能力表面、已有/需自建清单、两阶段部署拓扑
- [工程规范 v0.1](docs/engineering-workflow.md)——开发流程的统一来源（openspec 变更、SDD/TDD、独立复核、Git/CI 节奏）

## 目录

```
AGENTS.md        工程入口（执行者先读）
docs/            工程规范与设计文档
openspec/changes/ 每项变更的规格(spec.md)与结果(result.md)，首次实际变更时创建
src/             宿主与领域件（调度、观察存储、队列、投递）
skills/          Agent 技能包（采集、清洗、校验等，复用 pi-coding-agent 官方机制）
tests/           测试
```

## 开发

开始任务前读 [AGENTS.md](AGENTS.md) 与 [工程规范](docs/engineering-workflow.md)。开发与试用均在 MacBook 本机；阶段 1 与 OptraCall 同机联动，两者都非常驻、可开启关闭。

本仓库公开：不含凭据与真实经营数据，样例使用合成材料。
