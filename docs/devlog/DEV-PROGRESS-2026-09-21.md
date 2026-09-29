# 研发进展：打通「连接→定位表→查改数据」闭环

日期：2026-09-21 | 阶段：WBS 阶段 2（连接管理）+ 阶段 3 的元数据部分

---

## 一、交付清单

| # | 模块 | 包 | 单测 | 状态 |
|---|---|---|---|---|
| 1 | 连接配置与生命周期 | `packages/core-connection` | 30 | ✅ |
| 2 | MySQL 驱动封装 | `packages/core-driver-mysql` | 37 | ✅ |
| 3 | 列式 IPC 编解码 | `packages/core-ipc-codec` | 35 | ✅ |
| 4 | 编辑保存构造器 | `packages/core-mutation` | 39 | ✅ |

**验证结果**

- `npm run typecheck` — tsc 严格模式 **0 error**（此前项目无根 tsconfig，本轮补齐）
- `npm test` — **301/301** 通过（上一批 160 + 本批 141）
- `npm run e2e` — 真实 MySQL fixture **36/36** 通过
- `npm run e2e:perf` — 性能预算**全部达标**

---

## 二、真库实测发现（三条，都写进代码注释与 README）

### 1. `KILL QUERY ?` 会被 MySQL 服务端拒绝 —— 真缺陷

KILL 语句**不接受占位符参数**。原实现 `admin.query('KILL QUERY ?', [id])` 在
单测替身上永远"成功"，直到真库 e2e 才暴露：取消功能实际从未生效。

修复：connection_id 内联 + 整数强转（id 来自 `CONNECTION_ID()`，非用户输入）。

> 教训：SQL 类功能**必须用真库 e2e 兜底**，只靠替身的单测会给出虚假绿灯。

### 2. 被 KILL 的查询是 resolve 而不是 reject

mysql2 对中断的查询正常返回（`SLEEP(5)` 在 305ms 返回 `[["1"]]`），不抛异常。
因此**不能用"抛异常"判定取消成功**，必须判"提前返回"。

### 3. R10 参数让所有 LONGLONG 列返回字符串

开了 `supportBigNumbers + bigNumberStrings` 后，mysql2 把 **LONGLONG 列的
所有值都以字符串返回**，普通 `INT` 也是 `"1"` 而非 `1`。驱动无法在字符串化前
区分该列是否真是 BIGINT（协议只给字段类型码，不给列定义）。

对照实测：

| 参数 | `big_no` = 9007199254740993 |
|---|---|
| R10 全量 | `"9007199254740993"` ✅ 精度完整 |
| 去掉 supportBigNumbers | `9007199254740992` ❌ 精度丢失 |

**这是"不丢精度"的必然代价，接受它。** 应对：

- 排序必须服务端执行（PRD §6.3.3 本就如此要求）
- 需要数值语义的列，由调用方传列定义 `dataType` 给 `encodeColumnar()` 第三参
- `safeToNumber()` 保证不丢精度：BIGINT 超 2^53 与 DECIMAL 保持字符串

---

## 三、性能实测（1000 万行 fixture，5 次采样 P50）

| 项 | 实测 | 预算 | 结论 |
|---|---|---|---|
| 服务端查询 3000 行 | 4.5ms | 1000ms | ✅ |
| 列式编码 | 3.8ms | 500ms | ✅ |
| 首屏可视区解码 | 0.2ms | 500ms | ✅ |
| **端到端表首屏** | **8.3ms** | **1000ms** | ✅ |
| 带索引排序 | 1.6ms | 1500ms | ✅ |

**只解可视区的可扩展性**（这是列式的立身之本，在真库上得到验证）：

| 结果集 | 编码体积 | 首屏解码 |
|---|---|---|
| 3,000 行 | 130 KB | 0.092 ms |
| 30,000 行 | 1.4 MB | 0.102 ms |
| 100,000 行 | 4.7 MB | **0.149 ms** |

对照：10 万行全量物化 46.7ms。首屏解码耗时**几乎恒定，与结果集大小无关**。

---

## 四、红线验证结果

| 红线 | 验证方式 | 结果 |
|---|---|---|
| 只提交被编辑的单元格 | 真库 UPDATE，`amount` 未编辑 → 断言 SQL 里不含该列且库中值不变 | ✅ |
| 无唯一键表网格只读 | `no_key_table` 真表 → 不生成任何写语句 | ✅ |
| BIGINT > 2^53 精度 | 9007199254740993 完整保留 | ✅ |
| DATETIME(6) 微秒 | `2026-09-20 15:04:05.123456` 完整保留 | ✅ |
| JSON 不自动 parse | 保持字符串，大整数完整 | ✅ |
| NULL vs 空串可区分 | nullMask 区分 | ✅ |
| 只读模式拦截 | 12 个用例（含 `CALL` / `INTO OUTFILE` / 多语句第二条 / 解析失败） | ✅ |
| 冲突检测 | 他人已改动 → affectedRows=0 → 识别冲突不覆盖 | ✅ |
| 长查询取消后服务端确实终止 | KILL QUERY + 提前返回验证 | ✅ |
| 配置文件不含明文密码 | `validateConnectionConfig` 静态检查 | ✅ |

---

## 五、补齐的工程缺口

1. **根 `tsconfig.json`**（此前没有）— 类型错误此前只能到打包才暴露。
   首次全量检查暴露 14 处问题，含**存量模块的 3 处真错误**：
   - `UtilityProcess` 从 `node:child_process` import 是错的（属 Electron API）
     → 改为本地 `UtilityProcessLike` 最小接口，保持模块不依赖 electron、可单测
   - `sanitizeCell` 返回类型漏了 `Date` → 这正是 S3「日期退化成裸数字」的同类隐患
   - `core-export` 一个未使用字段
2. **npm scripts**：`typecheck` / `e2e` / `e2e:perf` / `verify`（串起三者）
3. **`electron-window-glass@1.0.0`** 装到根 workspace（此前只在 spike 目录）
4. **`mysql2@3.24.4`** 装到根 workspace

---

## 六、下一步

| 项 | 说明 |
|---|---|
| 数据网格视觉层 | S1 已解禁；形态 = 方案 A（整窗玻璃 + 内容区不透明）。必须调 `isEditable()` |
| 库表树 UI | 懒加载 + 搜索 + D1 展开记忆（模块层已就绪，差 UI） |
| SQL 编辑器 | CodeMirror 6，懒加载（S2：不能进首屏 bundle） |
| SSH 隧道 | ssh2 尚未接入，目前只有配置与私钥权限校验 |
| R1 风险复测 | S1 探针是最小网格（每帧 28 可见行），真实单元格含富样式需按同法重测帧率 |

---

## 七、运行方式

```bash
npm run verify      # typecheck + 301 单测 + 真库 e2e（推荐，一条命令）
npm test            # 301/301
npm run typecheck   # 0 error
npm run e2e         # 36/36，需 fixture 在 13306
npm run e2e:perf    # 性能预算，需 fixture
```

e2e 密码默认 `dbstudio_local_2026`，可用环境变量 `DB_STUDIO_E2E_PWD` 覆盖。
e2e 自建临时库、跑完即 DROP，不污染 fixture。
