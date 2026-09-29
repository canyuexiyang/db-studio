# @dbstudio/renderer

渲染层（Vite + React）。三栏布局 + 数据网格 + 保存预演 + 命令面板。

```bash
npm run dev      # 开发服务器
npm run build    # 产物到 dist/
```

## 数据来源

接的是 `src/demoData.ts`（5 万行 demo 数据）。**接真数据时只替换
`buildDemoPayload()` 的返回值，组件不用改** —— UI 与后端可以并行推进。

## 三条硬约束（改网格时不要违反）

1. **只解可视区**：滚动时调 `decodeRange`，绝不 `decodeAll` / `materialize`
2. **行 DOM 池化**：绝对定位行 + `key=行号`，只渲染可视区 + 缓冲
3. **能否编辑必须问 `isEditable()`**：无主键/唯一键的表网格只读（B5 红线）。
   **组件不自己判有无主键** —— 判断逻辑在 core-mutation，只有一处

## 为什么没有引入 UI 框架

网格是性能热路径。手写绝对定位 + CSS 变量比组件树快得多，
也更容易守住"滚动路径不分配对象"这条线（S1 探针靠这个做到 120.5 FPS）。

## 首屏体积

`265 KB / gzip 85 KB`，远低于 S2 定的 1.5MB 未压缩硬约束。
`chunkSizeWarningLimit` 设成 700 把这个约束变成构建期可见的警告。

## 依赖纪律

`core-*` 一律走源码 alias，不打包产物。**渲染层不要引 `core-driver-mysql`**
（会把 mysql2 拖进浏览器）—— 需要标识符转义请用零依赖的 `core-sql-ident`。
