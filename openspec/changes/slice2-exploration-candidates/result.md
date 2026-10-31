# slice2-exploration-candidates 结果记录

状态：LOCAL_IMPLEMENTED（本机受控路径完成；真实模型、真实公网与 held-out 验收未运行，待用户授权与配置）。分支 `work/qoder/slice2-exploration-candidates`，基线 `main@cb3103e`；候选尚未提交、推送或创建 PR。

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

## Host 与 Agent 职责边界及复用检查（2026-10-31）

- 已按工程规范 §4 完成实际代码、调用链、SDK 文档与受控运行记录检查，正式记录见 [boundary-review.md](boundary-review.md)，原始证据位于被忽略的 `.local/slice2-boundary-review/`（startup.log、health.json、runs.json、candidates.json）。
- 代码与受控运行结论：Host 仅承担环境、权限、资源控制、状态与持久化；SDK 会话循环、工具、上下文、取消与重试复用合理；必要安全控制不属于 Agent 干涉；未发现第二模型调用、隐藏修复 Agent 或平行会话机制。合成 fixture 的固定序列明确不属于自主性证据。
- 独立复核维持 **待验证**：真实 sessionId、provider/model 与 `sdk:*` 事件缺失，真实 Agent 的选择、纠错与续接恢复不能由代码或受控测试推断。本项不得作为合并／发布完成项；真实模型证据补齐前不得合并或发布，无例外申请。

## Git / CI

- 2026-10-31 已提交 `5e9ac73`（`feat: implement descriptive exploration and case candidates`）并推送至 `origin/work/qoder/slice2-exploration-candidates`；未创建 PR，CI 未运行。
- 分支包含大量新增与删除文件，待用户确认本结果记录和真实模型／公网授权范围后再决定是否收尾提交与 PR。

## 用户验收

- 未开始。需要用户确认本机合成候选质量与 UI，并分别授权真实模型（模型、预算、可发送字段）与真实公网白名单／映射后，才能执行切片二规格剩余验收。
