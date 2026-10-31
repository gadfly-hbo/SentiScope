# SentiScope

Watch with evidence. ／ 以证据守望，把发现变成决策。

SentiScope 是运行在用户本机的自主数据分析 Agent：接收用户导入的数据，从获授权的公开网页获取竞对与行业对比资料，保留原始证据并完成可重放清洗，再由真实 Agent 通过目标、历史、竞对和行业差距进行描述性探索，输出有证据的 **Case 候选**。MVP 不自动创建 Case 或 Project，不做预测、根因断言或经营动作。

## 当前状态

切片一 `slice1-observation-core` 已完成并通过用户验收，作为工程基座保留。切片二 `slice2-exploration-candidates` 已在分支 `work/qoder/slice2-exploration-candidates` 完成本地受控实施：

- CSV／XLSX 导入、原始证据、画像与可重放清洗。
- Host 批准的目标／历史／竞对／行业描述性比较。
- 真实 pi-coding-agent SDK 运行路径、8 个领域工具与出口边界。
- 反证与搜索覆盖强校验的 Case 候选门禁、人工复核和 OptraCall 风格 UI。
- 本地 `npm run check` 39/39 通过，依赖审计 0 漏洞，非作者独立复核通过。

真实模型质量、真实公网抓取与 held-out 验收尚未运行，须分别授权；候选尚未提交 Git 或创建 PR。详见 [整体产品方案 v0.2](docs/SentiScope_整体产品方案_v0.2.md)、[切片二规格](openspec/changes/slice2-exploration-candidates/spec.md) 与[结果记录](openspec/changes/slice2-exploration-candidates/result.md)。

## 文档

- [整体产品方案 v0.2](docs/SentiScope_整体产品方案_v0.2.md)——MVP、问题定义、对象模型、现有实现增删与切片路线
- [工程规范 v0.1](docs/engineering-workflow.md)——开发流程统一来源
- [产品讨论稿 v0.1](OptraCall_自主探索Agent_产品讨论稿_v0.1.md)——产品方向历史输入
- [技术盘点 v0.1](SentiScope_技术盘点_pi-coding-agent与部署拓扑_v0.1.md)——pi-coding-agent 与部署历史盘点

## 目录

```
AGENTS.md        工程入口（执行者先读）
docs/            产品方案与工程规范
openspec/changes/ 各项变更的规格、结果与 UI Demo
src/             宿主与领域件
skills/          Agent 技能包
tests/           测试
```

## 开发

开始任务前读 [AGENTS.md](AGENTS.md) 与 [工程规范](docs/engineering-workflow.md)。开发与试用均在 MacBook 本机，当前为非常驻、可开关形态。本仓库公开：凭据、用户导入文件、真实经营数据、原始会话与运行日志不得提交；公开样例使用合成材料。
