# 0.10.0 研发日志（2026-11-23）—— DBDelve 借鉴轮

> 范围依据：[`docs/product/PLAN-0.10.0-迭代清单.md`](../product/PLAN-0.10.0-迭代清单.md)。
> 分析来源：[`docs/research/DBDelve-深度分析与迭代清单-2026-11-23.md`](../research/DBDelve-深度分析与迭代清单-2026-11-23.md)。
> 本轮为 **一个 minor 版本**，P0/P1/P2 共 11 项一次落地；P3 未动。

## 交付清单

| ID | 项 | 关键落点 |
|---|---|---|
| P0-01 | 行检查器（当前行全字段/编辑） | `detail/RowInspector.tsx`；`DetailPanel` 表/行页签；`DataGrid.onActiveCellChange` 按 tab 上报焦点格 |
| P0-02 | 执行计划 2.0（估算版） | `core-sql-editor` 的 `ExplainNode` 数值指标；`SqlEditorPanel` 条形/全表扫计数/估行/过滤比 |
| P0-03 | 导入 SQL 预览 + 空值语义 + 逐列解析 | `core-import` `normalizeImportCell`/`withPreview`；`ImportWizard` Rows·SQL 双预览/`#` 映射列；worker/transfer/IPC 全链带 `emptyAsNull`/`parsers` |
| P1-04 | 只读结构页 | `workspace/StructureTab.tsx`；`TablePane` 数据/结构切换；MySQL `getTableInfo(includeIndexes)` 按需加载索引 |
| P1-05 | 命令面板连接 scope | `core-command-palette` `#`；`CommandPalette` connectionItems；App 按分组构建连接项 |
| P1-06 | 状态栏结果透明度 | `workspace/resultMeta.ts`；行数/截断/字节/耗时合并单元，未知不编造 |
| P1-07 | 外键感知 JOIN ON 补全 | `SqlEditorCore.joinTableAt`；`SqlEditorPanel.foreignKeys`；App 从 `fkCache` 摊平 |
| P2-08 | 欢迎页 URL 粘贴 | `EmptyState` URL；`core-connection.parseMysqlUrl`；`ConnectionEditor.initialUrl` |
| P2-09 | 拖拽 `.sql` / 数据文件 | preload `webUtils.getPathForFile`；App 窗口级 drop；`ImportWizard.initialFilePath` |
| P2-10 | 表体积/行数/缓存年龄 | `DetailPanel` 按需拉 `schemaGetTableInfo`；schema 加载时刻显示相对年龄 |
| P2-11 | 工具栏减负 | 移除主题/行高下拉；统一进偏好设置（`⌘,`）；行高变化实时生效 |

## 关键取舍

- **行检查器不新增写路径**：编辑只调既有 `onCellEdited → 脏格 → SavePreviewModal`，不自动保存；行面板只解当前行，不做全量 decode。
- **计划 2.0 不执行查询**：只解析 `EXPLAIN FORMAT=JSON` 的估算字段；条形是「相对 cost/行数」，不伪造 actual/self time。`EXPLAIN ANALYZE` 的 actual/错估留待单独评估（会执行查询）。
- **导入 SQL 与执行同源**：预览用 `buildInsertBatches(..., withPreview)`，与 worker 走同一份 normalization/validate；空字段默认仍为 NULL，选择空串时数值/日期/布尔列拒绝（防止 MySQL 静默转 0）。
- **结构页索引按需加载**：`includeIndexes` 缺省 false，打开表首屏不增加 `information_schema.STATISTICS` 查询；首次打开结构页才查，挂载后保持，避免来回切换重复请求。
- **状态栏合并而非新增**：复用 `rowCountBasis`/`truncated`/`queryMs`；字节取列式 buffer 长度；`status-row-count` testid 保留，避免既有 e2e 失效。
- **外观唯一来源**：主题/行高的权威改为偏好设置；原工具栏两个 `<select>` 删除，`capture-installed` 与 `e2e-ui` 的主题切换改走 `⌘,`。

## 门禁结果

```text
VERIFY_EXIT=0
typecheck ✅
test 2550 / 101 文件 ✅
check:bundle 9/9 ✅（首屏 618.5 KB；编辑器 chunk 140.8 KB gzip；功能弹窗 63.1 KB gzip）
e2e:ui 484/484 ✅（新增行检查器/结构页/状态栏 4 条断言）
e2e:app 72/72 ✅
e2e:keys 47/47（4 项人工）✅
smoke 74、transfer 36、ssh 18、idle 16、keepalive 17、idle:ui 4、toolbar-fit 22、script:data 10、affected 21、conflict 17、ddl:real 22、script:ui 18 ✅
```

## 遗留

- P3-12 列虚拟化：未做，需先测 200/500 列帧时间再决定。
- P3-13 结果快照恢复：未做；现有只恢复 tab 元数据，避免陈旧数据误导。
- P3-14 可重绑定快捷键：未做；保留只读速查 + 动作目录。
- 已用 `npm run dist:dir` 打包并 `ditto` 安装到 `/Applications/DB Studio.app`（0.10.0，ad-hoc 重签自检通过）；已发布 [GitHub Release v0.10.0](https://github.com/canyuexiyang/db-studio/releases/tag/v0.10.0)。按要求**跳过** `verify:installed`。旧 0.9.0 备份在 `apps/desktop/release/.prev-installed-0.9.0-before-0.10.0.app`。
