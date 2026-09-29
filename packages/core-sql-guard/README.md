# @dbstudio/core-sql-guard

SQL 只读守卫 —— D6 只读模式的**安全层**。

> 依据：`docs/engineering/TECH-REVIEW-v1.0.md` §4.2（阻塞级问题 B4）

## 为什么不用正则

原 PRD 用「正则扫关键字 + 跳过注释字符串」拦截写操作。这在工程上**必然漏判**：

| 场景 | 正则能拦吗 |
|---|---|
| `CALL some_proc()` | ❌ 漏判 |
| `SELECT * FROM t INTO OUTFILE '/tmp/x'` | ❌ 漏判 |
| `WITH x AS (...) UPDATE t SET a=1`（PG） | ❌ 漏判 |
| `SELECT 1; DROP TABLE t`（多语句第二条） | ❌ 漏判 |
| `SELECT ... FOR UPDATE`（加锁） | ❌ 漏判 |

反过来还会**误判**：`SELECT update_time FROM t`、`WHERE name='delete'`。

这是安全功能，漏判 = 用户以为开着只读模式，实际改了生产库。

## 设计

采用 **SQL AST 语句类型白名单**，三条硬规则：

1. **白名单，不是黑名单** —— 只放行确定只读的语句类型，未来任何新语法天然被拦
2. **多语句逐条判定** —— 任一条不合规，**整批拒绝**
3. **解析失败 → 拒绝（fail-closed）** —— 宁可误拦，不可漏放

### 白名单

| 类型 | 说明 |
|---|---|
| `select` | 基础查询 |
| `show` | SHOW 系列 |
| `describe` / `desc` | 表结构 |
| `explain` | 执行计划 |
| `use` | 切库 |
| `set` | **仅安全变量白名单**，见下 |

### SET 变量白名单

`SET` 在 MySQL 里有副作用（`SET autocommit=0`、`SET @@global.*`、`SET GLOBAL *`），因此只放行：

`names`、`character_set_client|connection|results|server`、`time_zone`、`sql_mode`

以下一律拒绝：`@@` / `@` 前缀的变量、`GLOBAL` / `PERSIST` 作用域、白名单外的任何变量。

### SELECT 的写副作用检测

在**已确定为 select 类型的 AST 之上**做附加检测（不是拿正则当主防线）：

- `INTO OUTFILE` / `INTO DUMPFILE` —— 通过 `ast.into.keyword` 检测
- `FOR UPDATE` / `LOCK IN SHARE MODE` —— 加锁会阻塞他人写入

> ⚠️ 实现注意：实测 `node-sql-parser@5.4.0` **没有保留** `FOR UPDATE` / `LOCK IN SHARE MODE` 的信息（`ast.lock` 为 `undefined`），因此这两项用文本匹配兜底（已先剥离注释、用词边界匹配避免误伤 `for_updated_at` 这类字段名）。

## 用法

```ts
import { checkReadOnly, isReadOnly } from '@dbstudio/core-sql-guard';

const r = checkReadOnly(sql, 'mysql');
if (!r.allowed) {
  // r.reason: 'parse-failed' | 'not-in-whitelist' | 'forbidden-select-modifier' | 'unsafe-set' | ...
  // r.message 是中文，可直接展示
  // r.offendingStatement 多语句场景下定位是哪一条
  blockWith(r.message);
}
```

## 测试

```bash
npm test
```

**50 passed / 50**，覆盖：

- **允许**：基础查询、SHOW/DESC/EXPLAIN/USE、安全 SET、误判防护（字段名与字符串含 `update`/`delete`/`drop`、注释里含写操作关键字）、多条纯 SELECT
- **拒绝**：UPDATE/DELETE/INSERT/TRUNCATE/DROP/ALTER/REPLACE/LOAD DATA/CREATE TEMPORARY TABLE、`CALL`、`INTO OUTFILE`、`FOR UPDATE`、`LOCK IN SHARE MODE`、PG `WITH…UPDATE`、多语句第二条写操作、危险 SET（autocommit/@@global/GLOBAL/@x）、语法错误（fail-closed）
- **语义**：解析失败原因、多语句定位、语句类型返回、空语句

## 已知限制

1. **`SET NAMES utf8mb4` 解析器不支持**（无 `=` 赋值形式，MySQL 方言下直接抛错）。已做前置放行——它是确定安全的会话级字符集设置且用户高频使用。若无此放行，fail-closed 会误拦所有 `SET NAMES`。
2. `FOR UPDATE` / `LOCK IN SHARE MODE` 靠文本兜底（解析器未保留该 AST 信息）。已剥离注释 + 词边界匹配降低误判。
3. PG 方言未覆盖 PG 特有的写操作语法全量（如 `SELECT ... FOR NO KEY UPDATE`），后续按需补。
4. 本模块只做**判定**，不做连接层拦截。第二道闸（`SET SESSION TRANSACTION READ ONLY`）需在连接管理层实现，且不可作为唯一防线。

## 与其它模块的关系

D6 只读模式有**两层**：

- **体验层**：UI 写操作入口置灰（PRD 已要求）
- **安全层**：本模块 + 连接层拦截（**只有这层算数**）

UI 置灰不能替代本模块——快捷键、粘贴、SQL 编辑器都能绕过 UI。
