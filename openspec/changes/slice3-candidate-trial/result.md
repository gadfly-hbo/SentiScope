# slice3-candidate-trial 结果记录

状态：本地受控实施完成，待独立复核与用户试用验收。分支基线 `main@9927586`。

## 实施记录（2026-11-01）

- **阈值配置版本化（TRI-01/02/03）**：`src/core/benchmarks.ts` 增加数据目录 `benchmarks.json` 加载（缺失回落代码默认并在界面标注；JSON 非法、未知/重复基准 id、非正数阈值、非法 version 均 fail-closed 拒绝启动）；`applyBenchmarkConfig` 以"默认＋覆盖"方式生效，覆盖生成 `${id}@v${version}` 新 thresholdVersion；每次加载把覆盖项登记到 `benchmark_versions` 表（同版本重复登记不刷写）；历史候选的 thresholdVersion 与比较结果不受新配置改写。Host 无任何运行期写配置接口，Agent 工具集不含配置写入口。
- **多数据集运行（TRI-04）**：`POST /api/runs` 接受 `datasetId`（默认最新导入），找不到返回 404 `dataset_not_found`；运行、观察、候选、搜索事件绑定所选数据集。
- **排除原因标签（TRI-05）**：`ReviewRecord` 新增 `reason`；排除必须单选四类之一（口径不符/证据不足/重复/其他），缺省拒绝 `exclusion_reason_required`、非法值拒绝 `invalid_exclusion_reason`；旧库 `reviews` 表自动迁移补 `reason` 列；复核历史只追加。
- **统计（TRI-06）**：`GET /api/trial-stats` 返回候选状态计数、命中率（保留÷已裁定）、按比较类型分布、排除原因分布、逐运行行（数据集名、模型、候选数、搜索/抓取/读取、usage）与配置状态＋变更记录；数值均由既有候选/运行数据聚合，可回溯到具体候选。
- **成本观察（TRI-07）**：`src/host/session-usage.ts` 只读解析 Pi 会话 JSONL（SDK 自身持久化），汇总 modelCalls、input/output/cacheRead/totalTokens 与会话记录费用（无费用字段时如实为 null，不估算）；运行结束后写入 `run.usage`。不订阅、不复制、不折叠 Agent 遥测（延续 B-08）。
- **试用报告（TRI-08/09）**：`GET /api/trial-report` 生成 Markdown：命中与排除、逐运行成本表、阈值配置（当前 vs 默认）＋变更记录、最近 5 个候选抽查清单；报告只陈述统计与建议，不修改配置、不外发、不含用户原始数据行。
- **UI（UI-09/10/11）**：侧栏新增"试用台账"（统计卡、排除原因分布、运行历史表＋数据集筛选、配置状态卡、报告下载）；探索视图新增运行数据集选择；候选看板新增数据集筛选；候选抽屉排除前必选原因标签，未选被拦截并提示；复核后台账即时刷新。

## 独立复核（非作者，2026-11-01）

- 第一轮 **REJECT**：中-1 报告抽查无回链与失败清单；中-2 统计缺数据集/比较类型维度且历史不显示排除原因；中-3 同版本不同阈值冲突被静默吞掉；低-1 缺启动日志、低-2 类型宽容强转、低-3 会话目录路径耦合、低-4 用量读取无兜底、低-5 版本不变性缺显式测试。边界确认：无配置写入口、只读成本不复制遥测、报告不外发。
- 修复：报告抽查逐条列证据 `kind:locator` 并经 `verifyEvidenceLink`（抽为 `src/host/trial.ts` 纯函数）校验计算事件/资产/定位，失败单列「回链失败」章节；trialStats 增加 byType/byDataset 三状态拆分，历史行显示（原因）；同 (id,version) 不同阈值启动即抛 `benchmark_version_conflict`；启动日志打印基准配置状态与"运行期不可修改"；threshold/version 严格 `typeof number`、条目非对象给字段级错误；用量读取 try/catch 兜底；补版本不变性、类型矩阵、回链失败分支用例。
- 第二轮 **PASS**：七项全部确认关闭，边界三项无回归；剩余一条非阻断建议（回链失败分支补自动化用例）已随之落地（`tests/mvp-trial.test.ts` TRI-09 用例）。

## 检查与验证（更新）

- `npm run check`：70/70 通过（新增 `tests/mvp-trial.test.ts` 10 项与宿主级 1 项：配置矩阵与类型严格性、版本登记/冲突/幂等/重置、历史候选版本不变性、排除原因门禁、旧库迁移、会话用量解析含坏行/缺会话/无费用、回链校验失败分支、阈值覆盖生效、404 数据集、统计分组与报告内容）。
- 浏览器验证（临时数据目录 + benchmarks.json 覆盖）：试用台账渲染与筛选正确；未选原因点排除被拦截、选择后保存并统计即时更新（口径不符 ×1，命中率 0%）；指定数据集零候选运行绑定所选数据集；报告内容含免责声明与原因统计；无控制台错误。
- 未做：真实模型下的成本读取（受控运行无会话文件时 usage 为 null 并如实显示"不可得"，真实路径沿用切片二授权，试用期自然累积）。

## 边界自查（工程规范 §4）

- 阈值/来源配置是用户批准的环境配置，Host 只读取与登记版本，不提供运行期修改，Agent 无写入口（TRI-03）。
- 成本读取只读 SDK 会话持久化文件，未新增遥测流、事件上限或折叠。
- 统计与报告为 Host 环境数据聚合，不进入 Agent 上下文，不导演分析。

## Git

- 2026-11-01 分支 `work/qoder/slice3-candidate-trial` 提交 `7d8357d`；分支 CI run `41290960615` success；PR #3 squash 合并 main（提交 `adf793b`），main CI run `41291096377` success。本地已切回 main。
