# 开发日志 2026-09-27 —— 网格 C 轮:行号列与整行操作(A19-A22)

> 需求:表数据/查询结果第一列前加序号,支持选中整行后复制结果、复制为 INSERT 等;
> 参照 DBeaver / DataGrip / TablePlus 的结果集交互做一轮表格体验补全。

## 交付内容

### A19 行号列(gutter)+ 整行选择

- **渲染**:每行(含表头)第一个子元素为 52px 行号格,显示 1 起的全局行号。
  不参与复制/选区 —— `columnIndexes` 始终是原始数据列下标,隐藏列语义不变。
- **sticky 左钉**:行号格 `position: sticky; left: 0`。两个前提(踩坑记录):
  - `.grid-header` 必须改 `width: max-content; min-width: 100%` —— 原先是流内块级盒,
    宽度只有视口宽,sticky-left 横滚超过一屏会被 containing block 拉走脱锚;
  - `.grid-row` 的 `contain: paint` 实测(Chromium)**不**劫持 sticky(最小 repro 验证过),
    行号钉得住,行容器的绘制豁免保留。
- **不透明底**(红线 11):行号格必须盖住横滚的数据列,`--sel-bg`/`--row-hover` 都是
  半透明的,不行。方案:常规/斑马态用 `--bg`/`--bg-alt`,hover 用
  `background-image: linear-gradient(var(--row-hover), var(--row-hover))` 在元素自身合成;
  选中态新增实色 token **`--row-sel-solid`**(浅 `#e6f2ff` / 深 `#183656`,
  = sel-bg 复合在 bg 上的换算值)。**三处调色板(:root / data-theme / 媒体查询兜底)已同步**。
- **交互**:点击=选中单行(`SelectionModel.selectRowOnly`,替换语义)、Cmd+点击=勾选/取消、
  Shift+点击/按住拖动=范围选(`selectRowRange`)、右键=行菜单(已选行不塌缩)。
  行号点击后键盘焦点落到该行首列(新原语 `setFocus`,不碰选区),Space/方向键/Enter 有落点。
- **选择语义收敛**(重要,改了 ⌘C 行为):
  - `rowsFromSelection` 新增 `selectedRows` 输入,**行勾选优先于矩形选区优先于聚焦行**;
  - 行号点选(plain/Shift)清空遗留的矩形选区(新原语 `clearRanges`)—— 否则构造函数
    初始的 1×1 选区会混进选中统计(视觉验收第二轮抓到的真 bug:选中 2 行显示 3 行);
  - 普通点击数据格清空行勾选(回到单元格模式);⌘A 清空行勾选;
  - 状态栏统计改走新纯函数 `selectionStats`(并集行数;未覆盖勾选行 × colCount 计格)。

### A20 复制为 INSERT/UPDATE 带真实值

- **旧行为是坑**:`serializeCopy('insert'/'update')` 产出 `VALUES (?, ?)` 占位模板 ——
  复制出来根本不能用,与 DataGrip/TablePlus 体验差距的根源。
- **契约澄清**(头注释重写):`?` 占位是**写库路径**(core-mutation)的防注入手段;
  剪贴板里的 SQL 是**文本导出**,不回灌执行,必须带值。标识符仍走
  `quoteIdentifier`/`quoteQualified`(红线 5 不破)。
- 新增 `sqlLiteral(v)`:NULL→`NULL`(空串区分)、number 原样(NaN/±Inf 退化 NULL)、
  boolean→1/0、**字符串一律加引号**(BIGINT 原文以字符串形态到达,带引号导出后 MySQL
  端隐式转回精确值,不经 Float64 —— 红线 6 不破;反过来"像数字就去引号"才是注入面)、
  Date→`'YYYY-MM-DD HH:MM:SS.mmm'`、二进制→`X'hex'`(空二进制 `_binary''`,`X''` 是语法错)。
- **整行语义**:菜单 INSERT/UPDATE 走新 `copyRowsAs`(行勾选优先,否则右键所在行 ×
  全部可见列)—— 右键单格产出单列 INSERT 是误导,与「复制选中区」(选区语义)刻意分开。
- **UPDATE 定位列**:宿主传 `locateColumns`(TablePane 用 core-mutation 的
  `locateColumns(table)`,与保存预演同源,判定只有一处)。定位列不在复制范围内 → 整批
  拒绝产出(不产半截 WHERE)。
- **查询结果补表上下文**:`QueryOutcomeDto.source`(主进程 `extractSingleTable`,A12 已有)
  接进 ResultGrid —— 单表查询的 INSERT 复制可用;UPDATE 因结果集无定位列元数据保持禁用,
  菜单给出禁用原因(「结果集没有可靠的表上下文…」/「没有主键/唯一键定位列…」)。
  demo 后端不回 source → dev 模式该两项禁用,属预期。

### A21 列头右键菜单(补全 A5 的右键半边)

- 新组件 `grid/HeaderContextMenu.tsx`(与 CellContextMenu 同款自绘浮层骨架,刻意不复用 props)。
- 条目:升序/降序/取消排序(排序组仅 `sortable` 时出现,查询结果网格传 false)、
  复制列名、自适应列宽、隐藏此列(至少留 1 列,与列显隐面板同守卫)。
- 排序契约扩展:`onSortChange(column, additive, direction?)`,`direction` 为
  `'ASC'/'DESC'`(显式单列,新纯函数 `applySortDirection`)或 `null`(清空全部);
  不传 = 三态循环(左键老语义)。**坑:TablePane 的 handleSort 中转曾丢掉 direction
  参数导致菜单排序退化成三态循环,e2e 抓到后已修。**

### A22 单元格右键快速筛选

- 菜单组:等于此值/不等于此值/包含此值;本格为 NULL 时只给「为 NULL」。
- `DataGrid.onQuickFilter(column, value, op)` → TablePane → App:并进该 tab 的
  `FilterModel`(基于**已生效**的 `tab.filter` 追加,同步 `setFilterModel`),
  走既有 `loadTable({ filter })` 重拉链路,WHERE 值仍走 `?` 占位参数(防注入不破)。
- 筛选组只在右键落在数据列时出现(行号列右键的 `column` 为空)。

## 验证

- 单测 +23(core-grid-view 9、core-clipboard 14):行选 API/统计/显式排序、
  sqlLiteral 保真(BIGINT 原文/NULL vs 空串/转义/二进制/Date)、行选优先复制、
  UPDATE 定位列越界拒绝。**972 全绿**。
- e2e:ui 新增 6.5 节 15 项断言(行号渲染/sticky 横滚 0px 偏差/点选/Cmd/Shift/
  状态栏统计/INSERT 带值无占位符/UPDATE 主键定位/列头菜单显式降序/取消排序/快速筛选),
  **99/99 全过**;既有用例中受 gutter 影响的单元格下标已修正(`.grid-cell` nth +1)。
- `npm run verify` 全量绿(bundle 373.8KB / 预算内;e2e:grid 首屏解码 0.100ms)。
- 视觉验收(浅/深 × 行选/行菜单/列头菜单/横滚/总览共 10 状态):第二轮全过;
  首轮抓到的「选中统计混入初始选区」已修(见上)。
- 截图:`docs/design-mockups/verify-grid-{rowselect,rowmenu,headermenu,hscroll}-{light,dark}.png`。

## 决策记录

1. **INSERT/UPDATE 复制带值不是破防注入红线** —— 红线管的是写库链路(参数绑定 +
   标识符 quote + 预演),剪贴板是导出物。值转义集中在 core-clipboard `sqlLiteral` 一处,
   字符串无条件加引号(保守侧),标识符仍走 core-sql-ident。
2. **行选与矩形选区并存,优先级:行勾选 > 最近矩形选区 > 聚焦行**;行选模式下清空
   矩形选区(Cmd 追加除外),避免双选择状态互相污染统计与复制。
3. **查询结果的 UPDATE 复制禁用而非凑合** —— 结果集没有可靠的定位列元数据,
   凑合生成 `WHERE` 是数据事故面;INSERT(单表)可用。
4. 快速筛选的值走既有 FilterModel/`?` 参数链路,不在网格里拼 SQL。

## 顺带修复(非本轮范围,单独说明)

- `packages/core-import/src/index.test.ts` 有一个未使用的类型导入
  (`ScriptStatementSplitter`,13:38 的并发改动引入)导致全仓 typecheck 红,
  已删除该行。若是后续要用,建议直接在签名里引用或删除导出。
