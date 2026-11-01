# SentiScope

Watch with evidence. ／ 以证据守望，把发现变成决策。

SentiScope 是运行在用户本机的自主数据分析 Agent：接收用户导入的数据，保留原始证据并完成可重放清洗；缺少竞对或行业基准时，由真实 Agent 在 Host 受控工具内执行 `web_search` → `fetch_page` → `read_snapshot` 的 deepresearch 式公网补证，再通过目标、历史、竞对和行业差距进行描述性探索，输出有证据的 **Case 候选**。MVP 不做爬虫、不自动创建 Case 或 Project、不做预测、根因断言或经营动作。

## 当前状态

切片一 `slice1-observation-core` 已完成并通过用户验收，作为工程基座保留。切片二 `slice2-exploration-candidates` 的前一个候选已在分支 `work/qoder/slice2-exploration-candidates` 完成：

- CSV／XLSX 导入、原始证据、画像与可重放清洗。
- Host 批准的目标／历史／竞对／行业描述性比较。
- 真实 pi-coding-agent SDK 运行路径、领域工具与出口边界。
- 反证与搜索覆盖强校验的 Case 候选门禁、人工复核和 OptraCall 风格 UI。
- 本地 `npm run check` 54/54 通过，依赖审计 0 漏洞。

但 EVAL-2026-001 真实验收已中止：10 个真实模型 trial＋1 个边界元用例执行层均为 FAIL，公网／预算／UI 用例 NOT_RUN。2026-11-01 起公网获取范围修订为 deepresearch 模式搜索（暂不做爬虫），旧单 URL 抓取与 `/api/public-sources` 已退出，搜索工具链、快照证据与配额控制已在本地受控实施；真实模型与真实搜索 Provider 的验收仍待用户分别授权，不能宣称切片二验收通过。详见 [整体产品方案 v0.3](docs/SentiScope_整体产品方案_v0.3.md)、[切片二规格](openspec/changes/slice2-exploration-candidates/spec.md)、[结果记录](openspec/changes/slice2-exploration-candidates/result.md) 与[验收中止记录](projects/EVAL-2026-001-sentiscope-slice2/closeout.md)。

## 文档

- [整体产品方案 v0.3](docs/SentiScope_整体产品方案_v0.3.md)——MVP、deepresearch 公网检索、问题定义、对象模型、现有实现增删与切片路线
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

本机试用：`npm start`（默认数据目录 `~/.sentiscope/mvp`，合成受控演示，不调用模型与公网）。真实模型与真实搜索 Provider 需分别授权：先读 [授权记录](openspec/changes/slice2-exploration-candidates/authorization.md)，再用 `node scripts/authorization-check.mjs` 做不出网预检（模型可经 `SENTISCOPE_MODEL=provider:model-id` 固定，Provider 配置模板见 `config/search.example.json`）。常用环境变量：`SENTISCOPE_HOME`（数据目录）、`SENTISCOPE_HOST_PORT`、`SENTISCOPE_REAL_MODEL=1`（真实模型，需已保存 Pi 配置与单独授权）、`SENTISCOPE_MAX_TOOL_CALLS`（工具预算上限，默认 40）、`SENTISCOPE_EGRESS_BLOCK`（禁止外发的内部值，每行一个）、`SENTISCOPE_NO_OPEN=1`。公网检索 Provider 在数据目录的 `search.json` 配置（仅 `type:"http"` 的通用适配器：endpoint、queryField、hitsPath、url/title/snippet 字段、`apiKeyEnv`＋`apiKeyHeader`、`preferredDomains`、`budget`）；密钥只经环境变量读取，未配置时探索只使用导入数据。
