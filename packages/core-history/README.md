# @dbstudio/core-history

查询历史与片段存储（本地 SQLite）。

> 依据：`docs/engineering/TECH-REVIEW-v1.0.md` §1.4

## 技术约束（严格遵守）

| 约束 | 说明 |
|---|---|
| `node:sqlite` | 零 native 依赖、零重建，符合"不依赖完整 Xcode"的定位 |
| **只用核心 API** | `DatabaseSync` / `StatementSync` / `exec` / `prepare` / `run` / `get` / `all` / `iterate` |
| **绝不碰** | `createSession` / `applyChangeset` / `createTagStore` —— Stability 1.1，升级 Electron 会 API 漂移 |
| `PRAGMA journal_mode=WAL` | 读写并发 |
| **所有写走 prepared statement** | 历史库里存的 SQL 全是用户原文，拼字符串必然出事 |

## 注入防护（红线）

历史库存的 SQL 是用户原文，可能含引号、分号、注释符。测试覆盖了这些原文：

```
SELECT * FROM t WHERE name = 'O'Brien'; DROP TABLE query_history; --
SELECT "a" FROM t /* comment */ UNION SELECT 1
SELECT '); DELETE FROM query_history; --
```

全部走 prepared statement，逐字符原样存取，表不被删除。

`searchHistory` 对 LIKE 的 `%` `_` `\` 做了转义 —— 用户搜 `a_b` 不该匹配 `aXb`。

## 行为决策

- **Q5：失败语句也记录**。失败的最需要复用。失败原因存在 `error` 字段，可直接展示。
- **pruneHistory(keep)** 保留最近 N 条，防止历史库无限增长。
- 片段（`snippet`）名唯一，重复插入会抛错（由 UNIQUE 约束保证）。

## 用法

```ts
const store = new HistoryStore(join(app.getPath('userData'), 'history.db'));

store.addHistory({
  connectionId: 'conn-1', database: 'bench', sql: 'SELECT 1',
  success: true, error: null, durationMs: 12, rowCount: 1, executedAt: Date.now(),
});

store.searchHistory('big_table');   // 搜历史
store.pruneHistory(5000);           // 只留最近 5000 条
```

> ⚠️ `:memory:` 库**不支持 WAL**（SQLite 限制）。生产用真实文件；测试若需验证 WAL 必须用临时文件。

## 测试

```bash
npm test   # 22 passed
```
