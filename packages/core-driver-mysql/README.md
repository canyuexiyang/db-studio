# core-driver-mysql — MySQL 驱动封装

依据：TECH-REVIEW §4.3（取消）/ §4.4（R10 参数）/ §4.5（元数据）/ §5.1（懒加载）

## 三条硬约束

### 1. 驱动懒加载，不在启动路径上 require

`connect()` 内部才 `await import('mysql2/promise')`。
S2 实测：三个驱动全同步加载也只 26ms，固定成本是 Electron 运行时 —— 但懒加载仍是正确做法，
且让本模块可以在"没有装驱动"的环境里被单测（注入 `loadModule`）。

### 2. R10 参数不是偏好，是正确性要求

```ts
supportBigNumbers: true, bigNumberStrings: true,  // BIGINT > 2^53 不丢精度
decimalNumbers: false,                            // DECIMAL 保持字符串
dateStrings: true,                                // 保留 DATETIME(6) 微秒原文
jsonStrings: true,                                // JSON 不自动 parse
multipleStatements: false,                        // 默认禁多语句
rowsAsArray: true,                                // 大结果集省内存
```

**⚠️ 真库实测的副作用（2026-09-21，e2e 暴露，必读）**：
开了 `supportBigNumbers + bigNumberStrings` 后，mysql2 把 **LONGLONG 列的所有值都以字符串返回**，
连普通 `INT` 也是 `"1"` 而不是 `1`。驱动无法在字符串化前区分该列是否真是 BIGINT。

对照实测：

| 参数 | `big_no` = 9007199254740993 |
|---|---|
| R10 全量 | `"9007199254740993"` ✅ 精度完整 |
| 去掉 supportBigNumbers | `9007199254740992` ❌ 精度丢失 |

**后果**：网格拿到的原始值几乎全是字符串。因此
① 排序必须服务端执行（PRD §6.3.3 本就如此要求）；
② 需要数值语义的列，必须由调用方传列定义 `dataType` 给 `core-ipc-codec` 显式还原。

### 3. 取消靠管理连接，且 KILL 不支持占位符

MySQL 无带内取消。`connect()` 会开**两条**连接：业务连接 + 管理连接。
`cancel()` 用管理连接发 `KILL QUERY <connection_id>`。

**⚠️ `KILL QUERY ?` 会被服务端直接拒绝**（真库实测）—— KILL 语句不接受占位符参数。
connection_id 来自 `CONNECTION_ID()`，是我们自己拿到的整数，内联是安全的，但必须整数强转。

**⚠️ 另一个实测语义**：被 KILL 的查询，mysql2 是 **resolve** 而不是 reject
（SLEEP(5) 在 305ms 返回 `[["1"]]`）。**不要用"抛异常"判定取消成功**，要判"提前返回"。

## 元数据 introspect

`introspect()` 用 4 条 information_schema 查询拉全量（库/表/字段/索引），
**不逐表往返** —— 库多时这是数量级差异。

- 复合唯一键按**索引组**记录到 `TableMeta.uniqueGroups`
  （单列判定会过约束，`core-mutation` 依赖它做复合定位）
- `estimatedRows` 是 InnoDB 估算值，UI 必须标"约"
- 库节点以 `targets` 为基准建立，SCHEMATA 只补充字符集
  （SCHEMATA 查不到时不会整库丢失）

## 标识符安全

`quoteIdentifier()` / `quoteQualified()` / `joinIdentifiers()`：
反引号包裹 + 内部反引号加倍，拒绝空名、超 64 字符、含 NUL。

**本文件刻意不提供"值转义"函数** —— 值一律用 `?` 占位参数绑定。
没有这个函数，就没有人能拿它拼字符串。
