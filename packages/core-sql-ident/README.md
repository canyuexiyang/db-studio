# @dbstudio/core-sql-ident

MySQL 标识符转义 —— 防 SQL 注入的最后一道。

## 为什么是零依赖的独立包

原本它在 `core-driver-mysql` 里。但**渲染层（网格/筛选器）也需要转义列名**，
一 import 就把 **mysql2 整个拖进浏览器 bundle**：

```
Vite 构建实测：mysql2 → stream / tls / crypto / zlib / timers 等
Node 内置模块全部 externalize 报错，模块数 157 → 30 才干净
```

标识符转义是纯字符串逻辑，根本不需要驱动 —— 抽出来，两边都不背依赖。

`core-driver-mysql` 仍 re-export 这些函数（保持既有 import 路径可用），
**新代码请直接引本包**。

## 规则

1. 标识符（库/表/列名）只能用反引号包裹 + 内部反引号加倍。
   没有"转义"能救带 `0x00` 或超长（>64 字符）的名字，遇到**直接拒绝**。
2. 用户输入的值**一律 `?` 占位参数绑定**，绝不拼进 SQL 文本。
   **本文件故意不提供"值转义"函数** —— 就是为了防止有人拿它拼字符串。

## 测试

```bash
npm test   # 9 passed
```
