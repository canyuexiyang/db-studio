# REQ-0.7.1 修复迭代（2026-10-26 真机反馈 4 项）

> 来源：用户真机反馈（截图 `iShot_2026-10-26_23.29.44.png`）。
> 本文是这批诉求的**迭代计划**：每项的根因（已核到代码行）、对标竞品的口径、修复方案、
> 非目标、验收口径与任务拆解。状态口径：⬜ 未开始 / 🔄 进行中 / ✅ 已完成 / ⚠️ 待真机确认。
>
> 版本定位：**0.7.1 = 缺陷修复补丁版**。不新增功能入口，只修这 4 项 + 回归既有 16 道门禁。

---

## 零、一句话结论

4 项里 **3 项是「显示/交互口径」问题，1 项是「资源生命周期」问题**，没有一项需要新架构：

| # | 用户描述 | 真实根因（已核到行） | 性质 |
|---|---|---|---|
| 1 | UPDATE 执行结果显示「返回 0 行」 | 驱动层**有** `affectedRows`，但 `runQuery` 只回传 `rows.length`，全链路把「结果集行数」当成了「影响行数」 | 语义丢失（数据在，被丢掉） |
| 2 | 全屏时按钮大小不一 | `.sql-toolbar button` 没有 `white-space: nowrap` 也没有 `flex: 0 0 auto` → 空间不足时被 flex **压缩**，按钮文字折行，宽度参差 | CSS 缺约束（截图可见） |
| 3 | 中间清单单击就打开表 | `ObjectBrowser` 的 `onClick` 直接调 `onOpenObject`，与左树「单击选中 / 双击打开」语义不一致 | 交互不一致 |
| 4 | 连接十几分钟就失效 | `DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000`（10 分钟），且**没有任何心跳保活**；服务端 `wait_timeout` 到点也会杀 | 默认值 + 缺保活 |

**一个必须提前说清的技术坑（需求 1）**：MySQL 的 `affectedRows` 是**已修改行数（changed）**，
不是**匹配行数（matched）**。用户截图那条 `update t_user set password = "123456" where password is null`
如果目标行本来就是 `123456`，`affectedRows` 会是 **0** —— 这不是 bug，是 MySQL 语义。
竞品（Workbench）之所以不误导用户，是因为它显示了 `Rows matched: 1  Changed: 0`。
**所以需求 1 不能只把 `affectedRows` 接到 UI 上，必须同时透出 matched/warnings**，否则我们只是把
「假 0 行」换成了「另一种让人以为没生效的 0 行」。

---

## 一、需求 1（P0）：非 SELECT 语句的执行结果 → 影响行数

### 1.1 用户故事

> 作为**每天要跑数据修复脚本**的用户，
> 我希望执行完 `UPDATE` / `DELETE` / `INSERT` 后，能直接看到「改了几行、有没有漏」，
> 以便**当场判断这条语句是不是按预期生效**，而不是再去 `SELECT` 一遍核对。

### 1.2 根因链（四层，逐层核对过）

| 层 | 文件:行 | 现状 | 问题 |
|---|---|---|---|
| 驱动 | `packages/core-driver-mysql/src/index.ts:156-163`、`:434-440` | `QueryResult` **已有** `affectedRows` / `insertId`（`isResultSet ? rows.length : resultSet.affectedRows`） | 无（数据齐） |
| 会话 | `apps/desktop/src/main/session-registry.ts:78-93`、`:1041-1051` | `QueryOutcome.rowCount = budget.rows.length`，`affectedRows` **被丢弃** | 🔴 断点在这里 |
| IPC | `apps/desktop/src/shared/ipc-channels.ts:221-245` | `QueryOutcomeDto` 无 `affectedRows` / `insertId` / `info` / `warnings` | 契约缺字段 |
| 渲染 | `apps/desktop/renderer/src/editor/SqlEditorPanel.tsx:653`、`:977`、`:1301`；`editor/resultTabs.ts:88-93` | `返回 ${rowCount} 行` / `耗时 x ms · N 行` / 标签标题 `N 行` | 三处统一把「结果集行数」当唯一事实 |

旁证：写操作走的是另一条链路 `MUTATION_APPLY`（`ipc-handlers.ts:401-424`），那里**已经是**
`rowCount: r.affected` —— 说明「影响行数」这个概念项目里早有，只是 SQL 执行通道没接上。本次修复
等于**把两条通道的口径统一**，不是引入新概念。

另外：`UPDATE` 时 `payload` 仍是「0 列 0 行」的合法载荷（`encodeColumnar([], [])`），
所以结果区现在渲染的是一个**空网格**（`SqlEditorPanel.tsx:1397-1420`）+ 一句「返回 0 行」。
这就是用户看到的画面。

### 1.3 竞品口径（对标，不是照抄）

| 竞品 | UPDATE 后展示 | 值得吸收的点 |
|---|---|---|
| MySQL Workbench | Action Output：`1 row(s) affected Rows matched: 1  Changed: 1  Warnings: 0` | **matched / changed 分开给**；warnings 显式 |
| Navicat | 信息栏 `受影响的行: 1`，耗时同排 | 用「受影响的行」而非「返回 N 行」，**词汇区分结果集与写操作** |
| DataGrip | 结果区 `1 row affected`，编辑器下方 `Update completed in 12 ms` | 一句话人话 + 耗时，不画空表格 |
| TablePlus | 底部 `1 row affected` | 不把空网格当结果 |

**共同点**：都不对写操作渲染「空结果表格」；都区分「行数」与「影响行数」的措辞。

### 1.4 方案

**① 契约补齐（四层打通）**

```ts
// core-driver-mysql QueryResult 追加（mysql2 OkPacket 原生就有）
info: string | null;        // 例 "Rows matched: 1  Changed: 1  Warnings: 0"
warnings: number;           // OkPacket.warningStatus

// QueryOutcome / QueryOutcomeDto 追加
affectedRows: number;       // OkPacket.affectedRows（= changed；结果集时 = rows.length）
insertId: number | null;
statementKind: 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';
info: string | null;
warnings: number;
```

`statementKind` 由 `core-sql-guard` 的 `parseStatements`（node-sql-parser，`classifyDanger` 已在用）给出：
新增 `statementKindOf(sql)`，把 AST 的 `type` 字段映射成上表 6 类。**零新依赖**——
`classifyDanger`（`index.ts:333`）已经在 `String(ast?.type)` 上分支，同一份 AST 顺手多给一个值。
解析失败 fail-safe 落 `'other'`（不猜）。

**② 渲染层按语句类型分流文案（单一真值函数）**

新增纯函数 `describeRunResult(kind, { rowCount, affectedRows, insertId, warnings, elapsedMs })`，
**三处消费同一份输出**（结果标签标题 / 消息行 / 内联耗时行），避免三处各写一遍再漂移：

| 语句 | 主文案 | 次信息（消息行补充） |
|---|---|---|
| SELECT | `返回 1,234 行` | 耗时 |
| INSERT | `已插入 3 行` | `自增 ID 起始 1024`（insertId 非 null 时） |
| UPDATE | `已修改 2 行` | `匹配 5 行 · 2 行有变化`（从 info 提取 matched）+ warnings 徽标 |
| DELETE | `已删除 3 行` | 耗时 |
| DDL | `执行成功` | 耗时（DDL 无行数概念，**不要**显示 0 行） |
| 取消 | `已取消 · 120 ms` | 保持现状 |

⚠️ `UPDATE` 命中 0 行但 matched > 0 时，文案必须是**`已修改 0 行 · 匹配 3 行（值未变化）`**，
不能只说「已修改 0 行」—— 这是本次最容易做错的一条，见 §1.7 验收陷阱。

**③ 结果区不再画空网格**

`payload` 列数为 0（非结果集）时，结果区渲染一张**执行摘要卡**而非空表格：
语句类型徽标 + 主文案 + 耗时 + warnings（有则黄色）+「复制 info 原文」。
复用既有 `.sql-message` 与 `.banner` token，不引入新设计语言。

**④ 历史记录同口径**

`recordHistory` 的 `rowCount` 对非 SELECT 写 `affectedRows`（当前 `ipc-handlers.ts:350` 用
`outcome.rowCount`，UPDATE 会记成 0）—— 否则历史面板里全是「0 行」，回溯价值归零。

### 1.5 非目标

- ❌ 不做「多语句合并汇总」（现有设计是每语句一个结果标签，天然逐条清晰，合并反而丢信息）。
- ❌ 不做事务级「共影响 N 行」聚合。
- ❌ 不改 `MUTATION_APPLY` 链路（已正确）。
- ❌ 不引入 `CLIENT_FOUND_ROWS` 连接标志改 `affectedRows` 语义（会污染全局行为，仅靠 info 透出 matched 即可）。

### 1.6 验收

| 类型 | 口径 |
|---|---|
| 单测 | `describeRunResult` 表驱动 12 例（6 类语句 × 有/无次信息）；`resultTabs.resultTabTitle` 对非 SELECT 不出 `N 行`；`core-ipc-codec` 新增字段往返；驱动 `OkPacket → QueryResult` 映射 4 例（结果集 / OkPacket / info 缺失 / warnings 非 0） |
| 真库 e2e（新增 `e2e:affected`） | 真 MySQL 上跑：`UPDATE` 命中 3 行 → 断言 UI 出现「已修改 3 行」且**断言文本不是**「返回 0 行」；`UPDATE` 命中但值未变 → 断言含「匹配 N 行」；`UPDATE` 命中 0 行 → 断言「已修改 0 行」；`INSERT` → 「已插入 1 行」+ 自增 ID；`DELETE` → 「已删除 N 行」；`CREATE TEMPORARY TABLE` → 「执行成功」且**不含**「0 行」 |
| 截图 | 三类语句各一张，肉眼核对文案与无空网格 |

**证伪要求**（沿用项目既有方法论）：新断言必须在**旧实现**上确认变红 —— 具体做法是把
`affectedRows` 强行置 0 跑一遍，验证断言会失败，否则这条断言只是「照着新实现写的」。

### 1.7 🔴 验收陷阱（写在这里防止实现时踩）

1. **affectedRows ≠ matched**：`UPDATE ... SET x = x` 在无 `CLIENT_FOUND_ROWS` 时 `affectedRows = 0`。
   断言里必须有一个「值未变化」的 case，否则上线后用户照样看到 0。
2 个错法是「显示 `payload.rows.length` 与 `affectedRows` 取大者」—— 会把空结果集的 0 变成假值。
3. **DDL 不要显示行数**：`CREATE` 返回 OkPacket 且 `affectedRows = 0`，照抄会显示「0 行」。

---

## 二、需求 2（P1）：工具栏按钮随容器宽度自适应

### 2.1 用户故事

> 作为**把窗口开到全屏 / 收回半屏反复切换**的用户，
> 我希望工具栏按钮在任何窗口宽度下都**保持统一尺寸和单行文字**，
> 以便**不因为按钮被挤压、文字折行而看不清哪个是执行、哪个是取消**。

### 2.2 现象与根因（截图已确认）

截图 `iShot_2026-10-26_23.29.44.png`（1080×316）实测：**9 个按钮全部文字折行成两行**
（「执行全 / 部 ⌘R」「执行当前语 / 句 ⌘⏎」「取消查 / 询 ⌘.」「打开 / 文件」「另存 / 为」…），
宽度参差、第二个字单独成行。

根因（`styles.css:1157-1184`）：

```css
.sql-toolbar { display: flex; align-items: center; gap: 6px; }   /* 无 flex-wrap */
.sql-toolbar button { padding: 3px 11px; ... }                    /* 无 white-space / 无 flex-shrink:0 / 无统一 height */
```

布局算账：左树 240px + 右详情 240px + 分隔条 → 1080px 窗口下中间区仅 **≈570px**，
而工具栏 9 个按钮 + 文件徽标 + 库选择器 + 当前连接徽标实际需要 **≈900px**。
差额被 flex 默认 `flex-shrink: 1` 摊到每个按钮上 → 每个按钮都被压窄 → 文字在空格处折行。
**所以这不是「全屏才有」，是「中间区宽度不足就有」**；全屏反而更宽松，只是用户多数时候在窄窗口下察觉。

顺带一个隐性不一致：`.sql-toolbar` 里按钮有的只有文字、有的 `icon + 文字`（`:1103`、`:1117`、`:1142`、`:1150`），
`display: inline-flex` 生效后 SVG 与文字基线对齐依赖 `align-items: center`，但**没有 `flex: 0 0 auto`**，
图标按钮被压缩时会先挤图标。

### 2.3 方案（三级密度 + 统一尺寸令牌）

**① 统一尺寸（治「大小不一」）**

```css
.sql-toolbar {
  --tb-btn-h: 26px;
  display: flex; align-items: center; flex-wrap: wrap;   /* 放不下就换行，绝不压缩 */
  column-gap: 6px; row-gap: 6px;
}
.sql-toolbar button {
  height: var(--tb-btn-h); padding: 0 11px; line-height: 1;
  white-space: nowrap;          /* 🔴 治本：文字永不折行 */
  flex: 0 0 auto;               /* 🔴 治本：按钮永不被压缩 */
  display: inline-flex; align-items: center; gap: 4px;
}
.sql-toolbar button > svg { flex: 0 0 auto; }
.sql-toolbar .sql-db-select { height: var(--tb-btn-h); }
```

**② 按钮内部结构必须拆 span（否则做不了分级）**

现在快捷键是**纯文本拼接**（`{`▶ ${scope.runAll} ⌘R`}`，`SqlEditorPanel.tsx:1080` 等 6 处），
CSS 无法单独隐藏「⌘R」。改为：

```tsx
<button ...><span className="sql-btn-label">执行全部</span><span className="sql-btn-kbd">⌘R</span></button>
```

⚠️ 连带影响：`e2e` 与快捷键展示逻辑都读过按钮文本（历史上有过 `/^▶ 执行 ⌘R$/` 精确匹配翻车的记录），
本次必须确认现有断言用的是 `data-testid`（`sql-run-all` 等已有）而**不是精确文本**。

**③ 三级密度（治「随屏占比自动缩放」）**

用容器查询 `@container`（面板是 `min-width: 0` 的 flex 子项，加 `container-type: inline-size`）。
**2026-10-27 已拍板走三段式**（不采纳横向滚动：高频的执行/取消会滚出视野）：

| 中间区宽度 | 呈现 |
|---|---|
| ≥ 900px | 全量：图标 + 文字 + 快捷键（现状） |
| 620–900px | 隐藏 `.sql-btn-kbd`（快捷键进 aria-label / tooltip）；文件名徽标收窄到 96px + 省略号 |
| < 620px | 仅图标（label 视觉隐藏，靠 `aria-label` + tooltip 保证可达）；文件名徽标与「执行对象」指示器让位隐藏 |

> 一份例外：连接目标徽标（`sql-conn-target`）**任何宽度都不降级** —— 它是「这条 SQL 会打到哪个库 / 是不是生产」的安全信息，不是装饰。生产环境仍是红底 + ⚠。

不做「字号缩放」：字号已由 `fontZoom`（`workspace/fontZoom.ts`，`body.style.zoom`）统一控制，
再叠一层视口字号会让两套缩放互相打架（0.85 档 + 容器缩放 = 文字小到不可读）。**只做密度分级，不做字号分级。**

### 2.4 非目标

- ❌ 不做可自定义工具栏 / 可拖拽重排。
- ❌ 不改菜单栏与命令面板（⌘K 已有入口，密度降级后仍可全功能触达）。
- ❌ 不动左树/右详情面板宽度逻辑。

### 2.5 验收

| 类型 | 口径 |
|---|---|
| 自动化（新增 `verify:toolbar-fit`，22 条断言） | **起渲染层 dev server + 真 Chromium**，四档视口 1080 / 1280 / 1512 / 2560 下量 `getBoundingClientRect`：①按钮高度**去重后 `size === 1`**（「大小不一」的唯一严格口径）；②高度必须落在 24–28px（折行会让 button 长高）；③`scrollHeight − clientHeight <= 1`（不被裁切）；④三段式密度档位与面板实测宽度一致；⑤纯图标档下每个按钮仍有 `aria-label`/`title`；⑥拉宽后快捷键文字会**回来**（证明不是永久 `display:none`） |
| 视觉 | 四档宽度截图人工确认一眼可辨执行/取消 |
| 回归 | `e2e:ui` 全绿（按钮文本结构变化后选择器不破） |

> 为什么不用真 Electron：被判定的 CSS 是**容器查询**，输入只有「面板自身的 inline-size」，
> 与宿主是 Electron 还是 Chromium 无关；而 Electron 冷启动 + CDP 连不上（屏幕锁定时必现）
> 都是与被测对象无关的翻车点。真机观感另由打包后的人工验收覆盖。

> 这条门禁的价值：`高度去重 size === 1` 在**旧实现**上必然失败 —— 实测把 0.7.0 的
> `.sql-toolbar` 逐字还原后跑到 **14/22**，高度 45.7 / 64.5 / 83.4 / 102.2 / 121.1px
> 五种并存（截图里「全部折行成两行」的量化形态）。是真正能证伪的断言；
> 「截图看着还行」不能当验收。

---

## 三、需求 3（P1）：中间清单单击选中、双击打开

### 3.1 用户故事

> 作为**在中间清单里浏览表**的用户，
> 我希望**单击只选中**（右侧显示表设计 / DDL / 索引），**双击才打开数据**，
> 以便**快速扫一批表的结构时不会每点一下就多出一堆标签页**。

### 3.2 根因与现状

`apps/desktop/renderer/src/workspace/ObjectBrowser.tsx:109-112`：

```tsx
onClick={() => { const node = findByKey(roots, o.key); if (node) onOpenObject(node); }}
```

- **左树**（`tree/TreeView.tsx` 文件头交互契约）已经是「单击选中 + 切换展开 / 双击打开表」——
  用户对左树的预期是成熟的，中间清单是**唯一的例外**。
- 右侧详情面板**本来就支持单击联动**：`App.tsx:903-924` 的 `detailContext` 按 `activeKey`
  在 `treeRoots` 里找 object 节点 → 交接 `DetailPanel`（常驻组件，`:4345`），且树单选也走
  `onSelectNode={(n) => setActiveKey(n.key)}`（`:3881` 附近）。**所以「单击出详情」不需要新建数据通路**，
  只需要把中间清单的单击接到 `setActiveKey` 上。
- 中间清单的 item key 就是树节点 key（`o.key`），`detailContext` 的递归查找能直接命中 —— 无适配成本。

### 3.3 方案

| 动作 | 行为 | 视觉反馈 |
|---|---|---|
| 单击 | `setActiveKey(o.key)` → 右侧详情显示该表 | 行高亮（新增 `.ob-item[data-active="1"]`，用 `--row-selected` token，与树选中同色） |
| 双击 | 现状行为（`onOpenObject` → 打开表标签） | 打开后中间区被 `TablePane` 取代（现状不变） |
| Enter / ⌘↓ | 等价双击（键盘可达性，树也这么做） | — |
| 右键 | 既有对象菜单（不变） | — |

实现要点：
1. `ObjectBrowser` props 增加 `onSelectObject(node)` 与 `activeKey` 派生高亮（`activeKey === o.key`）。
2. 双击用 `onDoubleClick`；**单击不得延迟 300ms 等待判定**（竞品都允许单击立即响应，双击时第二次点击
   自然覆盖选中态，无副作用）—— 不做「单击延迟」的经典错误。
3. `App.tsx:4247` 接线：`onSelectObject={(n) => setActiveKey(n.key)}`。

### 3.4 非目标

- ❌ 不改左树交互（已是目标形态）。
- ❌ 不新增「单击预览浮层」。
- ❌ 不做多选（中间清单暂无批量操作需求）。

### 3.5 连带必须改的既有资产（漏了就是回归）

| 资产 | 位置 | 改法 |
|---|---|---|
| e2e 打开表 | `scripts/e2e-ui.mjs:2136-2141`、`:2462-2467` | `.click()` → `.dblclick()`（**两处**，T19/T20 前置） |
| e2e 截图脚本（临时，收尾已删除） | `scripts/_shot.mjs:55` | 同步双击（否则截图取不到表标签） |
| 选中态样式 | `styles.css:5015-5031` | 新增 `[data-active]` 规则（现在只有 hover / focus-visible） |

### 3.6 验收

- 单测：`objectBrowserModel` 无逻辑变更（选中是纯渲染态），新增「单击不打开」的组件级断言若既有基建支持则加，否则由 e2e 承担。
- e2e（`e2e:ui` 内新增 4 条）：① 单击 `.ob-item` 后**标签数不变**；② 单击后右侧 `DetailPanel` 表名等于该表；
    ③ 双击后标签数 +1 且 `pane-<table>` 出现；④ 单击 A 再单击 B，选中高亮只有 1 个（`[data-active="1"]` count === 1）。
- 真机：⚠️ 待确认「双击手感」（两次点击间隔、是否误触发标签打开）。

---

## 四、需求 4（P0）：连接有效期延长

### 4.1 用户故事

> 作为**开着工具间歇性查数据**的用户，
> 我希望连接能长时间挂着（几小时不用也不断），
> 以便**回来就能直接查**，而不是每次都要重新连、重新输密码、重新等握手。

### 4.2 根因（两个独立原因叠加，只修一个不够）

**① 本地主动断开：默认 10 分钟**

`packages/core-connection/src/index.ts:95`：`DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000`。
`ConnectionRuntime.armIdleTimer()`（`:386-394`）到点 `transition('closed', '空闲超时，自动断开释放资源')`。
连接编辑器（`connection/ConnectionEditor.tsx:443-451`）把这个值以**分钟**暴露给用户，可改 ——
但默认 10 分钟对「间歇性查看」的使用姿态（AGENTS.md §一 目标用户画像）明显偏短。
（v1.3 已修过它的次生灾害：idle 后自动重连 + `releaseIdleSession` 释放资源，但**默认时长本身没动**。）

**② 服务端主动杀连接：无心跳保活**

即使本地不断，MySQL 服务端 `wait_timeout`（自建默认 8h，但现在大量云托管 / RDS / 代理层是
**60s ~ 600s**）会单方面断开。我们**没有任何 keepalive**（全仓无心跳实现），
所以用户感受的「几分钟、十几分钟就失效」很可能是 **①+②混合**：
本地 10 分钟断开，或服务端 5 分钟杀掉后我们才在下次查询时报错重连。

> 结论：**只把 10 分钟改长解决不了一半问题**。必须同时加保活，否则「改成 2 小时」只是把断线从
> 「本地温和断开」变成「服务端硬杀 + 首次查询报错」。

### 4.3 竞品口径

| 竞品 | 默认行为 |
|---|---|
| Navicat | 默认**不自动断开**；连接设置里有「保持连接间隔（秒）」，到点发一次轻量查询保活 |
| DataGrip | 默认不主动断；连接池有 `keep-alive` 探活，失效连接自动重建 |
| TablePlus | 保持连接，断线后自动重连（无空闲超时概念） |
| DBeaver | `Keep-Alive` 默认 120s，`Connection keep-alive` 可关 |

**共同点：默认不断 + 定时保活 + 断了自动重连。** 我们是三者里最保守的（10 分钟主动断 + 无保活）。

### 4.4 方案（分三档，推荐 B）

| 档 | 做法 | 取舍 |
|---|---|---|
| A 最小改动 | 默认 `10min → 120min` | 5 分钟改 1 行；服务端 `wait_timeout` 问题仍在 |
| **B 推荐** | 默认 **120 分钟** + **心跳保活 60s** + 断线自动重连（已有 `autoReconnect`）+ 设置项标注「0 = 不自动断开」 | 覆盖两个根因，改动可控（~3 文件） |
| C 激进 | 默认**永不主动断**（`0`）+ 心跳 60s + 休眠/锁屏释放 | 最贴竞品，但长连接占用服务端连接数、SSH 隧道常驻，需额外处理合盖/sleep（`powerMonitor`） |

**推荐 B**（2026-10-27 已拍板采纳）：理由是本产品差异点是「反应最快」，用户抱怨的核心是「要重连」，
B 已经解决；C 需要额外做系统休眠监听与连接数上限，属于 0.8.0 的正经功能（可进路线图）。

**B 的具体改动**

1. `core-connection/src/index.ts:95`：`DEFAULT_IDLE_TIMEOUT_MS = 120 * 60 * 1000`，
   并在注释里钉住「这是默认值不是硬编码，连接级可覆盖；0 = 永不自动断」。
2. **新增 keepalive（`session-registry.ts`）**：
   - 间隔 60s；仅 `state === 'connected'` 且**无查询在跑**（`running` 表空）且**距上次活动 > 60s** 时发。
   - 实现用既有 `driver.query('SELECT 1')`，**必须走连接的串行队列**，且**不推进状态机**
     （`beginQueryTracked` 会把连接标 busy → 用户此时点执行会吃 `BUSY`，这是最容易踩的坑）。
   - 心跳失败 **连续 2 次**才判死 → 交给既有 `autoReconnect`（不直接 `transition('failed')`，
     避免偶发网络抖动把连接打成失败态并弹横幅）。
   - 心跳也刷新 `lastActivityAt`，让 idle 计时从「最后一次真实活动」算起。
3. `ConnectionEditor.tsx:443-451`：文案补一句「0 = 永不自动断开；建议 120 分钟」，
   并在输入为 0 时给一次轻提示（不阻断）。
4. 断开入口保持显式（手动断开 / 退出应用释放），不做后台静默残留（SSH 孤儿红线仍由 `releaseIdleSession` 兜底）。

### 4.5 非目标

- ❌ 不做连接池 / 多连接复用。
- ❌ 不做「后台常驻连接保活到应用退出」（C 档，留 0.8.0）。
- ❌ 不改密码保存机制（`core-secret`）。

### 4.6 验收

| 类型 | 口径 |
|---|---|
| 单测 | `core-connection`：默认值 = 120min；`idleTimeoutMs = 0` 时不 arm 定时器；keepalive 调度器纯函数（应发/不该发 6 例：忙 / 刚活动过 / 已断开 / 到点 / 连续失败 1 次 / 2 次） |
| 真库 e2e（扩 `e2e:idle-reconnect.mjs`） | ① 显式传 `idleTimeoutMs: 3000` 仍能走到 closed 并推送（回**归现有 16 项**，证明默认值改动没破坏机制）；② 心跳：把服务端 `wait_timeout` 压到 5s（fixture 可改 `SET GLOBAL`），开着连接闲置 20s，断言**连接仍 connected 且能直接查**，不出现 closed；③ 心跳失败路径：`KILL CONNECTION` 后断言 2 次内进入重连并恢复可查 |
| 真机 | ⚠️ 需人工：合盖 → 唤醒后是否自动恢复（B 档未处理 sleep，预期「唤醒后首次查询触发重连」，需确认为可接受体验） |

### 4.7 🔴 真机验证反查出的第三个根因（已修，`normalizeError` 补码）

写 `e2e:keepalive` 时 C 段红了：`KILL CONNECTION` 之后状态机**一直停在 `connected`**，
心跳发了、报错了，但连接"看起来"还活着 —— 于是重连链路根本没被触发。

探针（真 mysql2 + 真库）给出的答案：

```
[wait_timeout 掐断后 query]        [KILL CONNECTION 后 query]
  message = Can't add new command when connection is in closed state
  code    = undefined               ← 没有 code
  fatal   = true                    ← 只有这个
```

`isConnectionLostError()`（`session-registry.ts:1405`）只认 `code`，
而 mysql2 在"连接已死"之后抛的连接级错误**恰恰没有 code**。补码责任放在驱动层
`core-driver-mysql/.../normalizeError()`：`fatal === true` 且无 code → 归一到
`PROTOCOL_CONNECTION_LOST`（不新造码，下游断线码表不用学第二套）。

**影响面比需求 4 更大**：服务端 `wait_timeout` 掐断、代理/网关回收连接、合盖唤醒后
`ECONNRESET` 这些**都不是**带 code 的错误 —— 在这之前它们全被漏判，用户看到的是
"连接正常但每条查询都报错，只能手动断开重连"。这条修复顺带治好了这个老症状。

**方法论教训（写进记忆）**：`session-registry.test.ts` 的 `LOST()` 替身是
`Object.assign(new Error(...), { code: 'PROTOCOL_CONNECTION_LOST' })` —— 替身照着
"我以为的错误形态"实现，于是 6 条断线用例全绿，而真机上一个都触发不了。
**替身必须照着真库的观测结果实现，不能照着被测代码的假设实现。**

---

## 五、优先级与排期（单补丁迭代）

RICE 简评（Reach = 受影响用户比例，Confidence = 证据强度）：

| # | 诉求 | Reach | Impact | Confidence | Effort | 优先级 |
|---|---|---|---|---|---|---|
| 1 | 非 SELECT 影响行数 | 100%（所有跑写语句的人） | 高（判断是否生效） | 高（根因已核到行） | M | **P0** |
| 4 | 连接有效期 | 100%（所有用户，每次使用） | 高（核心体验） | 中高（两因叠加，需真库验） | M | **P0** |
| 3 | 单击/双击语义 | ~60%（用中间清单的人） | 中（误开标签的烦躁） | 高 | S | **P1** |
| 2 | 工具栏自适应 | 100%（视觉第一印象） | 中（可辨识性） | 高（截图实证） | S | **P1** |

**实施顺序**：1 → 4 → 3 → 2。理由：1、4 动 IPC 契约与连接生命周期，**先是硬骨头且互相独立**；
3、2 是纯渲染层，放后面可以吃前两项的联调空窗，且都属 S 级可并行。

---

## 六、任务拆解（12 项，可 1:1 建子任务）

| ID | 任务 | 层 | 依赖 | 验收 |
|---|---|---|---|---|
| T01 | 驱动 `QueryResult` 补 `info` / `warnings`（OkPacket 映射） | driver | — | 单测 4 例 |
| T02 | `core-sql-guard` 新增 `statementKindOf(sql)`（映射 AST `type`，与 `classifyDanger` 同解析器，零新依赖） | guard | — | 单测 6 类语句 + 解析失败落 `other` |
| T03 | `QueryOutcome` + `QueryOutcomeDto` 补 5 字段，`QUERY_RUN` 透传 | main/ipc | T01,T02 | 单测 + codec 往返 |
| T04 | `describeRunResult` 纯函数（6 类语句 × 次信息） | renderer | T03 | 表驱动 12 例 + **旧实现证伪** |
| T05 | 三处消费统一（标签标题 / 消息行 / 内联耗时）+ 非结果集改摘要卡 | renderer | T04 | e2e:affected |
| T06 | 历史 `rowCount` 改口径（写操作记 affectedRows） | main | T03 | 单测 |
| T07 | keepalive 调度纯函数 + `session-registry` 接线（不推状态机 / 不抢 BUSY） | main | — | 单测 6 例 |
| T08 | `DEFAULT_IDLE_TIMEOUT_MS` 120min + 连接编辑器文案（0 = 不断） | core-connection/renderer | — | 单测 + 真库闲置 |
| T09 | 心跳失败 2 次 → 交 `autoReconnect`；`KILL CONNECTION` 场景验证（**+ 反查出 `normalizeError` 漏补 `fatal` 码**，见 §4.7） | main/driver | T07 | 真库 e2e `e2e:keepalive` 17 例 |
| T10 | `ObjectBrowser` 单击选中 + `[data-active]` 样式 + Enter 打开 | renderer | — | e2e 4 条 |
| T11 | e2e 资产同步：`e2e-ui.mjs` 2 处改双击（临时 `_shot.mjs` 已随收尾删除） | test | T10 | 全绿 |
| T12 | 工具栏统一尺寸令牌 + span 拆分 + 三级密度 + `verify:toolbar-fit` | renderer/test | — | 高度 size===1 |

**新增门禁 3 道**（进 `verify` 链）：`e2e:affected`、`e2e:keepalive`、`verify:toolbar-fit`。
**扩展现有门禁 2 道**：`e2e:idle-reconnect`（回**归 16 例全绿**）、`e2e:ui`（+单击/双击 4 条）。

---

## 七、风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `affectedRows` 被当成 matched 展示 | 用户误判「没改到」/「改多了」 | §1.7 三个陷阱 + 「值未变化」case 必测 |
| 心跳与用户查询抢连接 → `BUSY` 误报 | 点执行报「已有查询在执行」 | 心跳走串行队列且不 `beginQueryTracked`；单测钉住 |
| 默认 120 分钟导致服务端连接堆积 | DBA 抱怨 / 云账单 | 心跳+长连接是竞品标配；设置项可调；文档标注「0 = 不断，长连接请自行评估」 |
| 双击改造破老用户肌肉记忆 | 抱怨「点了没反应」 | 单击有明确选中高亮（视觉上「点到了」）；Enter 也能开；0.7.1 Release note 写明 |
| 按钮 span 拆分破 e2e 精确文本选择器 | 门禁假红 | 实施前先全仓扫 `sql-toolbar` / 按钮文本断言，统一改 `data-testid` |
| 改 IPC 契约 → 旧版本渲染层/主进程混跑 | 字段缺失 undefined | 新字段全部可选语义 + 渲染层对 `undefined` 走旧文案（前向兼容） |

**回滚**：4 项彼此独立、各自单 commit，任一可单独 revert；`0.7.0` 安装包已在
`release/.prev-installed-*` 备份，可退版本。

---

## 八、发布检查清单（0.7.1）

- [x] 版本号唯一来源 `package.json` → `0.7.1`（修 bug 必升补丁号，避免同号两二进制）
- [x] `npm run verify` **exit 0**（16 道 → **19 道**：新增 `e2e:affected` / `e2e:keepalive` / `verify:toolbar-fit`；单测 2200 → **2273**）
- [ ] `npm run verify:installed` 22/22（**先清实例**：`pgrep -fl "MacOS/DB Studio"` → `kill -15`）
- [ ] `npm run verify:traffic-lights` 6/6（**先查锁屏**，锁屏下 CDP 必超时）
- [ ] 真机人工：4 项各自按 §1.6/§2.5/§3.6/§4.6 复验一次（含双击手感、合盖唤醒）
- [x] `docs/RELEASES.md` 追加 v0.7.1 条目（4 项 + 新增门禁 + 已知限制「合盖唤醒需首次查询触发重连」）
- [ ] GitHub Release：资产名**连字符**（`DB-Studio-0.7.1-arm64.dmg`），核对 `latest-mac.yml` 的
      sha512 + size 与远程一致；旧 `.app` 先 `mv` 到 `release/.prev-installed-0.7.0.app`

### 8.1 已取得的证据（2026-10-28）

| 项 | 证据 | 结论 |
|---|---|---|
| 需求 1 | `packages/core-driver-mysql` 6 例 + `session-registry` 5 例 + `resultMessage` 19 例 + `e2e:affected` **21/21**（真库） | 通过。真库反查到 `mysql2` 默认带 `CLIENT_FOUND_ROWS`，`affectedRows` 是 matched；changed 只能从 `info` 解析 |
| 需求 2 | `verify:toolbar-fit` **22/22**；把 0.7.0 的 `.sql-toolbar` 逐字还原后 **14/22**（高度 45.7/64.5/83.4/102.2/121.1px 五种并存） | 通过，且门禁具备证伪能力 |
| 需求 3 | `e2e:ui` 新增 4 条（单击只选中不出标签 / 双击才开 / 选中态高亮 / 详情换成表设计）**377/377** | 通过 |
| 需求 4 | `core-connection` 12 例 + `session-registry` 6 例 + `e2e:keepalive` **17/17**（真库，含「对照组裸连接确实被掐」的反向断言）+ `e2e:idle-reconnect` 16/16 | 通过 |
| 回归 | `check:bundle` 9/9（首屏 538.0 KB，未增长）；`typecheck` 全绿 | 通过 |
| 证伪检验 | `parseMatchedRows` 临时退化为 `null` → 2 条断言变红后恢复；工具栏旧实现 → 门禁 14/22 | 断言不是照着实现写的 |

**门禁自身事故（已修，值得记住）**：首轮 `verify` 卡在 `e2e:conflict`，断言其实**已经 17/17 全绿**，
但进程 10 分钟不退出。原因是 0.7.1 新增的保活 `setInterval` 是活跃句柄，而那个脚本成功路径
没有 `process.exit(0)`，靠事件循环自然排空结束。修法两条防线：①建定时器时 `unref()`；
②最后一条活连接断开时 `clearInterval`（否则用户断开全部连接后它还在空转）。已补 2 条单测钉住。
教训：**"断言全绿"与"门禁跑完"是两件事** —— 一个永远不退出的进程会让整条链静默挂死，
而且因为 `tee` 缓冲+`tail` 看不到任何输出，看起来像"没报错"。

---

## 九、已决策（2026-10-27 用户拍板）

| 决策点 | 结论 | 落点 |
|---|---|---|
| 连接有效期默认值 | **B 档：默认 120 分钟 + 心跳保活 60s + 断线自动重连**（`0` = 永不主动断，设置项保留） | §4.4，T07–T09 |
| 窄窗口降级方式 | **三段式：全量 → 隐藏快捷键（进 tooltip）→ 仅图标**（`aria-label` + tooltip 保证可达） | §2.3 ③，T12 |

**明确排除**（留 0.8.0 路线图）：C 档「永不主动断 + 系统休眠监听释放」—— 需 `powerMonitor` 与连接数上限，
属正经功能而非补丁；「横向滚动不换行」方案不采纳（高频按钮会滚出视野）。

> 其余按本文直接实施，不再二次确认。
