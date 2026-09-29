# 需求文档：v1.2 SQL 编辑器增强（格式化 / 高亮 / 表提示 / 字段属性提示）

> 版本 v1.0 · 2026-09-28
> 母文档：`docs/product/PRD-v1.2-功能增量.md` §五（S 板块）
> 调研依据：`docs/research/竞品调研与功能路线图.md`

---

## 一、背景与现状

### 1.1 用户痛点

「SQL 一键格式化，以便看别人写的烂 SQL 时不用人肉整理」是 PRD §4.2 明确列出的 **P1 用户故事**，至今未交付。除此之外，编辑器还有三处体验短板：

| 短板 | 具体表现 |
|---|---|
| **拿到一段压缩 SQL 没法读** | 同事/日志/SQL 生成器产出的单行 SQL 需要人工断行整理 |
| **高亮不是 SQL 配色** | 当前用 CodeMirror 通用 `defaultHighlightStyle`，关键字、字符串、注释、数字共用一套泛用色，**没有 SQL 关键字/函数/类型的区分**，且不跟随 `data-theme` 切换 |
| **提示信息量不足** | 表名提示的 `detail` 只有库名；字段提示的 `detail` 只有 `dataType`。没有 hover 能力，不能反问「这列什么类型、可空吗、是不是主键」 |

### 1.2 现状盘点（代码实测）

| 能力 | 位置 | 状态 |
|---|---|---|
| 编辑器实例 | `renderer/src/editor/SqlEditorCore.ts` | ✅ CodeMirror 6，lazy chunk 加载 |
| 补全源 | `SqlEditorCore.ts:71-95` `completionSource` | ✅ 走 `buildCompletions` |
| 候选构建 | `packages/core-sql-editor/src/index.ts:635-723` | ✅ 关键字 43 条 / 函数 29 条 / schema（库·表·字段） |
| 候选上限 | `MAX_COMPLETION_ITEMS = 200`（`:589`） | ✅ 有截断保护 |
| 上下文表感知 | `contextTableOf()` + `wordBefore()`（`:733+`） | ✅ 本语句内的表字段会排到最前；`order.` 后前缀为空（`wordBefore` 注释明确了这是刻意为之） |
| 候选信息 | `CompletionItem.detail`（`:582`） | ⚠️ 表 → 只有库名；字段 → 只有 `dataType` |
| 语法高亮 | `SqlEditorCore.ts:125` `syntaxHighlighting(defaultHighlightStyle, {fallback:true})` | ⚠️ 通用样式，非 SQL 配色，不跟主题 |
| SQL 方言 | `SqlEditorCore.ts:126` `sql({dialect: MySQL, upperCaseKeywords: true})` | ✅ MySQL 方言已就位 |
| **SQL 格式化** | 无 | ❌ E2 已否决 sql-formatter |
| **hover 提示** | 无 `hoverTooltip` 扩展 | ❌ |

### 1.3 竞品参照

| 工具 | 相关能力 |
|---|---|
| **Navicat 18** | SQL Beautifier（美化）；Hover Info（悬停出元数据预览）；Real-Time Error Detection；Highlight Usages；Go to Declaration |
| **TablePlus** | ⌘I / ⌃I 格式化（Indent selected SQL Code）；Beautify SQL；SQL Editor 的 highlight / autocomplete / favorite & history |
| **DataGrip 2026.2** | 重构（Rename Symbol / Refactor to Alias）；hover 元信息；编辑器内联显示每条查询耗时；更强的方言支持 |
| **DBeaver 26.x** | SQL 格式化 + 关键词自动补全 + 可配置格式化风格 + 内联 ORDER BY 高亮等细粒度着色 |

---

## 二、🔴 S0 决策门：SQL 格式化的体积实测（**必须最先做完**）

### 2.1 为什么这是必须先做的一件事

`AGENTS.md §五` 明令：「❌ 未跑 `npm run check:bundle` 就引入新依赖；体积敏感决策参考先例：**sql-formatter 被明确拒绝**（E2：预算紧，锦上添花不值得）」。

`core-sql-editor/src/index.ts:14` 也写着：「不做 SQL 格式化（E2：sql-formatter 不入 v1）」。

**这不是不可推翻的教条，但推翻必须给实测数据**。当前实测量：

| 项 | 实测值 | 预算 | 余量 |
|---|---|---|---|
| 编辑器 lazy chunk | **119.1 KB gzip** | 150 KB gzip | **30.9 KB** |
| 首屏 | 375.2 KB | 1465 KB（未压缩） | 充足 |
| 功能弹窗组 | 33.5 KB gzip | 60 KB gzip | 26.5 KB |

即有 **30.9 KB 的明确余量**。是否够放 sql-formatter，必须实测才知道，不能估。

### 2.2 实测方案（S0 交付物）

在一个临时分支上做三组对照，**每组跑一次 `npm run check:bundle` 并记录数字**：

| 方案 | 做法 | 要拿到的数字 |
|---|---|---|
| **A. 直接引 sql-formatter** | `pnpm add sql-formatter`，在 `SqlEditorCore.ts` 里动态 import 使用 | 编辑器 chunk gzip 增量、是否超出 150KB |
| **B. 自研轻量格式化** | 仅做：关键字大写、主要子句（SELECT/FROM/WHERE/JOIN/ORDER BY/GROUP BY/HAVING/LIMIT）前换行、定长缩进、注释保留。**正则是已知的失败面，见 §2.3 红线** | 新增代码 gzip 体量、单测用例数 |
| **C. 不改（维持否决）** | — | 作为对照基线 |

**判定规则**（写死，避免事后圆）：

- A 方案若 **≤ 150 KB gzip 且其它门禁全绿** → 采用 A
- A 方案若超出 → 采用 B（自研只做「可读化」而非「标准美化」）或 C
- 任何方案都**不准**让 sql-formatter 进入首屏 bundle（首屏必须保持 cm-editor 零泄漏）

### 2.3 红线（S1 实施时必须守住）

1. **格式化是纯文本变换，不得改变语义**。
2. 🔴 **禁止在字符串字面量与注释内部做分词或换行** —— `core-sql-editor` 的 `splitStatements` 与 `core-import` 的 `createStatementSplitter` 已经用同一套「四种字符串上下文 + 两种注释上下文」处理过这个坑；**格式化必须复用这套状态机，不得自己写新的 `sql.split(' ')`**。这是最容易出数据事故的地方（把 `SELECT 'a b'` 里的空格当成分词点）。
3. **格式化结果不得进入执行链路的自动流程** —— 只能由用户显式触发（快捷键 / 按钮 / 右键），且应能 `⌘Z` 撤销（CodeMirror `history()` 已在扩展里）。
4. 不支持 `DELIMITER`（与既有决策一致，见 `core-sql-editor/src/index.ts:15`）；遇到存储过程脚本应提示「不支持格式化」而不是产出错误结果。
5. 大文本护栏：超过阈值（建议 512KB）不格式化并给出提示，避免主线程卡顿。

### 2.4 交互定义（S1）

| 项 | 定义 |
|---|---|
| 快捷键 | `⌘I`（对齐 TablePlus），也可 `⌃I` 兜底 |
| 入口 | 编辑器右键菜单「格式化 SQL」+ 工具栏按钮 + 快捷键 |
| 作用范围 | **有选中 → 只格式化选中部分**；无选中 → 格式化整个文档 |
| 反馈 | 格式化后 toast 显示「已格式化 N 行 / K 条语句」；无法安全格式化时明确提示原因 |
| 可撤销 | 必须能 `⌘Z` 一步回退 |

**验收标准**：
- 单测覆盖：字符串内含关键字 / 注释内含关键字 / 嵌套子查询缩进 / `--` 与 `/* */` 保留 / 结尾分号处理 / 空输入 / 单条无分号 / 512KB 护栏
- 单测必须包含**往返稳定性**：`format(format(x)) === format(x)`（幂等，反复按 ⌘I 不应让文本继续变化）
- e2e:ui 新增：⌘I 后文本结构变化、`⌘Z` 可回退、语义等价（同一条 SQL 格式化前后执行结果行数一致，需真库）

---

## 三、S2 SQL 专属语法高亮（深/浅双主题）

### 3.1 需求（EARS）

- 系统应提供面向 MySQL 的语法着色，至少区分：**关键字 / 函数名 / 数据类型 / 字符串 / 数字 / 注释 / 标识符 / 操作符 / 标点符号**。
- While theme is dark → 所有 token 颜色必须取自暗色调色板；While theme is light → 取自亮色调色板。**禁止硬编码写死单一颜色**。
- When 用户切换主题时 → 编辑器（若已加载）应立即重新着色，无需重新加载 chunk。
- 控件ROM 颜色必须从既有 `styles.css` 的 CSS 变量取值，不新增一套平行调色板。

### 3.2 实施要点

- 用 `@codemirror/language` 的 `HighlightStyle.define()` + `@lezer/highlight` 的 `tags`，替换当前的 `defaultHighlightStyle`（`SqlEditorCore.ts:125`）。
- `sql({dialect: MySQL})` 已在（`:126`），它会产出 SQL 语义 tag，`HighlightStyle` 直接消费即可，**不需要换解析器**。
- 跨平台出现 covered 列名等情形由 `sql()` 的 Schema 配置可选增强，非必需。
- 该扩展与编辑器同 lazy chunk，**不影响首屏**（这条要由 `check:bundle` 断言守住）。
- 🚫 禁止紫色/紫蓝渐变配色（项目设计红线）。

### 3.3 验收

- 深/浅双主题各截一张图，人工比对（`docs/design-mockups/verify.mjs` 已有先例，建议加 SQL 编辑器场景）
- e2e:ui 断言：切换 `data-theme` 后编辑器 token 的计算色发生变化
- `npm run check:bundle` 全绿（9/9）

---

## 四、S3 表名/库名提示增强

### 4.1 需求

| 项 | 定义 |
|---|---|
| 现有能力 | 前缀匹配（`startsWith`），上下文表的字段排最前，`MAX 200` 截断 |
| **新增：模糊匹配** | 支持子序列/驼峰/拼音匹配，让 `usrord` 能命中 `user_orders`。⚠️ 必须与树已有的搜索体验对齐（`core-command-palette` 里已有 pinyin 表 `:73-97`，**直接复用，不要新建一套**） |
| **新增：hover 表/库信息** | 悬停表名显示：所属库、行数估算、列数、表注释、引擎。**数据来源必须是既有 schema 缓存，禁止 hover 时打库**（会拖垮 hover 体验，且违背 E4「补全只吃缓存」的既有约定） |
| **新增：别名感知** | `SELECT * FROM orders o WHERE o.` 时，应识别出 `o` → `orders` 并把 orders 的字段排到最前。当前 `contextTableOf()` 只做单表识别，需要扩展别名映射 |
| **新增：排序加权** | 收藏表 > 上下文表字段 > 前缀命中 > 模糊命中 > 其它。复用 `tree/favorites.ts` 的收藏数据 |

### 4.2 红线

- hover **不得触发任何 IPC 查询**（契约：hover 是渲染层 + 内存缓存行为）。行数估算若需服务端数据，取既有 `schemaGetTableInfo` 的缓存结果，不在 hover 时新发请求。
- 标识符补全插入时仍走 `core-sql-ident` 语义（转义口径一致），**不得手拼反引号**（红线 5）。

### 4.3 验收

- 单测：别名映射（单表 / 多表 JOIN / 子查询）、模糊命中率、收藏加权顺序
- 单测：hover 不触发网络（以不调用 backend 方法为准）
- e2e:ui：输入 `SELECT * FROM orders o WHERE o.` 后首个候选是该表字段

---

## 五、S4 字段属性提示

### 5.1 需求

当前 `CompletionItem.detail` 对字段只有 `dataType`（`core-sql-editor/src/index.ts:666,678,692`）。补全候选本身已有丰富元数据可用：`ColumnMeta` 里有 `name / dataType / nullable / isPrimary / isUnique / isAutoInc / comment / defaultValue`（详情面板 `DetailPanel.tsx:300-309` 已经在用同一批字段渲染 flags）。

**字段属性应出现在两处：**

| 位置 | 内容 |
|---|---|
| **补全候选行** | 右侧 `detail` 扩展为类型 + 关键 flags（PK / UQ / AI / NN）。宽度有限，flags 用缩写，参照既有 `DetailPanel` 的写法保持一致 |
| **hover 卡片** | 完整属性表：类型（含长度/精度）、可空、主键、唯一、自增、默认值、注释、所属表。卡片为多行，比候选行信息更全 |

### 5.2 数据契约

`CompletionItem` 需要从 `schemaCompletions` 透出更多元数据。建议把 `detail` 保持为短字符串（候选行显示），新增一个可选的结构化字段承载 hover 用的完整信息。

⚠️ **注意 `core-sql-editor` 的导出边界**：这个包刻意不进 lazy chunk（它是纯字符串逻辑，见包头注释第 6-8 行），新增字段不得引入任何新依赖或把该包拖进首屏。

> 另注意既有约定：首屏组件要用 `core-sql-editor` 的工具函数时必须从 `@dbstudio/core-sql-editor/facts` 子入口引（主入口会拖进关键字表 +15KB）。

### 5.3 验收

- 单测：各 flag 组合的 detail 拼接与 hover 字段完整性（含注释为空、默认值为空的边界）
- 单测：**BIGINT / DATETIME(6) 等类型显示不丢精度信息**（数据保真红线 6 的 UI 侧延伸）
- e2e:ui：字段候选行出现类型标识；hover 后卡片含注释

---

## 六、交付顺序与依赖

```
S0 体积实测（阻塞 S1）
   ├─→ S1 SQL 格式化（按 S0 结论选 A/B/C）
   └─→ S2 SQL 高亮（无依赖，可与 S0 并行）
       └─→ S3 表提示增强（依赖 S2 的 hover 基座）
           └─→ S4 字段属性提示（依赖 S3 的 hover 基座）
```

**建议**：S2 与 S0 并行先做（S2 零依赖、风险低、观感提升直接）；S1 等 S0 出数据再定；S3/S4 依赖 hover 基座，放在最后。

---

## 七、验收总表

| 项 | 门禁 |
|---|---|
| 类型 | `npm run typecheck`（根 + renderer 两套）全绿 |
| 单测 | `npm test` 全绿，S 板块新增单测 ≥ 40 例 |
| 体积 | `npm run check:bundle` 9/9 全绿，**首屏 cm-editor 零泄漏** |
| UI | `npm run e2e:ui` 全绿 + 新增 S 板块断言 |
| 视觉 | `node docs/design-mockups/verify.mjs` 深/浅双主题截图，含 SQL 编辑器场景 |
| 真机 | `npm run e2e:app`（dist 产物）全绿 |
| 全量 | `npm run verify` exit 0 |

---

**文档版本**：v1.0 · 2026-09-28 · S 板块专项
