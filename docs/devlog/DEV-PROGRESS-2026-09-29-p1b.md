# DEV-PROGRESS 2026-09-29（v1.2 P1-B：网格编辑深度 V8–V13）

> 本轮交付 `docs/product/PRD-v1.2-功能增量.md` §二 P1-B 全部 6 项：把 grid 当电子表格。
> 定位依据：DB Studio 已有竞品没有的**写操作安全护城河**（只提交脏单元格 + 逐条 SQL 预演 + 无主键只读），本轮在护城河之上叠加「编辑便利性」。
> 验收口径：`npm run verify` **exit 0** 全绿；e2e:ui 新增 66 条真机断言（124 → 190）；e2e:smoke 新增真库段【3.5】【7.5】共 21 条。

---

## 一、交付清单

### V8 冻结列（固定前 N 列）

- **实现**：逐列 `position: sticky`（不是拆两段 DOM）——冻结数被 `clampFrozenCount` 钳在 ≤8，left 偏移只有 ≤8 个值，无 O(n²) 问题；DOM 顺序不变，拖选/复制/key 复用零改动。
- **入口**：工具栏 toggle 第 1 列 + 列头右键「冻结到此列（前 N 列）」；点已冻结的最后一列 = 取消（Excel/DataGrip 手感）。
- **🔴 实色底（红线 11）**：`background-color` 承不透明基色（--bg / --bg-alt / --row-sel-solid），半透明高亮（dirty/invalid/match/drag/hover）全部走 `background-image: linear-gradient()` 叠加 —— 与 A19 行号列已验证的方案同款，不新发明机制。
- **持久化**：frozenCount 进 A15 的 `GridViewState`（同一份 localStorage）；旧快照没有该字段 → 读回兜 0，不视为损坏。
- **连带修正**（真机才能抓到）：`revealCell` 与拖选横向命中都要感知冻结块 —— 冻结列 sticky 后「内容坐标 ≠ 视觉坐标」，命中测试分三段（行号列 / 冻结块按客户端坐标 / 滚动区按内容坐标且钳到冻结块右缘之后）。

### V9 外键值导航与下拉选择器

- **驱动层**：`listForeignKeys`（KEY_COLUMN_USAGE JOIN REFERENTIAL_CONSTRAINTS，一次往返）+ `lookupReferencedValues`（服务端 LIKE + LIMIT ≤500，`escapeLikeKeyword` 转义 `% _ \`）。SQL 构造抽成纯函数 `buildReferencedValuesSql` 可离线单测。
- **IPC 契约五处同步**：channels / channels.cjs / preload / handlers / backend（demo 后端给了 `order.user_id → user.id` 的假外键，候选值与 buildDemoPayload 的 user_id 生成规则同源）。
- **渲染层**：列头 FK 徽标 + 单元格链接图标 + 右键「跳转到引用行」+ 编辑态候选值下拉（`ForeignKeyPicker`，200ms 防抖、竞态守卫、拿不到候选值显式给原因不静默）。
- **跳转定位**：走既有「打开表 + FilterModel eq 筛选」链路（值走 ? 占位参数），**不手拼 SQL**；引用行不存在 → toast 明确提示（PRD 要求不静默失败）。
- **刻意收窄**：复合外键**不给单格导航**（单格 → 单行的映射对复合键不成立，跳过去会定位错行）；元数据按表缓存在 App 层（pane 常挂 DOM，各自拉取会在会话恢复时并发打十几次 information_schema）。
- **降级语义分层**：外键列表拿不到 → 空数组（少个链接不该让表打不开）；候选值拿不到 → 冒泡报错（用户点了下拉就必须给原因 —— V1-V7 的教训）。

### V10 单元格 SQL 表达式模式

- **三层防线**：
  1. 渲染层即时反馈：`validateSqlExpression`（core-mutation，纯字符串状态机 —— 四字符串 + 两注释 + 括号平衡，**禁止 split(' ')**）；
  2. 构造层 fail-closed：`buildUpdate` / INSERT 分支遇到非法表达式直接 `MutationError`，不产半截 SQL；
  3. **主进程 AST 兜底（真防线）**：新增 `checkMutationStatement`（core-sql-guard）接进 `applyMutation`，事务开始**之前**逐条校验 —— 恰好一条语句 / 类型限 insert·update·delete / UPDATE·DELETE 必带 WHERE / 解析失败拒绝。整批校验：任一条不合规 → 一条都不执行。
- **为什么必须第 3 层**：表达式值是「原样嵌进 SQL 文本」的，渲染层校验能被绕过（改包/直接调 IPC）；只读守卫只服务只读连接，**正常连接的写链路此前没有任何 AST 校验**。
- **参数位契约**：表达式列不占 `?` 位 → `SqlStatement.setParamCount` 新字段；`stripConflictComparisons` 改用它定位 WHERE 参数起点（用 `edits.length` 会在「含表达式 + skipConflictCheck」时错位，静默产出错 SQL）。
- **预演强化**：`hasSqlExpr` 标记 → SavePreviewModal 顶部黄色告警「fx 的值会原样嵌进 SQL 执行」+ 每条语句 fx 角标 + 左边条（头号红线：用户必须看得见即将执行的原文）。
- **入口**：编辑态 fx 按钮 / ⇧⌘E / 单元格右键「SQL 表达式模式编辑」；批量条同款 fx 开关（「把 created_at 全改成 NOW()」= V10 + V13 的组合拳，正是 PRD 说的「我为什么还要开终端」时刻）。
- **黑名单口径**：剥掉字符串字面量后再扫写/权限/DoS 关键字（`CONCAT('drop table x', y)` 不误杀；`SLEEP`/`BENCHMARK`/`LOAD_FILE` 在列 —— 填值入口不该能挂住连接或读服务器文件）；`SELECT` 不在黑名单（PRD 明确允许子查询）。

### V11 Expand Selection ⌥↑ 递进选区

- `SelectionModel.expandSelection(grow)` + `ExpandLevel`（0 单格 → 1 整列 → 2 整行 → 3 全表），⌥↓ 反向收缩。
- 档位顺序「列 → 行 → 全表」对齐 DataGrip 手感；**focus 不随档位移动**（递进意图是围绕当前格扩大，selectAll 推 focus 是因为 ⌘A 语义就是重置）。
- 所有其他选择动作（selectCell/navigate/extendTo/toggleRow/selectRow*/setFocus）把档位归零；⌘A 直接对齐 3 档（⌥↓ 才有正确起点）。

### V12 结果集转置（Transpose）

- 独立组件 `TransposedView`（不是 DataGrid 的 flag）：转置把「行 = 数据行」的整套前提翻过来，flag 分支会让两条滚动路径互相污染；转置态定位是**只读查看**（语义在 UI 明示）。
- **🔴 红线 8**：横向虚拟滚动复用 `computeTransposedVisibleRows`（= computeVisibleRange 同一套线性公式，行高↔列宽互换），只解可视区数据行（e2e 实测 64~80 格，滚动后有界）；onScroll 只写一个数字 state。
- 复制语义按 PRD 要求**明示**：⌘C 按**数据行**复制（转置只是查看姿态，粘进 Excel 要是正常表格）。
- 字段数 > 200 拒绝转置（`canTranspose` 给原因，按钮禁用）——渲染几千行 DOM 不是转置该干的事。
- **Esc 挂 window capture**（不能只挂 viewport：焦点没落到 viewport 时用户会被困在转置视图里）。

### V13 选中多行批量编辑条（Apply / Discard）

- 判定走 `batchEditTarget`（core-grid-view 纯函数）：行号勾选 ≥2 行 × 焦点列，或矩形选区「多行 × 单列」；多列选区不给（一个值填进不同列几乎必然是误操作）。
- **🔴 不引入新写路径**：Apply 只调 `source.setDirty` 逐格标脏（`planBatchEdit` 只产计划不产 SQL），落库仍走既有 onRequestSave → buildMutationPlan → SavePreviewModal 逐条预演（e2e 断言「即将执行 4 条语句」）。
- Discard 清这批脏标记；只读/无主键表禁用并给原因（isEditable + readOnly 双判定，UI 提示 + App 层拦截 + 主进程 AST 三层）。
- 支持 fx 表达式模式（与 V10 同一套 validateSqlExpression）。

---

## 二、真机/真库抓到的 bug（单测全部测不出来）

1. **`.grid-cell { position: relative }` 全局规则覆盖了行号列的 sticky** —— fx 角标需要定位基准，我顺手加了全局 relative；它在文件后段、同 specificity，把 `.gd-rowno` 的 `position: sticky` 覆盖成 relative → 横滚 800px 行号跟着滚走。e2e:ui 既有断言「偏差 66px」抓到。修法：relative 收窄到 `.gd-expr:not(.gd-frozen)`（冻结格是 sticky，本身就是包含块）。
2. **转置视图卸载 `.grid-viewport` 后，ResizeObserver 观察的是已移除节点** —— 旧节点触发 clientHeight=0 → viewportHeight 卡 0 → 退出转置后网格**渲染 0 行**（整片空白，但无任何报错）。`useEffect(..., [])` 不会为新节点重挂 observer。修法：依赖加 `transposed`。
3. **fx 按钮 `preventDefault()` 挡不住显式 `focus()`** —— 按钮嵌在单元格里，mousedown 冒泡到 `onCellMouseDown` → 那里显式调 `viewportRef.current?.focus()` → 输入框 blur → commitEdit → 编辑器当场卸载（用户点 fx 编辑器就消失）。修法：`stopPropagation()`（preventDefault 只挡浏览器默认焦点行为）。fk-toggle 同款。
4. **e2e:smoke 表达式 UPDATE affectedRows=0** —— fixture 给 ts 传了 `oldValue: null`，冲突检测生成 `AND ts IS NULL`，而该行 ts 有真值 → 匹配 0 行，表达式根本没执行。产品行为完全正确（这就是冲突检测该干的），是测试数据错了。INSERT 路径的 NOW(6) 真求值成功反而对照出了这一点。
5. **弱断言的照妖镜**：「冻结列在 52px 处」在 order 表（7 列，maxScroll 实测仅 66px）上**没滚动也成立** —— 属于假绿。造了 40 列宽表 fixture（`wide_metrics`，maxScroll 5016px）后断言才有意义：横滚 600px、冻结列 lefts=[52,142] 不动、4 列被覆盖。

## 三、真库验证的方法论落地

- **外键 JOIN 列序假设**：`listForeignKeys` 在 rowsAsArray 下按**列下标**解构，单测 mock 是照假设写的（替身照着被测代码的假设实现 = 一起错）。先用临时探针打真库确认 8 列顺序 + 复合外键 ORDINAL_POSITION 排序，再把断言**固化进 e2e-smoke【3.5】段**（9 条）—— MySQL 升级改了 information_schema 结构，冒烟会红而不是静默错。
- **表达式真求值**：单测只能断言「SQL 文本里有 NOW()」，看不出它**到底被求值了没有**（被转义成字符串会落 '0000-00-00' 或报错）。e2e-smoke【7.5】段（12 条）真库断言：NOW(6) 落库为当前时间（±10 分钟窗口）、`amount * 3` = 30.00 不是 0、params 与 ? 一一对应、INSERT 路径同款。整段跑事务 + ROLLBACK —— 第一版没包事务，amount 被改成 30.00 污染了【11】筛选断言的数据分布。

## 四、验证结果（全绿）

- `npm run typecheck`：根 + renderer 两套 ✅
- `npm test`：**1073/1073** ✅（36 文件；985 → 1073，+88）
- `npm run check:bundle`：**9/9** ✅（首屏 416.1KB / 预算 1465KB；编辑器 chunk 119.3KB 不变 —— V9/V10 零新增依赖）
- `npm run e2e`（e2e:smoke）：51 → **72 条** ✅（新增【3.5】外键 9 条 +【7.5】表达式 12 条）
- `npm run e2e:ssh`：18/18 ✅
- `npm run e2e:grid`：网格性能 ✅
- `npm run e2e:ui`：**190/190** ✅（124 → 190，新增 12.8 节 P1-B 真机验证 66 条）
- `npm run e2e:app`：31/31 ✅
- `npm run verify` 全量：**exit 0** ✅

### e2e:ui 新增断言摘要（12.8 节）

- **V8**：冻结按钮/徽标/右键「冻结到此列（前 3 列）」/toggle 取消/落盘持久化；横滚后行号 0px 偏差、冻结列 52px 不动、`position:sticky`、**底色不透明**（常规+斑马两态）；**宽表靶子**（40 列，maxScroll 5016px）：滚 600px 冻结列 lefts=[52,142]、4 列被覆盖
- **V9**：FK 徽标 / 链接单元格 / tooltip 指明 `user.id` / 非外键列不画 / 右键跳转反馈「已跳转到 user.id = 1001」/ 新开标签
- **V10**：fx 开关及开启态 / 提交后 fx 脏标记 / 预演弹窗表达式告警 / **NOW() 原样嵌入未转义**（`SET \`created_at\` = NOW() WHERE \`id\` = 9 AND ...`，WHERE 参数没错位）/ 分号多语句被拦 + 不提交 + 无脏标记 / SLEEP 被拦 / 字符串字面量里的关键字不误杀
- **V11**：⌥↑ 三档（列 cells=rows → 行 1×7 → 全表 rows×7）/ ⌥↓ 收缩 / **focus 不漂移**
- **V12**：7 字段行 × 8 数据列 / 语义明示（一行=一个字段·只读）/ **渲染量有界**（64 格，滚动后 80 格）/ 独立选中统计 / Esc 退出
- **V13**：单格禁用 / 多行单列启用 / 批量条列名+行数 / Apply 4/4 标脏 + toast 指向 ⌘S / **仍走保存预演**（即将执行 4 条 + refunded 值）/ Discard 0/4

## 五、改动面清单

| 层 | 文件 | 改动 |
|---|---|---|
| core-grid-view | `index.ts` | ExpandLevel/expandSelection、clampFrozenCount/frozenCountForColumn、computeTransposedVisibleRows/canTranspose、batchEditTarget/planBatchEdit、GridViewState.frozenCount |
| core-mutation | `index.ts` | EditValueKind、validateSqlExpression/normalizeSqlExpression、buildUpdate/INSERT 表达式分支、SqlStatement.hasSqlExpr/setParamCount、PendingInsert.valueKinds |
| core-sql-guard | `index.ts` | checkMutationStatement（写链路结构白名单）+ RejectReason.missing-where |
| core-driver-mysql | `index.ts` | ForeignKeyMeta、listForeignKeys、lookupReferencedValues、buildReferencedValuesSql/escapeLikeKeyword（纯函数） |
| 主进程 | `session-registry.ts` | applyMutation 前置 AST 校验；getForeignKeys（降级空数组）/lookupReferencedValues（不降级）；DriverLike 契约扩展 |
| 主进程 | `ipc-handlers.ts` | SCHEMA_GET_FOREIGN_KEYS / SCHEMA_GET_REFERENCED_VALUES 两个 handler |
| IPC 契约 | `ipc-channels.ts/.cjs`、`renderer-types.ts`、`preload.cjs` | 五处同步（有测试守着两份一致） |
| 渲染层 | `DataGrid.tsx` | V8 sticky 冻结/命中修正、V10 fx 编辑态、V13 批量条、V9 链接与下拉接线、工具栏三按钮 |
| 渲染层 | 新文件 `TransposedView.tsx`、`ForeignKeyPicker.tsx` | V12 转置、V9 候选值下拉 |
| 渲染层 | `useGridData.ts` | DirtyCell.valueKind（setDirty/valueKindOf/dirtyCells 透传） |
| 渲染层 | `App.tsx` | onRequestSave 带 valueKind/valueKinds/hasSqlExpr；onBatchEdit/onBatchDiscard；外键缓存+onFollowForeignKey+onLookupForeignKeyValues；**loadTable 返回 rowCount**（await 后读 sources/ws 会拿旧值） |
| 渲染层 | `TablePane.tsx`、`SavePreviewModal.tsx`、`CellContextMenu.tsx`、`HeaderContextMenu.tsx`、`icons.tsx`（+4 图标）、`styles.css`（+565 行） | 接线与视觉 |
| demo | `demoData.ts`、`backend.ts` | wide_metrics 40 列宽表 + 假外键 + 按表名路由 payload（元数据/载荷错配 = 值全 null 且不报错的假绿） |
| 门禁 | `e2e-smoke.mjs`（+21 条）、`e2e-ui.mjs`（+66 条） | 真库【3.5】【7.5】段、12.8 节 |

## 六、遗留与建议

1. **V9 复合外键**只做了元数据（columns/referencedColumns 数组已完整），导航/下拉刻意只支持单列外键 —— 复合键的单格导航语义不成立，若未来要做需要「多列联合定位」的交互设计。
2. **V12 转置是只读查看模式**：编辑请先退出转置（UI 已明示）。若未来要支持转置态编辑，需要把 SelectionModel/脏单元格/编辑态整套翻转过来的设计评审，不是小改。
3. **V9 displayColumn 目前恒 null**（下拉 label = 值本身）：「引用表的可读列」需要列选择交互或启发式（name/title 优先），本轮未做，接口已留。
4. `e2e:script:ui` 仍未进 verify 串联（P1-A 轮遗留，同前）。
