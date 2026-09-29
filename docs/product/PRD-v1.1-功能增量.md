# PRD v1.1 功能增量（R1 竞品对齐轮，2026-09-26）

> 依据：《竞品对比与功能迭代清单-2026-09-26》A–F 板块。本文档描述本轮新增/增强的功能与交互逻辑，供下一轮迭代参考。原有 v1.0 功能不变处不再赘述。
> 范围红线不变：A–F 全部落在 PRD §三 非目标之外；表单视图（Q8）、SQL 格式化（E2）维持不做。

## 6.1 连接管理（增强）

### D1 断线检测与重连横幅
- 主进程 `SessionRegistry` 每次**状态迁移**（握手成功/失败、busy、断线检测、自动重连、手动断开）都经 `setOnStateChange` 推送 `event:connState {id, state, lastError}`。
- 自动重连（1s/2s/4s 三次）由会话层接管：密码经 `setPasswordProvider` **现取现用**（不留存明文）；三次耗尽停在 failed，等横幅手动重连。取消（KILL）不算断线。
- 渲染层 `ConnStateBanner`：state ∈ {disconnected, failed, closed} 且 lastError 非空时出横幅（failed 红/掉线黄），附「重连」按钮（promptEveryTime 连接转密码弹窗）与「×」。恢复连接自动收起；demo 模式天然不出现。

### F1 macOS 原生菜单栏
- 菜单命令经 `event:menuCommand {command}` 推送到渲染层分派；命令枚举（16 条）见 `main/menu.ts` 的 `MENU_COMMANDS`：new-connection ⌘N / new-query ⌘T / close-tab ⌘W / open-palette ⌘K / save ⌘S / filter ⌘⇧F / export ⌘⇧E / import ⌘⇧I / design-table ⌘⇧D / refresh-schema ⌘R / font-zoom-in ⌘= / font-zoom-out ⌘- / font-zoom-reset ⌘0 / toggle-theme（无加速键）/ next-tab ⌃Tab / prev-tab ⌃⇧Tab。
- ⌘W 必须是「关标签」⌘R 必须是「刷新表结构」（刻意不用 close/reload role，menu.test 有防回归断言）。macOS 菜单加速键拦截在菜单层，页面 keydown 不会双触发；纯浏览器 demo 无菜单，既有 keydown 兜底。

## 6.2 库表树（增强）

- **C1 对象扩展**：树新增「触发器」「事件」两个类别（TableMeta.kind 扩展；触发器带 triggerTable/timing/event 元数据）。introspect 的两条信息查询**单独容错**——权限不足/老版本不拖垮库表树。demo 数据已含示例。
- **C2 查看定义**：视图/存储过程/函数/触发器/事件右键「查看定义」、表右键「查看建表语句」→ `SHOW CREATE` 原文填入查询标签（只读参考）。六类对象的 DDL 列名映射见 `object-meta.ts`（按列名取，不按下标）。
- **C3 复制 DDL / 生成 INSERT 模板**：表节点右键。INSERT 模板由 `core-sql-ident.insertTemplate` 生成（`?` 占位，转义走包内函数）。
- **C5 收藏表**：行尾星标 + 右键「收藏/取消收藏」（localStorage `dbstudio.favTables.v1`，上限 50）；⌘K 面板收藏表置顶（每次打开面板重读）。
- **C6 键盘**：树聚焦后 F2=设计表（进表设计器）、Delete/Backspace=删除表（走既有危险确认链路）。
- **C7 拖拽表名**：表行可拖入 SQL 编辑器插入转义后的全限定名；`application/x-dbstudio-table` 数据携带完整 TableMeta（编辑器侧可扩展）。
- 树容器节点展开：**单击 caret 切换**（行体单击选中、连接行单击=未连接时握手、对象行双击=打开）。⚠️ `docs/design-mockups/verify.mjs` 的展开方式已同步为 caret 点击。

## 6.3 数据网格（主战场，增强最多）

网格顶部新增 26px 工具栏（不属于滚动区）：查找 / 列选择器 / 换行 / 跳转到行 / 复制。

| 项 | 交互 | 说明 |
|---|---|---|
| A1 查找 | ⌘F 或工具栏；Enter/⇧Enter 循环；Esc 关闭 | 分块扫描（≤2000 行/块让出主线程），只搜已加载行并明示；核心逻辑在 core-grid-view `findMatches` |
| A2 设 NULL | ⌘0 或右键菜单 | 幂等：已是 NULL 的格子再按 = 清除脏改动。走既有 onCellEdited → 保存预演 |
| A3 单元格右键菜单 | 右键 | 复制该值 / 复制选中区（六格式）/ 设为 NULL / 清除本格改动 / 插入复制行 / 查看完整值 |
| A4 复制行 | ⌘D 或右键 | core-mutation `buildDuplicateRowPlan`：自增主键留空服务端生成；**非自增主键留空标红**（不填则预演拒绝，防止撞唯一键）；落库仍走 SavePreviewModal |
| A5 列显隐 | 工具栏列选择器 | 至少保留 1 列；回调仍传**原始列索引**（可见列映射换算）；隐藏列不参与复制/聚合 |
| A7 列宽 | 表头右缘拖拽；双击热区自适应 | 自适应只量可视区 ≤200 行（CJK 1.6 倍宽启发式） |
| A15 视觉记忆 | 自动 | 列宽/显隐/换行按表持久化（`dbstudio.grid.view.v1:<connId:db:table>`） |
| A8 聚合 | 选中区浮动条 | 计数/求和/均值/最值；上限 2 万格明示截断；隐藏列不参与 |
| A16 跳转 | 工具栏输入行号 Enter | scrollTop 直达 + 焦点设到行首可见列 |
| A17 复制 | ⌘C / 工具栏 / 右键 | ⌘C 复制选中区（多重选区取最近一块矩形；2 万格上限），无选区退化为聚焦行；格式 TSV/CSV/JSON/INSERT/UPDATE/Markdown（App 工具栏旧「复制」按钮已移除，入口收敛进网格） |
| A18 换行 | 工具栏开关 | 单元格内容最多 2 行 line-clamp，**行高保持固定**（虚拟滚动约束，刻意为之） |
| C4 列注释 | 表头悬浮 | title = `名称 · 类型 · 注释` |
| F5 选中统计 | 状态栏 | 「选中 N 行 / M 格」，仅激活 tab 回报，切 tab 清零 |

### A12 查询结果写回（本轮差异化重点）
- 主进程对每条成功执行的语句跑 `core-sql-guard.extractSingleTable`：**单条 SELECT + 唯一真实表 + 无 DISTINCT/GROUP/HAVING/CTE/派生表/聚合/INTO** 才回填 `QueryOutcomeDto.source`（fail-closed：检测不出保持只读）。
- 结果消息行出现「打开可编辑表格」按钮 → 复用既有开表链路（schemaGetTable 拿 PK 定位元数据 → 表格 tab），写回仍走逐条 SQL 预演红线。
- ⚠️ 配套修复：App 的 `onRequestSave` 现按 `row >= 已加载行数` 分流 **INSERT / UPDATE**——追加行此前会被构造成 `WHERE pk IS NULL` 的坏 UPDATE（粘贴路径同样受益）。

### A14 行数估算
- 打开表时状态栏显示「约 N 行」（information_schema.TABLES.TABLE_ROWS 估算，**绝不做全表 COUNT**）；视图/无权限静默不显示。

## 6.4 SQL 编辑器（增强）

- **B1 保存片段**：工具栏「保存片段」→ 名称（必填，重名覆盖）+ 描述 → `snippetSave`；空编辑器拦截。
- **B3 草稿自动恢复**：内容 debounce 400ms 存 `dbstudio.draft.v1:<tabId>`（>200KB 不存）；挂载时编辑器为空且有草稿则恢复 + toast；有意注入的内容覆盖草稿；卸载不删（崩溃恢复是主诉求）。
- **B4 执行计划树**：执行计划统一直发 `EXPLAIN FORMAT=JSON`，一次查询同喂「树/表格」双视图（表格由 JSON 反推 11 列）；树视图按 accessType 着色（ALL 红/index 黄/其余蓝）、显示 cost；视图选择按面板记忆。解析失败自动降级表格。
- **B6 错误定位**：失败结果页「定位到语句」→ 滚动编辑器到该语句（不重新执行）；选中执行以选区起点为基准换算偏移。
- **B7 结果导出**：每个结果页签「导出」→ 复用导出面板的 SQL 通路（携带语句原文 + 列元数据；worker 侧有 fields 兜底）。

## 6.5 详情面板（增强）

- **A9 JSON**：值可解析为对象/数组时提供「格式化/原文」切换 + 四色语法高亮（React span，非 innerHTML）+ 复制格式化；>256KB 只显原文。
- **A10 BLOB/图片/HEX**：BIN 列（Uint8Array）或 binary/blob/varbinary 类型：PNG/JPEG/GIF/WebP 魔数 → 图片预览（8MB 护栏）；非图片 → 前 2KB HEX 视图 + 复制；「保存到磁盘」走主进程 `file:saveBinary`（256MB 护栏，弹系统保存框）。

## 6.6 导入导出（增强）

| 项 | 说明 |
|---|---|
| E1 Markdown 导出 | `toMarkdownTable`（竖线转义、NULL 可配）；流式分批写 |
| E2 高级选项 | 分隔符（仅 CSV）/ 编码 UTF-8·UTF-8 BOM / NULL 文本（默认 `\N`）/ 包含表头；xlsx/json/sql 忽略 |
| E3 JSON 导入 | 对象数组 → 键序伪表头 → 映射向导复用；100MB 护栏；**键序前缀性质**有单测守住（peek 与全量解析不错位） |
| E4 整库备份 | 导出面板「范围：整库」（仅 SQL/Markdown）：SHOW TABLES → 逐表 DDL + 分批 INSERT；**INSERT 不带源库前缀**（mysqldump 语义，防止恢复时写回源库）+ `FOREIGN_KEY_CHECKS` 包裹；默认不带 DROP（保守）；进度按表推送 |
| E5 失败行重试 | 完成页「重试失败行(N)」→ 同参数 + `retryRows`；行号口径统一：`fileRow = (有表头?1:0) + 数据行0基下标 + 1` |
| B7 查询结果导出 | ExportModal 接受 `sql/columns`，标题「查询结果（自定义 SQL）」；信任边界：导出走的是用户已在编辑器确认执行的 SQL |

## 6.7 应用壳（增强）

- **F2 字体缩放**：菜单 ⌘=/⌘-/⌘0 或 ⌘K「字体放大/缩小/重置」；`document.body.style.zoom` 档位 [0.85, 1, 1.15, 1.3]，持久化 `dbstudio.fontZoom.v1`。
- **F4 会话恢复**：重启还原标签（query 带 SQL 原文；table 只存三元组重拉）；全关时清快照；上限 20 个；activeId 不跨会话。
- **F7 空态引导**：无连接 → 建连接引导 + demo 提示；有连接无标签 → ⌘K/⌘T/双击树三入口（`[data-testid="empty-state"]`）。
- **F8 错误横幅可复制**：点击 toast 复制全文。
- **F5 状态栏增强**：选中 N 行/M 格、约 N 行（估算）。

## 附：本轮明确不做（维持既有决策，需先推翻才能进迭代池）

A11 表单视图（Q8 拍板 v1 不做）、B8 sql-formatter（E2 否决）、G 板块全部（PG 支持/AI/数据画像/手动事务模式为战略决策项）。
