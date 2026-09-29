# 版本发布记录

DB Studio 的**发布历史与门禁基线**。每次打包发版后在这里追加一条，GitHub Release 的说明从这里摘。

- **版本号唯一来源**：根 `package.json` 的 `version`（electron-builder 写入 `Info.plist`，子包版本不参与）。
  改版本号**只改这一处**，不要动 `apps/desktop/package.json`。
- 发版流程与陷阱见 [`docs/devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md`](devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md) §九。

## 版本总览

| 版本 | 日期 | 主题 | 门禁 | 分发 |
|---|---|---|---|---|
| **0.5.0** | 2026-09-30 | v1.3 缺陷清理（6 项真机反馈） | 1563 单测 / e2e:ui 219 / e2e:app 45 | ✅ GitHub Release + 本机安装 |
| 0.4.0 | 2026-09-29 | v1.2 功能收官（P1-A/P1-B/P1-C/P2/S/W） | 1548 单测 / e2e:ui 190 / e2e:app 45 | ✅ GitHub Release |
| 0.3.0 | 2026-09-27 | 网格 C 轮：行号列与整行操作（A19~A22） | — | 仅本地 dmg |
| 0.2.0 | 2026-09-27 | 连接编辑器布局重排 + 库/表级 SQL 脚本导入 | — | 仅本地 dmg |
| 0.1.0 | 2026-09-26 | v1.0 收官（首个可打包版本） | — | 仅本地 dmg |

> 0.1.0~0.3.0 只在本地打了 dmg、未发 GitHub Release，也没有留下门禁数字；
> 主题按同期 `devlog/` 与 dmg 产物时间对应，未做追溯补录。

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
