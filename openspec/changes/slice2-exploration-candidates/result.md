# slice2-exploration-candidates 结果记录

状态：ACCEPTANCE_ABORTED（本机受控实施完成；真实模型执行出现 FAIL，公网／预算／UI 用例 NOT_RUN，用户决定中止，未签发验收通过或完成结论）。分支 `work/qoder/slice2-exploration-candidates`，基线 `main@cb3103e`；已提交并推送，未创建 PR。

## 实施记录

- 2026-10-30　完成新 MVP 本地垂直链路：
  - 导入：CSV／XLSX 原始字节内容寻址保存；CSV 严格 UTF-8／引号／列数校验；XLSX 手工解析 ZIP 中央目录，限制条目数、总解压大小与压缩比，拒绝 Zip64、加密、宏／外部链接、XML ENTITY 与外部 relationship，data descriptor 场景不绕过扫描；公式不执行，缓存值降级待补证。
  - 清洗：字段映射、日期／单位／实体别名、重复隔离与质量门禁形成可重放步骤；每步保存版本、参数、输入输出哈希与稳定 rowId 血缘；原始资产与旧数据版本不可改写。
  - 公网：Host 白名单、HTTP(S)／默认端口／无凭据／无查询约束，逐跳 DNS 解析校验并固定连接 IP；IPv4、IPv4-mapped／compatible、NAT64、ULA、组播、文档与保留地址拒绝；robots 每个目标主机检查，支持通配、行内注释、SentiScope 专属组、非 200 fail-closed；公网工具默认禁用。
  - 描述性比较：目标／历史／竞对／行业四类由 Host 批准的基准定义决定方向、阈值、指标与实体；历史必须去年同期，竞对／行业必须由双方当前期与同期原始值重新计算增速，不用模型提供的增速；单位、范围、币种、地域、期间闭环、来源等级与发布滞后全部显式校验，未知即待补证。
  - Agent：真实 pi-coding-agent `session.prompt()` 路径接入；模型只能使用 8 个 `sentiscope_*` 工具（画像、查询、清洗、公网补证、比较、候选、观察、覆盖）。Host 校验参数与结果；标准行只投影批准字段；provider 请求返回脱敏载荷；SDK 事件先脱敏再持久化；会话 ID 与实际模型 ID 在成功和失败路径均记录。
  - 候选门禁：必须先保存搜索覆盖；候选引用已执行比较；反证必须是同 run、同 comparisonId、带真实原始／标准证据的持久观察，计算引用不能替代反证；候选证据 SHA 与 locator 必须存在于候选创建时数据版本；根因／预测标题与缺失未知项拒绝；实质变化形成修订并保留历史，措辞或覆盖文本变化不刷板。
  - 运行与宿主：SQLite 持久 assets／datasets／runs／observations／candidates／reviews；每个工具调用即时保存事件与预算；预取消不执行、运行中可取消、预算耗尽失败、宿主重启将遗留 running 标记 interrupted_by_restart；loopback 写保护，异步运行 API。
  - UI：正式 OptraCall 风格外壳、候选看板、宽详情抽屉、探索事件、数据集清洗预览、来源面板与证据下载；所有动态值转义；计算证据定位持久 comparisonId，网页证据从原始字节提取指定表格行，原始／标准证据定位到候选创建时数据版本。
- 退出旧 BI 轮询实现：`src/core/{config,evidence,observation-store,pipeline,types}.ts`、`src/source/{adapter,synthetic-server}.ts`、`src/host/observe.ts`、旧 BI 配置／fixture 与对应测试删除；切片一 openspec 历史与本机 `~/.sentiscope` 数据保留，新 MVP 使用独立 `~/.sentiscope/mvp`。
- 依赖：新增 `exceljs` 与 `node-html-parser`；`uuid` 覆盖到 11.1.1，`npm audit` 0 漏洞。

## 检查与验证

- `npm run check`：2026-10-30 通过，typecheck + 39/39 测试，0 失败；覆盖 IMP／WEB／CLN／CMP／CAND／AGT／SEC／E2E、取消、预算、重启、XLSX data descriptor、robots 通配／注释、IPv6 映射／NAT64、候选修订与血缘哈希。
- `npm audit --audit-level=high`：0 漏洞。
- 真实本机路径（受控模型，不调用真实模型、不访问真实公网）：`npm start` 启动成功；`/health` 200；默认工作区生成 1 个标准数据集、1 个来源文件、2 个合成网页快照和 4 个候选，覆盖目标／历史／竞对／行业；近失目标差距为观察，线上订单为待补证；公网 API 默认返回 `public_web_disabled`；会话探针通过且不调用模型。
- 浏览器验证（2026-10-30，最终代码）：候选看板 4 候选与导航计数正确；目标候选详情可查看事实、计算、反证；计算证据跳转并高亮 `comparisonId` 对应观察，显示公式；探索事件保留工具调用、观察、候选提交与停止原因；此前同日还验证了真实 CSV 上传生成 v2 标准数据集、零候选运行、人工复核持久化、原始／标准证据下钻、桌面／390px 与明暗主题。
- 未验证：真实模型质量（E2E-01、AGT-01～07 的真实 SDK 事件与 held-out 变体）、真实公网域名抓取、CI、Git 交付与用户产品验收。受控模型测试只证明编排与门禁，不证明自主发现质量。

## 独立复核

- 2026-10-30 第一轮独立复核 REJECT：发现 provider egress fail-open、Agent 自选阈值／方向、反证仅为文字、默认数据血缘哈希不一致、候选指纹受措辞影响、IPv4-mapped SSRF、robots／redirect 绕过、XLSX data descriptor 绕过、公网映射口径可伪造、取消／重启状态错误、SDK 事件与工具缺失、证据下钻错数据等。全部修复并补对抗性测试。
- 第二轮独立复核 REJECT：发现反证证据可伪造、模型工具返回完整 rawRows、SDK 事件未脱敏、robots 专属组／通配优先级、未知口径 fail-open、公网映射仍由 Agent 断言、内嵌 IPv6 绕过、计算证据下钻不稳、失败会话身份丢失。全部修复并补测试。
- 第三轮聚焦复核 REJECT：发现展开格式 IPv6、robots 组泄漏、计算引用作为反证、历史前期维度不一致、provider hook 返回值误判、计算下钻按标题搜索。全部修复。
- 一次复核请求因模型服务错误未返回，已重试；最终独立复核 **PASS**：复跑 `npm run check`（39/39）、`npm audit` 0 漏洞，并独立 smoke 真实入口（受控模式）、证据文本 API、公网禁用与会话探针。复核结论：此前阻断项全部关闭；真实模型／真实公网／held-out／正式浏览器全量走查属授权后验收，非实现阻断。
- 非阻断观察已记录：CSV 内部空行会使逻辑行定位与物理行偏移、WEB-05 可补专门用例、异常 ZIP 可能以 500 而非 400 呈现但 fail-closed。

## 真实验收执行与中止（EVAL-2026-001）

- 2026-10-31 用户授权真实验收，PLAN-GATE 批准 `plans/v001` 后冻结 45 文件并执行；实际模型 `openai-codex:gpt-6.1-sol`，各 trial 均有真实 sessionId／SDK 事件，非 ControlledRuntime。
- 实际完成 10 个真实模型 trial＋1 个边界元用例评分，执行层结果均为 FAIL；SS2-06 预算、SS2-08 公网、SS2-14 UI 为 NOT_RUN。主要失败为候选与覆盖不足、自主纠错链缺失、取消／重启状态断言及 held-out 数值断言失败，详见 `projects/EVAL-2026-001-sentiscope-slice2/runs/run-001/execution-return.md`。
- 真实公网未调用；用户指示跳过后，没有将该用例标为 PASS。用量汇总 456,348 tokens（含 cacheRead），`cost_total=0.3373904` 且 `currency=UNKNOWN`。
- 墙钟达到 9.0h 超过原定 8.0h，用户选择“不再继续”，未追加审核时间；流程 `aborted`，无独立 REVIEW／CONVERGE／最终套件判定，不签发验收通过或完成结论。中止记录见 `projects/EVAL-2026-001-sentiscope-slice2/closeout.md`。

## 2026-11-01 公网获取范围修订

- 用户决定切片二公网获取改为 **deepresearch 模式公网搜索**：Agent 自主调用 `web_search`，从命中中选择少量 URL `fetch_page`，用 `read_snapshot` 分页核对原文；暂不做爬虫、站点遍历或链接批量抓取。
- 仅参考 `/Users/huangbo/Dev/Projects/deep-research` 的检索架构与安全边界，不复制产品、代码、Provider 凭据或报告流程。
- 上位方案升级为 [整体产品方案 v0.3](../../docs/SentiScope_整体产品方案_v0.3.md)；本规格改为受控搜索工具链目标。此前候选 `51e3125` 的单 URL 抓取实现与真实验收 FAIL 历史保留，不得在该候选上直接宣称符合新范围。
- 后续实施须退出当前 `public-web` 单 URL API 与 `sentiscope_public_fetch`，重构 Provider 链与三工具；EVAL-2026-001 的失败记录与本节范围修订均不可删除。

## 2026-11-01 deepresearch 搜索模式本地受控实施

- 新增 `src/source/web-research.ts`：通用 HTTP Search Provider 适配器（仅 https 端点、10s 超时、响应体上限、密钥只经环境变量）、Provider 链瞬时错误切换并记录 attempts、`WebResearchService` 的 `search`／`fetch_page`／`read_snapshot`／`record_web_fact`、搜索／抓取／快照读取配额以错误值返回并提示收束、来源分级（优先域＞gov/edu＞org/int＞其他）、快照不可变与逐字引用校验、搜索词与 URL 的出口阻断。
- 退出旧单 URL 爬虫：删除 `fetchPublicSnapshot`／`publicTableToRawRows`／`PublicTableMapping`、`/api/public-sources` 与映射解析、`sentiscope_public_fetch`、`SENTISCOPE_PUBLIC_WEB`／`SENTISCOPE_PUBLIC_HOSTS` 与 UI 的 URL prompt 链；`public-web.ts` 仅保留 SSRF／robots／传输原语供检索服务复用。
- Host 校验失败以错误值回到 Agent（`researchCall`），并写 `research_error` 运行事件；配额耗尽、Provider 未配置、SSRF／robots／大小／内容类型／引用校验失败均不再把整轮运行写成失败或成功伪造。
- 外部数字资格由 Host 交叉核验：声明 `publishedAt` 与快照解析的 `<time datetime>` 冲突即拒绝；C 级来源一律按二手来源记录并打 `tier_c_source`；候选的外部基准若只来自 1 个搜索快照，由 Host 写入结构化 `singleSourceLimitation` 并在 UI 展示（WEB-06 单源限制分支）。
- 演示与验收替身：`demo.ts` 提供本地 fixture Provider／传输（不出网），qualified 演示真实走通搜索→快照→外部数字→四类比较→候选；新增 zero 与 limited（配额耗尽、PDF 被拒、待补证保留）两种演示模式；`maxToolCalls` 成为 Host 选项（默认 25，本机试用 40）。
- UI：来源视图新增搜索事件、命中与放弃 URL、快照卡片与配额边界；探索视图新增搜索配额横幅与搜索轨迹；候选详情展示 Host 标注的单源限制；证据下钻改为快照原文窗口（`/api/snapshots/:id/text`），删除表格行定位的爬虫式下钻。
- 验证：`npm run check` 54/54 通过（新增 WEB 搜索链、错误值化、单源限制、配额事件、fixture 演示等用例），`npm audit` 0 漏洞；浏览器在临时数据目录验证候选看板、探索搜索轨迹、来源搜索面、快照原文下钻、limited 与 zero 运行，无控制台错误；未调用真实模型与真实公网。
- 独立复核（非作者，2026-11-01）第一轮 **REJECT**：H-1 外部事实门禁采信模型自述 `publishedAt`／`sourceType` 而未与 Host 已解析快照信号交叉核验；H-2 WEB-06 单快照分支无降级或强制标注；另列 M-1 Provider 切换不留痕、M-2 HTTP Provider 无超时／scheme／大小限制、L-1～L-5。阻断与中等级项均已修复并补测试；第二轮聚焦复核 **PASS**（54/54 测试、typecheck 干净，确认无 Host 越权编排、无失败伪装成功、配额语义未破坏）。
- 复核残留（低，不阻断，记录为后续候选改进项）：N-3 搜索响应 1MB 上限为事后校验、无流式截断；N-4 被阻断／配额拒绝事件的 callKey 可与下一次真实调用重复（事件 id 仍唯一）。N-1（无 `<time>` 快照的发布时间不可核验）已以 `published_at_unverified` issue 标注，N-2（全链失败事件带 attempts）与 N-5（fetch/read 配额事件断言）已修复补测。
- 其他记录：L-4 为切片一规格文件仅链接更新（v0.2→v0.3 改名指针，未改写切片一验收结论）；L-5 为未跟踪的 `.qoder/repowiki` 生成卡片仍描述旧单 URL 链路（非交付物，待重新生成）。

## 2026-11-01 真实模型＋真实搜索同步验收（MiniMax，用户已授权）

- 授权范围：真实模型 `minimax-cn:MiniMax-M3.1-Flash`（与 OptraCall 当前选中一致，见 `~/.optracall/settings.json` 的 `selectedId=minimax-m31-flash`）；搜索 Provider 为 MiniMax Coding Plan 搜索 API（`POST https://api.minimaxi.com/v1/coding_plan/search`，`q`→`organic[{title,link,snippet,date}]`），与模型共用 Pi `auth.json` 中的 `minimax-cn` 凭据，运行时经 `MINIMAX_API_KEY` 环境变量注入、不落盘；数据为合成 fixture；隔离工作区 `~/.sentiscope/real-acceptance`；配额 搜索6／抓取4／读取12，优先域 census.gov/sec.gov/stats.gov。用户指示两项授权同时进行。
- 为支持该 Provider，通用 HTTP 适配器新增 POST 查询体与 Bearer 鉴权（`method`／`authScheme`），预检 `scripts/authorization-check.mjs` 全绿；真实搜索实测返回 10 条命中。

### 运行过程与修复（按轮次，失败均如实保留）

1. **R1**：真实模型 31 次比较全部使用自创 `definitionId`（`revenue.target_gap`、`yoy_change` 等），40 次工具预算耗尽、零候选。根因是 Host 从未提供已批准基准目录，属环境缺口。修复：prompt 与 `sentiscope_compare` 描述注入基准目录，`getBenchmarkDefinition` 拒绝信息带出可用 id。
2. **R2**：7 次有效比较、反证质量正常，但 4 次 `propose` 全部 `search_coverage_required`；`fetch_page` 全部失败。修复：coverage 拒绝信息给出期望 selectionContext 与已存条目、`sentiscope_coverage` 回读已存列表、prompt 写明“逐字一致”契约。传输根因两个：Node 24 以 `{all:true}` 调用自定义 `lookup`（单地址回调导致 `ERR_INVALID_IP_ADDRESS`）；`secureGet` 只用 DNS 首个地址，个别 IP/IPv6 不通即整体失败。修复：`defaultTransport` 兼容 `all:true` 数组回调、`secureGet` 逐地址回退（策略错误不重试），补回归测试。
3. **遥测写盘事故**：每条流式 `sdk:message_update` 被复制进 `run.events` 并全量重写 run JSON（R1 2838 条，库文件 56MB）。用户指出“只记里程碑／设上限／折叠”的修复方案仍是越位管 Agent 执行。最终按「Host 管环境」原则删除平行机制：Host 不再订阅或复制 SDK 遥测，`run.events` 只写 Host 环境事实，会话原文由 `SessionManager` 持久化（B-08；2000 条流式事件回归测试）。教训已写入长期记忆。
4. **R3**：真实搜索→快照→外部数字首次走通（国家统计局 2026Q3/2025Q3 GDP），但 `亿元` 不在清洗单位表，新登记行被 `unknown_unit` 隔离。补 `亿元→万元` 确定性换算与测试。
5. **R4**：模型已理解并遵守 coverage 逐字契约，但 40 次工具预算在提交阶段耗尽，3 个 qualified 比较未能 propose（会话原文明确记录此原因）。
6. **R5（预算 60）完成**：真实模型＋真实搜索端到端产出 **3 个通过门禁的真实候选**——华东 2026-09 收入低于目标 120 万元（−12%）、西南收入同比 −6.2%、华南平均等待时长超目标 +53.3%；每个候选都有原始行证据、计算引用、反证与未知项。行业／竞对比较因口径不一致为 `needs_evidence`，未产候选（全国 GDP、同庆楼与“同一细分市场”不可比，门禁正确拒绝）。本轮 6 次搜索、2 个真实快照、4 次快照读取、1 条外部事实登记；`model=minimax-cn:MiniMax-M3.1-Flash`、`sessionId=01a19580-2b2c-7372-8d46-dfbd5dd777b7`，库文件不再增长。

### 结论与边界

- 真实模型与真实搜索 Provider 链路已端到端验证，候选为真实 Agent 自主产出（非 ControlledRuntime）。**这不等于切片二验收通过**：AGT/E2E held-out、多次运行稳定性、真实导入数据、UI 全量走查、独立复核与 CI 均未做；候选尚待用户人工复核。
- 语义口径（例如全国 GDP 与细分市场是否可比）仍由 Agent 声明并由人工复核，Host 只校验声明与证据的一致性、来源等级与发布时间；R5 中不可比基准被正确留在待补证。
- 真实搜索为 Coding Plan 搜索 API，命中以新闻／转载为主（本批快照均为 C 级）；C 级来源按二手记录，不能作为一手基准通过门禁。

## 2026-11-01 held-out 与多次运行稳定性（用户授权）

- held-out：模型未见过的数值变体（12 行，实体 江东/江北/淮南/淮北/线上，oracle 人工独立计算，存于未跟踪的 `projects/heldout-2026-11-01/`）。真实模型＋真实搜索同配置运行，产出恰好 3 个候选——江东收入低于目标 −288 万元（−32%）、淮北收入同比 −70 万元（−9.21%）、江东等待时长 +12 秒（+30%）——与 oracle 逐项一致；近失项（江北 +1.63%、淮南 −2.5%）与不可比行（线上订单）均未进入候选。**PASS**。
- 稳定性：同数据集同配置连跑 3 轮，`candidateIds` 集合完全一致（同一组 3 个指纹，后续轮次按门禁去重、不刷板）；数值全部来自 Host 比较工具，无表外数字。**PASS**。
- 写盘核查：3 轮真实运行后库文件 816KB（此前遥测写放大已删除，未复现）。
- 用户裁定：真实导入数据不再单独测试，合成数据通过即视为真实通过；剩余收尾为 CI 与合并 main。

## Host 与 Agent 职责边界及复用检查（2026-10-31）

- 已按工程规范 §4 完成实际代码、调用链、SDK 文档与受控运行记录检查，正式记录见 [boundary-review.md](boundary-review.md)，原始证据位于被忽略的 `.local/slice2-boundary-review/`（startup.log、health.json、runs.json、candidates.json）。
- 代码与受控运行结论：Host 仅承担环境、权限、资源控制、状态与持久化；SDK 会话循环、工具、上下文、取消与重试复用合理；必要安全控制不属于 Agent 干涉；未发现第二模型调用、隐藏修复 Agent 或平行会话机制。合成 fixture 的固定序列明确不属于自主性证据。
- 独立复核维持 **待验证**：真实 sessionId、provider/model 与 `sdk:*` 事件缺失，真实 Agent 的选择、纠错与续接恢复不能由代码或受控测试推断。本项不得作为合并／发布完成项；真实模型证据补齐前不得合并或发布，无例外申请。

## Git / CI

- 2026-10-31 已提交 `5e9ac73`（`feat: implement descriptive exploration and case candidates`）并推送至 `origin/work/qoder/slice2-exploration-candidates`；未创建 PR，CI 未运行。
- 分支包含大量新增与删除文件，待用户确认本结果记录和真实模型／公网授权范围后再决定是否收尾提交与 PR。

## 用户验收

- 未开始。需要用户确认本机合成候选质量与 UI，并分别授权真实模型（模型、预算、可发送字段）与真实搜索 Provider（密钥环境、配额、偏好来源）后，才能执行切片二规格剩余验收。
