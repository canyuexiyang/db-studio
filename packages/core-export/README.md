# @dbstudio/core-export

导出 Worker 骨架（`utilityProcess`）。

> 依据：`docs/engineering/TECH-REVIEW-v1.0.md` §2.1 / §5.3 + Spike S3 实测结论

## 为什么用 utilityProcess 而不是 worker_threads

| | worker_threads | **utilityProcess** |
|---|---|---|
| 取消 | 只能"跑完再丢弃" | **`kill()` 真取消**（S3 实测延迟 6ms） |
| 崩溃影响 | 拖垮主进程 | 独立进程，不拖垮 |
| 内存释放 | 随主线程 | 进程结束即释放 |

S3 实测：`fork` 正常通信、`kill()` 返回 true、进程确实消失、主进程存活、kill 后停止写入。

## exceljs 硬约束

```ts
// ✅ 只用流式 writer
new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useSharedStrings: false, useStyles: false })
// ❌ 禁止：全量缓冲会 OOM
workbook.xlsx.writeFile()
```

`excelWriterOptions()` 已强制 `useSharedStrings:false + useStyles:false`。
S3 实测：默认配置 100 万行 20.28s / 2739MB，优化后 **6.26s / 987MB**。

> **选型结论（S3）**：**不采用**手写 sheet XML。它虽快 2 倍（3.12s），但**日期会退化为裸数字**（写了 Excel 序列号却无 `numFmt` 样式，读回变 `43831.0000115741`）。"失去样式能力"的真实代价是**数据类型损坏**，不只是观感。

## 取消语义（PRD 验收项）

`kill()` 后输出文件是**半截的**（S3 实测 60 字节）。产品必须**删除该文件或标记未完成**，不能残留打不开的 .xlsx。

`ExportTask.cancel()` 的语义（集成测试驱动修正过）：
- **无论能否真正 kill，取消意图都会记录**（`isCancelled` 置 true）—— 否则 UI 会一直显示"进行中"
- 返回值表示"是否真的 kill 了"：未 attach 子进程或 kill 抛异常时返回 `false`
- 重复调用返回 `false`（幂等）

## 纯函数（可单测，不依赖 Electron）

| 函数 | 用途 |
|---|---|
| `sanitizeCell(v)` | PRD Q6 的 B 方案：截断到 32767 字符 + 清除 XML 非法控制字符，返回 `{ value, truncated }` |
| `csvRow(values)` | RFC 4180 CSV 行生成（含逗号/引号/换行自动加引号转义） |
| `columnName(i)` | 列索引 → A1 列名（0→A, 26→AA, 702→AAA） |
| `dateToExcelSerial(d)` | Date → Excel 序列号（1899-12-30 起算） |

`sanitizeCell` 来自 S3 实验的 E4 实现，是那次实验最有价值的产出之一 —— 无论最终走 exceljs 还是手写 XML 都需要它（非法控制字符会让 xlsx 损坏打不开）。

## 测试

```bash
npm test   # 27 passed
```
