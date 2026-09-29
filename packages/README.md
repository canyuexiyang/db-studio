# 模块总览

## 验证入口（一条命令跑全）

```bash
npm run verify     # typecheck(tsc --noEmit) + 301 单测 + 真库 e2e 36 项
npm test           # 301 passed / 301
npm run typecheck  # 全项目 TS 严格模式，0 error
npm run e2e        # 真库端到端（需 fixture 在 13306）
npm run e2e:perf   # 真库性能预算（1000 万行表）
```

## 第一批：6 个不依赖 Spike 的纯逻辑模块（事项 rhhxcK）

| 模块 | 包 | 测试 | 依据 | 状态 |
|---|---|---|---|---|
| 1. 工程骨架 / IPC 框架 | `apps/desktop` | 21 | TECH-REVIEW §2.1 / §3.2 + S1/S4 实测 | ✅ |
| 2. SQL AST 只读校验 | `packages/core-sql-guard` | 50 | §4.2（B4 阻塞级安全问题） | ✅ |
| 3. Schema 缓存 | `packages/core-schema-cache` | 16 | §4.5 / PRD R11 | ✅ |
| 4. 历史库 | `packages/core-history` | 22 | §1.4 | ✅ |
| 5. safeStorage 凭据层 | `packages/core-secret` | 17 | §1.3（替换 keytar） | ✅ |
| 6. 导出 utilityProcess 骨架 | `packages/core-export` | 27 | §2.1 / §5.3 + S3 实测 | ✅ |
| 集成验证 | `packages/_integration` | 7 | —— | ✅ |

## 第二批：打通「连接→定位表→查改数据」闭环（2026-09-21 完成）

| 模块 | 包 | 测试 | 依据 | 状态 |
|---|---|---|---|---|
| 7. 连接配置与生命周期 | `packages/core-connection` | 30 | PRD §6.1.1~6.1.5 | ✅ |
| 8. MySQL 驱动封装 | `packages/core-driver-mysql` | 37 | §4.3 / §4.4（R10）/ §4.5 | ✅ |
| 9. 列式 IPC 编解码 | `packages/core-ipc-codec` | 35 | §2.2 + S5 修正论证 | ✅ |
| 10. 编辑保存构造器 | `packages/core-mutation` | 39 | §4.1（B5 头号红线） | ✅ |

真库端到端 `scripts/e2e-smoke.mjs`：36/36 通过。
真库性能 `scripts/e2e-perf.mjs`：表首屏 P50 **8.3ms**（预算 1000ms）。

## 明确没做（等 S1 结果，现已解除）

网格视觉层、玻璃相关代码、窗口构造参数固化 —— 这三项原本要等 S1。**S1 已于 2026-09-21 出结果（方案 A / D4 达成），限制解除，可以开工。**

`apps/desktop/src/main/window.ts` 已按 S1 结论固化窗口形态与降级路径，可直接作为正式开发起点。

## 跨模块的三个关键契约

### 1. 只读模式是两层，只有第二层算数

- **体验层**：UI 写操作入口置灰
- **安全层**：`core-sql-guard` 的 AST 白名单 + 连接层拦截

快捷键、粘贴、SQL 编辑器都能绕过 UI 置灰，**所以 UI 置灰不能替代 sql-guard**。

### 2. 无唯一键 → 网格只读（B5 / R4 红线）

`core-schema-cache` 的 `locateStrategy()` 把这条从口号变成可验收机制：

| 表具备 | 策略 | 可编辑 |
|---|---|---|
| 主键 | `pk` | ✅ |
| 唯一键 | `unique` | ✅ |
| **无唯一键** | `none` | ❌ **只读** |

网格实现必须调用 `isEditable()`，**不要自己判断**。
`core-mutation` 的 `isEditable()` 与之等价且**能识别复合唯一键**（读
`TableMeta.uniqueGroups`），新代码统一用它。

### 3. 导出走 exceljs 流式，不选手写 XML（S3 实测）

`core-export` 的 `excelWriterOptions()` 已强制 `useSharedStrings:false + useStyles:false`。

**不要**为 2 倍加速改用手写 sheet XML —— 它会让**日期退化为裸数字**（数据类型损坏）。

### 4. 网格拿到的原始值几乎全是字符串（真库实测，2026-09-21）

R10 的 `supportBigNumbers + bigNumberStrings` 让 mysql2 把 **LONGLONG 列
所有值都以字符串返回**，普通 `INT` 也是 `"1"`。这是"不丢 BIGINT 精度"的必然代价。

因此：**排序必须服务端执行**（PRD §6.3.3 本就如此要求，不是巧合）；
要拿真正的数值列，必须把列定义 `dataType` 传给 `core-ipc-codec`。

## 已修正的上游论证（建议同步架构文档）

来自 Spike 与真库实测，与评审/PRD 原文不符，但**不影响模块实现**：

1. **列式 IPC**：在 PRD 规模下体积不更小、编码反而比 JSON 慢 3~5 倍。真实价值是「只解可视区 + 内存有界 + 大结果集可扩展」，不是"省体积"。
2. **Darwin 版本**：本机 `os.release()` = **27.0.0**，不是文档所称的 26（原文误把 build 号 26A428 当内核版本）。阈值 `>= 26` 仍安全。

## 真库实测发现的两个驱动行为（写进代码注释了，这里再提醒一次）

1. **`KILL QUERY ?` 会被服务端拒绝** —— KILL 语句不接受占位符参数，
   connection_id 必须内联（整数强转）。这是 e2e 冒烟跑出来的真缺陷。
2. **被 KILL 的查询是 resolve 不是 reject** —— mysql2 对中断的查询正常返回
   （SLEEP(5) 在 305ms 返回 `[["1"]]`）。**不要用"抛异常"判定取消成功**，要判"提前返回"。

## 性能实测（1000 万行 fixture，5 次采样）

| 项 | P50 | 预算 |
|---|---|---|
| 服务端查询 3000 行 | 4.5ms | 1000ms |
| 列式编码 | 3.8ms | 500ms |
| 首屏可视区解码 | 0.2ms | 500ms |
| **端到端表首屏** | **8.3ms** | **1000ms** |
| 带索引排序 | 1.6ms | 1500ms |

只解可视区的可扩展性：3千→3万→10万 行，首屏解码 0.092 → 0.102 → **0.149ms**（几乎恒定）；
对照全量物化 10 万行 46.7ms。

## 测试策略说明

- 各包单测覆盖自身行为与边界
- `_integration` 只测**跨模块协作**（4 条链路），不重复单测
- `window.test.ts` 用 `vi.mock` 拦掉 electron —— 无 GUI 环境无法构造 BrowserWindow，但纯逻辑（版本判断/降级路径）恰恰是最容易写错且错了会让应用起不来的部分，必须测

集成测试驱动发现并修复了一个真实缺陷：`ExportTask.cancel()` 原先在未 attach 子进程时不记录取消意图，导致 UI 会一直显示"进行中"。已修（见 `core-export/README.md`）。
