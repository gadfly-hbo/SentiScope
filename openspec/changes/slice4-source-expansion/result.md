# slice4-source-expansion 结果记录

状态：本地受控实施完成，待独立复核与用户确认。分支基线 `main@e9608b5`。

## 实施记录（2026-11-01）

- **PDF 来源（SRC-01/02/04）**：`fetch_page` 接受 `application/pdf`，经 `unpdf`（MIT，pdf.js 系，无原生编译）受限提取文本层——不执行脚本、不加载外部资源；快照记录 `pdfPages`（页数与每页字符偏移）；损坏（`pdf_parse_failed`）、无文本层/扫描件（`pdf_no_text_layer`）、超 60 页（`pdf_too_large`）一律 fail-closed 为错误值且不留快照；`read_snapshot`／`record_web_fact` 与 HTML 同一套逐字引用校验；`/api/snapshots/:id/text` 返回窗口所在页码；证据下钻显示"第 N 页 · 字数"。PDF 无发布时间元数据时登记 `published_at_unverified`（沿用 N-1 规则）。
- **环比基准（CMP2-01）**：新增 Host 批准定义 `revenue-mom`（`revenue-mom@v1`，阈值 8%，`periodRule='previous-period'`）；`isPreviousPeriod` 仅认月对月、季对季的紧邻上一期；期间校验失败 fail-closed 为待补证；纳入 `benchmarks.json` 可覆盖范围。
- **同级对比（CMP2-02）**：新增 `entity-peer`（`entity-peer@v1`，从严阈值 20%，`periodRule='same'`）；实体必须不同且同 metric／unit／期间、双方 usable；`selectionContext` 少于 20 字直接拒绝（`peer_selection_context_required`），prompt 同步说明；演示数据中 华东（region=华东）与 华南（region=华南）的 region 口径不同，同级对比按 sharedScope 判为待补证（口径不一致），如实留观察——从严阈值路径由单元测试覆盖（region 口径一致的行对，−16.19% 未过 20% 仅留观察）。跨地域区域对比需在数据建模上统一 region 口径后方可成立。
- **演示与 fixture**：行业基准来源改为合成 PDF（`fixtures/mvp/行业_公开统计.pdf`，pdf-lib 生成，3 页可引用文本）；演示传输按原始字节返回（修复 utf8 损坏 PDF 的缺陷）；qualified 演示现产出 5 候选（含环比），同级对比因 region 口径不一致留待补证；CSV 增加 2026-08 行。
- **UI（标签级）**：看板类型标签新增环比差距／同级对比；来源卡片 PDF 徽标（PDF · 文本层 · N 页）；证据窗口显示页码；试用台账新增"按比较类型"分组条。
- 依赖：新增 `unpdf`（runtime）、`pdf-lib`（devDependency，仅测试生成 PDF）；`npm audit` 0 漏洞。

## 检查与验证

- `npm run check`：75/75 通过（含 /OpenAction JavaScript PDF 用例：只提取文本、无执行副作用）（新增 `tests/mvp-pdf.test.ts` 与 CMP2 用例：PDF 文本层入快照与逐字引用、损坏/扫描/超页 fail-closed 不留快照、环比紧邻期间矩阵、同级实体与选择理由门禁；宿主级断言 PDF 页码端点第 1/2 页）。
- 浏览器验证（临时数据目录）：候选含环比类型、试用台账"按比较类型"含环比、PDF 快照卡片徽标、行业候选证据下钻显示"第 2 页 · 59 字"并高亮 PDF 原文；无控制台错误。
- 未做：真实公网 PDF 站点的真实验收（沿用既有真实搜索授权，试用期自然覆盖）；加密 PDF 专项用例（pdf-lib 不支持生成加密件，解析路径上密码件走 pdf_parse_failed fail-closed，待后续以真实样本补）；OptraCall 投递（用户决定后置）。

## 边界自查（工程规范 §4）

- PDF 解析为 Host 确定性环境能力，Agent 工具集不变（仍三个检索工具）；无解析选项外泄给模型。
- 新基准定义为 Host 批准业务上下文，纳入版本化配置；Agent 不得自创定义或阈值；peer 的"选谁比"仅口径与理由门禁约束，结论仍走既有候选门禁。
- 未放松出口扫描、robots、SSRF、大小与配额边界；PDF 与 HTML 同一来源分级、发布时间核验与单源限制规则。

## Git

- 2026-11-01 分支 `work/qoder/slice4-source-expansion` 提交 `0ed3a88`；分支 CI run `41295483202` success；PR #4 squash 合并 main（提交 `7ae27b1`），main CI run `41295661823` success。
