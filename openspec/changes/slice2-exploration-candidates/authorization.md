# 切片二真实模型与真实搜索 Provider 授权记录

状态：**两项均未授权**。本文件只准备授权范围与核验方式；在你逐项确认之前，不执行真实模型调用、真实搜索或公网页面读取。两项授权分别记录，任何一项都不能由另一项、开发权限或 Git 权限推导。

## 预检（不出网）

```bash
SENTISCOPE_HOME=<数据目录> SENTISCOPE_MODEL=<provider:model-id> node scripts/authorization-check.mjs
```

预检只读本地配置：列出 Pi 可用模型并解析固定模型、检查 `search.json` 端点 https 与字段映射、密钥环境变量是否已设置（只看存在性）、配额与优先域、出口策略与工具预算。不读取密钥值，不发起任何网络请求。

## 一、真实模型授权（待你确认）

| 项目 | 需确认内容 | 当前默认／建议 |
| --- | --- | --- |
| 固定模型 | `SENTISCOPE_MODEL=provider:model-id` | 不固定则使用 Pi 默认模型；验收建议固定（EVAL-2026-001 曾用 `openai-codex:gpt-6.1-sol`） |
| 工具预算 | `SENTISCOPE_MAX_TOOL_CALLS` | 40；搜索链＋四类比较＋候选一轮约 26 次 |
| 允许进入模型的数据字段 | 行投影白名单 | `closed`／`comparable`／`label`；其余维度不进入模型 |
| 禁止外发值 | `SENTISCOPE_EGRESS_BLOCK`（每行一个） | 内部秘密、客户名、未公开收入等；命中即在 provider 请求、搜索词、URL 前阻断并留事件 |
| 验收数据范围 | 合成 fixture 或明确授权的导入数据 | 默认只用 `fixtures/mvp` 合成数据；导入真实数据须单独确认 |
| 运行与预算边界 | 运行次数、取消、墙钟 | 每次运行可取消；验收轮次与时长由你设定 |

确认方式：在本节下方追加“已确认”记录（日期、模型、预算、字段、数据范围），或直接回复确认以上默认值。确认后才执行真实模型运行，并保留 sessionId、实际 provider/model、`sdk:*` 事件与工具事件作为证据。

## 二、真实搜索 Provider 授权（待你确认）

| 项目 | 需确认内容 | 当前默认／建议 |
| --- | --- | --- |
| Provider 配置 | `<数据目录>/search.json`（模板 `config/search.example.json`） | 仅 `type:"http"` 通用适配器；endpoint 必须 https |
| 字段映射 | queryField、hitsPath、urlField、titleField、snippetField | 按 Provider 实际响应填写 |
| 密钥存放 | `apiKeyEnv`＋`apiKeyHeader` | 密钥只经环境变量读取，不写入仓库、search.json 或日志 |
| 配额 | `budget.maxSearches`／`maxFetches`／`maxSnapshotReads` | 8／6／20；耗尽以错误值提示收束，不隐藏重试 |
| 偏好来源 | `preferredDomains` | 一手统计机构、竞对官方披露域名；C 级来源按二手记录 |
| 检索业务范围 | 允许检索的指标、实体、期间 | 搜索词不得包含内部数据；出口扫描命中即阻断 |

确认方式：同上，在本节记录确认内容后，才执行真实搜索与快照读取；验收保留搜索事件（query、Provider、callKey、attempts、命中与等级）、快照、快照读取与配额事件。本地合成 Provider／fixture 通过不等于真实公网通过。

## 执行顺序建议

1. 先只授权真实模型、不配置 `search.json`：验证真实 Agent 在导入数据上的自主选择、纠错与候选质量。
2. 再单独授权真实搜索 Provider：在同一固定模型下验证检索、快照、可比性与配额收束。
3. 两项分别记录结果；任何 FAIL、中止或未运行用例都如实保留，不写成通过。

## 已执行记录（2026-11-01，用户三项指示）

- 用户指示：真实模型与 OptraCall 当前选中模型一致（本地查明为 `minimax-cn/MiniMax-M3.1-Flash`）；搜索 Provider 与模型共用，采用其自带搜索能力（实测为 MiniMax Coding Plan 搜索 API）；两项授权同时进行。
- 实际执行：隔离工作区 `~/.sentiscope/real-acceptance`，合成 fixture 数据，配额 6/4/12，工具预算 40→60，优先域 census.gov/sec.gov/stats.gov；密钥只经 `MINIMAX_API_KEY` 环境变量注入。共 5 轮真实运行（R1～R5），过程失败与修复全部保留在 [result.md](result.md) 的“真实模型＋真实搜索同步验收”一节。
- 结果：R5 产出 3 个真实候选（target×2、history×1），行业／竞对因口径不一致未产候选；真实搜索与快照链路验证通过，Host 不再复制 SDK 遥测。切片二整体验收仍未签发通过；候选待人工复核。
