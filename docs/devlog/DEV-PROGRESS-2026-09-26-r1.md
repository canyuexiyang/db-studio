# DEV-PROGRESS 2026-09-26（R1 竞品对齐轮）

> 本轮目标：落地《竞品对比与功能迭代清单-2026-09-26》A–F 板块功能。全程按 `docs/archive/R1-并行研发契约-2026-09-26.md` 组织：主控预写共享管线 → 6 个并行子代理（文件所有权互斥）→ 1 个串行子代理 → 主控集成 → 全量验证 → 文档回填。

## 一、交付清单（对应竞品清单编号）

- **网格 A（浏览态）**：A1 ⌘F 查找（分块扫描）/ A5 列显隐 / A7 列宽拖拽+双击自适应 / A15 表级视觉记忆 / A8 选中区聚合 / A16 跳转到行 / A18 换行 / C4 列注释 / F5 选中统计回调。core-grid-view +5 组纯函数与单测。
- **网格 B（编辑态，串行）**：A2 ⌘0 设 NULL（幂等）/ A3 单元格右键菜单 / A4 ⌘D 复制行（buildDuplicateRowPlan：自增留空、非自增主键标红待填）/ A9 JSON 高亮预览 / A10 BLOB·图片·HEX·另存 / A17 多格式复制（⌘C 收敛为组件内复制选中区，App 旧「复制」按钮移除）。
- **模式/驱动层**：C1 触发器/事件入 schema（introspect 单独容错）/ C2 六类对象 SHOW CREATE（按列名取 DDL，真机全验）/ C9+A14 表信息与估算行数（🔴 无 COUNT）/ C3 insertTemplate（core-sql-ident）/ D1 状态迁移全量推送 + 自动重连接线（密码现取现用不留存；gen 代数防「断开后复活」，孤儿隧道红线不弱化）。
- **SQL 编辑器**：B1 片段保存 UI（补齐半成品）/ B3 草稿自动恢复 / B4 EXPLAIN FORMAT=JSON 树视图（表格由 JSON 反推，一次查询喂两视图）/ B6 错误定位（保留语句偏移）/ B7 结果导出入口 / F6 耗时展示核对（已有）。
- **导入导出**：E1 Markdown / E2 高级选项（BOM/分隔符/NULL 文本/表头）/ E3 JSON 导入（键序前缀性质单测钉住）/ E4 整库备份（INSERT 不带源库前缀 + FK 开关包裹，真库回放验证）/ E5 失败行重试（行号口径统一）/ B7 worker 侧 SQL 导出（fields 兜底）。
- **树 UX**：C1 图标与 demo 数据 / C2·C3 右键项 / C5 收藏表 + ⌘K 置顶 / C6 F2·Del / C7 拖表名（dataTransfer 双份数据）。
- **应用壳**：F1 原生菜单（16 命令，⌘W/⌘R 语义防回归断言）/ F2 字体缩放 / F4 会话恢复（轻量快照，20 上限）/ F7 空态引导 / F8 横幅可复制 / D1 断线横幅组件。
- **主控集成**：共享管线（3 条新 IPC 通道 + backend 门面 + demo 后端 + handler 注册）、App.tsx 全量接线（菜单命令订阅/缩放/会话恢复/空态/横幅/收藏加权/导出与写回入口/状态栏）、main.ts D1 接线、A12 全链路（extractSingleTable fail-closed 检测 + 「打开可编辑表格」+ **保存流 INSERT/UPDATE 分流修复**——追加行此前会被构造成 `WHERE pk IS NULL` 的坏 UPDATE）、A14 状态栏「约 N 行」、7 个模块 css 合并回 styles.css（恢复单文件约定）、e2e 空态断言与 verify.mjs 展开方式修复。

## 二、关键决策与实测

1. **并行架构**：App.tsx/styles.css/ipc 契约由主控独占（子代理出「集成说明」），模块 css 先独立后合并 —— 六代理零文件冲突，typecheck 中途红点全部来自跨代理依赖的短暂在途状态，自愈。
2. **A12 保守启发式**：node-sql-parser 的普通 SELECT 也恒置 `into: {position: null}`，不能按真值判（单测抓到）；INTO 改文本级检测（误拒无害，漏放才事故）。JOIN/派生表/聚合/CTE 全部 fail-closed 只读。
3. **E4 整库备份安全语义**：INSERT 不带库名前缀 + `SET FOREIGN_KEY_CHECKS` 包裹 + 默认不带 DROP —— 真库「导出→灌回全新库」回放验证行数/NULL/中文保真。
4. **A18 换行不改行高**：虚拟滚动线性 offsetTop 公式与 DOM 池化依赖固定行高，换行用 2 行 line-clamp 表达。
5. **⌘C 语义收敛**：选中区复制进组件（core-clipboard `rowsFromSelection`，2 万格上限），App 层旧「复制第 0 行」删除。
6. **树展开语义对齐**：容器行单击 caret 切换；design-mockups/verify.mjs 旧的「行双击展开」写法（双击=两次单击抵消）已改为 caret 点击，与 e2e-ui 同口径。

## 三、验证结果（全绿）

- `npm run typecheck`：根 + renderer 两套 ✅
- `npm test`：**33 文件 937/937** ✅（新增 core-grid-view 22、core-sql-guard 13、core-clipboard/mutation/history/core-import/core-export/tree-favorites/menu/fontZoom/sessionSnapshot 等约 90 例）
- `npm run verify` 最终全量：typecheck ✅ + **937/937** + bundle **8/8**（首屏 364.3KB / lazy chunk 148.3KB gzip）+ e2e 冒烟 **51/51** + transfer **28/28** + ssh **18/18** + grid 性能 ✅ + e2e:ui **85/85** + e2e:app **31/31** —— 单条命令全链路绿。
- **视觉验收（visual-judge 双主题截图）**：首轮提出 3 处问题并全部修复复验通过 —— ① 工具栏溢出致右端徽标半截（「约 N 行」移入状态栏后消除）；② 深色下原生 select 白底（UA 面孔不随 color-scheme 动态重绘，`.toolbar select` 改显式 token 配色 —— 该问题 v1.0 即潜伏，本轮抓出）；③ 状态栏补「约 N 行」。截图见 `docs/design-mockups/verify-{light,dark}.png`。
- `npm run e2e:ui`：**85/85** ✅（含空态断言修复后）
- `npm run e2e`（真库冒烟）：**51/51** ✅
- `npm run e2e:transfer`：**28/28** ✅（xlsx 日期保真、bigint 精度无回归）
- `npm run e2e:ssh`：**18/18** ✅
- `npm run e2e:grid`（性能）：✅（首屏解码 0.111ms，10 万行底部 0.022ms）
- `npm run e2e:app`（打包应用全链路）：**31/31** ✅（编辑器 chunk 预热 0.2ms、无控制台错误）
- 子代理各自另跑：worker 冒烟 43 例、真库 DDL 六类取回、树交互浏览器冒烟 26 例等（见各代理报告）。

## 四、遗留与风险（下一轮候选）

1. **B4 表格视图近似**：EXPLAIN JSON 反推的 11 列中 select_type 为近似值（JSON plan 无原值）；真库核对已做一轮，复杂查询（UNION/物化）建议再跑一轮人工比对。
2. **A1 搜索范围**：只覆盖列式载荷已加载行（追加脏行不参与），UI 已明示；百万行级结果建议把扫描进度 UI 节流。
3. **A4 非自增主键**：复制行后必须手填主键才能保存（预演会拒绝并说明）——交互上可考虑下一步自动生成（如 MAX(id)+1 需要写权限探测，暂缓）。
4. **F4 会话恢复**：table tab 恢复依赖 schemaGetTable，磁盘快照可用时 fromCache 打开；快照过期的表静默失败。
5. **e2e:transfer:ui**（打包 .app 全链路）需要 `npm run dist` 出新包后执行，本轮未跑。
6. **网格 B 的 ⌘0**：单元格编辑态（输入框聚焦）内不响应，需先 Enter 提交再按 —— 下一轮可把快捷键接进编辑分支。
7. **双主题截图**：`docs/design-mockups/verify-{light,dark}.png` 已重新生成，建议人工过一眼新增 UI（工具栏/横幅/空态）的观感。

## 五、打包安装（2026-09-27 补记）

- 版本升 **0.2.0**（R1 功能轮），`npm run dist` 产出 dmg + .app（`apps/desktop/release/`），已替换安装到 `/Applications/DB Studio.app`（先 ditto 干净复制，再 `codesign --force --sign -` 外层 ad-hoc 重签）。
- **签名坑**（已写进 electron-builder.yml 注释）：EB 26.15.3 在 identity:null 下完全跳过签名，产物带 Electron 模板旧签名（codesign --verify 报错）；补签时用了 `--deep` 会抹掉内嵌 Helper 的 entitlements → 网络服务 crash-restart 循环、渲染层加载不出（真机复现）。正确做法：只签外层。
- **verify-installed.mjs 改造**：playwright `electron.launch` 对打包 bundle 的 target 自动附加会把 Chromium 网络服务杀成死循环（仓库内 Electron 无此问题，纯打包组合行为）→ 改为手动 spawn + `connectOverCDP` 直连，验收步骤不变。
- 真机验收 `npm run verify:installed`：**21/21** 通过（中文逐键输入、真库测试连接 8.0.46/29ms、自动握手、网格中文与 NULL 保真、分栏拖拽、SQL 执行、A12「打开可编辑表格」按钮可见、收尾清理）。
