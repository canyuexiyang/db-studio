# AGENTS.md — DB Studio(database-app 子项目)

> 作用范围:仅本目录(`database-app/`)。供 AI 编码代理在此仓库工作时遵循。
> 规则分三级:**🔴 红线**(违反即事故)/ **⛔ 禁止**(不做)/ **📋 规范**(默认遵循,偏离需说明理由)。

## 一、项目定位(决定取舍的方向盘)

- **DB Studio = 反应最快的 macOS 数据库查看器**。单机自用、MySQL 优先、目标用户是「间歇性查看/修改数据」的开发者,不是 DBA。
- 「快」不是口号,是**验收门槛**:性能预算见 `docs/product/PRD-v1.0.md` §7,全部按 M5 Pro + 120Hz 实测口径设定。任何让核心链路(连接 → 定位表 → 查改数据)变慢的设计都应否决。
- UI 文案**只做简体中文**;只做 macOS,不做跨平台。
- 非目标(PRD §三,**不要实现**):数据/结构同步、ER 图、定时任务、权限管理、服务器监控、BI 图表、团队协作/云同步/账号体系、存储过程调试器、Windows/Linux。

## 二、技术栈与工程划分

- Electron **锁定 44.x**(R1:macOS 26+ GPU 空转修复线 + electron-window-glass 要求 + EOL 考量),Node ≥ 22.13。**⛔ 不追 alpha/beta,不随意升级 Electron**。
- npm workspaces + TypeScript strict(含 `noUnusedLocals/noUnusedParameters`)。
- **两套 tsconfig,互不包含**:
  - 根 `tsconfig.json`:packages + 主进程(pure Node lib,无 DOM);
  - `apps/desktop/renderer/tsconfig.json`:渲染层(DOM lib + JSX)。
  两边分别 typecheck,由 `npm run typecheck` 串联。**🔴 改动后必须全绿再交付**。
- `@dbstudio/*` 别名在**三处同步维护**:根 tsconfig `paths`、`vitest.config.ts` alias、renderer tsconfig。新增包时三处都要加,漏一处会出现「typecheck 过但测试 fallback 到 node_modules」的隐性错位。
- **测试文件与源码同目录**(`*.test.ts`),`npm test` 跑 `packages/**` + `apps/**`。核心包不依赖 Electron,纯逻辑可离线单测——新逻辑优先做成这种形态。

## 三、架构地图

```
packages/core-*            纯逻辑层(无 Electron/React 依赖,单测覆盖)
  core-grid-view           网格视图模型:虚拟滚动可视区/选择/键盘/排序三态
  core-ipc-codec           列式 ArrayBuffer 编解码(只解可视区,内存有界)
  core-mutation            脏单元格 → INSERT/UPDATE/DELETE(头号红线的落地处)
  core-sql-guard           SQL 只读守卫/危险分级(node-sql-parser)
  core-sql-ident           MySQL 标识符转义,零依赖,渲染层可安全引入
  core-driver-mysql        mysql2 封装:流式/KILL QUERY 取消/元数据
  core-secret              safeStorage 凭据加密
  core-ssh-tunnel          SSH direct-tcpip 转发(ssh2 可注入,单测不起真服务)
  core-schema-cache        schema 磁盘快照 + 行定位策略(主键/唯一键/none)
  其余:clipboard/command-palette/connection/filter/history/import/export/
        sql-editor/table-designer/tree-view —— 职责见各包 package.json description
apps/desktop/src
  main/                    主进程:window(玻璃窗)/ipc-handlers/session-registry/
                           connection-store/tunnel-manager/transfer-manager
  main/workers/            export/import 跑在 utilityProcess(可 kill = 真取消)
  preload/ + shared/       IPC 通道与类型(ipc-channels 是唯一通道清单)
apps/desktop/renderer/src  React 19 渲染层
  backend.ts               双后端:有 IPC 走真实现,纯浏览器 dev 自动降级 demo 后端
  database/                **0.7.3 全部 DDL 的唯一构造处**(ddlTemplates.ts 零 React 依赖
                           + DdlDialogs.tsx 建库/删库/改名/复制表/名称输入四类弹窗)
  grid/ tree/ editor/ workspace/ filter/ transfer/ designer/ danger/ ...
  ui/icons.tsx             全部 SVG 图标唯一出处
  styles.css               全部视觉 token 与组件样式(单文件)
scripts/                   e2e-*.mjs 全家桶 + check-bundle.mjs(体积预算门卫)
docs/                      文档资产(索引见 docs/README.md,改功能前先查)
  product/                 PRD v1.0 定稿 + v1.1/v1.2 增量 + REQ 需求文档
  engineering/             技术评审 / SPIKE 实测报告 / 专项决策实测(代码注释按 §章节号引用)
  research/                竞品调研与功能路线图(唯一维护版本)
  devlog/                  每日开发日志(只追加,真机踩坑都在这)
  design-mockups/          设计稿 + 双主题真实截图 + 截图脚本
  archive/                 已被取代的历史文档(⚠️ 不要据此实现功能)
```

**数据流**:主进程 mysql2 拉取 → 列式编码(ArrayBuffer transfer)→ 渲染层**只解码可视区**。网格行 DOM 池化(绝对定位 + `key=全局行号`)。

## 四、🔴 红线(代码评审一票否决项)

1. **只提交被编辑的单元格,绝不整行覆盖**(core-mutation);任何写操作必须先展示可逐条预览的 SQL 原文。
2. **无主键/唯一键的表 → 只读**(B5 红线)。可编辑判定只问 `isEditable()`,判断逻辑只在 core-mutation/core-schema-cache 一处,UI 不许自判。
3. **密码绝不明文落盘**:一律经 safeStorage 加密(`passwordEnc`);safeStorage 不可用时强制 `promptEveryTime=true` 且不落密文。connection-store 检测到疑似明文字段会**拒绝保存**。
4. 只读连接的写语句必须被 core-sql-guard 拦截;渲染层拦截只是体验,不是防线。
5. SQL 中的标识符转义**必须走 core-sql-ident**,禁止手拼反引号(防注入最后一道)。
6. 数据保真三件套:**NULL 与空串严格区分;BIGINT > 2^53 不丢精度;DATETIME(6) 微秒不丢**。改动编解码/传输层时先跑 `scripts/e2e-smoke.mjs` 对应断言。
7. SSH 隧道孤儿进程红线:调用方拿到异常时隧道必须被关闭,`driver.close()` 负责释放。
8. **虚拟滚动纪律**:只渲染可视区+缓冲;**滚动路径上禁止对象分配**;绝不 `decodeAll()/materialize()` 全量数据。
9. **CodeMirror 首屏 0 字节**(E2):编辑器/方言/补全作为单个 lazy chunk(≤150KB gzip);lazy 组件(`lazy()` 加载的 SQL 编辑器、连接编辑器、导入导出、表设计器)的**外壳样式必须在 styles.css 首屏就位**,否则懒加载间隙布局塌陷。
10. **首屏 bundle ≤ 1.5MB 未压缩**(S2),`npm run check:bundle` 是门卫,特征串断言(cm-editor/autocompletion/GROUP_CONCAT 等禁入首屏)。
11. 渲染层内容区**必须不透明**(方案 A:玻璃只在 Electron 侧 + 侧栏/浮层的 CSS 毛玻璃降级)。
12. **窗口:原生交通灯的唯一可用组合是 `transparent: true` + `titleBarStyle: 'hidden'` + `trafficLightPosition`**(几何常量 `TRAFFIC_LIGHT_MEASURED`:直径 14/间距 23/x∈[16,76] → 安全区 **78px**)。🔴 `frame:false` 下 Chromium **根本不创建**窗口按钮视图,`setWindowButtonVisibility(true)` 静默无效;再叠加 `roundedCorners:false` 灯直接消失 —— v1.2「灯已存在、只需让位」的结论**已被 v1.3 证伪**,探针对照表见 `docs/product/REQ-v1.3-缺陷清理.md`。**⛔ 不许自绘按钮**;⛔ 仍不开 vibrancy(与 transparent 冲突导致模糊错乱)。改窗口参数后必须跑 `npm run verify:traffic-lights`(像素级门禁;Playwright/DOM 穿不透 darwin 窗口 API)。
13. SSH 隧道/驱动层的资源释放语义不许改弱:取消 = 真取消(KILL QUERY / kill utilityProcess)。

## 五、⛔ 禁止操作

- ❌ 实现 PRD 非目标清单里的任何功能(§一),哪怕「顺手就做了」。
- ❌ 未跑 `npm run check:bundle` 就引入新依赖;体积敏感决策参考先例:**sql-formatter 被明确拒绝**(E2:预算紧,锦上添花不值得)。
- ❌ 导出/导入用 worker_threads —— 必须用 `utilityProcess`(可 kill,崩溃不拖垮主进程)。
- ❌ 结果集传输改回 JSON —— 列式 ArrayBuffer 是既定决策。正确的反驳理由是「大结果集下 JSON 全量解析卡死渲染进程」(50 万行 ≈ 338ms),不是「JSON 体积大」(实测列式并不更小)。
- ❌ 手写 sheet XML 替代 exceljs 流式(E4 决策:手写快 2 倍但日期退化为裸数字 `43831.0000115741`,是数据损坏不是观感问题)。xlsx 日期必须保真(Date 类型读回)。
- ❌ 用 emoji 当图标(🔑✅⚠️ 一律不许),新图标进 `renderer/src/ui/icons.tsx`(lucide 风格内联 SVG,颜色跟 currentColor)。
- ❌ 界面出现紫色/紫蓝渐变系配色(设计红线,2026-09-26 定稿)。
- ❌ 在滚动/编码热路径上做对象分配、正则、字符串拼接。
- ❌ 跳过 `npm run verify` 宣告完成(顺序:typecheck → test → check:bundle → e2e 全家桶)。

## 六、📋 样式与 UI 规范

**风格基调:Apple 原生精修**(2026-09-26 用户拍板,方案 E)。macOS 原生应用质感,克制、柔和、信息密度不降。设计示意图与截图工具在 `docs/design-mockups/`。

**色彩 token(styles.css `:root`,改色只动这里):**

| Token | 浅色 | 深色 |
|---|---|---|
| --bg / --bg-alt / --bg-panel | `#FFFFFF` / `#F5F5F7` / `#F6F6F8` | `#1C1C1E` / `#262628` / `#212123` |
| --text / --text-dim | `#1D1D1F` / `#86868B` | `#F5F5F7` / `#98989D` |
| --accent | `#007AFF` | `#0A84FF` |
| 状态 --ok / --warn / --error-bar | `#248A3D` / `#B25E00` / `#FF3B30` | `#30D158` / `#FFD60A` / `#FF453A` |

**必须遵守:**
- 主题唯一权威是 `data-theme` 属性(light|dark),`public/theme-boot.js` 在首帧 CSS 前同步写入防闪烁;媒体查询块只是 JS 失效兜底。**🔴 两处深色调色板必须保持一致,改一处必改另一处**。
- 字体锁定:`-apple-system / "SF Pro Text" / "PingFang SC"`,数据/数字列 `"SF Mono"`/Menlo + `tabular-nums`。不引入外部字体。(注:此为 Apple 品牌约束,经用户确认覆盖 ui-design-guide 的默认字体禁令)
- 组件既有模式,新代码跟随:按钮 12px + `white-space: nowrap` + 禁止收缩;说明文本 `ellipsis` 可收缩;hover 用灰底浮起(不是边框变蓝);focus 用蓝色柔光 ring(`--focus-ring`);树选中蓝底白字;网格斑马纹靠 `DataGrid.tsx` 里按**全局行号**加的 `.alt` 类(不要改成 nth-child,虚拟滚动会错位);`.env-tag` 永不收缩。
- 图标一律从 `ui/icons.tsx` 引;颜色跟 `currentColor`,主题切换零成本。
- 改样式后的验证动作:`npm run e2e:ui`(行为回归)+ `node docs/design-mockups/verify.mjs`(浅/深双主题真实截图,人工比对)。

## 七、命令速查

```bash
npm run typecheck        # 根 + renderer 两套 tsconfig
npm test                 # vitest 全部单测(含包间集成 @dbstudio/integration)
npm run check:bundle     # 体积预算门卫(会自动先 build:renderer)
npm run e2e:ui           # 真浏览器 UI 回归(起 vite dev,用 demo 后端)
npm run e2e:idle         # 空闲断开自动重连(真驱动 + 真 MySQL,只把 idleTimeoutMs 压到秒级)
npm run e2e:idle:ui      # 状态栏如实显示「已断开」(真 Electron,渲染层订阅那一半)
npm run verify           # 全量:typecheck + test + check:bundle + e2e 全家桶
npm run verify:installed # 已安装 .app 的真机验收(22 项,含版本一致性断言)
npm run verify:traffic-lights # 原生交通灯像素级门禁(6 项)
npm run start            # build + 起真实 Electron 应用
npm run dist             # 打包 mac arm64(.dmg + .app)
npm run dist:dir         # 只打 .app + ad-hoc 外层重签 + 签名自检(本机安装用)
```

- `npm run verify` 的链条（19 道）：typecheck → **gen:actions --check** → test → check:bundle → e2e(冒烟) → e2e:transfer → e2e:ssh → e2e:grid → **e2e:idle → e2e:keepalive → e2e:idle:ui** → e2e:ui → verify:toolbar-fit → e2e:script:data → e2e:affected → e2e:conflict → e2e:script:ui → e2e:app → e2e:keys。`verify:installed` / `verify:traffic-lights` **不在链里**（前者需要已安装的 .app，后者要像素比对），改对应代码后单独跑。
- e2e 脚本(playwright-core)复用本机 Chromium:`~/Library/Caches/ms-playwright/`,缺失时设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。
- e2e:smoke / e2e:app / e2e:idle 需要本地 MySQL fixture;纯 UI 改动跑 `e2e:ui` 即可,数据层改动跑对应专项。

### 版本号与发版

- **版本号唯一来源是根 `package.json` 的 `version`**(electron-builder 写入 `Info.plist`;子包 `apps/desktop/package.json` 不参与,不要跟着改)。
- 覆盖安装前先把旧 `.app` `mv` 到 `apps/desktop/release/.prev-installed-<旧版本>.app` 留回滚,再 `ditto` 新包 + `xattr -dr com.apple.quarantine`。
- 发版后在 **`docs/RELEASES.md`** 追加一条(主题 + 门禁基线 + 遗留项),GitHub Release 说明从这里摘。

## 八、🔁 易复发坑（真机踩过，别再犯）

细节与探针过程在 `docs/devlog/`,这里只放**结论**:

- **渲染层必须订阅主进程状态推送**:`connStates` 只在启动读一次 → 连接 idle 断开后仍以为 connected → `ensureConnection` 跳过重连 → 表格空白却报「可编辑:是」。数据拉取统一在 `loadTable` 内 ensure(唯一通道);idle 断开要真释放驱动 + 隧道(`releaseIdleSession`)。
- **筛选真值只有 `tab.filter` 一处**:弹窗编辑 `filterDraft`,徽标/状态栏/导出全从 `openTab.filter` 派生;生效计数用 `effectiveConditionCount()`(判据与 `buildWhere` 一致,否则「N 条未填完已跳过」永不显示)。
- **会话恢复要过滤已删连接**:`restorePlan(snapshot, isKnown)`,否则恢复出「连接:未知」的标签 —— 执行按钮可点却必失败,**比不恢复更糟**。
- **真机 e2e 必须 `--user-data-dir` 隔离**:`DB_STUDIO_E2E_USER_DATA` 只接管主进程文件,**不管渲染层 localStorage**(它走 Chromium user data)→ 上一跑的会话快照被恢复 → **代码没改却上一轮绿、这一轮红**。时红时绿先找**跨运行共享状态**,不是调断言。
- **装完新包首次跑 `verify-installed` 会撞 CDP 冷启动窗口**:DevTools 地址已打印、`/json/version` 已 200,但 ws 握手还没就绪(主线程忙)。脚本已加固(探活 + 重试 3 次);**别误判成新包有缺陷**,用旧包做基线对照定性。
- **⛔ 未提交的工作区里 `git checkout <file>` = 回到初始提交**,不是「撤销我的改动」—— 曾一次性丢掉整个 v1.3 的 e2e-app 改动。要撤自己的改动只能手工反向编辑。
- **写断言前先问「此刻基线是什么」**:恒真断言与**前提不成立**是同一坏习惯的两面 → 断**口径**(不变量/相对变化/双向蕴含)而非具体值;**造不出前置条件的断言宁可不写**(会变成不改代码也通过的假绿);新断言要在**错误输入**上确认它会红。
- 🔴 **模态必须有退路**:`TableDesigner` 曾是全仓唯一没有 Esc、也没有 footer 取消钩子的模态 → e2e 里关不掉,残留 `.modal-mask` 把后面**所有**点击吃掉,表现为一串 30s 超时(看着像「功能坏了」,其实是上一个模态没退)。新模态一律「Esc(降级前先让内层处理)+ 点遮罩 + 明确的取消按钮」三条都有。
- 🔴 **DDL 后的三件事顺序固定**:登记定位意图(`pendingRevealRef`,必须在 `await` **之前**)→ `schemaRefresh` → **最后**才 `setToast` 成功回执。`onRefreshConnSchema` 自带「已刷新表结构」toast,回执写早了必被盖掉(用户只看到刷新)。
- 🔴 **守卫层兜底只能在解析失败之后**:`node-sql-parser` 不认带反引号的 `DROP DATABASE`、完全不认 `OPTIMIZE/ANALYZE/CHECK/REPAIR TABLE` → 文本兜底必须**闭合枚举 + 整串锚定**,显式拒绝多语句(`;`)与 `/`+`*`+`!` 可执行注释。**兜底不能变成后门**,加兜底必配反例测试。
- 🔴 **demo 后端每次必须返回新对象**:返回同一个常量/同一 ref → `useMemo` 判未变 → 建库/删库/改名在纯浏览器 e2e 里**全是假绿**。
- **树行断言按 key 不按标签**:demo 两个连接共享同一份库结构,同名表会出现两行;`filter({ hasText })` 又是**子串**匹配(`access_log` 命中 `access_log_zz`)。`data-node-key` + 精确等值,两道都要。
- **菜单项点击必须精确等值**:`hasText: '复制表'` 会先命中「复制表名」→ 弹窗永不出现,看着像「点了没反应」。
- 🔴 **同一个外部标识写在多处时必须钉成等式**:`publish.owner`(electron-builder.yml)/ 回退 URL(updater.ts)/ 产物里的 `app-update.yml` 三处都写 GitHub owner,曾把 `canyuexiyang` 写成 `canyuexiang`(少一个 y)→ 应用内检查更新永远 404,而 Release 页是好的,两轮发版都没发现。现在 `package.json.repository` 是第二证据源,`updater.test.ts` 断言三者相等。

## 九、工作习惯约定

- **文档索引在 `docs/README.md`**;**发版记录在 `docs/RELEASES.md`**。改功能前先查 `docs/product/PRD-v1.0.md` 对应小节(§6.x 与界面一一对应)与 `docs/devlog/DEV-PROGRESS-*.md` 开发日志——大量决策(E1~E4、D1~D5、R 系)有实测依据,别凭直觉推翻,**推翻决策要给实测数据**。
- 新增功能前先过 `docs/research/竞品调研与功能路线图.md` §3.5「明确不抄」清单与 PRD §三 非目标——**两份清单是范围红线**,想做的事落在里面要先给实测理由推翻。
- `docs/archive/` 下的文档**已被取代,不要据此实现功能**(每份顶部有归档声明指向现行版本)。
- 代码注释是中文,密度高且多为「为什么」;改动时保持既有注释风格,删代码连注释一起删。
- 提交信息/文档/报错文案均使用简体中文。
