# @dbstudio/core-grid-view

数据网格视图模型 —— **纯逻辑、零 UI 依赖、零 DOM**。

> 依据：PRD §6.3.2 虚拟滚动 / §6.3.3 排序 / §9.2 网格快捷键

## 为什么先做纯逻辑

网格是本项目最核心的模块。把可视区计算、选择、键盘导航、排序三态都做成
**输入是数字与数组、输出是可直接渲染的数据** 的纯函数，就能在**搭 React 之前**用单测
把所有交互边界守住。UI 组件只负责把结果画出来。

刻意不放进来的两件事（避免逻辑分散到多处）：

- **单元格取值** —— 由 `core-ipc-codec` 的 `ColumnarReader` 负责（只解可视区）
- **能否编辑** —— 由 `core-mutation` 的 `isEditable(table)` 决定。
  **渲染层必须调它**，不要在本模块里自行判断有无主键（B5 红线）

## 能力

| 能力 | 入口 | 说明 |
|---|---|---|
| 可视区计算 | `computeVisibleRange()` | 可视区 + 上下各 10 行缓冲；返回 `offsetTop` 直接给渲染层 translateY |
| 滚动定位 | `computeScrollToReveal()` | 已完全可见返回 `null`，调用方不必 setState |
| 列裁剪 | `computeVisibleColumns()` | 冻结列永远渲染，不参与裁剪 |
| 选择模型 | `SelectionModel` | 单元格矩形选区 + 焦点格 + 整行勾选，三者并存 |
| 键盘导航 | `navigate()` | 方向键 / `Cmd+方向` 跳边界 / `Shift` 扩展 |
| 排序三态 | `applySort()` | 无 → ASC → DESC → 无；`Shift+点击` 多列，列头角标 ①②③ |
| 加载状态 | `loadState()` | 有估算值标注"约"字，不谎报精确值 |

## 边界（都有测试兜底）

`rowCount=0` / `viewportHeight=0` / 空列 / 负 scrollTop / 删除行后行号上移 /
结果集 resize —— 全部返回合法空态而不抛异常。网格在"还没数据""容器还没布局完"时
会真实遇到这些状态。

## 测试

```bash
npm test   # 47 passed
```
