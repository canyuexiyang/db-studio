# @dbstudio/core-clipboard

网格剪贴板 —— 复制序列化 + 粘贴对齐与校验。

> 依据：PRD §6.3.6（D2 决策：支持从 Excel/Numbers 粘贴）

## 三条硬要求（都在这里落地，UI 只执行结果）

1. **列数超出剩余列 → 丢弃并提示**，绝不自动新增列
2. **超出行尾 → 追加新行**，受 `maxRows` 上限保护（默认 1000）
3. **逐格类型校验**：不合法的格子标红并给出原因，**不进入脏单元格**

粘贴本身**不自动提交**，必须显式 `Cmd+S` 并经 SQL 预演。

## 复制：五种格式

`tsv` / `csv` / `json` / `insert` / `update`

- `Cmd+C` 默认 TSV（可直接粘进 Excel/Numbers）
- `Cmd+Shift+C` 弹菜单选格式
- INSERT/UPDATE 的**值一律 `?` 占位**，标识符走 `quoteIdentifier`

## 粘贴：解析优先级

**HTML table > TSV > CSV**

Excel/Numbers 会同时提供 HTML 与 TSV。HTML 能正确表达"单元格内含制表符/换行"，
优先用它更稳。

⚠️ 判定 CSV 时有一条容易漏的规则：单行且既无逗号也无制表符的 CSV
（如 `"a""b"`）只能靠**行首引号**识别，少了这条会退化成 TSV，引号不会被还原。

## 被拒的几种情况（整体拒绝，不是跳过个别格）

| 情况 | 原因 |
|---|---|
| 无主键/唯一键 | **B5 红线**：无法安全定位行，网格只读 |
| 超过 1000 行 | PRD 规定的单次上限 |
| 起始列越界 | 如实报错，不悄悄夹到最后一列（静默改位置会让用户粘错列） |
| 起始行 > 已加载行 | 中间会出现无法定位的行洞 |

## 与 core-mutation 的桥接

`toMutationInput(plan)` 把计划转成 mutation 的输入：
已有行 → 按行分组走 UPDATE（同行的多个单元格合并成一条 UPDATE）；
追加行 → INSERT，主键不出现在 values 里（由服务端生成）。

## 测试

```bash
npm test   # 45 passed
```

真库验证见 `npm run e2e` 的【12】粘贴 → 真库 INSERT。
