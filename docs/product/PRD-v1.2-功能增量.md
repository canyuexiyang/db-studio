# PRD v1.2 功能增量（2026-09-28 定稿）

> 依据：`docs/research/竞品调研与功能路线图.md`（含全部代码勘察证据与竞品来源）。
> **定位不变**：「反应最快的 macOS 数据库查看器」，目标用户是间歇性查看/修改数据的开发者，不是 DBA。
> **范围红线不变**：PRD §三 非目标一律不碰（数据同步 / ER 图 / 定时任务 / 权限管理 / 服务器监控 / BI 图表 / 团队协作 / 云同步 / 存储过程调试器 / 跨平台 / 多语言）。
> **与 v1.1 的关系**：v1.1（R1 轮 A–F 板块）已交付的 40 + 4 项不变，本文只描述 v1.2 新增。

---

## 〇、本轮六大板块与交付顺序

| 板块 | 内容 | 成本 | 顺序 |
|---|---|---|---|
| **P1-A** | 补断层：把已实现但没接线的能力还给用户（7 项） | 6-10 天 | **1（✅ 已交付 2026-09-29）** |
| **P1-B** | 网格编辑深度（6 项） | 15-22 天 | **2（✅ 已交付 2026-09-29）** |
| **P1-C** | 对象上下文与可读性（4 项） | 8-12 天 | **3（下一个可开工）** |
| **P2** | 中期候选（6 项） | 视工期 | 4 |
| **S** | SQL 编辑器增强：格式化 / 高亮 / 表提示 / 字段属性提示 | 待实测后定 | **与本轮并行** |
| **W** | 窗口左上角原生控件（关闭 / 缩小 / 放大） | 2-4 天 | **穿插（改动面小）** |

> **为什么 P1-A 必须第一个做**：它们是「用户按下键没反应」的真缺陷，且全部为接线工作、零架构风险。不先补就上 P1-B，新功能会建在一层不可靠的地基上。

---

## 一、P1-A 补断层（7 项，6-10 天）

> **✅ 已交付（2026-09-29）** —— V1–V7 全部落地，`npm run verify` 全绿（typecheck + 985 单测 + check:bundle 9/9 + e2e:ui 124/124 + e2e 全家桶）。明细见 `docs/devlog/DEV-PROGRESS-2026-09-29.md`。
> 共同特征：**底层能力、IPC、单测均已就绪，只差渲染层接线**。不涉及新依赖、不碰性能红线。

### V1 修复网格 ⌘V 粘贴

**现状**：
- `DataGrid.tsx:702-706` 有 `Cmd/Ctrl+V` → `onPaste()` 分支
- `TablePane.tsx:185` 传 `onPaste={() => undefined}` → **按下无任何行为**
- `SqlEditorPanel.tsx:769` 同样传空函数
- 实际可用路径只有工具栏「粘贴」按钮（`App.tsx:1964-1967` → `onPasteRows`）
- `onPasteRows` 已支持：多行多列粘贴、追加新行、类型校验、1000 行上限（`App.tsx:1177-1211`）

**需求**（EARS）：
- 当用户在网格容器内按下 `⌘V` 时，系统应执行与工具栏「粘贴」按钮完全相同的粘贴流程。
- 当当前表不可编辑（`isEditable()` 为 false）时，系统应提示不可粘贴且不进入编辑态。
- 当剪贴板读取失败时，系统应显示已有文案「Electron 下需经 preload 授权」。

**验收**：
- e2e:ui 新增：网格聚焦 → ⌘V → 脏单元格数与工具栏粘贴结果一致
- 结果网格（`SqlEditorPanel`）的 ⌘V 保持只读语义，不得静默失效

---

### V2 修复 ⌘⌫ 删除选中行

**现状**：
- `DataGrid.tsx:712-716` 有 `Cmd/Ctrl+Backspace` → `onDeleteRows()`
- `core-grid-view` 的 `removeRows()` 已实现
- `TablePane.tsx:186` / `SqlEditorPanel.tsx:770` 传 `onDeleteRows={() => undefined}`

**需求**：
- 当用户选中行后按 `⌘⌫` 时，系统应把选中行标记为待删除，并弹出保存预演（`SavePreviewModal`）展示逐条 `DELETE` 原文。
- 当表无主键/唯一键时，系统应拒绝并提供原因说明（红线：无定位列不能构造安全 WHERE）。
- 删除链路必须经 `core-mutation` 与 `core-sql-guard` 的 AST 拦截（只读连接必须被拦）。

**验收**：e2e:ui 新增「⌘⌫ → 预演 → 确认 → 数据真删 Decrease」全链路；只读连接下该快捷键被拒且给出提示。

---

### V3 鼠标拖选矩形选区

**现状**：
- `SelectionModel.extendTo()` 已实现（`core-grid-view/src/index.ts:400-412`）
- 渲染层**零调用**（全仓搜索 `extendTo` 在 renderer 下无命中）
- 现有仅有的拖选是行号列纵向拖选（`DataGrid.tsx:825-847`）与列宽拖拽（`:288-304`）

**需求**：
- 当用户在单元格区域按下并拖动鼠标时，系统应把选区从锚点扩展到当前指针所在的单元格矩形。
- 拖拽过程中**禁止在滚动路径上分配对象**（红线 8）。
- 拖选应与既有语义一致：普通拖选替换选区，`⌘` 拖追加选区块。

**验收**：单测（core 层已覆盖逻辑）+ e2e:ui 拖拽动作断言选区范围与状态栏统计。

---

### V4 命令面板三条「假命令」治理

**现状**：
- `core-command-palette/src/index.ts:260,262,263` 定义了 `cmd.refresh` / `cmd.toggleReadOnly` / `cmd.openPreferences`
- UI 能被搜到、能选中，但 `App.tsx:1725-1747` 的分派链无对应分支
- 最终落到 `App.tsx:1744` 的 `setToast(\`执行命令：${action}\`)` —— **只有提示，无任何副作用**

**需求**：
- `refresh` 应接线到「刷新当前 tab 数据 / 树 schema」（有明显副作用）。
- `toggleReadOnly` 与 `openPreferences` 应随 V5 偏好设置一并落地；若本轮来不及，**必须从命令表中移除**，禁止出现「能搜到但点了没反应」的条目。

**验收**：e2e:ui 断言命令面板中不存在的命令不可被列出，存在的命令执行后有可观测副作用。

---

### V5 偏好设置面板（⌘,）

**现状**：
- `openPreferences` 命令存在，但**全仓无 preferences 组件**
- macOS 用户按 `⌘,` 无任何响应，菜单里也没有「偏好设置…」
- PRD §2.2 设计的「使用统计开关」尚无落点

**需求**（最小版，lazy chunk）：
- 当用户在 macOS 按下 `⌘,` 或从菜单选择「偏好设置…」时，系统应打开偏好设置面板。
- 面板至少包含：① 外观三态（跟随系统/浅色/深色）② 字体缩放当前档位 ③ 网格默认项（默认行数、行高、换行默认值）④ 快捷键一览（只读）⑤ 使用统计开关（默认关闭）。
- 「使用统计」开启后，数据只写本地 `~/Library/Application Support/DB Studio/telemetry.log`，**不做任何网络上报**（PRD §2.2）。
- 新增开关（如 V14 列头类型显示）统一在此注册，避免各自散落。

**验收**：`⌘,` 可打开；改动后重启仍生效；面板 lazy 加载且外壳样式在 `styles.css` 首屏就位（红线 9）。

---

### V6 查询历史增强：删单条 / 自动裁剪 / 星标

**现状**：
- `HistoryStore` 已实现 `deleteHistory` / `pruneHistory`，但**主进程零调用**
- IPC 只有 `historyClear`（整表清空，**危险且不可逆**）被铺设，渲染层 `Backend` interface 未声明该方法
- 实际表现：**历史只增不减**

**需求**：
- 当用户在 ⌘K `@` 历史模式下操作某条历史时，系统应提供「删除此条」「星标/取消星标」。
- 系统应按数量上限自动裁剪历史（默认保留最近 N 条，N 可在 V5 偏好设置里改）。
- 历史列表应支持按连接过滤。

**验收**：单测覆盖裁剪边界；e2e:ui 断言删单条后列表长度精确 -1。

---

### V7 连接级「运行 SQL 脚本」入口

**现状**：
- 库/表级入口已于 2026-09-27 交付（`SqlScriptModal` + `core-import` 流式分割器 + `sql-script-worker.cjs`）
- 连接级缺失，原因记录于 `docs/devlog/DEV-PROGRESS-2026-09-27.md §四.3`：需配目标库下拉

**需求**：
- 当用户在连接节点右键选择「运行 SQL 脚本…」时，系统应先弹出目标库选择，再进入既有脚本流程。
- 完成后的 `schemaRefresh` 行为与库/表级保持一致。

**验收**：复用 `scripts/e2e-script-ui.mjs` 链路，新增连接级用例。

---

## 二、P1-B 网格编辑深度（6 项，15-22 天）

> **✅ 已交付（2026-09-29）** —— V8–V13 全部落地，`npm run verify` **exit 0** 全绿（typecheck + 1073 单测 + check:bundle 9/9 + e2e:smoke 72 条含真库 V9/V10 段 + e2e:ssh 18/18 + e2e:grid + e2e:ui 190/190 + e2e:app 31/31）。明细见 `docs/devlog/DEV-PROGRESS-2026-09-29-p1b.md`。
> 零新增依赖（编辑器 lazy chunk 仍 119.3KB，首屏 416.1KB / 预算 1465KB）。
>
> 定位依据：DB Studio 已有竞品没有的**写操作安全护城河**（只提交脏单元格 + 逐条 SQL 预演 + 无主键只读）。本板块是在这条护城河之上叠加「编辑便利性」，结果是**比别人既安全又顺手**。
>
> **本轮补的一道防线**：V10 让表达式值「原样嵌进 SQL 文本」，而只读守卫只服务只读连接 ——
> 正常连接的写链路此前**没有任何 AST 校验**。已新增 `checkMutationStatement`（core-sql-guard）
> 接进 `applyMutation`，在事务开始前逐条校验（单语句 / 类型限 insert·update·delete /
> UPDATE·DELETE 必带 WHERE / 解析失败 fail-closed）。

### V8 冻结列（固定前 N 列）

**来源**：DataGrip / Excel / TablePlus。

**技术前提已具备**：行号列 sticky 的踩坑记录完整（`docs/devlog/DEV-PROGRESS-2026-09-27-grid-row-gutter.md:12-21`）—— `.grid-header` 已改 `width:max-content; min-width:100%`；`.grid-row` 的 `contain:paint` 实测不劫持 sticky；实色底 token 已有 `--row-sel-solid`。

**需求**：
- 当用户从列头右键选择「冻结到此列」时，该列及其左侧所有列应在横向滚动时保持左钉。
- 冻结列必须使用**实色底**（不得用 `--sel-bg` 等半透明 token，否则会透出下层数据列 —— 红线 11）。
- 冻结列的复制/隐藏语义与普通列一致，行号列永远在最左。

---

### V9 外键值导航与下拉选择器

**来源**：DataGrip「Navigation by foreign keys」（其 Top-9 第 2 条，官方原话 "In many situations this saves you from having to write a query"）/ Navicat 外键下拉。

**需求**：
- 当单元格属于外键列时，用户点击该值应能跳转到引用表的对应行（新开 tab + 按主键自动定位）；引用行不存在时给出明确提示而非静默失败。
- 编辑外键列时，应基于引用表提供候选值下拉。
- 定位必须走既有 `locateStrategy()` 行定位策略，**不得自行判断是否可跳转**（契约 2）。

> 这是 PRD §4.2 已承诺的 P1 用户故事：「我希望外键字段显示关联表的可读值，以便不用手动 JOIN 才知道这行是谁」。

---

### V10 单元格 SQL 表达式模式

**来源**：DataGrip 2026.2「SQL Expression mode」（官方原文：*Now you can just turn the SQL Expression mode on and enter the value, instead of running SQL commands to update the cell*）。

**需求**：
- 当用户在单元格编辑态切到表达式模式并填入 `NOW()` / `UUID()` / `amount * 2` 这类 SQL 表达式时，生成的 UPDATE/INSERT 应**原样嵌入该表达式而不做字符串转义**。
- 标识符仍必须走 `core-sql-ident` 转义（红线 5 不破）；表达式只允许出现在**值**的位置。
- 保存预演必须把含表达式的完整 SQL 原文逐条展示给用户确认（头号红线不破）。
- 表达式模式下不得允许用户在同一格里混用字面量与子查询结果以外的危险结构（`core-sql-guard` 兜底）。

**价值**：「把 created_at 全改成 NOW()」当前只能写 SQL 执行 —— 这是本产品最典型的「我为什么还要开终端」时刻。

---

### V11 Expand Selection 递进选区

**来源**：DataGrip（Top-9 第 4 条）。

**需求**：当用户按 `⌥↑` 时，第一次应选中当前列、第二次当前行、第三次整个网格；`⌥↓` 反向收缩。

**价值 / 成本**：几乎零成本。选列/选行是做区域统计、复制为 INSERT、隐藏列的前置动作，当前只能靠鼠标拖过上千行。

---

### V12 结果集转置（Transpose）

**来源**：DataGrip View options → Transpose（官方原文：*makes it easier to view the spreadsheet if it has many columns*）。

**需求**：
- 宽表场景下，用户可切换「行列互换」视图，该变换**只作用于已加载的可视区**，永远不触发 `decodeAll()`（红线 8）。
- 转置是纯前端渲染变换，不产生新查询、不改动数据源。
- 转置态下复制、默认的语义需明确定义（按视觉行还是按数据行），并在 UI 上明示。

---

### V13 选中多行的批量编辑条（Apply / Discard）

**来源**：Navicat 18「Batch Editing — Batch record modifications with a manual Apply/Discard bar」。

**需求**：
- 当用户选中多行同一列后，工具栏应出现批量编辑条：填一个值 + Apply = 全部选中行的该列标记为脏；Discard = 一次性清除这批脏标记。
- **不引入新的写路径**：Apply 后仍走既有 `core-mutation` + `SavePreviewModal` 逐条预演。
- 只读 / 无主键表下批量编辑条必须禁用并给出原因（契约 1、2）。

> 刻意不做 G4「手动事务 / 未提交变更暂存面板」—— 那是动定位的哲学切换，需先给「比现行逐条预演更快」的实测理由。

---

## 三、P1-C 对象上下文与可读性（4 项，8-12 天）

### V14 列头显示数据类型（可开关）

**来源**：DBeaver 26.1（*"Added an option to show data type names in column headers, disabled by default"*）。

**需求**：在既有 tooltip（`名称 · 类型 · 注释`）之外，列标题第二行显示类型缩略（如 `INT(11)`），**默认关闭**，开关注册进 V5 偏好设置。

---

### V15 JOIN 结果列头的来源表名

**来源**：DBeaver 26.1（*"Added the source table name to column header tooltips for query results with JOIN"*）。

**需求**：多表 JOIN 的结果集中，每个列头的 tooltip 应补充该列的来源表，列名重复时尤为关键。数据来源复用既有 `extractSingleTable` 的元数据链路。

---

### V16 SQL 编辑器实时错误检测下划线

**来源**：Navicat 18「Real-Time Error Detection — pinpoint syntax flaws and invalid schema object detection」/ Hover Info / Highlight Usages。

**需求**：
- 编辑器应对未闭合引号、明显语法断裂、以及**不存在的表名/列名**给出波浪线与 hover 说明。
- 判定基于既有 `splitStatements` + schema 缓存，**纯前端静态推断，不额外打库**。
- 必须与既有 CodeMirror lazy chunk 同批加载，不得引入新的首屏字节（红线 9 / E2）。

---

### V17 编辑器内联显示查询执行耗时

**来源**：DataGrip 2026.2（*"you can now find the execution time right next to each query ... on the first line of the query"*）。

**需求**：每个已执行语句下方显示该语句耗时（`QueryOutcomeDto` 里该数据已存在，只差渲染），无需切到结果页查看。

---

## 四、P2 中期候选（6 项，视工期）

| # | 项目 | 来源工具 | 说明 |
|---|---|---|---|
| V18 | 已保存的筛选方案（命名保存/重命名/删除/搜索，按表持久化） | DBeaver 26.1 | 同一张表的同一组筛选每天重配 |
| V19 | 分组行条纹（按列值着色分组） | DBeaver 26.1 | 纯渲染层提升，不动数据流 |
| V20 | 列列表快速定位 ⌘F12 | DataGrip Top-9 第 7 条 | 100 列宽表找目标列当前只能横向滚 |
| V21 | 自动更新（electron-updater + ad-hoc 重签） | 所有商业竞品 | F3 长期欠账 |
| V22 | 「加载更多」/ 大表行数警告 | DataGrip paging / DBeaver fetch size | core 有 `loadState`/`shouldWarnLargeTable`/`LARGE_TABLE_THRESHOLD=100_000`，渲染层零引用 |
| V23 | 多窗口 / 标签拖出成窗口 | TablePlus | 跨库对照场景，成本高 |

---

## 五、S 板块：SQL 编辑器增强

> 详见专项文档 `docs/product/REQ-v1.2-SQL编辑器增强.md`（含 E2 决策门的实测方案）。
> 本板块含**一项推翻既有决策**的条目（S1 SQL 格式化），必须先做体积实测取得数据再选技术路径。

| # | 项目 | 现状 | 来源工具 |
|---|---|---|---|
| S0 | **决策门**：SQL 格式化体积实测 | E2 已否决 sql-formatter | — |
| S1 | SQL 格式化 | 无 | Navicat 美化 / TablePlus ⌘I / DBeaver |
| S2 | SQL 专属语法高亮（深/浅双主题） | 用 CM 通用 `defaultHighlightStyle`，非 SQL 配色且不跟主题 | 所有竞品 |
| S3 | 表名/库名提示增强（hover 看表信息、fuzzy、别名感知） | 有前缀匹配，`detail` 只有库名 | DataGrip / Navicat Hover Info |
| S4 | 字段属性提示（类型 + 可空 + 主键 + 注释 + 默认值） | `detail` 只有 `dataType` | Navicat Hover Info / DataGrip |

---

## 六、W 板块：窗口左上角原生控件

> 详见专项文档 `docs/product/REQ-v1.2-窗口原生控件.md`。

**现状**：`window.ts:128-137` 已调用 `setWindowButtonPosition({x:16,y:14})` + `setWindowButtonVisibility(true)`，但 `.toolbar` 的 `padding: 0 10px` **没有为交通灯预留左侧空间** —— 首个按钮「命令面板 ⌘K」紧贴窗口左边缘，与交通灯区域重叠。

| # | 项目 | 说明 |
|---|---|---|
| W1 | 内容区为交通灯预留安全区 | 工具栏左侧 padding 留出 ≥72px，且 prometheme 不遮挡 |
| W2 | 三个按钮行为接线 | 关闭 / 缩小 / 放大的实际行为与键盘等价 └ 双击标题栏行为也要对齐 macOS |
| W3 | 放大语义对齐 macOS | macOS 绿按钮默认为**进入全屏**（非最大化），⌥+点击才是放大。作为「原生观感 5.0」的产品必须对齐 Apple 语义 |
| W4 | hover 显示符号 | macOS 原生交通灯在 hover 时才显示 `─` `─` `✕` 符号 |

---

## 七、⛔ 本轮明确不做（维持既有决策）

| # | 项目 | 原决策 | 重开条件 |
|---|---|---|---|
| X1 | PostgreSQL 支持 | 建议延后 | 先完成 P1-A 全部断层；当前 MySQL 链路尚有 7 项未接线，过早扩库会把「一个半成品」变「两个」 |
| X2 | AI 辅助 | Q14 v1 不做 | 若重开，只做最轻形态（SQL 报错解释）；必须默认关闭、走 fetch 不入首屏 bundle（守 E2/S2） |
| X3 | 数据画像 / 列值分布 | 贴 BI 非目标边缘 | 若做必须带 LIMIT，禁止全表扫描 |
| X4 | 表单视图 Form View | Q8 拍板 v1 不做 | 需给实测理由（如长文本编辑行高受限的真实阻塞） |
| X5 | 数据同步 / ER 图 / BI / 权限 / 监控 / 定时任务 / 团队云同步 | PRD §三 非目标 | 不追 |

---

## 八、不可破的红线（每次提交前逐条复核）

1. **性能**：每个改动后跑 `npm run verify`（typecheck + 单测 + `check:bundle` + e2e 全家桶）。
2. **体积**：新增依赖前先跑 `npm run check:bundle`。编辑器 lazy chunk ≤ 150KB gzip（实测当前 119.1KB，**余量 30.9KB**）。
3. **写安全**：V2 / V10 / V13 必须走 `core-mutation` + `SavePreviewModal` 逐条预演，**不许有绕过路径**。
4. **只读**：UI 置灰不算防线，只有 `core-sql-guard` 的 AST 白名单算。
5. **网格只读判定**：任何地方不得自行判断有无主键，只问 `isEditable()`。
6. **虚拟滚动纪律**：V3 / V12 不得在滚动路径上做对象分配，不得 `decodeAll()`。
7. **数据保真**：NULL 与空串严格区分；BIGINT > 2^53 不丢精度；DATETIME(6) 微秒不丢。改动编解码/客户端先跑 `e2e-smoke` 对应断言。
8. **视觉红线**：禁 emoji 图标（一律进 `ui/icons.tsx`）；禁紫色/紫蓝渐变配色；三方调色板（` :root` / `data-theme` / 媒体查询兜底）必须同步改。

---

## 九、度量口径

| 指标 | 当前基线 | 目标 | 验法 |
|---|---|---|---|
| ⌘V / ⌘⌫ 触发成功率 | **0%（失效）→ 100%（2026-09-29 已达成）** | 100% | e2e 断言 + 埋点 |
| 快捷键触发占全部操作比（PRD G4） | 未采集 | 提升 | 埋点（默认关） |
| 「改数据」闭环转化率（预演→确认执行） | 未采集 | 提升 | 埋点 |
| 冻结列后的宽表横向滚动可用性 | 无 | **可用（2026-09-29 已达成）** | e2e:ui 宽表靶子断言：40 列 / maxScroll 5016px，横滚 600px 后冻结列 lefts=[52,142] 不动、4 列被覆盖、常规+斑马两态底色均不透明 |
| 编辑器 lazy chunk gzip | 119.1KB | ≤150KB | `check:bundle`（P1-B 交付后仍 **119.3KB**，零新增依赖） |
| SQL 表达式真求值正确性（V10） | 无 | **100%（2026-09-29 已达成）** | e2e:smoke【7.5】真库断言：`NOW(6)` 落库为当前时间（±10min 窗口）、`amount * 3` = 30.00 而非 0、params 与 `?` 一一对应 |
| 外键元数据列序正确性（V9） | 无 | **100%（2026-09-29 已达成）** | e2e:smoke【3.5】真库断言：8 列下标逐一对齐、复合外键 `[x,y] ↔ [a,b]` 顺序一一对应 |

> 埋点一律走 V5 的「使用统计」开关，**默认关闭**，数据只写本地，不做网络上报。

---

**文档版本**：v1.2 · 2026-09-28（P1-A 交付状态更新于 2026-09-29；P1-B 交付状态更新于 2026-09-29）
**配套文档**：`docs/product/REQ-v1.2-SQL编辑器增强.md`、`docs/product/REQ-v1.2-窗口原生控件.md`、`docs/research/竞品调研与功能路线图.md`、`docs/devlog/DEV-PROGRESS-2026-09-29.md`（P1-A）、`docs/devlog/DEV-PROGRESS-2026-09-29-p1b.md`（P1-B）
