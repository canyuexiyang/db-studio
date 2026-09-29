# core-ipc-codec — 列式 IPC 编解码

依据：TECH-REVIEW §2.2（P4）；论证经 Spike S5 实测**修正**。

## 为什么列式 —— 理由必须写对

S5 实测：在 PRD 规模（LIMIT 3000）下，列式
- **体积并不更小**（0.477 vs 0.443 MB）
- **编码反而比 JSON 慢 3~5 倍**（4.15 vs 0.70 ms）

所以**不要拿"省体积/省编码时间"当理由**。真正的价值是：

| 场景 | 列式（只解可视区） | JSON（全量解析） |
|---|---|---|
| 3 千行首屏 | 0.092 ms | — |
| 3 万行首屏 | 0.102 ms | — |
| 10 万行首屏 | **0.149 ms** | 全量物化 46.7 ms |

（真库实测，1000 万行 fixture。**耗时几乎恒定，与结果集大小无关**）

加上：渲染端内存有界（TypedArray 而非几十万 JS 对象）、大结果集可扩展。

## 核心 API 是"按需解码"，不是"全量解码"

```ts
const reader = new ColumnarReader(payload);
reader.decodeRowRange(scrollTop, scrollTop + visibleRows);  // 网格滚动只调这个
reader.decodeAll();                                          // 导出才用，会物化全量
```

`ColumnarReader.stats.cellsDecoded` 是**防作弊计数器** —— 测试用它证明
"没有偷偷全量解码"。视图按列懒建并缓存，反复滚动不重建。

## 红线保真

| 数据 | 处理 |
|---|---|
| NULL vs 空字符串 | nullMask 区分，`isNull()` O(1)，**绝不混淆**（PRD §6.3.4） |
| BIGINT > 2^53 | 保持字符串，不进 Float64 |
| DATETIME(6) | 保持服务端原文字符串，不被 Date 吞掉微秒 |
| JSON | 保持原文字符串，不 `JSON.parse` |
| 二进制 | `decodeCell` 返回**拷贝**，调用方写不坏共享内存 |

## R10 字符串化数值的还原

见 `core-driver-mysql/README.md`：R10 下 mysql2 把 INT 也返回成字符串。
要让网格拿到真正的数值列，**必须传列定义**：

```ts
const types = fields.map(f => table.columns.find(c => c.name === f.name)?.dataType);
const payload = encodeColumnar(rows, fieldNames, types);
```

安全边界：`safeToNumber()` 只在 `String(n) === v` 时才转，
因此 `9007199254740993` 保持字符串（转 Float64 会静默丢精度），
DECIMAL `"10.00"` 也保持字符串（`1.5 !== "1.50"`），不引入浮点误差。

## 布局

每列占用 buffer 数（`bufferCounts`）：

| 类型码 | buffer 数 | 说明 |
|---|---|---|
| NULL | 0 | 整列全 NULL，不占数据 |
| F64 / BOOL / DATE | 2 | nullMask + values |
| STR / BIN | 3 | nullMask + offsets(Uint32) + bytes |
