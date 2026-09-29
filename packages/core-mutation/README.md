# core-mutation — 编辑保存构造器

依据：TECH-REVIEW §4.1（B5）。**这是头号红线的落地机制。**

## 红线：只提交被编辑的单元格，绝不整行覆盖

这条不是"尽量"，是**几何约束**：UPDATE 的 `SET` 列表里只出现 dirty 的列，
没有 dirty 的列根本不会出现在 SQL 里 —— 想整行覆盖都做不到。

```sql
-- 只改了 status 和 note
UPDATE `db`.`order` SET `status` = ?, `note` = ? WHERE `id` = ? AND `status` = ?
-- amount / score / payload 完全不在 SQL 里
```

## 三条配套机制

### 1. 行定位策略 → 决定网格能否编辑

| 表具备 | 策略 | WHERE | 可编辑 |
|---|---|---|---|
| 主键 | `pk` | `WHERE pk = ?` | ✅ |
| 唯一键（含复合） | `unique` | `WHERE uk1 = ? AND uk2 = ?` | ✅ |
| **无任何唯一键** | `none` | —— | ❌ **只读** |

**网格必须调 `isEditable()`，不要自己判断。** 无键表的改动不生成任何 SQL，
进 `plan.rejected` 并带原因。

复合唯一键**整组参与**定位（依赖 `core-driver-mysql` introspect 写的
`TableMeta.uniqueGroups`）—— 单列判定会过约束。

### 2. 冲突检测：WHERE 带被编辑列的原值

```sql
UPDATE t SET `status` = ? WHERE `id` = ? AND `status` = ?   -- 最后那个 ? 是原值
```

`interpretResult(affectedRows)`：

| affectedRows | 判定 | 处理 |
|---|---|---|
| 1 | `ok` | 成功 |
| 0 | `conflict` | 行已删除或已被他人修改，**不覆盖** |
| >1 | `ambiguous` | 定位条件不唯一，立即中止整轮（这是定位缺陷，绝不能继续） |

**排除列**：`FLOAT/DOUBLE/JSON/BLOB/TEXT/GEOMETRY` 的原值**不进 WHERE** ——
浮点与二进制比较不可靠，只会产生假冲突。见 `isComparableColumn()`。

原值是 NULL 时用 `IS NULL`（`= NULL` 永远为假）。

### 3. 批量提交语义

- 一轮保存（`Cmd+S`）= **单事务**，任一失败整轮回滚
- UI 保留全部脏标记，错误精确定位到行与列
- 执行顺序：`UPDATE → DELETE → INSERT`（新增行最后，失败即停）
- 新增行先 INSERT 拿 `insertId`，后续编辑才算可定位

## 安全

- 标识符全部走 `quoteIdentifier()` 转义
- 值**一律** `?` 占位参数绑定 —— 测试用 `'; DROP TABLE x; --` 验证过
- 不支持直接改主键列（需显式的删除+重建语义，v1 不做）

## 用法

```ts
const plan = buildMutationPlan(db, table, {
  updates: [[edit1, edit2]],   // 一个子数组 = 同一行的多个单元格
  deletes: [{ rowId, locate, locateValues }],
  inserts: [{ tempId, values }],
});
previewSql(plan);   // 红线 2：写操作必须可预览 SQL 原文
```
