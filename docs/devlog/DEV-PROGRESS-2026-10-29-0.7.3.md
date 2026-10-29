# 2026-10-29 · 0.7.3 交互完备性缺口全量落地

> 需求与逐项取舍见 [`product/REQ-0.7.3-交互完备性落地.md`](../product/REQ-0.7.3-交互完备性落地.md)，
> 排查来源见 [`product/AUDIT-0.7.2-交互完备性排查.md`](../product/AUDIT-0.7.2-交互完备性排查.md)。
> 本文只记**当日真机/门禁抓出来的东西**和**踩过的坑**，不复述需求。

## 一、交付

11 个子任务（todo `rWzZlb`）+ 1 项自查补口全量落地：新建/删除数据库、5 类对象新建模板、
视图改定义、重命名表（F2）+ ⇧F2 进设计器、清单右键与 ↑↓ 巡行、整库导出、测试连接、
标签「关闭左侧/关闭全部」、表维护（优化/分析/检查）、复制表（结构/结构+数据）、分组管理。

门禁：单测 2391 → **2473（92 文件）**、e2e:ui 434 → **476**（新增第 14 章）、
`npm run verify` exit 0（19 道）、`verify:installed` **22/22**。

## 二、e2e 抓出的 4 个既有真缺陷（都不是本轮写坏的）

1. **删库 / 表维护的成功回执被刷新 toast 盖掉**：`onRefreshConnSchema` 自己会
   `setToast('已刷新表结构')`，而回执写在 `await` 之前 → 用户永远只看到「已刷新表结构」。
   修法是把顺序钉死：**先登记定位意图 → await 刷新 → 最后才报回执**，三处（建库/删库/维护）同一顺序。
2. **表设计器是全仓唯一退不出的模态**：`App` 的快捷键拦截注释写着「Esc 留给模态关闭」，
   但 `TableDesigner` 从来没有任何 keydown 监听，也没有 footer 取消按钮的语义钩子。
   e2e 里 ⇧F2 打开后关不掉 → 残留 `.modal-mask` 把后续所有点击吃掉，表现为**一串 30 秒超时**。
   补了 window-capture 的 Esc（`saving` 期间禁止关闭、内层有弹窗时让给内层）。
3. **建库/改名后树不展开定位**：`useMemo` 依赖时序 —— 刷新完成时树还没重建。
   用 `pendingRevealRef` + 依赖 `treeRoots` 的 effect，且**登记必须在 `await` 之前**（否则 effect 已空跑）。
4. **demo 后端恒返回同一份库结构**：`DEMO_DATABASES` 常量直接返回 →
   建库/删库/改名/复制在纯浏览器 e2e 里**全是假绿**。改成可变 `demoDatabases` + 每次产出新数组
   （同一 ref 会让 `useMemo` 判未变）+ `demoApplyDdl` 真改结构。

## 二之二、发版准备时抓出的第 5 个：发布通道 owner 拼错

`electron-builder.yml` 的 `publish.owner` 是 `canyuexiang`，真实账号 `canyuexiyang`（少一个 y）。
`api.github.com/repos/canyuexiang/db-studio` 实测 **404**，而 `canyuexiyang` **200**。

这属于**沉默的错误**：产物里 `app-update.yml` 指向一个不存在的仓库 → 应用内「检查更新」
永远 `failed`；而 Release 页本身是好的（0.7.2 发版时手工验的是 `canyuexiyang` 的下载 URL，
根本没经过 owner 这一行），所以两轮发版都没发现。

修法：owner 改成 `canyuexiyang`；`updater.ts` 的回退 URL 同步；给 `package.json` 补
`repository` 当**第二证据源**；加 3 项单测钉住「`publish.owner/repo` == `repository.url`
== `releaseBaseUrl()`」。**新断言在错 owner 上实测 2 红**（先确认会红再加进来）。

教训：凡是「配置项 + 代码常量 + 产物里生成的文件」三处都写同一个外部标识的，
必须有一个测试把它钉成等式 —— 否则错的那个永远不会报错，只会静默失效。

## 三、守卫层的真实缺口（`core-sql-guard`）

`node-sql-parser 5.4.0` 实测：**不认**带反引号的 `DROP DATABASE`、
**完全不认** `OPTIMIZE / ANALYZE / CHECK / REPAIR TABLE` → 删库与表维护在 DDL 入口被永久判「不安全」，
不是 UI 没做，是守卫层根本放不过去。

补法刻意收窄：**只在 AST 解析失败之后**才走**闭合枚举 + 整串锚定**的文本兜底
（`ADMIN_DDL_FORMS`，`drop` 与 `maintenance` 两种形态），并显式拒绝多语句（含 `;`）与
`/`+`*`+`!` 开头的可执行注释。25 项测试里 10 项是反例（拼语句、可执行注释、缺名、额外 token），
另有 3 项断言「白名单没被放宽」。**兜底不能变成后门**是这段代码的唯一验收口径。

## 四、踩坑

- 🔴 **行内入口的位置是设计问题，不是测试问题**：「＋ 新建数据库」最初做成连接行第 4 个 hover 按钮，
  动作区约 100px 在 240px 侧栏里左缘压到行宽中线 → **点连接行中点会弹建库对话框**，
  连带左分隔条被遮罩挡住拖不动（宽度断言 240→240）。改为库列表尾部 `.tree-adddb`：
  缩进按连接层级 +1、刻意不用 `.tree-row`（不参与选中/键盘/计数）。
- 🔴 **树行断言必须按 key 不按标签**：demo 两个连接共享同一份库结构，同名表出现两行 →
  「旧表名消失」永远为假。给 `.tree-row` 加 `data-node-key` 后用 `obj:<connId>:<db>:<table>` 定位。
- 🔴 **菜单项必须精确等值点**：`hasText: '复制表'` 会先命中「复制表名」（DOM 里排前面）→
  复制表弹窗永不出现，看着像「点了没反应」。改成遍历 `.ctx-item` 精确比对文本。
- **`filter({ hasText })` 是子串匹配**：`access_log` 命中 `access_log_zz`，
  四条「旧表名消失」断言同时失去证伪力 —— 这类断言必须**精确等值**。
- **复制表要发两条语句**（`CREATE TABLE … LIKE` + `INSERT … SELECT`）：
  结构成功、数据失败时如实说明「结构已建、数据未复制」，不能笼统报成功或失败。
- **F2 名实不符**：动作目录里 `tree-design-table` 的 accelerator 是 `F2`，但 F2 在 Finder/VSCode
  里是重命名 → 改为 F2=重命名、⇧F2=设计器，`npm run gen:actions` 同步生成文档（36 条动作）。

## 五、打包与发版

- `dist:dir` → `ditto` 装 /Applications（**不能 `cp -R`**）→ `verify:installed` 22/22。
- 打包与发布陷阱（brokered-fs、safe-delete、连字符资产名、`--noproxy` 直连）见
  [`RELEASES.md`](../RELEASES.md) v0.7.2 段的「操作留痕」，本轮完全复用同一套流程。
