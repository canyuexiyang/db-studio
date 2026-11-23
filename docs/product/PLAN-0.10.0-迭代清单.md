# DB Studio 0.10.0 迭代清单（DBDelve 借鉴轮）

> **来源**：[DBDelve 深度分析与迭代清单](research/DBDelve-深度分析与迭代清单-2026-11-23.md) 的 P0/P1/P2。
> **范围**：11 项，全部纳入 0.10.0；P3（列虚拟化/结果快照/可重绑定快捷键）不在本轮。
> **纪律**：不新增写路径；所有网格编辑仍走脏单元格 + 保存预演；不引入新依赖；不碰 PRD §三 非目标。
> **状态**：2026-11-23 研发实现完成；`verify` 全链通过（含 MySQL fixture）；已 `dist:dir` 打包并本机安装 0.10.0，发布 [GitHub Release v0.10.0](https://github.com/canyuexiyang/db-studio/releases/tag/v0.10.0)。按要求未跑 `verify:installed`。

## 1. 范围与状态

| ID | 优先级 | 项 | 落点 | 状态 |
|---|---|---|---|---|
| DB-01 | P0 | 行检查器（当前行全字段/编辑） | `detail/RowInspector.tsx`、`DetailPanel`「行」页签、`DataGrid.onActiveCellChange` | ✅ |
| DB-02 | P0 | 执行计划可视化 2.0（估算版） | `ExplainNode` 数值指标、`SqlEditorPanel` 计划条形/汇总 | ✅ |
| DB-03 | P0 | 导入 SQL 预览 + 空值语义 + 逐列解析 | `core-import`、`ImportWizard`、worker/transfer/IPC | ✅ |
| DB-04 | P1 | 只读 Structure tab（列/索引/外键） | `workspace/StructureTab.tsx`、`TablePane` 数据/结构切换、`getTableInfo` 索引 | ✅ |
| DB-05 | P1 | 命令面板 Connections scope | `core-command-palette` `#`、`CommandPalette`、App 连接项 | ✅ |
| DB-06 | P1 | 状态栏结果透明度 | `workspace/resultMeta.ts`、状态栏合并行数/截断/字节/耗时 | ✅ |
| DB-07 | P1 | 外键感知补全 JOIN ON | `SqlEditorCore` JOIN 上下文、`SqlEditorPanel` foreignKeys、App fkCache | ✅ |
| DB-08 | P2 | 首启欢迎页 / URL 粘贴 | `EmptyState` URL、`parseMysqlUrl`、`ConnectionEditor.initialUrl`；「最近」由既有 ObjectBrowser/命令面板承载，空态不重复造第二套入口 | ✅ |
| DB-09 | P2 | 拖拽 `.sql` / `.csv` | preload `pathForFile`、App 窗口级 drop、`ImportWizard.initialFilePath` | ✅ |
| DB-10 | P2 | 表体积/行数/缓存年龄 | `DetailPanel` 拉 `schemaGetTableInfo` + schemaLoadedAt | ✅ |
| DB-11 | P2 | 工具栏减负 | 移除主题/行高下拉，外观进 `⌘,`；偏好设置生效 | ✅ |

## 2. 关键边界（实现时守住）

- **DB-01**：行检查器只服务「激活表标签 + 详情面板同一张表」；编辑只写 `GridDataSource` 脏格，不直接写库、不自动保存。
- **DB-02**：估算版只用 `EXPLAIN FORMAT=JSON`，不执行查询；条形是相对成本/行数，不伪造 `self time`。`EXPLAIN ANALYZE` 的 actual/错估仍留待后续（会执行查询）。
- **DB-03**：预览 SQL 与真正执行的 `buildInsertBatches` 同源；空字段默认 NULL（0.7.x 行为），选空串时数值/日期/布尔列仍拒绝，防止 MySQL 静默转 0。
- **DB-04**：结构页只读；索引按需 `includeIndexes=true` 加载，不拖慢表首屏；编辑仍走既有表设计器 + DDL 预演。
- **DB-05**：`#` 连接 scope 只读内存 connections；已连接定位到树，未连接走既有握手/密码提示。
- **DB-06**：字节取列式 payload 实际 buffer 长度；未知不显示，不编造 `0 B`。
- **DB-07**：只用已加载外键；没有数据不按列名猜连接；JOIN 后仅在尾随空白时建议 ON。
- **DB-08**：URL 仅 MySQL/MariaDB；密码只进表单内存，保存仍走 safeStorage。
- **DB-09**：`.sql` 只打开不执行；数据文件必须已有目标表，路径取不到时明确提示而非静默失败。
- **DB-10**：体积/行数为 information_schema 估算，标「约」；读不到显示「—」。
- **DB-11**：身份/保存/筛选/导出不折叠；主题/行高唯一来源改为偏好设置。

## 3. 验收与门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 根 + renderer |
| `npm test` | ✅ 2550（101 文件） |
| `npm run check:bundle` | ✅ 9/9；首屏 618.5 KB / 编辑器 chunk 140.8 KB gzip |
| `npm run e2e:ui` | ✅ 484/484（含 0.10.0 行检查器/结构页/状态栏专项断言） |
| `npm run verify:toolbar-fit` | ✅ 22/22 |
| `npm run verify` | ✅ 全链通过（typecheck → test → bundle → e2e 全家桶） |

**新增/调整的断言**

- `packages/core-import`：空字段 NULL/空串、逐列 number/boolean、SQL 预览转义。
- `packages/core-sql-editor`：ExplainNode 数值指标。
- `packages/core-command-palette`：`#` 连接 scope。
- `packages/core-connection`：MySQL URL 解析（默认端口、IPv6、非法协议）。
- `apps/desktop/renderer/src/workspace/resultMeta.test.ts`：状态栏顺序与「未知不编造」。

## 4. 明确不在本轮

- P3-12 列虚拟化（先测 200/500 列再决定）。
- P3-13 会话结果快照恢复（陈旧数据风险；现有只恢复 tab 元数据）。
- P3-14 可重绑定快捷键（成本高、单用户收益低）。
- 不抄：ER 图、主题导入/glass、三档 Full 权限、无主键全列可编辑、Row 模式自动保存、客户端排序、文本化传输、GPL 代码。