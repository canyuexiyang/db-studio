# DEV-PROGRESS 2026-09-29 · v1.3 缺陷清理（6 项真机反馈）

> 需求资产计划：[`../product/REQ-v1.3-缺陷清理.md`](../product/REQ-v1.3-缺陷清理.md)
> 门禁结果：`npm run verify` **exit 0**（typecheck / 1559 单测 / check:bundle 9/9 / e2e 全链路 393 断言）
> 专项门禁：`npm run verify:traffic-lights` **6/6**（新增）｜双主题截图 `docs/design-mockups/verify.mjs` ✅

---

## 一、交付清单

| # | 用户描述 | 真实根因 | 修复 |
|---|---|---|---|
| 1 | 表格无法编辑、编辑按钮点不动 | **数据没加载出来**：连接空闲 10min 自动断开进 `closed`，全链路无自动重连 | `loadTable` 内 ensure + `onConnState` 订阅 + idle 真释放资源 |
| 2 | 复制带上了列字段 key | `serializeCopy` tsv/csv 固定输出表头 | 默认只复制值，`includeHeader` 可选 + 右键「含列名」逃生口 |
| 3 | 树选中表不联动右侧详情 | `DetailPanel` 只吃 `openTab?.table` | `detailContext`：树选中优先，回退激活标签 |
| 4 | 筛选界面乱 / 点击多 / 按钮丑 | `flex-wrap` 不对齐；AND/OR 用 `select` 要三步；浏览器默认按钮 | Grid 六轨对齐 + `LogicChips` 一步切换 + `.fb-btn` 统一 |
| 5 | 详情面板信息不够，要建表语句 | 注释只在 `title` 悬浮；第三块是单元格值 | 字段两行制含注释常驻；第三块换 `SHOW CREATE TABLE` |
| 6 | 左上角没有红绿灯 | **`transparent+frame:false` 下原生灯根本不渲染**（静默无效） | `titleBarStyle:'hidden'` + `trafficLightPosition`，删 `roundedCorners:false` |

---

## 二、🔴 真机抓到、单测全绿也照样漏的 bug

### 1. 缺陷 6：`setWindowButtonVisibility(true)` 静默无效（本次最大收获）

**症状**：窗口关不掉、缩不了、放大不了。左上角一片空白。

**为什么藏了这么久**：旧代码该有的防御全做了 ——
```ts
if (typeof win.setWindowButtonVisibility === 'function') {  // 判空 ✓
  win.setWindowButtonVisibility(true);                       // 调用成功 ✓
}
```
`typeof` 通过、调用不抛异常、`isClosable()` 返回 true、e2e 断言全绿。
**但灯就是没有。** v1.2 的 W 板块还据此写了一份需求文档，结论是「灯已存在，只需让位」，
于是做了 78px padding + no-drag 层 + 关闭拦截 —— **让的是一块空白地方**。

**定位手段**（Playwright 与 `capturePage` 都穿不透原生控件，只能走系统层）：
```
每个窗口形态一个独立 Electron 进程
  → screencapture -R 抓窗口矩形
  → 像素检测 macOS 三色（红 255,95,86 / 黄 254,188,46 / 绿 40,200,64）
```

**探针对照表**（Electron 44.4.3 / Darwin 27）：

| 配置 | 交通灯 |
|---|---|
| `frame:false` + `transparent:true` + `roundedCorners:false`（旧） | ❌ 无 |
| `frame:false` + `transparent:true` | ❌ 无 |
| `frame:false` + 不透明 | ✅ 有 |
| `titleBarStyle:'hiddenInset'` + `transparent:true` | ❌ 无 |
| `titleBarStyle:'hidden'` + `transparent:true` + **`roundedCorners:false`** | ❌ **无** |
| `titleBarStyle:'hidden'` + `transparent:true` + 玻璃 + `trafficLightPosition` | ✅ **有** |

**两条结论**：
1. `transparent:true` 必须配 `titleBarStyle:'hidden'` 才有原生灯。`frame:false` 下
   Chromium **根本不创建标准窗口按钮视图**，`setWindowButtonVisibility` 调了等于没调。
2. `roundedCorners:false` **单独就能让灯消失**（P1 有灯 vs P2 无灯，其余配置完全相同）。
   这条最反直觉 —— 一个"圆角"开关居然连着窗口按钮的生死。

**连带发现（差点漏掉）**：换 `trafficLightPosition` 构造参数后，灯的**渲染几何变了**。
旧口径「直径 12px、间距 8px、x∈[10,62]」，新实测「直径 **14px**、间距 **23px**、x∈[**16,76**]」。
渲染层安全区当时是 72px → **绿灯右缘露出 1px 在 drag 区里**。已同步改 78px 并把实测几何
固化成 `TRAFFIC_LIGHT_MEASURED` 常量 + 单测断言，避免两处数字再次各自漂移。

### 2. 缺陷 1：「无法编辑」是假象，真因是「没有数据」

用户截图给了三条互相矛盾的线索，拼起来才成立：
- 状态栏写着「**可编辑：是**」「**连接：已连接**」；
- 网格区暗像素 **0 个**（只有列头，一行数据都没有）；
- 底部横幅 OCR 出原文「打开表失败：连接当前状态 **closed**，无法执行查询」。

`closed` 只有一个来源：`DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000` 的空闲自动断开。
用户「间歇性查看数据」的姿态正好踩中。

**三层叠加，缺一条都不表现为此缺陷**：
1. 主进程 idle 断开 → `closed`；
2. **渲染层 `connStates` 从不订阅推送**（只有 `ConnStateBanner` 自己订阅了）→ App 仍以为
   `connected` → 状态栏显示假象 → `ensureConnection` 读到 `connected` 直接返回 `'ready'`
   → **跳过重连**；
3. 只有 `openTableTab` 做了 ensure，`loadTable` 自己没有 → 排序/筛选/刷新/加载更多/**会话恢复**全漏。

**为什么表信息还是好的**：`schemaGetTable` 走内存/磁盘快照，不需要活会话；
`runQuery` 才需要。所以「结构完整 + 数据全空」这个组合是必然的，也是最有诊断价值的特征。

**如果只补第 3 层会怎样**：修复被第 2 层架空 —— `ensureConnection` 读陈旧状态返回 ready，
查询照旧失败。**两层都要修才成立**，而第二层从任何单测里都看不出来。

**顺手修掉的孤儿红线隐患**：idle 断开此前只推状态机，**驱动与隧道原封不动留着**。
用户下次操作触发重连时 `connect()` 新建隧道+驱动，旧的成孤儿 —— 违反 AGENTS.md §四.7
（SSH 场景下就是留一个 ssh 子进程）。新增 `releaseIdleSession()` 在 `observedClock` 里收口
（idle 迁移只可能由该定时器引发，是唯一收口点）。

### 3. 缺陷 5：改 CSS 前必须先想「这块的能力谁来接」

「单元格完整值」那块同时承载着 A9（JSON 格式化 + 四色高亮）与 A10（图片预览 / HEX /
保存到磁盘）两项已交付功能。直接删掉 = 功能倒退，而 PRD §6.7 明确写了「网格里长文本与
BLOB 是截断的，用户需要一个地方看全」。所以整块搬到 `CellValueModal` 弹窗，
入口仍走网格右键「查看完整值」（该菜单项本来就有）。

**差点埋的坑**：菜单项原来只调 `onCellActivated`（把值送进侧栏）。侧栏那块换成 DDL 后，
若不另开回调，用户点「查看完整值」将**什么也不发生** —— 一个点了没反应的菜单项
比没有这个菜单项更糟。所以新增 `onInspectCell`，宿主没接时退化为原行为。

另一个坑：handler 里**不能用 `openTab`**。右键可能落在非激活 pane 上（多标签常挂 DOM），
用错 tab 的表现是「弹窗显示的是另一张表的值」—— 比不弹更难查。改为按 `tabId` 取该 pane 自己的 source/table。

### 4. 我自己写的断言当场翻车三次

| 断言 | 错在哪 | 修法 |
|---|---|---|
| 「含列名首行含 `id`+`status`」 | 右键的是**单个单元格** → 选区只有一列，首行是那列的列名。我按整行语义写了断言 | 改口径断言：默认「1 行选中 = 1 行输出」；含列名「恰好多一行且其余逐字一致」 |
| 「弹窗显示第 3 行」 | 行号是虚拟滚动的**全局行号**（实测 408、415…） | 改 `/第\s*\d+\s*行/` |
| 「弹窗显示列名 order_no」 | `.grid-cell.nth(1)` 跳过行号 gutter 后是**第一数据列 `id`** | 改 `/单元格完整值 — \S/`（只验结构不验具体列） |
| 「各条件行左缘差值 = 0」 | 在**只有 1 行**时量的 → `max-min` 恒为 0，**不改代码也恒真的假绿** | 必须先加第二条条件再量，并断言 `rows.length >= 2` |

### 5. e2e-app 的编辑器断言是**既有竞态**，被我的改动稳定暴露

```
❌ 编辑器从生产产物加载并渲染 — 点击 → 编辑器可见 -1ms
✅ chunk 载入 ≤300ms
   （紧随其后的 waitForSelector('.cm-editor') 又通过了）
```
"报 -1 但元素明明在" 这个自相矛盾的组合就是竞态铁证：`MutationObserver` 只对**注册之后**
的 DOM 变更回调。而应用启动时**自带一个 query 标签**，`.cm-editor` 早已挂载；
点击「查询」只是 `ws.activate()` 切标签，**不新增节点** → observer 永不回调 → 20s 超时。

自诊断字段证实：`点击前已存在=true，标签 1→1`。
且 stash 掉我的改动跑基线 dist，同样是 `tabs=1, hasCm=true` → **既有竞态**，
基线那次测到 173.1ms 纯属时序抖动；我新增的 `onConnState` 订阅 effect 改变启动时序，
把它从"偶然通过"变成"必然失败"。

修法：改**轮询存在性**（确定性 —— 无论"点击后新挂载"还是"本就在"都能 resolve，
真没渲染出来照样超时失败，不假绿）。E3 的真断言是 chunk 载入 ≤300ms，那条不受影响。

### 6. 门禁脚本自己的 BMP 解析器写错，导致假红

给缺陷 6 写常驻门禁时，第一版手解 `sips` 输出的 BMP，结果 sips 给的是 **BITMAPV4/V5 头**
（`headerSize=124`、`dataOff=138`、`height` 为负 = 自上而下、`bpp=32`、
`compression=3` = BI_BITFIELDS 需读通道掩码），而我按标准 54 字节头 + 自下而上 + BGR 写死
→ **灯明明在，门禁报"一个都没检测到"**。

教训与项目既有方法论一致：**替身/解析器不能照自己的假设实现**。
改成让 Chromium 自己解码 PNG（`data:image/png;base64` + canvas `getImageData`）——
零格式假设。⚠️ 必须用 data URL 不能用 file://：后者会污染 canvas，`getImageData` 抛 SecurityError。

还有一个色相判定错误：黄灯 `(253,197,50)` 的 r **也是最大值**，
`r>g && r>b → RED` 会把它判成红（报出 `GREEN,RED,RED`）。
正确判据是看蓝通道相对绿通道低多少：黄灯 `g-b > 50`，红灯 `g≈b`。

---

## 三、验证方法论补充（本轮新增）

1. **「调了不抛异常」≠「生效」**。系统级 API（尤其 darwin 专属的窗口/外观类）必须用
   **渲染层之外的手段**验证：原生控件走 `screencapture` + 像素检测，
   Playwright / `capturePage` / DOM 查询全部穿不透窗口服务器层。
2. **凡是断言外部渲染几何的数字，必须来自实测而非常识推算**。交通灯直径从 12px 变 14px、
   间距从 8px 变 23px，都是换 API 后 macOS 的实际渲染变化，没有任何文档会告诉你。
3. **用户截图是可以读的，而且信息密度极高**。本轮靠 OCR（macOS Vision）读出底部横幅原文
   与状态栏矛盾，靠像素统计证明网格区暗像素为 0 —— 缺陷 1 的根因在写第一行修复代码前就确定了。
   别急着猜，先把用户给的证据榨干。
4. **状态不同步是最隐蔽的接线缺陷**：主进程推了、渲染层没订阅，于是所有基于该状态的
   判断都建立在陈旧值上。这类问题从单测里永远看不出来，必须查"谁订阅了这个推送"。
5. **改 CSS 类名要连测试选择器一起改**：筛选器 `.col/.op` → `.fb-col/.fb-op` 后，
   既有红线断言（数值列没有「包含」）会因选择器落空而**静默跳过** —— 假绿比假红危险得多。
   本轮同时把该断言从"靠 option 文本里的 `decimal` 认数值列"改成按 value 精确选 `amount`
   （因为 option 文本改成显示 comment 了，旧认法必然失配）。
6. **`MutationObserver` 不适合断言"元素存在"**，它只报"元素新增了"。
   若目标元素可能在注册前就存在，必须用轮询或先查一次。
7. **🔴 写断言前先问"此刻的基线是什么"**。本轮 §七 那 6 条假红**没有一条是实现错了**：
   断言前 A22 快速筛选已经应用过 1 个条件，徽标本来就是「筛选(1)」，我却要求"徽标不含数字"。
   这与"恒真断言"是同一个坏习惯的两个方向 —— 都把某个时刻的具体状态当成了通用前提。
   修法：先「清除」建立零基线，再全程做**相对**断言（"不变" vs "变亮"成对出现）。
8. **🔴 文档写了、界面从没显示过的能力，比没写更糟**。"N 条未填完已跳过"这句提示
   是我自己写进需求文档的，但两个计数取了同一个表达式 → 条件恒 false → 提示永不显示，
   而没有任何测试会红（它不是回归，是从未生效的新功能）。
   对策：**每条写进文档的用户可见能力，都要有一条断言看着它真的出现过一次**。
9. **UI 上"显示给用户看的状态"必须有唯一真值来源**。徽标 / 状态栏 / 导出弹窗现在都读
   `openTab.filter`，草稿单独放 `filterDraft`。此前它们读的是"编辑中的全局镜像"，
   于是出现「宣称筛了 2 条、数据一行没变」。判据：凡显示状态处，都要能回答"这个数从哪来"。
10. **截图脚本也要断言**。最典型的假绿是"图生成了，画的却是旧布局"。
    给 `verify.mjs` 补 DOM 断言（grid / 纵向差值 0 / chip ≥2 / 注释常驻 / DDL 非空）后，
    画错会直接抛错；再用像素比对（深/浅相同比例 0%）证明主题真切换了。人工比对不可复跑。

---

## 四、门禁结果

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（根 + renderer） | ✅ exit 0 |
| `npm test` | ✅ 47 文件 / **1559** 项（基线 1548，新增 11） |
| `npm run check:bundle` | ✅ 9/9；首屏 **442.1 KB** / 1465 KB（基线 421.6，+20.5 KB = CellValueModal 进首屏）；编辑器 lazy 133.0/150 KB gzip 未变 |
| `npm run e2e`（真库冒烟） | ✅ |
| `npm run e2e:transfer` | ✅ |
| `npm run e2e:ssh` | ✅ 18/0 |
| `npm run e2e:grid` | ✅ |
| `npm run e2e:ui` | ✅ **219/219**（基线 190，新增 29 条缺陷回归断言） |
| `npm run e2e:app`（真 Electron + 真 MySQL） | ✅ **45/45** |
| **`npm run verify` 全链路** | ✅ **exit 0，393 条断言，0 失败** |
| `npm run verify:traffic-lights`（新增专项） | ✅ 6/6 |
| `docs/design-mockups/verify.mjs` 双主题截图 | ✅ 已跑，并**扩展覆盖**筛选弹窗 + 详情面板（新增 4 张图 + DOM 断言；深/浅逐像素相同比例 **0%**） |

---

## 五、遗留项（下一轮处理）

1. **缺陷 1 的长时验证**：idle 超时 10 分钟，自动化等不起。需真机放置或临时调小
   `idleTimeoutMs` 验证「断开后点排序能自动重连出数据」。逻辑链路已由单测覆盖，
   但"真库真断线真重连"这条端到端还没跑过。
2. **缺陷 6 的人工手感终验**：像素门禁证明了灯在且几何正确，但「红=关闭且脏标签走保存预演 /
   黄=最小化 / 绿=全屏 / ⌥+绿=Zoom」这套交互语义需真机点一遍（自动化测不出"拖不动"）。
3. ~~缺陷 4/5 的双主题比对~~ → **已完成**：`verify.mjs` 已扩展覆盖筛选弹窗与详情面板，
   并带 DOM 断言（画错直接抛错）。仅剩**视觉精修的主观判断**（配色/间距是否好看）留给人眼。
3. **`titleBarStyle:'hidden'` 的系统拖拽带**：它会保留一条原生拖拽区，与 `.toolbar` 的
   `-webkit-app-region: drag` 是否冲突需真机手感确认（自动化测不出"拖不动"）。
4. **首屏体积**：442.1 KB 距 1500 KB 上限尚宽，但 CellValueModal（含 A9/A10 全部逻辑）
   现在进了首屏。若后续再加详情面板功能，应考虑把它改成 lazy chunk。
5. **`.traffic-light-safe` 高度 30 → 34px**：灯中心 y=21、直径 14 → 占 y∈[14,28]，
   30px 刚好够但无余量，改到 34px。全屏态下 macOS 把灯叠在内容上，需真机确认没有回归。

---

## 六、文件变更

**新增**
- `apps/desktop/renderer/src/detail/CellValueModal.tsx` — 单元格完整值弹窗（承接 A9/A10）
- `scripts/verify-traffic-lights.mjs` — 交通灯像素级门禁（`npm run verify:traffic-lights`）
- `docs/product/REQ-v1.3-缺陷清理.md` — 本批缺陷的资产计划
- `docs/design-mockups/shots-installed/traffic-lights.png` — 门禁截图证据
- `docs/design-mockups/verify-{filter,detail}-{light,dark}.png` — 缺陷 4/5 改版视图的双主题截图
- `docs/devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md` — 本文

**修改**
- `apps/desktop/src/main/window.ts` — 缺陷 6：`titleBarStyle:'hidden'` + `trafficLightPosition`；
  删 `frame:false` / `roundedCorners:false`；新增 `applyTrafficLights` / `TRAFFIC_LIGHT_MEASURED`；
  文件头补探针对照表与推翻说明
- `apps/desktop/src/main/window.test.ts` — 新增 4 条交通灯断言（18 项）
- `apps/desktop/src/main/session-registry.ts` — 缺陷 1：`releaseIdleSession()` + `observedClock` 收口
- `apps/desktop/renderer/src/App.tsx` — 缺陷 1（`onConnState` 订阅 + `loadTable` ensure + 3 个 ref 桥）；
  缺陷 3（`detailContext`）；缺陷 5（`cellModal` + `onInspectCell`）；
  **§七.1**（筛选改草稿态 `filterDraft` / `openFilter` / `closeFilter`，徽标与导出改从
  `openTab.filter` 派生；`onQuickFilter` 乐观写回）
- `packages/core-clipboard/src/{index,index.test}.ts` — 缺陷 2：`includeHeader`（默认 false）
- `packages/core-filter/src/{index,index.test}.ts` — **§七.2**：新增 `effectiveConditionCount()`
  与 5 条单测（含"生效数为 0 ⇔ 生成不出 WHERE"不变量）
- `apps/desktop/renderer/src/detail/DetailPanel.tsx` — 缺陷 3+5 重写
- `apps/desktop/renderer/src/filter/FilterBuilder.tsx` — 缺陷 4 重写（Grid + LogicChips + fb-btn）；
  **§七.2** 预览计数改 `effective` / `total` 双口径
- `apps/desktop/renderer/src/grid/{DataGrid,CellContextMenu}.tsx` — 缺陷 2/5 接线
- `apps/desktop/renderer/src/workspace/TablePane.tsx` — 缺陷 5：`onInspectCell` 透传
- `apps/desktop/renderer/src/ui/icons.tsx` — 新增 `IconTrash`（禁 emoji 红线）
- `apps/desktop/renderer/src/demoData.ts` — demo 表补字段注释（缺陷 5 的验证靶子）
- `apps/desktop/renderer/src/styles.css` — 缺陷 4 筛选器整段重写；缺陷 5 字段两行制 + DDL 区 +
  弹窗；缺陷 6 安全区 72→78px；删死代码 `.sf-btn`
- `scripts/e2e-ui.mjs` — 新增 **29** 条缺陷回归断言；修正筛选红线断言选择器；
  把恒真断言 `previewBefore.length >= 0` 换成真口径
- `scripts/e2e-app.mjs` — W 板块坐标口径更新（旧 x∈[10,62] 已作废）；
  编辑器断言改轮询修竞态
- `docs/design-mockups/verify.mjs` — **扩展覆盖筛选弹窗与详情面板**（原来只截网格/连接编辑器/
  脚本弹窗，改版的两个视图压根不在范围内），并加 DOM 断言防"图生成了但画的是旧布局"
- `package.json` — 新增 `verify:traffic-lights`
- `docs/product/REQ-v1.2-窗口原生控件.md` — §一 结论已证伪，加文首更正指向本文
- `docs/README.md` — 索引补本文与 v1.3 需求文档

---

## 七、🔴 改筛选界面时连带挖出的两个既有缺陷

都不是用户报的，是**写回归断言时被抓出来的**。共同特征：**UI 宣称的状态与真实数据不一致**，
而任何既有测试都看不见（两侧各自"正确"）。

### 1. 「取消」是空按钮 —— 草稿污染全局态

`FilterBuilder` 的 `onChange` 直接写全局 `filterModel`，但"已应用"的真值是 `tab.filter`
（`loadTable` 成功后才写回）。于是：

| 操作 | 修之前的表现 |
|---|---|
| 加条件 → 点「取消」 | 工具栏「筛选 (2)」、状态栏「筛选：2 条」照显示，**数据一行没变** |
| 再点「应用」 | 把用户以为已丢弃的条件悄悄用上 |
| 从 A 表切到 B 表 | 徽标仍显示 A 表的条件数（全局镜像切表不同步） |

修法：弹窗编辑 `filterDraft`，`openFilter()` 从 `openTab.filter` 取种子、`closeFilter()` 丢弃；
徽标 / 状态栏 / 导出弹窗一律从 `appliedFilter = openTab.filter` 派生（**真值只有一处**）。

`onQuickFilter`（A22 右键快速筛选）里那行"同步全局编辑态"删掉，改为**乐观写回**
`ws.patchTable(tabId, { filter: next })` —— `loadTable` 是 await 查询返回后才 patch，
期间徽标会滞后一拍，用户点了"筛选"却看不到计数变化，会以为没生效。

### 2. 徽标与预览虚报条数 —— 计数口径与 `buildWhere` 不一致

`conditionCount()` 数**所有**条件行（含未选字段、未填值的半截行），
而 `buildWhere()` 的生效判据是 `isConditionComplete(c)`。「筛选 (2)」可能对应 WHERE 里 0 条。

更要紧的是：我上一轮在预览区写了"N 条未填完已跳过"，但两个计数取的是**同一个表达式**，
`total > effective` 恒为 false —— **这句提示从来没显示过**，而它已经被我写进需求文档当作已交付能力。
文档说有、界面从不显示，且没有任何测试会红（它不是回归，是从未生效的新功能）。

修法：`core-filter` 新增 `effectiveConditionCount()`，判据与 `buildWhere` 的跳过条件逐字一致，
并用一条不变量单测钉住两处口径不漂移：

```ts
it('🔴 不变量：生效数为 0 ⇔ 生成不出 WHERE（口径未漂移）', () => {
  for (const m of cases) {   // 空模型 / 全半截 / 全生效 / 混排 / 无需填值 / 跨分组
    const eff = effectiveConditionCount(m);
    const { sql } = buildWhere(m);
    expect(eff === 0 ? sql === '' : sql !== '').toBe(true);   // 双向蕴含
  }
});
```

📌 **改 `buildWhere` 的跳过判据时必须同步改它** —— 漂移的表现是"徽标数与预览条件数对不上"，
而这种不一致**不会让任何单侧的测试变红**，只有跨两侧的不变量断言能抓住。

### 3. 我为此写的 6 条断言全是假红（教训比修复本身值钱）

第一次跑：`通过 212/218`，6 条失败全指向"徽标不该有数字"。查下去发现**实现是对的** ——
这段之前的 A22 快速筛选已经应用过 1 个条件，徽标本来就是「筛选(1)」，是**我的断言前提不成立**。

修法：先点「清除」建立**零基线**，再全程做相对断言，并让"取消不亮 / 应用才亮"成对出现：

```
✅ 缺陷 4：「清除」立即生效（弹窗关闭 + 徽标归零） — 徽标=筛选
✅ 缺陷 4：编辑中的草稿不污染工具栏徽标 — 徽标=筛选
✅ 缺陷 4：🔴 取消后徽标不残留计数（草稿已丢弃） — 徽标=筛选
✅ 缺陷 4：取消后状态栏不显示「筛选：N 条」 — (无筛选字样)
✅ 缺陷 4：点「应用」后徽标才显示已生效的条件数 — 徽标=筛选(1)
```

📌 与"恒真断言"是同一个坏习惯的两个方向：恒真是**断言太松**，这次是**前提不成立**。
根子都在"把某个时刻的具体状态当成通用前提"。**写断言前先问：此刻的基线是什么？**

另有一处同类翻车：用 `selectOption('isNull')` 造有效条件，但未选字段时操作符列表只有
`eq/ne`（`operatorsForColumn` 的回落），于是 Playwright **超时 30s 报"did not find some options"**。
必须先选字段再选操作符。而"重开后字段是空的"恰好成了草稿被丢弃的正面证据 ——
失败信息本身指对了方向。

---

## 八、第四轮：把缺陷 1 的「真机等 10 分钟」变成自动化门禁

上一轮收尾时缺陷 1 留了一条 ⬜：idle 超时 10 分钟，自动化等不起，只能真机放置验证。
这一轮把它压成秒级跑完 —— **真驱动 + 真 MySQL + 真定时器**，只改 `idleTimeoutMs`。

### 8.1 `scripts/e2e-idle-reconnect.mjs`（新增，16/16）

```
【A】直连：连接 → 空闲 3s → closed → 重连出数据
✅ A3 空闲到点后状态真的变成 closed
✅ A4 closed 被推送出来 — 推送序列=connecting→connected→busy→connected→closed
✅ A5 驱动被真释放 — created=1 closed=1
✅ A6 断开后不重连直接查会报 NOT_CONNECTED（空表格的成因）
✅ A8 重连后查到真数据 — rowCount=2（首查 2）
【B】隧道（假隧道 forward 真 MySQL，只替身跳板机那段）
✅ B3 隧道随空闲释放被关闭 — opened=1 closed=1
✅ B4 会话里已无存活隧道句柄 — live=0
✅ B6 重连开的是新隧道，旧的那条没被重复关
```

探针只包 `close()`、不改行为 —— **替身照自己假设实现**是本项目的老坑。

### 8.2 `scripts/e2e-idle-ui.mjs`（新增，4/4）：状态栏那一半

状态栏「连接：」实测时序 **已连接 → 已断开 → 已连接**，证明渲染层订阅真生效。
两个约束逼出了"预置 connections.json"的写法：
① React 的 `connections` 只在启动时读一次，IPC 建连渲染层看不见；
② UI 的空闲超时输入框按**分钟**填（最小 1 分钟），秒级只能从配置文件下手。
（`page.reload()` 试过：关闭守卫把 reload 当成关窗，窗口直接没了。）

### 8.3 🔴 顺手抓到并修掉：陈旧会话快照恢复出「连接：未知」的标签

**现场**：e2e-app 上一轮还是 45/45，这一轮同一份代码变成 44/45 ——
「无连接时执行按钮被禁用」红了。查下去是**跨运行污染**：

- 主进程文件已被 `DB_STUDIO_E2E_USER_DATA` 接管；
- 但**渲染层 localStorage 不适用那个变量**，它走 Chromium user data（真实 userData）；
- 于是上一跑留下的 `dbstudio.session.v1` 被恢复成一个 connId 已不存在的 query 标签
  → 状态栏「连接：未知」→ 执行按钮只判 `!connId` 所以可点 → 一点必然 NOT_CONNECTED。

**修两处**：
1. 过滤下沉到纯函数 `restorePlan(snapshot, isKnown)`，App 用当前连接列表回答"还在不在"
   （4 条单测；放在纯函数里才写得断言，放在 effect 里写不了）；
2. 两个真机脚本补 `--user-data-dir`，每次跑都是真冷启动。

📌 最值钱的不是修法，是**现象的形式**：代码一行没改，上一轮绿、这一轮红。
遇到这种"时红时绿"，第一反应该是找**跨运行共享状态**，而不是调断言。

### 8.4 翻车记录：我 `git checkout` 掉了本轮的 e2e-app 改动

想撤掉自己在 e2e-app 上的新改动，直接 `git checkout scripts/e2e-app.mjs` ——
但本轮全部工作都还没提交（仓库只有一个 v1.2 初始提交），于是**连同本轮既有改动一起没了**。
靠对话里读过的片段重建了两处（编辑器轮询、W 板块 78px 几何），跑 `e2e:app` 回到 45/45 才确认没漏。
📌 **未提交的工作区里，`git checkout <file>` 不是"撤销我的改动"，是"回到初始提交"**。
要撤自己的改动只能手工反向编辑。

---

## 九、v0.5.0 打包：版本升级 + 覆盖本机安装

### 9.1 流程与结果

| 步骤 | 结果 |
|---|---|
| 版本 0.4.0 → **0.5.0** | 根 `package.json` 唯一来源（EB 写进 Info.plist；子包 0.1.0 不参与） |
| `npm run build` + `npm run verify` | **exit 0**：47 文件单测、bundle 9/9（首屏 442.5KB）、idle 16/16、idle-ui 4/4、e2e:ui 219/219、e2e:app 45/45 |
| `node scripts/pack-dir.mjs` | .app 打包 + **外层 ad-hoc 重签** + `codesign --verify` 自检通过 |
| 覆盖安装 | 旧 `/Applications/DB Studio.app`（0.4.0）先 mv 到 `release/.prev-installed-0.4.0.app` 留回滚 → `ditto` 新包 → `xattr -dr com.apple.quarantine` |
| `npm run verify:installed` | **22/22** |
| dmg | `DB Studio-0.5.0-arm64.dmg` 144MB，`SHA256SUMS-0.5.0.txt`，`latest-mac.yml` 已更新 |

### 9.2 🔴 新坑：CDP 的「冷启动窗口」——HTTP 200 ≠ ws 握手可用

装完新包**第一次**跑 `verify-installed` 红：`connectOverCDP` 卡在 `<ws connecting>` 直到 30s 超时；
但 stderr 已打印 DevTools 地址、`/json/version` 返回 200、进程树（GPU/renderer/network helper）全在。

**查的方向一开始就是错的**：差点当成「0.5.0 新包把应用搞坏了」。
定性靠两个对照实验：

1. **旧包基线**：`DB_STUDIO_INSTALLED_APP=release/.prev-installed-0.4.0.app` 跑同一脚本 →
   connectOverCDP 正常、21/22（唯一红的是新加的版本断言）→ 不是脚本结构问题、不是环境问题；
2. **冷启动复现**：把 .app 复制到全新路径 `/tmp/...` 首次启动 → 加固后 22/22。

结论：端点打印/HTTP 200 之后还有一段主线程忙（建 userData、初始化窗口与玻璃效果）的窗口，
ws 握不上。**不加固的后果很坏**：每次装完新包第一次验收都红一次，且长得完全像新包有缺陷。
修法：轮询 `/json/version` 探活 + `connectOverCDP` 失败重试 3 次（每次重建连接）。

### 9.3 给「版本号升级」补了一条断言（并证明它不是恒真）

`verify-installed.mjs` 新增：装进 /Applications 的 `CFBundleShortVersionString` 必须等于根
`package.json` 的 `version`。版本写错/没重打包/没覆盖安装，界面上完全看不出来，只能靠断言。

📌 断言有效性当场验证过：**在旧 0.4.0 包上它红**（installed=0.4.0 vs declared=0.5.0），
**在新 0.5.0 包上它绿**。写一条只在正确版本上才绿的断言是不够的 ——
必须在**错误输入**上确认它会红，否则就是恒真假绿。
