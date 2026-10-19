# DEV-PROGRESS-2026-10-13

> 0.7.0 迭代开工：任务规划（52 条）+ 首条 P0 交付（T01 / R01）。
> 门禁基线：`typecheck` ✅ · `npm test` **1645/1645** ✅ · `check:bundle` **9/9** ✅ · `npm run verify` 全链 ✅（e2e:ui **234/234**、e2e:app 45/45）

## 一、开工前的任务规划（上午）

依据 `docs/research/项目全景与竞品深度调研-2026-10-12.md`（全盘采纳其修改项/优化项/新增项）建立 0.7.0 任务体系：

- 1 个版本大任务 + **52 个扁平编号、可独立执行的原子子任务**（大任务 ID `rvrK86`，标签 `0.7.0`）。
- 分批：P0 正确性 1–10 → 菜单/快捷键/只读 11–18 → 网格高频入口 19–30 → 值查看编辑 31–38 → 查询/导出/文件 39–45 → 界面信息层级 46–48 → 回归与文档 49–51 → 收尾发版 52。
- **明确不纳入**：I25 参数化查询模板 / I26 PostgreSQL / I27 AI 错误解释（报告 §10 标 P3、§11 明确排除）。
- 落盘：`docs/product/REQ-0.7.0-研发任务清单.md`（任务总表 + 逐条详述 + R/I 双向映射 + 证据定位 + 待确认问题），并在 `docs/README.md` 建索引。

## 二、T01 / R01：重载前保护未提交改动（已交付）

### 根因（不是"忘了关"，是数据结构决定的）

`GridDataSource` 的脏单元格 Map 以 **「行下标:列下标」** 为键；而 `useGridDataSource(payload)` 按 payload 缓存、**payload 一变就整体重建数据源**。而排序 / 筛选 / 刷新 / 加载更多 / 外键跳转**全都会换 payload** —— 于是脏格连同用户的输入一起蒸发，且此前**没有任何提示**。

真机复现：双击 `NO100001` 输入 `RESEARCH_PENDING` 按 Enter 标脏，再点列头排序 → 脏格 1→0、输入消失。

### 实现选择

**守卫长在 `loadTable` 内部，而不是逐个改调用点。** `loadTable` 是唯一数据拉取通道（代码注释自己也是这么写的），长在里面等于：排序 / 筛选 / 快速筛选 / 刷新 / 加载更多 / 外键跳转**以及将来新增的入口**都自动被覆盖。逐个守卫是"漏一处"的经典来源。

三条出口（对应报告 §R01 验收标准的"可选择先保存或明确放弃"）：

| 出口 | 行为 |
|---|---|
| 先保存… | 走既有「预演 → 确认」链路；确认成功后由 `onConfirmSave` 自己重拉（那时脏格已清，不再撞守卫） |
| 放弃改动并继续 | 清脏标记（含状态栏/标签角标）后照常重载 |
| 取消 | 本次不重载，并把入口做的**乐观写入回滚** |

**乐观写入回滚**是本条最容易漏的部分：排序 / 快速筛选 / 加载更多都是「先 patch 状态、再由 effect 触发重拉」。取消时若不回滚，列头箭头会停在新方向、筛选徽标会挂着没生效的条件 —— 那是一个**比原来丢数据更难察觉的假状态**。已为三处各登记回滚闭包，并在「预演被取消」时补执行（保存没发生 = 该回滚）、「提交成功」时作废。

### 改动文件

| 文件 | 变化 |
|---|---|
| `apps/desktop/renderer/src/grid/DirtyReloadModal.tsx` | **新增**。三选一弹窗，lazy 加载，复用既有 `.modal-mask`/`.modal` 外壳类 → **首屏 CSS 零新增**（红线 9） |
| `apps/desktop/renderer/src/App.tsx` | 守卫 + `requestDirtyDecision` promise 桥 + 三处乐观写入回滚 + 预演取消/提交成功时清理回滚闭包 + 弹窗渲染 |
| `scripts/e2e-ui.mjs` | 新增 8 条 T01 断言；新增 `clearDirtyByReload` 助手；给受影响的后续段落补显式清脏步骤 |

### 🔴 本条最值钱的教训：旧断言对 R01 **没有证伪能力**

改完之后，`e2e-ui.mjs` 的既有断言**立刻变红**，而且是连着两处：

1. 「排序三态」—— 三次点列头，每次都弹守卫 → 列头被遮住点不动。
2. V4「刷新当前对象」—— V1 粘贴留下的脏格让刷新弹守卫 → 后续 `prefs-close` 全被弹窗吃掉。

原因不是新代码破坏了什么，而是**这些断言是在「脏格已被静默丢掉」的状态下写的**：修复前它们之所以全绿，恰恰因为脏格被丢了、重载畅通无阻。只要实现回退到旧行为，它们**照旧全绿**。

这与既有方法论一致（「已有断言也可能是照旧实现写的，从而失去证伪能力」）。处置：

- 新增 T01 专属断言 —— 直接钉「不许丢」：带脏格点列头必须弹守卫；取消后脏格数不回退、且列头**没有**被写成已排序（证明回滚生效）；选放弃后脏格清零且排序真正生效。
- 给 V4 段落补 `clearDirtyByReload(page)` —— 用「命令面板 → 刷新当前对象 → 守卫 → 放弃」清掉残留脏格（走刷新而不是点列头，避免顺带改掉排序状态影响后续断言）。
- 断言数 226 → **234**（+8）。

## 三、环境事实（本轮踩到，记下来）

- 🔴 **当前执行环境内 `.git` 写入不生效**：`git add <file>` 返回 0、`git ls-files` 能列出，但 `git write-tree` 与 `HEAD^{tree}` **哈希完全相同** → 索引写盘被丢弃，`git status` 永远报 clean。所以本轮**不做提交**，改动全部留在工作区，提交需在沙箱外执行。
- 真库 fixture `dbstudio-mysql`（13306）在线健康，`npm run verify` 全链可跑通（上一轮报告里的 `ECONNREFUSED 127.0.0.1:13306` 只是没起 fixture）。

## 四、遗留与边界

- **T01 的已知边界**：本轮**不做**「跨重载按行身份迁移草稿」（那需要稳定行定位键 + 整栈撤销，属 I14/I18 范围），只保证**不静默丢**。这条边界写进了任务备注，避免后人误以为"草稿能跨排序活下来"。
- **0.7.0 剩余 51 条**未开工。成本「大」的两条（T44 结果加载上限与按需大值、T38 未保存编辑 undo/redo）开工前需先出实测数据/方案，不允许直接下手写。
- 未 commit、未发版、未跑 `verify:installed`（未打包）。

---

# 第二批：P0 收口（T02–T10）

> 门禁：`npm run verify` **exit 0** · 单测 **1645 → 1721** · e2e:ui 226 → **234** · e2e:conflict **17/17**（新增）· e2e:app 45/45

## 一、T02–T07：身份与保真

| 条 | 根因 | 落点 |
|---|---|---|
| T02 | 中央对象清单的归属只有 `database`，两个连接有同名库时**串上下文** | 抽 `workspace/objectBrowserModel.ts`（纯逻辑，7 测试）；`collectObjects(roots, scope, onlyKind, connNames)` 按 `(connId, database)` 双重归属；跨连接概览**显示连接名** |
| T03 | 树库行「新建表」不带 connId | 显式传 connectionId，设计器目标严格一致 |
| T04 | 片段身份是**裸名字**，同名片段互相覆盖上下文 | 新 `workspace/snippetCommand.ts`：身份编码 `(connectionId, database, name)`，分隔符 `\u0000` + `encodeURIComponent`（7 测试）；命令面板按身份精确回查 |
| T05 | 「格式化 JSON」走 `JSON.parse → stringify`，**超过 2^53 的整数被改写** | 新 `detail/jsonFormat.ts`：**词法级保真美化**（`tokenize()` 不解释转义、拒绝尾随逗号），大整数逐字保留。14 测试含「原文语义核验」`stripInsignificantWs` |
| T06 | 保存预览的参数替换用 `replace('?')`，**字符串里的 `?` 也被替换** | 新 `grid/fillParams.ts`：词法扫描（跳过字符串/标识符/注释），只替换代码位置的 `?`。13 测试 |
| T07 | 筛选导出的 SQL 拼表名**不过标识符转义** | 新 `transfer/exportSql.ts` `buildFilteredExportSql()` 走 `core-sql-ident` 的 `quoteQualified` |

## 二、T08–T10：提交契约与冲突闭环

**T08** 把「写库成功」从**猜测**变成**契约**：

- `ipc-channels.ts`：`MutationApplyRequest` 加 `mode?: 'grid-write' | 'ddl'`，语句加 `expect?: 'one' | 'any'`；结果加 `outcome / conflicts / committed`。
- `session-registry.ts` 逐条核对：`expect === 'one'` 时用 `interpretResult(rows)` 判定，非 `ok` 即 **ROLLBACK 整批**并回传 `conflicts`。
- `core-mutation`：UPDATE/DELETE 语句带 `refId`（行身份），冲突明细才定位得到行。

**T09** 冲突闭环三段：整批已回滚 / 草稿仍在 / 重载对比表（原值 vs 待提交值 vs 库中现值）。新 `grid/conflictProbe.ts`（`<=>` NULL 安全探针）+ `grid/SaveConflictModal.tsx`。

**T10** 真库并发门禁 `scripts/e2e-conflict.mjs`（**17/17**）—— 用**真实 SessionRegistry + 真实驱动**，不是替身。关键两条：

- **B5** 证明「先成功的第 1 条 UPDATE 确实被回滚」（`v` 仍是 `a`）——整批回滚不是嘴上说说。
- **C1** 证明**值未变化的 UPDATE 不误报冲突**：MySQL `CLIENT_FOUND_ROWS` 下 no-op UPDATE 返回 `affectedRows=1`，这条是实测确认的语义，不能靠猜。

### 🔴 顺带修掉的既有 P0 缺陷：树右键「删除表 / 清空表」一直是坏的

`mutationApply` 对 DDL 也跑 `checkMutationStatement`，而它的白名单**只有 DML** ⇒ `DROP TABLE` 报「语句类型「drop」不允许由网格保存链路执行」。**既有 e2e 只断言菜单项存在、从不点击，所以一直假绿。**

修法：`mode: 'grid-write' | 'ddl'` + 新增 `checkDdlStatement`（`core-sql-guard`，DDL 白名单 drop/truncate/create/alter/rename）。同时按 T30/R09 修批量删表：逐对象执行/报告、只关「确认已删」的标签、每组回源刷新、**不承诺 DDL 事务回滚**。

## 三、验证方法论（本批最值钱的产出）

- **替身不能照被测代码的假设实现** —— 所以 T10 坚持用真 SessionRegistry + 真驱动。
- **「接口全通」≠「页面能用」**：「删除表」的菜单项存在、命令枚举正确、函数体也对，但写库那一步的防线把它拒了。**只有点下去才发现。**
- **断言要在错误输入上确认会红**：T05 的「原文语义核验」、T11 的反例用例都是这个思路。

---

# 第三批：T11–T12 菜单 / 快捷键单一事实表

## 一、病根不是「谁写错了键」

同一个动作的键位被**三处各写一遍**：`main/menu.ts`（原生 accelerator）、`App.tsx`（window keydown）、`DataGrid/SqlEditorCore/TreeView`（局部 keydown）。三份各自演变，于是：

| 键 | 原生菜单 | 局部 | 后果 |
|---|---|---|---|
| ⌘R | 刷新表结构 | SQL 执行全部 | 菜单层先拦截 → **SQL 侧永远收不到** |
| ⇧⌘E | 导出数据 | SQL EXPLAIN / 网格表达式模式 | 同键**三义** |
| ⌘0 | 重置字体 | 网格设为 NULL | 数据动作被外观动作吃掉 |

🔴 更隐蔽的是：**这类冲突在 DOM 层观测不到**（Electron 的菜单 accelerator 在页面 keydown 之前），所以跑完整套 e2e 也是绿的。

## 二、修法：一张表 + 可执行的查重

`apps/desktop/src/shared/action-catalog.ts` —— 34 条动作，每行 `id / label / accelerator / display / surfaces / scope / availableWhen / localDraftOnly / requiresSqlConfirm / note`。

裁定：⌘R 归 SQL 执行全部（刷新结构 → ⇧⌘R）；⇧⌘E 唯归导出（EXPLAIN → ⇧⌘X，表达式模式 → ⌘E 仅编辑态）；⌘0 唯归重置字体（设 NULL → ⌥0）；⌘S 归保存表修改（SQL 标签下打开「保存为片段」，**不许静默**）；⌘1～9 去掉 `tabs.length <= 9`。

**冲突变成可检测的错误**：`findAcceleratorConflicts()` / `findCrossLayerConflicts()`，`action-catalog.test.ts` 钉住「必须为空」，并用**人为造错的反例**确认断言有证伪能力。

🔴 **写反例时抓到真 bug**：`keySignature` 未归一 `CmdOrCtrl`（Electron 标准写法，全目录都在用）→ `CmdOrCtrl+P` 归一成 `p`、`Cmd+P` 归一成 `cmd+p`，**被判成不同键** ⇒ 查重静默放行；更糟的是没修饰符的 `F12` 会与 `CmdOrCtrl+F12` 撞签名。这正是「已有实现也可能照着自己的假设写」的又一例。

## 三、口径收敛（消灭第 4、5 处副本）

发现同一份键位还有**更多手写副本**，一并收编到目录：

- `SqlEditorPanel` 工具栏四键（原写 `⇧⌘R` / `⇧⌘E`）
- `CellContextMenu`（原写 `⇧⌘E` / `⌘0`）
- `DataGrid` tooltip（原写 `⇧⌘E`）
- `prefs/preferences.ts` 的「快捷键一览」（原写 `⌘R 刷新表结构` / `⌘0 设 NULL`）→ 改为 `HINT_SEEDS` 用 `action:` 指目录、`displayOf()` 取串

**⌘S 也收敛为单点**：新增 `requestSaveActive()`，window keydown 与原生菜单 `case 'save'` 共用同一实现 —— 两条入口各写一遍正是 R05 的成因。

**文档同样是投影**：`npm run gen:actions` 从目录生成 `docs/product/ACTION-CATALOG-自动生成.md`；`--check` 进 `verify` 链，文档过期即红。

## 四、🔴 顺带修掉的第二个真缺陷：⌥0 在 macOS 上按不动

网格「设为 NULL」由 ⌘0 改 ⌥0 之后**仍然收不到按键** —— 因为 macOS 按住 Option 时 `e.key` 是**组合字符**（US 布局 Option+0 = `º`），只判 `e.key === '0'` 永远不成立。已改为认 `e.code === 'Digit0'`（保留 `e.key` 兜底）。

**教训**：改键位不能只改修饰符，还要问「这个键在新修饰符下还产生原来的 `e.key` 吗」。

## 五、旧断言按真实语义修正

`menu.test.ts` 期望 `刷新表结构 = CmdOrCtrl+R` → `Shift+CmdOrCtrl+R`。**这条断言原先锁的是有缺陷的行为** —— 与 T01 的「排序三态」同一类：断言本身没错，但它固化的是一份坏行为。

## 六、门禁

`npm run verify` **exit 0**（本次特意去掉 `| tail` 管道以避免吞掉退出码）：
typecheck 双工程 ✅ · `gen:actions --check` ✅ · **1721 单测 / 57 文件** ✅ · check:bundle **9/9**（首屏 466.9KB）✅ · e2e 及 e2e:transfer/ssh/grid/idle/idle:ui ✅ · e2e:ui **234/234** · e2e:script:data 10/10 · e2e:conflict **17/17** · e2e:script:ui 18/18 · e2e:app **45/45** ✅

