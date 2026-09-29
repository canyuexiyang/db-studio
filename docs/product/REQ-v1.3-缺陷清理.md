# REQ-v1.3 缺陷清理（2026-09-29 真机反馈 6 项）

> 来源：用户真机使用反馈（截图 `iShot_2026-09-29_11.24.06.png`）。
> 本文是这批缺陷的**资产计划**：每项的功能点、已确认根因、修复方案、验收口径与状态。
> 状态口径：⬜ 未开始 / 🔄 进行中 / ✅ 已完成 / ⚠️ 待真机确认。
>
> 关联事项：项目管理「v1.3 缺陷清理」父任务 + 6 个子任务（按本文编号对应）。

---

## 零、一句话结论

6 项里有 **2 项是"看起来是 A、实际是 B"的误判**，靠真机探针与截图像素分析才定位到真因：

| # | 用户描述 | 真实根因 |
|---|---|---|
| 1 | 表格无法编辑、编辑按钮点不动 | **数据根本没加载出来** —— 连接空闲 10 分钟被自动断开进 `closed`，而 `loadTable` 全链路都没有自动重连；表结构能显示是因为它走磁盘快照不需要活会话。网格里一行数据都没有，自然"没有格子可以编辑"。 |
| 6 | 左上角没有红绿灯 | **`transparent:true + frame:false` 下 Electron 44 根本不创建原生窗口按钮视图**，`setWindowButtonVisibility(true)` 调了也不抛异常（静默无效）。旧文档声称"frame:false 下唯一可用"——"不抛异常"是真的，"灯可见"是假的。 |

其余 4 项（复制带列名 / 树不联动 / 筛选界面乱 / 详情面板信息不够）是真实的产品缺陷，按用户要求直接改。

---

## 一、缺陷 1：表格查询结果无法编辑

### 1.1 现象与误判排除

截图证据（像素级核对）：

- 网格区域（css x∈[341,1172], y∈[175,780]）**暗像素 0 个** → 一个字符都没渲染，只有列头。
- 底部横幅 OCR 原文：`打开表失败：连接当前状态 closed，无法执行查询`。
- 状态栏 OCR：`标签：2 脏单元格：0 可编辑：是 排序：workflow_name_en ASC 约1,533行 筛选：2条 连接：已连接`。
- 右侧详情面板表信息完整（引擎 InnoDB、估算 1,533 行、字段 36 个、注释「工作流管理」）。

**关键推论**：状态栏写着「可编辑：是」「连接：已连接」，但数据是空的 → 不是编辑逻辑坏了，是**数据没拉到 + 状态显示是陈旧的**。

### 1.2 根因（三层叠加，缺一条都不会表现为此缺陷）

**① 主进程：空闲 10 分钟自动断开进 `closed`**
`core-connection` 的 `DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000`，`armIdleTimer()` 到点执行
`transition('closed', '空闲超时，自动断开释放资源')`。用户「间歇性查看数据」的使用姿态
（AGENTS.md §一 目标用户画像）恰好是最容易踩到的：开着窗口去干别的事，回来就断了。

**② 主进程：idle 断开只改状态机，不释放资源（孤儿红线隐患）**
`observedClock` 的定时器回调只调 `fn()` 推进状态，**驱动与隧道原封不动留着**。
后果两条：白占一条服务端连接；用户下次操作触发重连时 `connect()` 直接新建隧道+驱动，
旧的成孤儿 —— 违反 AGENTS.md §四.7「SSH 隧道孤儿进程红线」（SSH 场景下就是留一个 ssh 子进程）。

**③ 渲染层：`connStates` 从不订阅主进程推送（最致命的一条）**
`ConnStateBanner` 自己订阅了 `onConnState`，但 **App 的 `connStates` 只在启动时 `connList()` 读一次**，
之后再也不更新。于是主进程明明推了 `closed`，渲染层仍以为是 `connected`：
- 状态栏显示「已连接」（假象，与截图 OCR 一致）；
- `ensureConnection` 读到 `connected` 直接返回 `'ready'` → **跳过重连** → 查询照旧失败。

**④ 渲染层：只有"开表"入口做了 ensure，其余路径全漏**
`openTableTab` 调了 `ensureConnection`，但 `loadTable` 自己没有 —— 而排序、筛选、右键快速筛选、
刷新、加载更多、外键跳转、**会话恢复**全部直接调 `loadTable`。用户重启应用走的是会话恢复路径
（`openTableTabInner`，同样没有 ensure），于是一打开就是空表格。

### 1.3 修复

| 层 | 文件 | 改动 |
|---|---|---|
| 渲染 | `App.tsx` | 新增 `onConnState` 订阅 effect：主进程每次状态迁移都同步进 `connStates`（幂等按 id 覆盖） |
| 渲染 | `App.tsx` | `loadTable` 开头加 `ensureConnection`：`ready` 才查；`need-password` 弹密码框并把本次拉取存进 `pendingAfterConnectRef` 重放；`failed` 收掉 loading（不留"永远转圈"的假状态） |
| 渲染 | `App.tsx` | 新增 `loadTableRef` / `connectionsRef` / `ensureConnectionRef` 三个 ref 桥（`ensureConnection` 定义在 `loadTable` 之后，直接引用会踩 useCallback 依赖求值的 TDZ） |
| 主进程 | `session-registry.ts` | `observedClock` 侦测 `connected → closed` 迁移，调新增的 `releaseIdleSession()` 真释放驱动+隧道（不碰状态机，避免多推一次迁移）；`gen++` 作废在途建连 |

**为什么修在 `loadTable` 而不是逐个入口**：它是唯一的数据拉取通道（8 个调用方全经它），
一处 ensure 覆盖全部路径；逐个入口修必漏（本次缺陷就是这么漏出来的）。

### 1.4 验收

- ✅ 单测：`session-registry.test.ts` 66 项通过（已验）
- ✅ 真机（自动化，不再需要人工等 10 分钟）：`npm run e2e:idle` —— `scripts/e2e-idle-reconnect.mjs`
  **真驱动 + 真 MySQL + 真定时器**，只把 10 分钟压成 3 秒（`idleTimeoutMs`），
  验三件事：状态机真走到 closed 且**推送**出来 / 驱动真被 close / 再连一次出真数据（16/16）
- ✅ 真机（渲染层那一半）：`npm run e2e:idle:ui` —— `scripts/e2e-idle-ui.mjs`
  起真 Electron，状态栏「连接：」时序实测 **已连接 → 已断开 → 已连接**（4/4）

**为什么拆成两个脚本**：状态栏口径是 `connections[0]`，而 React 的连接列表只在启动时读一次；
预置连接会改掉 e2e-app 里「无连接时执行按钮被禁用」的基线。**各自守自己那一半，互不污染**
（详见两个脚本的文件头注释）。

**状态：✅ 已完成（真机自动化覆盖，人工长时验证不再必要）**

---

## 二、缺陷 2：复制只复制值，不带列字段 key

### 2.1 现状

`core-clipboard` 的 `serializeCopy` 在 tsv/csv 分支**固定**把列名作为首行输出：
```ts
const lines = [cols.map((c) => escapeDelimited(c, d)).join(d)];  // ← 永远有表头
```
用户复制两格值粘到聊天窗，会多出 `id\tname` 一行，得手工删。

### 2.2 修复（对齐 DataGrip 的 Copy / Copy with Headers 双动作）

- `CopyOptions` 新增 `includeHeader?: boolean`，**默认 false**；tsv/csv 按它决定是否输出首行。
- `markdown` **永远带表头**（少了表头与 `| --- |` 分隔行就不是合法 Markdown 表格，粘出去是散文本）；
  `json`/`insert`/`update` 的列名是结构的一部分，无法省略 —— 所以「含列名」只给 tsv/csv 两项，
  **不给一个点了跟不点一样的伪选项**。
- 右键菜单新增「TSV（含列名）」「CSV（含列名）」作为逃生口。
- `DataGrid.copySelection(format, includeHeader)` 串通；⌘C 走默认（纯值）。
- 转置视图 `TransposedView` 的 ⌘C 同样继承新默认（它复用 `serializeCopy`）。

**顺带修掉一处真实的往返不一致**：`planPasteFromText` 按纯值解析、本来就不认表头行，
所以旧行为下「复制 → 粘贴回网格」会把列名当成第一行数据粘进去。改成默认无表头后往返才是对的。

### 2.3 验收

- ✅ 单测：`core-clipboard` 74 项通过，含新增 4 条（默认无表头 / `includeHeader:true` 有表头 / CSV 两向 / 引号翻倍行号修正）
- ✅ e2e:ui：口径断言 —— 默认「1 行选中 = 1 行输出」；含列名「恰好多一行表头，其余与默认逐字一致」
- ⬜ 导出文件的 `includeHeader`（默认 true）**刻意不动** —— 那是文件产物语义，与剪贴板复制是两回事

**状态：✅ 已完成**

---

## 三、缺陷 3：左树选中「表」时右侧详情联动

### 3.1 现状

`<DetailPanel table={openTab?.table} />` —— 只吃**激活的表标签**。
在树里单击一张表，右侧详情纹丝不动，必须双击打开成标签才行。

### 3.2 修复

- App 新增 `detailContext` useMemo：按 `activeKey` 在 `treeRoots` 里递归定位 object 节点，
  取出 `{ table, database, connId }`（connId 从 `obj:<connId>:<db>:<table>` 的 key 第 2 段解析，
  与 `onOpenObject` 同口径）。
- 三级回退：`detailContext ?? openTab`，即**树选中优先，无选中时回退激活标签**。
- 树单击（`onSelectNode → setActiveKey`）本就携带节点的 `TableMeta`，**零额外请求**，联动是纯内存的。

### 3.3 验收

- ✅ e2e:ui：树里单击 `wide_metrics` → 详情面板显示 `wide_metrics` 与其字段注释「宽表指标列」
- ⬜ 真机人工确认：单击（不双击）即可联动

**状态：✅ 已完成**

---

## 四、缺陷 4：筛选操作界面优化

### 4.1 用户原话与逐条归因

> 「点击的地方过多，布局很乱，按钮很丑」

| 抱怨 | 技术归因 |
|---|---|
| 布局很乱 | `.filter-cond { display:flex; flex-wrap:wrap }` —— 值框 `flex:1 1 110px` 宽度随内容浮动，wrap 后第二行从最左重新开始，**多条件时纵向完全不对齐** |
| 点击过多 | AND/OR 是 `<select>`，切一次要「点开下拉 → 找选项 → 点它」三步；组内逻辑也是 select；「+ 条件」只在组头有一个入口 |
| 按钮很丑 | `+ 条件` / `重置` / `保存当前条件` / `重命名` / `删除` 全是**浏览器默认按钮外观**（灰底方角、无 hover 反馈、无 focus ring），与项目 Apple 原生精修基调冲突 |

### 4.2 修复

**① 严格网格对齐**：条件行改 CSS Grid 六条固定列轨
`58px / minmax(96px,1fr) / 106px / minmax(96px,1.5fr) / 40px / 24px`
（逻辑 / 字段 / 条件 / 值 / 状态 / 删除）。表头 `.fb-head` 共用同一套列轨才能对齐。
🔴 状态列与删除列都显式 `grid-column: 5 / 6` 钉位 —— 否则某行没有「未填完」标记时，
删除按钮会被 auto-placement 顺移到第 5 轨，与有标记的行错位。

**② AND/OR 改 chip**（`LogicChips`）：一步点击切换，当前态常显。
组内逻辑只在条件 ≥2 时出现（单条时 AND/OR 无意义，藏起来降噪）。
`role="group"` + `aria-pressed`，Tab 可达。

**③ 按钮统一到既有语言**：`.fb-btn`（12px + 灰底 hover 浮起 + focus ring + `.sm` 小号变体 +
`.danger` 暖红 hover），与 `.toolbar button` / `.gd-tool-btn` 同族。删除按钮平时淡灰 ✕、
hover 行时加深。新增 `IconTrash` 图标（进 `ui/icons.tsx`，禁 emoji）。

**④ 减少点击的具体动作**：
- 每个条件组底部都有整宽虚线「添加条件」，不用滚回顶部；
- 新增条件后**自动聚焦**它的字段下拉（`focusColOf` + effect 查 DOM，省一次点击）；
- 字段下拉 option 显示 `名称 — 注释`（选字段时"这是什么"比"什么类型"更重要），无注释才退回 `名称（类型）`；
- 值框 placeholder 带上字段注释（`等于：支付状态…`）；
- 空组给引导语 + 就地按钮；
- WHERE 预览独立成块，标明「N 条有效条件 · M 条未填完已跳过」。

**🔴 三条红线一条没动**：操作符仍全来自 `operatorsForColumn()`（数值列没有「包含」）、
WHERE 仍全参数化（`buildWhere()`，一句 SQL 不手拼）、参数顺序仍在 `loadTable`。

### 4.3 连带修复（改这块界面时暴露的两个既有缺陷）

这两条都**不是**用户报的，是写筛选回归断言时被抓出来的。共同特征：
**UI 宣称的状态与真实数据不一致**，而任何既有测试都看不见。

**① 「取消」是空按钮 —— 草稿污染全局态**

`FilterBuilder` 的 `onChange` 直接写全局 `filterModel`，但「已应用」的真值是
`tab.filter`（`loadTable` 成功后才写回）。后果：
- 加了条件点「取消」→ 草稿留在全局态 → 工具栏「筛选 (2)」、状态栏「筛选：2 条」照显示，
  **而数据一行没变**；
- 下次点「应用」还会把用户以为已丢弃的条件悄悄用上；
- 全局镜像**切表不同步** → 从 A 表切到 B 表，徽标仍显示 A 表的条件数。

修法（`App.tsx`）：
- 弹窗编辑 `filterDraft`（草稿），`openFilter()` 从 `openTab.filter` 取种子，
  `closeFilter()` 直接丢弃；
- 徽标 / 状态栏 / 导出弹窗一律从 `appliedFilter = openTab.filter` 派生 —— **真值只有一处**；
- `onQuickFilter`（A22 右键快速筛选）删掉「同步全局编辑态」那行，改为**乐观写回**
  `tab.filter`（`loadTable` 是 await 后才 patch，期间徽标会滞后一拍，用户以为没生效）。

**② 徽标与预览虚报条数 —— 计数口径与 `buildWhere` 不一致**

`conditionCount()` 数的是**所有**条件行（含未选字段、未填值的半截行），
而 `buildWhere()` 的生效判据是 `isConditionComplete(c)`。于是「筛选 (2)」可能对应
WHERE 里 1 条甚至 0 条。

更糟的是我上一版在预览区写了 `N 条未填完已跳过`，但两个计数都取"全部行"，
`total > effective` **恒为 false** —— 这句提示从来没显示过，
而它已经被我写进本文档 §4.2 ④ 当作已交付能力。**文档说有、界面从不显示。**

修法：`core-filter` 新增 `effectiveConditionCount()`，判据与 `buildWhere` 的跳过条件
逐字一致（`isConditionComplete`，内部已含 `!c.column → false`）。
`FilterBuilder` 用 `effective` / `total` 两个不同源的计数，`App` 的徽标用 `effective`。

🔴 **两处口径必须同步**：改 `buildWhere` 的跳过判据时要一起改 `effectiveConditionCount`，
漂移的表现是「徽标数与 WHERE 预览的条件数对不上」。已用单测钉住：
`packages/core-filter/src/index.test.ts` → 「🔴 不变量：生效数为 0 ⇔ 生成不出 WHERE」
覆盖 6 个模型（空模型 / 全半截 / 全生效 / 混排 / 无需填值 / 跨分组），
断言双向蕴含 —— 任一侧单独变化都会红。

### 4.4 验收

- ✅ e2e:ui 新增 **13 条**缺陷 4 相关断言：grid 布局 / ≥2 行时同类控件纵向差值 **0px** /
  chip 出现 / 点 OR 一次即生效 / `select.filter-logic` 已归零 / 删除按钮收行 /
  预览是参数化 WHERE（含反引号） / **有效数 + 未填完数 = 行总数** /
  「为空」无需填值即生效 / **半截条件被标注「未填完已跳过」** /
  **草稿不污染徽标** / **取消后徽标与状态栏都不残留** / **应用后徽标才亮**
- ✅ 单测 `core-filter` 38 项（新增 5 条，含上述不变量）
- ✅ 既有红线断言改为按 value 精确选 `amount`（改版后 option 文本变了，靠 `decimal` 认数值列会**静默跳过** → 假绿）
- ✅ `node docs/design-mockups/verify.mjs` 双主题截图 —— 已**扩展覆盖**筛选弹窗与详情面板
  （原来只截网格 / 连接编辑器 / 脚本弹窗，改版的两个视图**根本不在覆盖范围内**），
  并加了 DOM 断言：grid 布局、纵向差值 0、chip 数 ≥2、注释常驻、DDL 非空 ——
  任一不满足直接抛错，避免「图生成了但画的是旧布局」这种假绿

**状态：✅ 已完成（含双主题截图与断言）**

---

## 五、缺陷 5：详情面板信息划分调整

### 5.1 用户要求

| 区块 | 要求 |
|---|---|
| 表信息 | **保留不动** |
| 字段信息 | 显示内容不够，**最少要把 comment 显示出来** |
| 单元格完整值 | **取消**，替换为**完整的表结构语句** |

### 5.2 修复

**表信息**：一字未动（名称/类型/引擎/排序规则/估算行数/字段数/注释）。

**字段信息**：从单行 `名称 类型 PK·UQ·AI·NOT NULL` 改成两行
- 第一行：名称 + 约束徽标（`PK` 蓝 / `UQ` 绿 / `AI` 黄 / `NOT NULL` 中性灰）
- 第二行：类型（等宽）+ **注释常驻显示**（ellipsis，全文进 title）

🔴 注释必须常驻，不能塞回 `title` 悬浮 —— 悬浮等于没有（要逐个 hover，截图/录屏里根本看不见），
用户抱怨的正是这一点。徽标 `flex:0 0 auto` 永不收缩（挤掉徽标比截断列名更难读）。

高度分配重新配平：`.detail-cols-section` 用 `flex:0 1 auto` + `max-height:40vh`，
字段少时自然收缩、字段多时最多占 40%，剩下留给 DDL。
（旧版写死 `max-height:300px`，36 字段的表会把第三块挤到只剩一两行。）

**表结构语句**（替代单元格完整值）：
- 走**既有** `schemaGetObjectDdl` 通道（`SHOW CREATE TABLE` / `SHOW CREATE VIEW`），不新增 IPC；
- 120ms 防抖（树上连续扫过一串表时不打一串并发查询）；
- `alive` 标志防串台（异步返回前用户已切表 → 不能把上一张表的 DDL 写进当前视图）；
- 三态：加载中 / DDL 正文（等宽 + `white-space:pre` 横滚，**不 wrap** —— SQL 缩进结构靠换行表达）/ 失败原因；
- 失败只在本块内说明，**不 toast**（浏览态失败不该打断用户手头的操作）；
- 带「复制」按钮。
- 🔴 `pre.detail-ddl` 必须给显式 `min-height:180px`：`.detail-panel` 自身是 `overflow-y:auto`，
  父容器高度由内容决定，这种父级里 `flex:1 1 auto` **不会被拉伸**（没有确定高度可分），
  不给下限就会塌成一行。

**单元格完整值能力没有丢**：整块搬到新建的 `detail/CellValueModal.tsx`（弹窗）。
理由：① PRD §6.7 明确「网格里长文本与 BLOB 是截断的，用户需要一个地方看全」，这条能力不能随区块一起消失；
② A9（JSON 格式化 + 四色高亮）与 A10（图片预览 / HEX / 保存到磁盘）都是已交付功能，删掉是倒退；
③ 280px 侧栏放长文本与图片本来局促，弹窗反而更好用（`min(720px,92vw)` + `max-height:56vh`）。
入口：网格右键「查看完整值」（该菜单项此前已存在，原实现只是把值送进侧栏）。

🔴 新增 `onInspectCell` 回调而不是复用 `onCellActivated`：侧栏那块换成 DDL 后，
若「查看完整值」还走 `onCellActivated`，用户点它将**什么也不会发生** ——
一个点了没反应的菜单项比没有这个菜单项更糟。宿主没接时退化为原行为（向后兼容）。

🔴 handler 按 `tabId` 取该 pane 自己的 source 与 table，**不用 `openTab`**：
右键可能落在非激活 pane 上（多标签常挂 DOM），用错 tab 的表现是「弹窗显示的是另一张表的值」。

### 5.3 验收

- ✅ e2e:ui：字段区 innerText 含「订单主键」「支付状态」（**innerText 断言能真正区分常驻显示与 title 悬浮** —— title 内容不进 innerText）
- ✅ e2e:ui：第三块是「表结构语句」、不再有「单元格完整值」、DDL 已渲染、有复制按钮
- ✅ e2e:ui：右键「查看完整值」弹窗出现、显示列名+库表+行号、可关闭
- ⬜ 真机确认 SHOW CREATE TABLE 在真实 MySQL 上的输出与复制

**状态：✅ 已完成**

---

## 六、缺陷 6：左上角红绿灯缺失，窗口无法关闭/缩小/放大

### 6.1 🔴 推翻旧结论：这不是"内容没让位"，是**灯根本没渲染**

`docs/product/REQ-v1.2-窗口原生控件.md` §一 写的是「原生交通灯【已经存在】，问题在内容区没给它留位置」，
W 板块据此只做了 CSS 让位（`.sidebar-head` 的 78px padding + `.traffic-light-safe` no-drag）。
`window.ts` 旧注释：「交通灯用 setWindowButtonPosition + setWindowButtonVisibility（frame:false 下唯一可用且不抛异常的组合，S1 实测）」。

**用户截图证伪了这个结论**：左上角 (0,0)–(160,160) 像素全查，红/黄/绿三色命中 **0 个**，
`.sidebar-head` 区域是干净的浅灰 `#f6f6f8`（灯若存在，红色 (255,95,86) 不可能查不到）。
让位做得再好，让的是一块**空白的地方**。

### 6.2 真机探针（推翻决策必须给实测数据 —— AGENTS.md §八）

方法：每个窗口形态一个**独立 Electron 进程**（避免 destroy 透明窗口相互干扰）→
`screencapture -R` 抓窗口矩形（`capturePage` 只截 web 内容，**截不到原生控件**）→
像素检测 macOS 交通灯三色。环境：Electron 44.4.3、Darwin 27.0.0、M5 Pro。

| 变体 | 配置 | 交通灯 |
|---|---|---|
| **A（旧）** | `frame:false` + `transparent:true` + `roundedCorners:false` | ❌ **无** |
| B | `frame:false` + `transparent:true` | ❌ 无 |
| D | `frame:false` + 不透明 | ✅ 有 |
| E | `titleBarStyle:'hiddenInset'` + `transparent:true` | ❌ 无 |
| F | `titleBarStyle:'hidden'` + 不透明 + `roundedCorners:false` | ❌ 无 |
| C | `titleBarStyle:'hidden'` + `transparent:true` | ✅ 有 |
| **P2** | `titleBarStyle:'hidden'` + `transparent:true` + **`roundedCorners:false`** | ❌ **无** |
| **G/P5** | `titleBarStyle:'hidden'` + `transparent:true` + **玻璃 applied** + `trafficLightPosition` | ✅ **有** |

**两条结论**：
1. `transparent:true` 必须配 `titleBarStyle:'hidden'` 才有原生交通灯 ——
   `frame:false` 下 Chromium 根本不创建标准窗口按钮视图，`setWindowButtonVisibility(true)`
   调了也不抛异常，属于**静默无效**（最难查的一类：`typeof` 判空通过、调用成功、就是没有灯）。
2. `roundedCorners:false` **单独就能把灯弄没**（P1 有灯 vs P2 无灯，其余配置完全相同）——
   所以玻璃形态下不能再用它压圆角，圆角交给系统原生。

**唯一同时满足「原生玻璃 + 三灯可见 + 位置可控」的组合是 P5/G**：
`titleBarStyle:'hidden'` + `transparent:true` + `trafficLightPosition` + `createWindowGlass`。

### 6.3 修复

`apps/desktop/src/main/window.ts`：
- `frame:false` → **`titleBarStyle:'hidden'`**（语义正是"隐藏标题栏内容但保留窗口控件"）
- **删掉 `roundedCorners:false`**（圆角交给系统；探针实测 hidden 下原生圆角正常）
- `setWindowButtonPosition()` → **`trafficLightPosition` 构造参数**（首帧前生效，
  不会出现"灯先在默认位置、再跳到 16,14"的闪动）
- 玻璃 `cornerRadius` 用库默认 20，**不显式传**：hidden 自带原生圆角（实测 css ≈10px），
  系统会把子视图裁切到圆角内，玻璃圆角 ≥ 原生圆角即安全；传更小值反而四角露直角玻璃边
- 保留 `setWindowButtonVisibility(true)` 作为防御（全屏切换等路径可能藏灯）
- 新增导出 `applyTrafficLights(win)` 返回 `TrafficLightState`
  （`visibilityApplied` + `closable/minimizable/fullscreenable`）、
  `TRAFFIC_LIGHT_POSITION` 与 `TRAFFIC_LIGHT_MEASURED`

🔴 **为什么必须返回状态而不是"调了就算"**：旧代码只做 `typeof` 判空就认定成功，
这正是缺陷藏了这么久的原因 —— **「接口全通」≠「功能可用」**（项目验证方法论原话）。
现在 `visibilityApplied` 可被启动日志与 e2e 断言。

**⚠️ 连带影响：换构造参数后灯的渲染几何变了（只有像素实测才能发现）**

| | 旧（`setWindowButtonPosition`） | 新（`trafficLightPosition`） |
|---|---|---|
| 单灯直径 | 12px | **14px** |
| 相邻灯中心间距 | 8px | **23px** |
| 整体占据 css x | [10, 62] | **[16, 76]** |
| 灯中心 css y | — | 21 |

渲染层 `.traffic-light-safe` 当时宽 **72px** → **绿灯右缘 76px 露出 4px 在 drag 区里**
（拖拽吞掉 hover，macOS 的「hover 显示 ✕ ─ ＋ 符号」失效）。
已同步改为 **78px**（`.sidebar-head` padding-left 本就是 78，两处口径统一），
并把实测几何固化成 `TRAFFIC_LIGHT_MEASURED` 常量供单测引用 —— 渲染层是 CSS 字面量、
主进程是 TS 字面量，两处必然漂移，必须有一条断言把关系钉住。

**关闭守卫（W2）照旧**：红按钮点击仍不产生 DOM 事件，`installCloseGuard` 的询问-答复链路不变。

### 6.4 验收

- ✅ 单测：`window.test.ts` 18 项通过，含新增 4 条（visibility 调用成功并如实回报 /
  API 缺失时不抛 / `setWindowButtonVisibility` 抛异常时静默降级 / 实测几何与安全区口径自洽）
- ✅ **真机门禁 `npm run verify:traffic-lights` 6/6**（新增专项脚本，见 §6.5）——
  三灯齐全、三色正确、占 css x∈[16,76] ⊂ 安全区 78px、间距 23/23px、同一水平线 y=21
- ✅ e2e:app W 板块 7 条断言通过（坐标口径已按新几何更正：hit 点 20/43/66，安全区 ≥73）
- ⬜ 真机手感确认：红=关闭（脏标签走保存预演询问）、黄=最小化、绿=全屏、⌥+绿=Zoom
- ⬜ 真机确认原生玻璃观感未退化、窗口圆角正常、`titleBarStyle:'hidden'` 的系统拖拽带
  与 `.toolbar` 的 `app-region:drag` 不打架

**状态：✅ 像素级证据齐备（6/6），⚠️ 待人工手感终验**

### 6.5 新增常驻门禁：`npm run verify:traffic-lights`

缺陷 6 的教训是「所有接口层检查都是绿的，灯却不在」，所以必须有一条**看像素**的门禁常驻。
`scripts/verify-traffic-lights.mjs` 的流程：

```
起真实构建产物（apps/desktop/dist/main/main.cjs，不是合成窗口）
  → setPosition(0,0) 消除 getBounds 与 screencapture 的坐标系不确定性
  → screencapture -R 抓窗口左上角（capturePage 穿不透原生控件）
  → 交给 Chromium 解码 PNG（canvas getImageData）→ 连通域分析找三个彩色圆
  → 断言：三灯齐全 / 三色正确 / 右缘 ≤ 安全区 78px / 水平等距 / 同一水平线
  → 截图存档 docs/design-mockups/shots-installed/traffic-lights.png 供肉眼复核
```

两个踩过的坑（都已写进脚本注释，避免下一个人重踩）：

1. **不要手解图片二进制**。第一版手解 `sips` 输出的 BMP，结果 sips 给的是 BITMAPV4/V5 头
   （`headerSize=124`、`dataOff=138`、`height` 为负 = 自上而下、`bpp=32`、`compression=3`
   需读通道掩码），按标准 54 字节头 + 自下而上 + BGR 写死 →
   **灯明明在，门禁报"一个都没检测到"**。改为让 Chromium 解码，零格式假设。
   ⚠️ 必须用 `data:` URL 而非 `file://`（后者污染 canvas，`getImageData` 抛 SecurityError）。
2. **色相判定不能用「r 最大 → 红」**。黄灯 `(253,197,50)` 的 r 同样是最大值，
   那样会报出 `GREEN,RED,RED`。正确判据是看蓝通道相对绿通道低多少
   （黄灯 `g-b > 50`，红灯 `g≈b`）。

⚠️ 环境限制：Playwright 后台启动的窗口**拿不到焦点**（`isFocused` 恒为 false），
失焦窗口的灯会变灰。但本机 macOS 27 实测失焦态仍是彩色（红 (250,121,111) /
黄 (253,197,50) / 绿 (123,211,80)），所以门禁可靠；若在其它 macOS 版本上失焦变灰，
需把判据放宽为「三个等距同尺寸圆」而非「三种色相」。

---

## 七、资产清单（本次新增/修改）

| 文件 | 类型 | 说明 |
|---|---|---|
| `apps/desktop/src/main/window.ts` | 改 | 缺陷 6：窗口形态改 `titleBarStyle:'hidden'`；新增 `applyTrafficLights` / `TRAFFIC_LIGHT_POSITION`；文件头补探针对照表 |
| `apps/desktop/src/main/window.test.ts` | 改 | 新增 4 条交通灯断言（18 项） |
| `apps/desktop/src/main/session-registry.ts` | 改 | 缺陷 1：idle 断开真释放资源（`releaseIdleSession`） |
| `apps/desktop/renderer/src/App.tsx` | 改 | 缺陷 1：`onConnState` 订阅 + `loadTable` 内 ensure + 三个 ref 桥；缺陷 3：`detailContext` 树联动；缺陷 5：`cellModal` 状态与 `onInspectCell`；§4.3：筛选改草稿态（`filterDraft` / `openFilter` / `closeFilter`），徽标与导出改从 `openTab.filter` 派生 |
| `packages/core-clipboard/src/index.ts` | 改 | 缺陷 2：`includeHeader`（默认 false） |
| `packages/core-clipboard/src/index.test.ts` | 改 | 缺陷 2：新增 4 条（74 项） |
| `packages/core-filter/src/index.ts` | 改 | §4.3 ②：新增 `effectiveConditionCount()`（与 `buildWhere` 同判据） |
| `packages/core-filter/src/index.test.ts` | 改 | §4.3 ②：新增 5 条（38 项），含「生效数为 0 ⇔ 生成不出 WHERE」不变量 |
| `apps/desktop/renderer/src/detail/DetailPanel.tsx` | 重写 | 缺陷 3+5：字段两行制含注释常驻；第三块换 SHOW CREATE TABLE |
| `apps/desktop/renderer/src/detail/CellValueModal.tsx` | **新增** | 缺陷 5 配套：单元格完整值弹窗（承接 A9/A10） |
| `apps/desktop/renderer/src/filter/FilterBuilder.tsx` | 重写 | 缺陷 4：网格对齐 + `LogicChips` + 按钮统一 + 自动聚焦；§4.3 ②：预览计数改 `effective` / `total` 双口径 |
| `apps/desktop/renderer/src/grid/CellContextMenu.tsx` | 改 | 缺陷 2：`COPY_HEADER_ITEMS`（含列名）；`onCopySelection` 加 `includeHeader` |
| `apps/desktop/renderer/src/grid/DataGrid.tsx` | 改 | 缺陷 2：`copySelection(format, includeHeader)`；缺陷 5：`onInspectCell` |
| `apps/desktop/renderer/src/grid/TransposedView.tsx` | — | 继承新默认（复用 `serializeCopy`，无需改） |
| `apps/desktop/renderer/src/workspace/TablePane.tsx` | 改 | 缺陷 5：`onInspectCell` 透传（`handleInspect` 取 `source.raw`） |
| `apps/desktop/renderer/src/ui/icons.tsx` | 改 | 新增 `IconTrash`（禁 emoji 红线） |
| `apps/desktop/renderer/src/demoData.ts` | 改 | demo 表补字段注释（否则 demo/e2e 下缺陷 5 无法验证） |
| `apps/desktop/renderer/src/styles.css` | 改 | 缺陷 4：筛选器整段重写；缺陷 5：字段两行制 + DDL 区 + 弹窗；删除死代码 `.sf-btn` |
| `scripts/e2e-ui.mjs` | 改 | 新增缺陷 2/3/4/5 共 **29** 条断言（**219/219**）；修正筛选红线断言的选择器与选列方式；把恒真断言 `previewBefore.length >= 0` 换成真口径 |
| `scripts/e2e-app.mjs` | 改 | 缺陷 6：W 板块坐标口径按新几何更正（旧 x∈[10,62] 作废）；编辑器断言改轮询修**既有竞态** |
| `scripts/verify-traffic-lights.mjs` | **新增** | 交通灯像素级门禁（`npm run verify:traffic-lights`，6/6） |
| `docs/design-mockups/verify.mjs` | 改 | §4.3/§5：扩展覆盖**筛选弹窗**与**详情面板**（原来只截网格/连接编辑器/脚本弹窗，改版的两个视图不在范围内），并加 DOM 断言防止「图生成了但画的是旧布局」 |
| `docs/design-mockups/verify-{filter,detail}-{light,dark}.png` | **新增** | 双主题截图（4 张，像素比对确认深/浅 0% 相同 = 主题真切换） |
| `docs/product/REQ-v1.3-缺陷清理.md` | **新增** | 本文（资产计划） |
| `docs/product/REQ-v1.2-窗口原生控件.md` | 改 | 文首加「§一 结论已被证伪」更正块，指向本文 §六 |
| `docs/README.md` | 改 | 索引补本文、v1.3 需求文档与新 devlog；v1.2 窗口文档标 ⚠️ 部分作废 |
| `docs/devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md` | **新增** | 本轮踩坑全记录 |
| `docs/design-mockups/shots-installed/traffic-lights.png` | **新增** | 门禁截图证据（可肉眼复核） |
| `package.json` | 改 | 新增 `verify:traffic-lights` script |

---

## 八、门禁与遗留

**门禁**（AGENTS.md §五：不跑 `npm run verify` 不许宣告完成）

| 项 | 结果 |
|---|---|
| `npm run typecheck`（根 + renderer 两套） | ✅ exit 0 |
| `npm test` | ✅ 47 文件 / **1563** 项（基线 1548；v1.3 新增 11 + 收尾轮新增 4 条 `restorePlan`） |
| `npm run check:bundle` | ✅ **9/9**；首屏 **442.5 KB** / 1465 KB（基线 421.6）；编辑器 lazy **133.0 / 150 KB gzip 未变** |
| `npm run e2e:ui` | ✅ **219/219**（基线 190 + 新增 29） |
| `npm run e2e:idle`（**新增**） | ✅ **16/16**；真驱动 + 真库 + 真定时器，空闲断开 → 资源释放 → 重连出数据（含隧道无孤儿） |
| `npm run e2e:idle:ui`（**新增**，缺陷 1 遗留项） | ✅ **4/4**；真 Electron 状态栏「已连接 → 已断开 → 已连接」 |
| `npm run e2e:app`（真 Electron + 真 MySQL fixture） | ✅ **45/45** |
| `npm run e2e` / `e2e:transfer` / `e2e:ssh` / `e2e:grid` | ✅ 全通过（SSH 18/0） |
| **`npm run verify` 全链路** | ✅ **exit 0**（含新增两项门禁） |
| `npm run verify:traffic-lights`（新增专项） | ✅ **6/6** |
| `docs/design-mockups/verify.mjs` 双主题截图 | ✅ 已跑并**扩展覆盖**筛选弹窗 + 详情面板（新增 4 张图，含 DOM 断言；深/浅逐像素相同比例 **0%** = 主题真切换） |

**遗留与风险**

1. **缺陷 6 待人工手感终验**：像素门禁证明了灯在且几何正确，但「红=关闭且脏标签走保存预演 /
   黄=最小化 / 绿=全屏 / ⌥+绿=Zoom」这套交互语义与玻璃观感需真机点一遍。
   `titleBarStyle:'hidden'` 会保留一条系统拖拽带，需确认与 `.toolbar` 的 `app-region:drag` 不打架。
2. ~~**缺陷 1 的长时验证**~~ → **已自动化关闭**（`e2e:idle` 16/16 + `e2e:idle:ui` 4/4，见 §1.4）。
   真机 10 分钟等待不再是必要项；真机手感（点排序后数据真的刷出来）仍可顺手看一眼。
3. **体积**：首屏 442.1 KB 距 1465 KB 上限尚宽，但 `CellValueModal`（含 A9/A10 全部逻辑）
   现在进了首屏。若后续再加详情面板功能，应考虑改成 lazy chunk。
   编辑器 lazy 余量仍是 17 KB（133.0/150），**未受本轮影响**。
4. **文档连带已收口**：`REQ-v1.2-窗口原生控件.md` §一 结论已加更正块；
   `window.ts` / `styles.css` / `e2e-app.mjs` 里按旧几何写死的数字（12px/8px/x∈[10,62]/72px）
   全部更正为新实测（14px/23px/x∈[16,76]/78px），并把几何常量收进 `TRAFFIC_LIGHT_MEASURED`
   供单测断言，避免主进程 TS 与渲染层 CSS 两处数字再次各自漂移。
5. **本轮（收尾）新发现并修复：陈旧会话快照会恢复出指向已删连接的标签**。
   现场：真机 e2e 两次运行之间 localStorage 未隔离 → 上次退出的 `dbstudio.session.v1`
   被恢复成一个 connId 已不存在的 query 标签 → 状态栏「连接：未知」、
   执行按钮只判 `!connId` 所以照样可点，一点必然 NOT_CONNECTED —— **比不恢复更糟**。
   修：过滤下沉到纯函数 `restorePlan(snapshot, isKnown)`（4 条单测：`sessionSnapshot.test.ts`），
   App 用当前连接列表回答"还在不在"。同时给两个真机脚本补 `--user-data-dir` 隔离（见 §九.13）。

---

## 九、方法论收获（本次最值钱的部分）

1. **"不抛异常"不等于"生效"**。缺陷 6 的旧代码 `typeof` 判空 + try/catch 全做了，调用也成功了，
   灯就是没有。凡是"调了系统 API 但看不到效果"的缺陷，必须用**渲染层之外的手段**验证
   （原生控件要用 `screencapture` 像素检测，Playwright 与 `capturePage` 都穿不透窗口服务器层）。
2. **截图是可以读的**。用户只给了一张图，靠 OCR（macOS Vision）读出了底部横幅原文
   「连接当前状态 closed」与状态栏「可编辑：是 / 连接：已连接」的矛盾，
   再用像素统计证明网格区暗像素为 0 —— 缺陷 1 的根因在写第一行修复代码前就已经确定。
   **别急着猜，先把用户给的证据榨干。**
3. **状态不同步是最隐蔽的接线缺陷**。缺陷 1 若只补 `loadTable` 的 ensure，修复会被
   `connStates` 的陈旧值架空（`ensureConnection` 读到 `connected` 就直接 return 'ready'）。
   两层都要修才成立 —— 而第二层（订阅缺失）从任何单测里都看不出来。
4. **断言要能失败才有价值**。本次自己写的两条断言当场翻车：一条要求整行语义却右键了单格，
   一条写死虚拟滚动的行号；还有一条差点成为恒真断言（只有 1 行时 `max-min` 必为 0）。
   改法是**断言口径而非断言具体值**（行数关系、差值为 0、结构存在性）。
   这正是项目记忆里「假红假绿」教训的又一次复现。
5. **改类名要连测试一起改**。筛选器 `.col/.op` → `.fb-col/.fb-op` 之后，
   既有红线断言（数值列没有「包含」）会因选择器落空而**静默跳过** —— 假绿比假红危险得多。
6. **`MutationObserver` 断言不了"元素存在"**，它只报"元素新增了"。e2e-app 的编辑器断言
   是个既有竞态：应用启动自带一个 query 标签，`.cm-editor` 早已挂载，点击「查询」只是
   `ws.activate()` 切标签、不新增节点 → observer 永不回调 → 20s 超时报 `-1ms`，
   而紧随其后的 `waitForSelector` 又立刻通过。**"报超时但元素明明在"这个自相矛盾的组合
   就是竞态的铁证**。改用轮询存在性（确定性），并加 `alreadyThere` 自诊断字段。
7. **门禁脚本自己也会写错**。给缺陷 6 写像素门禁时，手解 BMP 撞了 V4/V5 头（`dataOff=138`、
   `height` 为负、需读通道掩码），结果"灯在、门禁报没灯"；色相判定又把黄灯（r 也是最大值）
   判成红。教训与项目既有方法论一致：**解析器/替身不能照自己的假设实现** ——
   改成让 Chromium 解码 PNG，零格式假设。
8. **既有失败与新增失败要分清，别把历史问题算到自己头上、也别把自己的回归推给环境**。
   本轮用 `git stash` 跑基线对照才确定：编辑器竞态是既有的（基线也 `tabs=1, hasCm=true`），
   只是我的 `onConnState` 订阅改变启动时序，把它从"偶然通过"变成"必然失败"。
9. **🔴 写断言前先问「基线是什么」**。§4.3 那 6 条失败**没有一条是实现错了**：
   这段之前的 A22 快速筛选已经应用过 1 个条件，徽标本来就是「筛选(1)」，
   而我按"徽标不含数字"写断言。修法是先「清除」建立**零基线**，再全程做相对断言。
   📌 与第 4 条同源，但方向相反：第 4 条是断言太松（恒真），这条是**前提不成立（恒假）**。
   两者都源于同一个坏习惯 —— 把某个时刻的具体状态当成通用前提。
10. **🔴 文档写了、界面从没显示过的能力，比没写更糟**。§4.3 ② 的「N 条未填完已跳过」
    是我自己上一轮写进需求文档的，而两个计数取了同一个表达式 → 条件恒 false → 提示永不显示。
    没有任何测试会红（它不是回归，是从未生效的新功能）。
    📌 对策：**每条写进文档的用户可见能力，都必须有一条断言看着它真的出现过**。
    本轮补的 `半截条件被标注「未填完已跳过」` 就是这条教训的产物。
11. **UI 宣称的状态必须有唯一真值来源**。徽标 / 状态栏 / 导出弹窗三处都读同一个
    `appliedFilter = openTab.filter`，草稿单独放 `filterDraft`。此前它们读的是
    "编辑中的全局镜像"，于是出现「宣称筛了 2 条、数据一行没变」。
    📌 判据：**凡是"显示给用户看某个状态"的地方，都要能回答"这个数从哪来"** ——
    答不上来或答案是"另一个组件顺手写的"，那就是缺陷。
12. **截图脚本也要断言，否则最典型的假绿是「图生成了，画的是旧布局」**。
    给 `verify.mjs` 补的 DOM 断言（grid 布局 / 纵向差值 0 / chip ≥2 / 注释常驻 / DDL 非空）
    任一不满足直接抛错；双主题再用像素比对（深/浅相同比例 **0%**）证明主题真切换了。
    人工比对截图不可复跑，断言才可复跑。
13. **🔴 真机 e2e 必须隔离 userData，否则"同一份代码、时红时绿"**。
    主进程侧文件已被 `DB_STUDIO_E2E_USER_DATA` 接管，但**渲染层 localStorage 不适用它** ——
    它走 Chromium 的 user data 目录（真实 userData）。于是上一次跑留下的会话快照
    会在下一次跑被恢复出来，断言结果取决于"这台机器跑过几次 e2e"。
    📌 现象最迷惑人的地方：**代码一行没改，上一轮绿、这一轮红**。
    修法是给 `electron.launch` 补 `--user-data-dir`，让每次跑都是真冷启动。
14. **造不出前置条件的断言，宁可不写** —— 它会变成恒真的假绿。
    想给"陈旧快照不得恢复"写真机断言，就得往渲染层 localStorage 预置快照，
    而 `addInitScript` 在 Electron 首帧写不进去（实测注入失败）；
    此时"标签数 = 0"是必然结果，断言**不改代码也通过**。
    📌 对策是把过滤下沉到**纯函数** `restorePlan(snapshot, isKnown)`，用单测守；
    真机造不出的场景，不要硬留一条样子的断言。
15. **改不了的前提就别改，另起一个脚本**。给缺陷 1 补状态栏断言时，
    预置连接会改掉 e2e-app 里「无连接时执行按钮被禁用」的基线（它依赖 connections 为空），
    `page.reload()` 又被本应用的关闭守卫当成关窗（窗口直接没了）。
    📌 与其改既有断言的前提（那会让另一条断言失去意义），不如拆成两个脚本各守一半。
