# @dbstudio/core-schema-cache

Schema 缓存 —— 服务「树首屏 ≤500ms」。

> 依据：`docs/engineering/TECH-REVIEW-v1.0.md` §4.5 / PRD §6.1.5（R11）

## 为什么需要

连接后异步拉取元数据并落盘快照，下次打开**先渲染快照再后台刷新**。没有这份快照，"树首屏 ≤500ms"做不到。

- 快照路径：`userData/schema-cache/<connId>.json`
- 带 `version` 与 TTL（默认 **7 天**）
- 过期 → `stale: true`，**但快照仍返回**（先渲染，UI 提示"元数据可能过期"并提供刷新入口）
- 版本不兼容 → `snapshot: null`（需整份重建）
- 快照 JSON 损坏 → 不抛异常，当作无快照

## 行定位策略（B5 / R4 红线）

这是本模块最关键的产出 —— 它把"无主键表不能编辑"从口号变成可验收的机制：

| 表具备 | `locateStrategy()` | `isEditable()` | 说明 |
|---|---|---|---|
| 单列/复合主键 | `'pk'` | ✅ | `WHERE pk = ?` |
| 非空唯一键 | `'unique'` | ✅ | `WHERE uk = ?` |
| 可空唯一键 | `'unique'` | ✅ | UI 需提示"存在歧义风险" |
| **无任何唯一键** | `'none'` | ❌ **只读** | 无法安全定位行 |

> Navicat 在这类表上的行为正是历史上事故来源。**没有唯一键就不允许网格编辑** —— 这是唯一能保证红线的方式。

## Q2：按字段名搜表

`buildColumnIndex()` 生成 `columnName → ["db.table", ...]` 倒排索引（小写键，去重），`findTablesByColumn()` 查询。纯内存，成本约 0.5 天。

## 安全

连接 ID 会做路径安全化（非 `[a-zA-Z0-9._-]` 替换为 `_`），防止 `../../evil` 这类 ID 越权写到缓存目录之外。

## 测试

```bash
npm test   # 16 passed
```

覆盖：落盘读回、TTL 过期、版本不兼容、JSON 损坏、路径穿越防护、Q2 倒排索引、**无唯一键→只读**红线的四种策略分支。
