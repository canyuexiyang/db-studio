# 版本发布记录

DB Studio 的**发布历史与门禁基线**。每次打包发版后在这里追加一条，GitHub Release 的说明从这里摘。

- **版本号唯一来源**：根 `package.json` 的 `version`（electron-builder 写入 `Info.plist`，子包版本不参与）。
  改版本号**只改这一处**，不要动 `apps/desktop/package.json`。
- 发版流程与陷阱见 [`docs/devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md`](devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md) §九。

## 版本总览

| 版本 | 日期 | 主题 | 门禁 | 分发 |
|---|---|---|---|---|
| **0.6.1** | 2026-10-13 | **P0 热修**：脚本导入数据丢失（50000 行只落 30~50）+ 写入行数核对 | 1645 单测 / verify exit 0 / verify:installed 22/22 | ✅ GitHub Release + 本机安装 |
| 0.6.0 | 2026-10-10 | 真机体验修复与功能增强（6 项 + 脚本性能） | 1639 单测 / e2e:ui 226 / e2e:app 45 | ✅ GitHub Release + 本机安装 |
| 0.5.0 | 2026-09-30 | v1.3 缺陷清理（6 项真机反馈） | 1563 单测 / e2e:ui 219 / e2e:app 45 | ✅ GitHub Release + 本机安装 |
| 0.4.0 | 2026-09-29 | v1.2 功能收官（P1-A/P1-B/P1-C/P2/S/W） | 1548 单测 / e2e:ui 190 / e2e:app 45 | ✅ GitHub Release |
| 0.3.0 | 2026-09-27 | 网格 C 轮：行号列与整行操作（A19~A22） | — | 仅本地 dmg |
| 0.2.0 | 2026-09-27 | 连接编辑器布局重排 + 库/表级 SQL 脚本导入 | — | 仅本地 dmg |
| 0.1.0 | 2026-09-26 | v1.0 收官（首个可打包版本） | — | 仅本地 dmg |

> 0.1.0~0.3.0 只在本地打了 dmg、未发 GitHub Release，也没有留下门禁数字；
> 主题按同期 `devlog/` 与 dmg 产物时间对应，未做追溯补录。

---

## v0.6.1（2026-10-13）—— P0 热修：脚本导入数据丢失

**缺陷**：SQL 脚本导入（CREATE TABLE + 大量 INSERT）执行后表建成了，但每表只写入 30~50 行，
UI 却显示「已执行 50004 条、0 失败」。

**根因**（`packages/core-import/src/runtime.cjs` 的 `mergeTwoInsert`）
worker 的合并写法是 `pending.sql = mergeTwoInsert(pending.sql, pending.shape, shape)` 但
**不更新 `pending.shape`** → 第二次合并时传入的仍是最初那一条的值组，
于是「头部 + 最初那 1 组 + 新那 1 组」= **只剩 2 组**，中间组被静默丢弃。
真库实测：每批 50 条语句但 `affectedRows` **恒为 2**，50000 行只落 **2002 行**。

**修复**
1. `mergeTwoInsert` 改为**从 prevSql 自身切出头部 + 全部值组**再拼 → 合并变幂等。
   切分只按括号配对，引号内的括号/逗号原样保留
2. 新增 `scripts/e2e-script-data.mjs`（真库数据完整性门禁，10 项），
   **已验证能抓住旧缺陷**：回退旧实现 → 6/10，4 项红（2002 / 50 / 82 行）
3. worker 采集并上报 `affectedRows`；UI 在 done 阶段做一致性核对，
   严重背离且 0 失败时**显式告警**（不再显示「全部成功」）
4. `e2e:script:data` 与 `e2e:script:ui` 一并接入 `npm run verify`

**门禁**：1645 单测（+6 回归守卫）｜ `npm run verify` **exit 0** ｜ `verify:installed` **22/22**（installed=0.6.1 declared=0.6.1）
**旧包回滚**：`apps/desktop/release/.prev-installed-0.6.0.app`

---

## v0.6.0（2026-10-10）—— 真机体验修复与功能增强

6 项真机诉求 + 1 项性能诊断，父任务 `r9JtRI`。

**① SQL 收藏按库归属**：片段从「全局 name UNIQUE」改为「(连接, 库, 名称) 库内唯一」。
名称上限 25 个汉字（**按码点计**，emoji 与代理对汉字都算 1 个 —— 用 `length` 会误拒）。
旧片段迁移到「全局」作用域（不猜库，避免把老收藏藏起来）。**迁移用空串哨兵而非 NULL**：
SQLite 的 UNIQUE 里 NULL 不参与冲突判定，用 NULL 会让"库内唯一"静默失效。

**② 中间面板跟随左侧树**：无打开标签时，中间显示对象清单而非空白/快捷入口卡。
选中某库 → 列出该库对象；选中某类别 → 只列该类；未选 → 全部连接概览。**不新增 IPC**。

**③ 修复「刷新看不到新表」**（三处根因叠加，全部修掉）：
- `session-registry` 的 `introspect` 被 `defaultDatabase` 限死 → 配了默认库的连接**永远只刷那一个库**
- 磁盘快照命中后直接 return，注释承诺的「先渲染快照再后台刷新」**全仓无实现**
- 脚本执行完只在**关弹窗**时才刷新，且 `.catch(() => undefined)` 静默吞错

现在：刷新覆盖连接可见的全部库；快照路径后台回源，结构真变了才推送（避免每次重渲染上千节点）；
脚本 done 事件到达即刷新，失败如实报错。

**④ 树多选 + 批量删除**：⌘ 点选/取消、⇧ 按可见顺序取区间、分类右键「全选本组」。
批量删除按 (连接, 库) 分组执行，确认弹窗**列出全部 SQL 原文**，生产环境要求输入表数量。
标识符走 `core-sql-ident`（红线 5），复用 `confirmLevelFor` 的分层确认。

**⑤ 分组行补类别图标**：树是三行容器里唯一没有图标的（库/对象都有）。新增 `IconFolder` + 接线 `kind` 分支。

**⑥ 红绿灯垂直对齐 + 顶部可拖窗**：`.sidebar-head` 30 → **42px**（= 2 × 灯中心 21），
并加 `app-region: drag`（顶部空白此前拖不动窗、也不能双击铺满）。

**⑦ SQL 脚本执行提速**（用户报「比 Navicat 慢好几倍」）：
实测根因是**每条语句一次 fsync**（单条 0.475ms 里 fsync 占 0.208ms = 61%），不是解析器。
两个改动：每 **50 条一事务**（非全局单事务 —— 保住 D3「已执行不回滚」）+
**合并连续 INSERT**（同库同表同列才合，拒 `ON DUPLICATE`/`INSERT...SELECT`/含分号的）。
基线 3000 条 1425ms → 预期 143ms（**10x**）。

**门禁基线**

| 门禁 | 结果 |
|---|---|
| `npm test` | **1639** 项 / 50 文件（基线 1563，新增 76） |
| `npm run check:bundle` | 9/9；首屏 **442.5 KB** / 1465 KB |
| `npm run e2e:ui` | **226/226** |
| `npm run e2e:app` | **45/45**（真 Electron） |
| `npm run e2e` / `e2e:transfer` / `e2e:ssh` | 74 / 28 / 18 |
| `npm run e2e:idle` / `e2e:idle:ui` / `e2e:grid` | 16 / 4 / 通过 |
| `npm run e2e:script:ui` | 18/18（含「脚本执行后 schema 自动刷新」） |
| `npm run verify` | **exit 0**（全链：typecheck → 单测 → bundle → e2e 全家桶） |
| `npm run verify:installed` | **22/22**（0.6.0 已安装，真Electron 跑通全链路） |
| `verify:traffic-lights` | **6/6**（三灯 @(23,21)/(46,21)/(69,21)，占 x∈[16,76]，y 一致） |

**本版修掉的工具链问题（会影响后续每一次改动）**
- `verify:traffic-lights` 在**无前台GUI 会话**下会把环境问题误报成产品缺陷 → 改为先校验「窗口在不在截图里」，不在就显式跳过并说明
- vite/vitest 的 **alias 前缀匹配**：子入口（`core-history/snippet-name`）必须排在同名主入口**之前**，
  否则拼成 `index.ts/snippet-name`。**typecheck 与单测都发现不了，只有 build 才炸**（AGENTS.md 说的"三处"实为四处）

**遗留（建议人工看一眼，不阻塞发布）**
- 红绿灯的**像素判定已 6/6 通过**（实测三灯 @(23,21)/(46,21)/(69,21)、占 x∈[16,76]、y 一致，
  正好等于 `.sidebar-head` 42px 的一半，对齐公式得到验证）。但**拖窗手感与双击铺满的体感**没法用像素断言，
  建议在桌面亲手试：拖顶部空白区移动窗口、双击铺满、悬停交通灯是否出现 ✕─＋ 符号。
- 脚本提速的 10x 是**离线实测外推**（1425ms → 143ms），建议真机跑一份万条 INSERT 脚本复核实际耗时。

###门禁脚本本轮修掉的一串假红（都会影响后续每一次改动）
- `screencapture -R` 失败曾被当成门禁失败 → 改为降级整屏截图 + canvas 裁剪，判定强度不变
- 无前台 GUI 会话时曾把环境问题报成「🔴 检测到 0 个灯 / frame:false 静默失效」→ 先校验窗口是否真在截图里，不在就显式跳过
- 🔴 **区域截图产出的是物理像素不是逻辑像素**（`-R 400,160` → 实测 800×320），却按 scale=1 处理 → 阈值与真实灯尺寸错开，
  报「一个都没检测到」，而**同一张截图肉眼明明三灯齐全**
- `window.screen.width` 当缩放分母（那是窗口宽度不是屏幕宽度）、`window.screen` 在 Electron 里可能是 null → 改用主进程注入的 `scaleFactor`
- 两条截图路径的 crop 语义不同（区域图已裁好不偏移 / 整屏图要按 bounds 裁）→ 用 `offset` 标志区分
- 收尾判定改为区分 passed / skipped / failed ——**门禁悄悄跳过 ≠ 门禁通过**

**已知未修**：应用内「检查更新」不通（缺 `app-update.yml` 与 electron-builder 的 `publish:`）。

---

## v0.5.0（2026-09-30）—— v1.3 缺陷清理

用户真机反馈的 6 项缺陷逐项修复并验收，另含两处顺手修掉的真缺陷。详见
[`product/REQ-v1.3-缺陷清理.md`](product/REQ-v1.3-缺陷清理.md)。

**6 项缺陷**

1. **表格无法编辑** —— 真因是连接空闲 10 分钟自动断开后渲染层不重连（`connStates` 只在启动读一次）。
   改为渲染层订阅主进程状态推送 + 数据拉取统一在 `loadTable` 内 `ensureConnection`。
   「真机放置 10 分钟」已压成秒级自动化：`e2e:idle` 16/16（主进程侧）+ `e2e:idle:ui` 4/4（状态栏侧）。
2. **复制默认不带列名表头** —— 默认只复制值；需要列名走复制菜单的「含列名」。
3. **树单击表详情面板不联动** —— 树选中优先，回退激活标签。
4. **筛选界面布局乱 / 点击过多 / 按钮丑** —— 条件行改 CSS Grid 六条固定列轨、AND/OR 一步切换（LogicChips）、按钮样式统一。
5. **详情面板重构** —— 表信息保留；字段注释常驻显示；第三块改为建表语句 DDL；单元格完整值迁入 `CellValueModal` 弹窗。
6. **左上角无 macOS 原生红绿灯** —— 推翻 v1.2「灯已存在、只需让位」的结论：`frame:false` 下 Chromium **根本不创建**窗口按钮视图，
   `setWindowButtonVisibility(true)` 静默无效。唯一可用组合是 `titleBarStyle:'hidden'` + `transparent:true` + `trafficLightPosition`。
   并固化像素级门禁 `npm run verify:traffic-lights`（6/6）。

**顺手修掉的两个真缺陷**

- 筛选「取消」是空按钮（草稿污染全局态）、徽标虚报且「N 条未填完已跳过」永不显示 → 新增 `effectiveConditionCount()`，口径与 `buildWhere` 一致。
- 陈旧会话快照恢复出指向已删连接的标签（状态栏「连接：未知」、执行按钮可点却必失败）→ 过滤下沉到纯函数 `restorePlan(snapshot, isKnown)`。

**门禁基线**

| 门禁 | 结果 |
|---|---|
| `npm test` | **1563** 项 / 47 文件 |
| `npm run check:bundle` | 9/9；首屏 **442.5 KB** / 1465 KB；编辑器 lazy 133.0 / 150 KB gzip |
| `npm run e2e:ui` | **219/219** |
| `npm run e2e:app` | **45/45** |
| `npm run e2e:idle` / `e2e:idle:ui` | **16/16** / **4/4**（本版新增，已进 verify 链） |
| `npm run verify:installed` | **22/22**（本版新增版本一致性断言） |
| `verify:traffic-lights` | 6/6 |

**遗留（必须人工）**：交通灯三灯手感与系统拖拽带是否打架；筛选/详情面板的视觉精修人工比对。
**已知未修**：应用内「检查更新」不通（缺 `app-update.yml` 与 electron-builder 的 `publish:`/`RELEASE_URL`）。

---

## v0.4.0（2026-09-29）—— v1.2 功能收官

首个公开 GitHub Release。六大板块：P1-A 补断层（V1~V7）、P1-B 网格编辑深度（V8~V13）、
P1-C（连接与导入导出）、P2（打包与发布）、S（SQL 编辑器增强 S0~S4）、W（窗口原生控件）。

门禁：1548 单测 / 首屏 421.6 KB / e2e:ui 190 / e2e:app 45 / e2e:smoke 74 / e2e:transfer 28 / e2e:ssh 18。

> ⚠️ 该版 W 板块「交通灯已存在、只需让位」的结论**已被 v0.5.0 证伪并推翻**，见上。
