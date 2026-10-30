# slice1-observation-core 结果记录

状态：实施中（规格与 UI Demo 已于 2026-10-30 获用户确认；实施分支 work/qoder/slice1-observation-core）。

已发生的事实记录：

- 2026-10-30　规格草案与 UI Demo（clickable/index.html，全合成数据）建立。
- 2026-10-30　UI Demo 结构与交互经浏览器脚本验证：4 统计卡、8 运行行、7 证据行、四态 chips 齐备；OBS-02 行点击抽屉（6 校验链项、4 事实项）、Esc 关闭、导航切换与投递占位正常。视觉外观未截图验证（浏览器视口不可见）。
- 2026-10-30　用户确认规格与 UI Demo；未决问题按建议落定（SQLite / loopback Web / loopback HTTP 合成源 / 真实模型调用保持未授权）。

## 实施记录

- 2026-10-30（Mac mini 本机，Node 24.21.0）实施完成首个候选（分支 work/qoder/slice1-observation-core）：
  - 依赖锁定：`@earendil-works/pi-coding-agent@1.4.0`、`typebox@1.3.27`（与 OptraCall 同款）；TS 原生类型剥离运行，`engines >=24`，CI 用 Node 25.9.0。
  - `src/core/`：types（对象模型）、config（声明式配置加载与逐字段拒绝）、pipeline（口径校验管道：可比性链→方向与零分母/目标为零→差额→触发，四态输出）、evidence（内容寻址快照：SHA-256、双时间戳、tmp+rename 原子写、同字节幂等引用）、observation-store（node:sqlite，append-only，稳定观察身份索引）、identity 并入 pipeline。
  - `src/source/`：synthetic-server（loopback 合成 BI 源，时间锚点 @fresh/@stale，slow 挂起端点）、adapter（只读适配器，超时/HTTP/解析失败为一等错误）。
  - `src/host/`：observe（一轮观察编排）、server（loopback 宿主：管理界面 + JSON API，写操作需专用头或本机 Origin）、session-probe（headless 会话探针：skill 发现注入、自定义工具注册、只读工具集、事件订阅、正常结束；不调用模型）。
  - `skills/caliber-validation/SKILL.md`（官方 SKILL.md 规范，被探针发现并注入会话）。
  - `src/ui/index.html`（按已确认 Demo 实现的只读管理界面，数据来自 API）、`scripts/start.mjs` + `启动 SentiScope.command`（双击启动，非常驻）、`.github/workflows/check.yml`（单任务 CI：npm ci → check → 高危审计）。
  - 配置与合成数据：`config/sources.json`（1 来源，readOnly 硬校验）、`config/rules.json`（9 规则）、`fixtures/dash-east-ops/`（8 样例 + slow）。

## 检查与验证

- `npm run check`（typecheck + node --test）：30/30 通过，0 失败（2026-10-30 本机，实际命令与退出码 0）。
- 覆盖：OBS-01～07 逐样例（pipeline 单元 + observe-round 端到端 9 规则四态断言）、配置校验拒绝、证据哈希与幂等引用、观察存储 append-only 与跨 run 查询、适配器超时/404/解析失败、宿主 API 鉴权与 404、会话探针。
- 可重复验证：同输入重复运行观察身份稳定、快照文件数不增长（幂等引用）；e2e 用固定时间锚点保证确定性。
- 实施中发现并修复：观察存储 append 误用首行 runId（测试检出）、latestObservations 同时间戳排序不可辨（改 rowid）、.mjs 中 TS 非空断言语法错误（启动时检出）、`tools` 白名单过滤自定义工具（探针检出，工具名入白名单修复）、fixture 冻结时间与真实时钟冲突（时间锚点机制）。
- 真实路径验证（2026-10-30 本机）：`npm start` 启动成功——会话探针通过（skills=caliber-validation，活动工具含 sentiscope_probe）；`/health` 200；POST /api/observe 返回 9 条观察四态 {ok:2, gap:2, insufficient:4, failed:1}；浏览器打开 http://127.0.0.1:4180 验证金路径：四态统计卡、9 行运行记录、抽屉（7 项校验链 + 证据 SHA）、会话探针面板、8 行证据、9 张规则卡、投递占位均正常。视觉外观未截图（浏览器视口不可用），结构与交互经 DOM 断言验证。
- 未验证：真实模型调用（未授权，探针不调用）；CI 尚未在远端运行（分支首次推送后由 GitHub Actions 触发，结果另行记录）。

## 独立复核

（待执行：完整候选收尾时固定候选并交独立复核 Agent，非作者）

## Git / CI

- 2026-10-30 分支 work/qoder/slice1-observation-core 提交并推送（见提交记录）；未合并 main，待独立复核与适用验收。
- CI 单任务已建立（.github/workflows/check.yml）；首次运行结果待记录。

## 用户验收

（待用户对固定候选的适用验收）
