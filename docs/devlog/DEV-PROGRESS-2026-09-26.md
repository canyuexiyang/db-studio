# DEV PROGRESS — 2026-09-26：v1.0 收尾冲刺收官

> 本日完成 v1.0 发布前全部剩余任务（P0-1~P2-2），进入整体测试阶段。
> 上半日（P0-2 表设计器 / P0-3 危险确认 / P0-4 多标签主体）见 `.workbuddy/memory/2026-09-24.md` 的 09-26 各节；
> 本文覆盖收尾冲刺的完整闭环。

## 任务清单与结论

| 任务 | 结论 | 关键产出 |
|---|---|---|
| P0-0 e2e:ui 门禁修复 + 状态对齐 | ✅（上会话） | 42→51 断言；任务系统对齐 |
| P0-1 导入导出 utilityProcess + 四格式 UI + D3 向导 | ✅ | e2e:transfer 28/28（真库 + 真 utilityProcess） |
| P0-2 表设计器（字段/索引/外键 + DDL 预览 + 建表） | ✅ | core-table-designer 28 单测；真库 DDL 验证 |
| P0-3 危险操作分层确认 | ✅ | classifyDanger AST 分级 + 生产第三层输表名 |
| P0-4 多标签工作区 | ✅ | e2e:ui 73/73（含脏 tab 关闭拦截、⌘1..9 / ⌘Shift+[ ]） |
| P1-1 树体验补全 | ✅ | D1 展开记忆持久化 + 保存后自动展开新组 + Q2 字段名搜表 |
| P1-2 深色模式三态 | ✅ | data-theme 权威 + theme-boot 无闪烁 + 面板命令 |
| P1-3 查询历史与片段 UI | ✅ | @ 走真 historySearch + 编辑器注入句柄 + 片段命令 |
| P2-1 SSL 驱动接线 + D2 粘贴 e2e | ✅ | +17 单测；真库 TLS 握手三断言；D2 粘贴 4 断言 |
| P2-2 应用图标 + electron-builder + PRD 合稿 | ✅ | icns 真机打包启动验证；PRD-v1.0.md 定稿 |

## 本日要点（每条都真机验证过）

### P0-4 收尾（e2e 适配）
- 🔴 `window.confirm` 在 Playwright 里必须**显式挂 dialog 监听**（默认 dismiss）。
  脏 tab ⌘W 关闭拦截的断言方式：挂 `page.on('dialog')` → dismiss 验「不关」，
  再 `page.once('dialog', accept)` 验「确认后关 + 激活邻位」。
- 焦点归还别点 `.toolbar` 本体（中心可能落在保存/设计按钮上）→ 点 `.env-tag`。

### P1-1 树
- 展开记忆落 `localStorage`（`dbstudio.treeExpansion.v1`）：首帧 `restoreExpansion`，
  变化落盘只存 `db:`/`kind:` 层 key（分组/连接层由核心规则保证展开，不膨胀）。
- 🔴 **组 key 含成员 id 集合**（`group:ungrouped:id1,id2`）——新建连接会改 key，
  旧展开记忆静默失效，用户"保存完看不到刚建的连接"。修法：保存后用新列表
  重算树，找到包含该连接的组节点 key 主动展开（`findGroupKeyOfConnection`）。
- Q2：`buildColumnIndex()` 纯函数（字段名 → `db.table` 清单）+ 列命中行渲染 +
  点击开表（连接上下文：激活 tab > 含该库的连接 > 第一个连接）。

### P1-2 深色模式三态
- `data-theme` 是唯一权威（App 挂载必写 dark|light）；**启动前**由
  `renderer/public/theme-boot.js` 同步设置——🔴 必须**外部脚本**（`<script src>`），
  生产 CSP 是 `script-src 'self'`，内联脚本会被静默拦截。
- 跟随系统 = `matchMedia('change')` 监听；面板命令「切换主题」三态循环；
  CSS 两处 dark 调色板（`[data-theme='dark']` + 媒体查询兜底）必须同步维护。

### P1-3 历史与片段
- `@` 模式接真 `historySearch`（seq 守卫乱序返回；demo 后端空数组降级）。
- 🔴 CodeMirror 实例归 SqlEditorPanel 私有，React state 够不着 →
  `registerInjector/injectorKey` 登记式命令通道；懒加载竞态用 pending 注入
  （登记发生时补写）。历史候选以自定义 `sql` 字段携带原文回填。
- 片段 = 动态命令（`action: 'snippet:<name>'`），回车插入当前查询标签。
- backend 补 `snippetSave`（IPC 三通道早已就绪，纯 UI 缺口）。

### P2-1 SSL（主进程由子代理并行完成）
- `MySqlSslOptions` 值是**文件内容**不是路径；`ssl:null/缺省/空对象` 不出现
  ssl 键（mysql2 以"有无 ssl 对象"判定启用 TLS，必须干净）。
- 主进程读文件 **fail-closed**：路径已配置但读取失败抛 `SSL_READ_FAILED`，
  绝不静默降级为无 CA 的 TLS。
- 真库断言（e2e-smoke 新增【SSL】段）：明文基线 → 正 CA 握手
  （实测 `TLS_AES_256_GCM_SHA384`）→ 篡改 CA 拒连（校验真实生效）。

### P2-2 发布工程
- 图标：`icon.svg` 手写源 + `scripts/make-icon.mjs`（playwright-core 渲染
  iconset + iconutil/sips 产出 icns/png），D7 Liquid Glass 规范。
- electron-builder.yml：workspaces 下 EB 依赖收集不可靠 → mysql2 /
  electron-window-glass / @dbstudio/core-import / node-sql-parser 闭包走
  `extraResources`（asar 外）；`asarUnpack: **/*.node`；ad-hoc 签名。
  `.app` 真机启动验证：native glass 生效、渲染层从 asar file:// 加载。
- 🔴 **vite SSR 外部化的 node-sql-parser 在打包态缺失 → 主进程求值即抛错，
  Electron 只弹空 stderr 的 NSAlert**。用 `sample` 抓 `-[NSAlert runModal]`
  才定位。新增运行时依赖时必须同步维护 extraResources 列表。
- `docs/product/PRD-v1.0.md` 定稿：v0.5 增量逐条并入正文，旧文档归档加注记。

### 合并检查抓到的断点
- 🔴 **e2e-app 漏适配多标签**：`.mode-switch` 已不存在（上会话只改了 e2e-ui），
  verify 全链路一跑才暴露 → 查询入口改 `[data-testid="btn-new-query"]`。
- D2 粘贴 e2e 的"假失败"：粘贴固定落第 0 行起（`startRow:0`），而虚拟滚动
  测试把网格滚到下方 + P0-4 保留滚动位置 → 目标行在视口外，DOM 渲染不出
  脏标记。测试先滚回顶部。判读时先看 statusbar 脏计数再怀疑功能。

## 门禁结果（修复后全量复跑）

```
typecheck（两套 tsconfig）      ✅ 0 error
单测                            ✅ 762/762（27 文件；SSL +17、树 +1）
check:bundle                    ✅ 首屏 310.8KB / gzip 99.5KB（预算 1465KB）
e2e 冒烟（真库）                ✅ 51/51（+3 SSL TLS 握手）
e2e:transfer                    ✅ 28/28
e2e:ssh                         ✅ 18/18
e2e:grid                        ✅
e2e:ui                          ✅ 73/73（多标签/树/主题/历史片段/D2 粘贴）
e2e:app（生产产物 + 真窗口）    ✅ 30/30（编辑器懒加载断言修复后）
```

## 未覆盖（诚实列出）
- dmg 目标未实际构建（`--dir` 验证到 .app；首次 `npm run dist` 时留意 dmg 阶段）。
- 打包态启动为自动化探针（CDP + 窗口计数 + 日志），玻璃观感待肉眼确认。
- 私钥带 passphrase 真机用例、KILL QUERY 编辑器端到端、EXPLAIN 真库渲染
  （PRD §14 保留的工程待办）。

---

# 追加轮（同日晚间）：安装后真机缺陷修复 + 可用性打磨

> 用户实际安装 `/Applications/DB Studio.app` 后反馈三大关键缺陷，根本无法正常使用。
> 本轮全部修复并经 computer use 驱动真实安装包端到端验收；门禁全量复跑通过。

## 三大关键缺陷（全部定位到根因）

### 1. 新建连接对话框无法输入中文 + 焦点自动跳回「连接名」
**根因（同一个）**：`ConnectionEditor` 里的 `Field` 组件定义在**组件函数体内**。
每次按键 → state 更新 → 重渲染 → 新的组件类型 → React 把整棵表单子树
**卸载重挂**。后果：① 输入法组合（IME）每个音节都被打断，中文一个字都进不去；
② `autoFocus` 在每次重挂时重新抢焦点，光标永远飞回「连接名」—— 用户描述的
「在其他输入框打字后被吸回连接名」即此。
**修复**：`Field` 提升到模块层，校验结论以 `issues` prop 下传；并立了规矩：
组件体内不允许出现 `const Xxx: React.FC = ...`（文件头注释写明）。
**回归**：e2e:ui 新增「中文逐键输入完整落格」「其他输入框打字时焦点不被抢回」两条断言。

### 2. 连接树无法展开/连接/选中（核心链路第一步就卡死）
三个叠加缺陷，缺一都表现为「新建的连接点不动」：
- 🔴 **`onToggleConnection` live 语义接反**（App.tsx）：之前 `live ? connect : disconnect`
  —— 未连接时双击反而去 disconnect（no-op），已连接时双击重连。
  修正为 `live ? disconnect : connect`。
- **行没有单击行为**：树行只挂了 dblclick，单击什么都不发生（无选中反馈）。
  现在单击 = 选中一切；未连接的连接节点单击即发起握手（对齐 TablePlus 的快节奏）；
  分组/库/对象类别节点单击即展开。双击 = 打开表（对象）/ 展开库（已连接）。
  防抖约定：容器节点单击已切换展开，双击不再响应（防「展开又收起」抖动）。
- **连接成功不自动展开**：现在 `connConnect` 成功后自动把 `conn:<id>` 加进展开集，
  单击连接即见库列表，无需二次操作。
- caret 点击补了 `stopPropagation`（否则与行单击各切换一次 = 净零）。

### 3. promptEveryTime 连接永远连不上（整体排查发现）
连接设置了「每次手动输入密码」后，树上点连接只会报
「该连接设置为每次手动输入密码」—— 全应用没有任何输入密码的入口。
**修复**：新增 `PasswordPromptModal`（Enter 提交 / Esc 取消），
明文只在内存里活到这一次 `connConnect` 调用（红线 3 口径不变）。

## 可用性打磨（对齐 Navicat 成熟度，不扩功能）

- **三栏宽度拖拽**：侧栏与详情面板各有一条分隔条（pointer capture 增量拖拽），
  宽度写 `dbstudio.layout.v1` 持久化；拖拽中全局 `user-select: none` + col-resize 光标。
  e2e:ui 新增「左拖加宽 / 右拖收窄 / 宽度持久化」三条断言。
- **溢出滚动**：详情面板整列 `overflow-y: auto`（矮窗口可滚）；工具栏窄窗口横向滚动。
- **图标规范化（红线）**：树里的 🔴危险标记 → CSS `.danger-dot`；⚙/✕/＋表 →
  SVG 图标（icons.tsx 新增 Gear/X/Plus/Refresh/Plug/Power/Database/Table/Eye/Braces/Fn）；
  标签条 🔒 → `IconLock`、▦/✎ → `IconTable`/`IconTerminal`；连接状态字符
  （⟳●◐✕○）→ 纯 CSS 状态圆点（含 connecting 脉冲动画）。工具栏 9 个按钮全部配图标。
- **删除连接二次确认**：之前点 ✕ 直接删（除红标外无任何拦截），现在 `window.confirm`。
- **侧栏刷新按钮**：对所有活连接 `schemaRefresh`（设计器之外改库后让树跟上）。
- 连接失败/断开状态本地即时反馈（不依赖未订阅的主进程推送通道）。

## 门禁结果（本轮修复后全量复跑）

```
typecheck（两套 tsconfig）      ✅ 0 error
单测                            ✅ 762/762
check:bundle                    ✅ 首屏 303.7KB / gzip 1465KB 预算内；lazy chunk 142.3KB gzip
e2e 冒烟（真库）                ✅ 28/28
e2e:transfer                    ✅ 通过
e2e:ssh                         ✅ 通过
e2e:grid                        ✅ 通过
e2e:ui                          ✅ 79/79（新增 8 条：树单击选中 / 拖宽×3 / 中文逐键 / 焦点稳定等）
e2e:app（生产产物 + 真窗口）    ✅ 31/31
```

## PRD 对齐
- §十四 #11 连接编辑器收口为已完成；新增 #14 记录本轮。
- §12.1 / §12.2 / §12.4 验收清单按门禁证据逐项勾选（缺专项验证的 5 项保留未勾并注明）。
- §0.5 能力矩阵：表设计器 / 导入导出向导 ⬜ → ✅。

### 真机验收补充发现（安装包端到端第二轮）
- 🔴 **第四个真缺陷：QUERY_RUN 丢弃 `req.database`** —— 未设「默认数据库」的连接上，
  SQL 编辑器里不带库前缀的语句全部 "No database selected"。修复：Session 增加
  `currentDb` 跟踪，`runQuery` 在库变化时补 USE（同库不重复发，省一个来回），
  用户手写 `USE xxx` 也纳入跟踪；IPC 处理器把 database 传下去。+5 单测。
- 数据灌库踩坑：`docker exec mysql` 客户端默认 latin1，中文会双重编码存坏
  （网格如实显示乱码，不是应用问题）—— 灌中文必须 `--default-character-set=utf8mb4`。
- 新增 `npm run verify:installed`（scripts/verify-installed.mjs）：驱动
  /Applications/DB Studio.app 真实安装包 + 真实 userData 的 19 项端到端验收
  （中文逐键/焦点稳定/真库握手/树展开/网格/拖分栏/编辑器执行/删除收尾），当前 19/19。
- 真机截图留档：`docs/design-mockups/shots-installed/`（浅/深主题、连接编辑器、连接树）。

---

# 追加轮 2（同日晚间）：执行 SQL 失败排查 + Navicat 式右键菜单 + 导入导出 UI 自测

## 1. 执行 SQL 失败（用户截图：No database selected）
**根因**：查询标签的库上下文只来自「表标签所在库」—— 从工具栏 ⌘T 新建、
没有打开任何表时，库上下文为 null；即使用户在左树已经选中了库节点也不继承。
上一轮修好的「req.database 传到主进程」只解决了一半：tab 压根没带库时无从传起。
**修复（两处）**：
- `newQueryTab` 优先级改为：激活表标签的库 → **左树选中节点解析出的库/连接**
  （`parseTreeKeyContext`，db:/kind:/obj: key 第 2/3 段）→ 第一个连接。
- SQL 编辑器工具栏新增**查询目标库下拉**（Navicat 标志性交互）：列出该连接
  schema 里的全部库，切换即 `patchQuery` 更新 tab 上下文，执行时主进程按需补 USE。
  老查询标签也能随手补救，不必关掉重开。

## 2. Navicat 式树右键菜单（各级别）
自绘 `TreeContextMenu`（跟随主题、Apple 菜单高亮、Esc/点外/失焦关闭），
右键同时选中节点（Navicat 语义）。各级别：
- **连接**：打开/断开连接、新建查询、编辑连接、刷新表结构、删除连接（红）
- **库**：新建查询（继承该库）、新建表、复制库名、刷新
- **表**：打开表、设计表、**导出数据…/导入数据…（直接对未打开的表操作，
  exportTarget/importTarget 泛化为显式目标）、复制表名、清空表（红）、删除表（红）**
- **对象类别（表）**：新建表、刷新；**分组**：新建连接；**树空白区**：新建连接
- 清空/删除表走与网格写操作同一安全链路：confirmDanger（生产红标自动第三层输表名）
  → mutationApply（主进程守卫兜底）；标识符转义走 core-sql-ident 的 quoteQualified；
  删除表后自动关闭其打开的 tab，清空后自动重载。

## 3. 导入导出 UI 级自测（新脚本 `npm run e2e:transfer:ui`，22/22）
驱动打包产物走完整链路（弹窗 → IPC → utilityProcess → 文件落盘 → 真库回读）：
- 导出 ×4 格式（xlsx/csv/json/sql）+ 文件内容抽检（CSV 中文无损/JSON 可解析/
  SQL 含 INSERT/XLSX 落盘）+ 树右键导出同链路验证。
- 导入 4 步向导：自动列映射、预览校验、3 行有效入库 + 1 行非法被拦
  （"列 amount 是 decimal，但值 abc 不是合法数"）、中文无损、未映射列走表默认值。

**自测抓到并修复的真缺陷**：
- 🔴 `connectionFor` 只用连接的 `defaultDatabase`，无视请求里的 `database` ——
  导出**非默认库**的表/连接未设默认库时报 "Incorrect database name ''"，
  导出功能对多库连接形同虚设。修复：请求库优先（transfer-manager）。
- 原生保存/打开框无法自动化：加 `DB_STUDIO_E2E_TRANSFER_DIR` /
  `DB_STUDIO_E2E_IMPORT_FILE` 两个主进程测试接缝（与 DB_STUDIO_E2E_USER_DATA 同族）。
- 自测脚本自身的教训：`MySqlDriver` 的 rows 是数组形态（rowsAsArray，R10 口径），
  回读断言按列下标取值，不按对象字段名。

## 4. 门禁
e2e:ui 新增 5 条断言（表/库右键菜单、Esc 关闭、库下拉继承 order_db、切库生效），
全量 verify 复跑全绿；`e2e:transfer:ui` 22/22。

---

# 追加轮 3（同日晚间）：「连接未建立」自动握手 + 结果页签可关闭

## 1. 右键新建查询后执行仍报「连接未建立」（用户反馈）
**根因**：树的库表列表可以来自【磁盘快照】—— `connList` 会把
`snapshotInfo` 的 schema 一并带回渲染层，所以用户能展开库、看到表、
右键新建查询，但会话本身并没有建立。上一轮修的「查询标签继承树选中库」
解决了库上下文，没解决"会话不存在"这一层。
**修复（Navicat 语义：看到了就能用）**：新增 `ensureConnection(connId)`：
- 已连接/执行中 → 直接放行；
- 连接中 → 等待在途握手落定（最多 ~15s，不并发二次握手）；
- 未连接 → **自动握手**（复用 onConnectNode：成功后 toast + schema 跟上 + 树展开）；
- promptEveryTime（无存储密码，握手做不到）→ 弹密码框，输入成功后经
  `pendingAfterConnectRef` **续接刚才被打断的动作**（继续执行 / 继续开表）。
接入点：`onRunSql`（执行 SQL）与 `openTableTab`（双击表/命令面板/列命中 ——
同样的快照场景）。握手失败时结果页给出明确结论，真实原因已在 toast。
`onConnectNode` 改为返回 boolean 供编排。

## 2. SQL 结果页签可关闭（用户反馈）
- 每个结果页签加 × 按钮（hover/激活显形；执行中禁用，避免与结果写入竞态）；
- 页签条从「>1 个才显示」改为「≥1 个就显示」—— 单个结果也能关；
- 关闭激活页签时激活邻位（优先右，与 ws-tab 同语义）；全关回到空态提示。

## 3. 门禁
- verify-installed 升到 21 项：新增「右键新建查询后直接执行 → 自动握手
  返回 1 行」「结果页签可关闭」两条真机回归，21/21。
- e2e:ui 增加结果页签关闭断言。
- 教训：真实 userData 里用户自己的树展开记忆会让其他连接出现同名
  「表」类别行 —— 真机脚本定位改为【verify_ui 子树内按标签找行下标】，
  泛匹配 .first() 会点错行；多查询 tab 后编辑器定位要限定
  `.ws-tab-pane:not(.hidden)`。
