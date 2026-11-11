# 2026-11-10 ~ 11-11 · 0.7.4 / 0.7.5 / 0.8.0 三版连续落地

> 范围依据见 [`product/PLAN-版本迭代任务清单-2026-11-10.md`](../product/PLAN-版本迭代任务清单-2026-11-10.md)，
> 逐版细节见 [`RELEASES.md`](../RELEASES.md)，横向汇总见 [`DEV-2026-11-11-三版收尾.md`](../DEV-2026-11-11-三版收尾.md)。
> 本文只记**门禁/真机抓出来的东西**和**踩过的坑**，不复述需求。

## 一、交付

三版累计 22 项改动，工单 #35–#52 + #68/#78/#79。门禁：单测 2473 → **2537（99 文件）**，
`verify` 从 **19 道扩到 20 道**（新增 `e2e:ddl:real`），首屏 563.0 → **597.2 KB**（预算 1465 KB），
`verify:installed` **22/22**、`verify:traffic-lights` **6/6**。

## 二、最大的一件事：`e2e:ddl:real`（0.8.0 #45）

**12 个对象生命周期入口此前只有假绿验收。** `renderer/backend.ts` 的 demo `mutationApply`
恒返回 `{ok:true, committed:true, conflicts:[]}`，所以 `e2e-ui.mjs` 那 40 条断言（「点按钮 →
出现预期 SQL 文本 → committed」）**永远为真**：SQL 拼错、执行必失败时照样全绿。

新脚本的三条口径，缺一条就会退化成假绿：

1. **复用生产同款构造器**（`import` 自 `renderer/src/database/ddlTemplates.ts`）——
   另写一套 SQL 就等于测了个平行实现。实测 tsx 能解析 `@dbstudio/*` 别名，可以用。
2. **回读 `information_schema`** 证明结构真变了（`TABLES`/`VIEWS`/`ROUTINES`/`TRIGGERS`/`EVENTS`），
   不只看返回 ok。
3. **每入口配反例**（非法库名 / 改名到已存在 / 对不存在表维护 / 重复建对象）。

证伪：把 `buildCopyTableSql` 的 withData 分支短路 → 20/22，「含数据复制」2 条精确报红。

## 三、踩坑（都自己造成、都被门禁抓到）

### 1. `var(--radius-sm)` 不存在 —— CSS 静默失效
给配置损坏告警块写 `border-radius: var(--radius-sm)`，本仓圆角 token 叫 **`--r-sm`**；
等宽字体**没有 token**（既有写法直接用字体栈）。CSS 引用未定义变量**不报错、整条声明消失**，
告警块就是没有圆角，肉眼极难发现。

而 `designTokens.test.ts` 原有断言只查「**定义了没人用**」（死 token），查不出反方向。
补了两条：① 无 fallback 的幽灵 token 必须为 **0**；② 带 fallback 的设棘轮基线 3
（`--font-mono/--overlay/--r-md` 历史遗留，渲染不坏，只许减不许增）；运行时注入的
`--sidebar-w/--detail-w` 白名单登记。证伪：注入 `--radius-sm` 后精确报出变量名。

### 2. `verify:traffic-lights` 第二次报「一个都没检测到」
第一次：「焦点已获得」但检测为 0。用**全屏截图**取证发现浅色区域占满整屏（0..3594）、
色块上百种 —— 说明屏幕录制权限正常，**但前台是我自己的浅色 IDE 窗口**，
脚本按 `bounds` 截的区域落在别的应用上。

`kill -9` 清**所有** Electron 进程（含之前 `open -a` 起的）后重跑 → **6/6**，
三灯 RED@(16,14)/YELLOW@(36,14)/GREEN@(56,14)、间距 20/20、右缘 62 ≤ 78。

**教训**：`pkill -f "MacOS/DB Studio"` 不够干净；且「焦点已获得」**不能证明**
截图里就是目标窗口 —— 要看截图内容本身。

### 3. 维护命令对不存在的表**不抛异常**
`OPTIMIZE/ANALYZE/CHECK TABLE` 对坏表返回结果行
`Msg_type=Error, Msg_text=Table '...' doesn't exist`，不 reject。
第一版反例用「期望抛错」写 → 假红。判据要查返回行里的 `Error` 列。
（又一次「写断言前先问此刻基线是什么」）

### 4. `dirtyGuardResolveRef` 单槽位的真实缺陷（#79）
原注释假定「同一时刻最多一个守卫（重载是串行的）」，但 **`truncate table` 成功后会遍历
所有同表标签页** `void loadTable(...)` 重载。两个 tab 都有未提交改动时，第二次赋值
**覆盖**第一次的 resolver → 前一个 promise **永不落定**：那个 tab 重载静默消失
（不重载、不报错、连 loading 都不亮），Promise 还泄漏。

修法 `workspace/singleModalGate.ts`：已占用时**不排队**，后来者立即以 `'cancel'` 落定
（不重载、用户脏值原样保留 = 安全侧）。证伪：注入「无条件覆盖」后 3 条红。

⚠️ 同时核实：`queryIdRef` **实为 per-tab**（`SqlEditorPanel` 是 `ws.tabs.map` 内的独立实例，
非激活仅 CSS `hidden`），审计「单槽位 ref 跨 tab 覆盖」对该组 ref **前提不成立**，
故未做全局 Map 重构 —— 不为一个造不出前提的问题冒回归风险。

### 5. React 守卫必须把 state 加进依赖数组
`runExplain` 加 `if (running)` 守卫后，若忘了把 `running` 放进 `useCallback` 依赖，
闭包捕获陈旧值、守卫形同虚设。`run`/`resumeBatch` 都列了，`runExplain` 此前漏了守卫本身。

### 6. 结果预算的采样外推（#47）
`estimateResultBytes` 只采样**前 200 行**估平均行宽再乘总行数。大 TEXT/BLOB 集中在
**后段**时严重低估 → 64MiB 字节预算**形同虚设**，最坏情况（正是预算要防的 OOM）被放过。
改为单次前向遍历真实累计，切点由「首次压垮预算的行号」决定。
证伪靶子：200 窄行（各 84B）+ 第 201 行 50k 字符（100008B）、预算 100000 ——
旧采样估 ≈16884 判「不超」漏掉，新累计 116808 必截断。

## 四、打包安装

`npm run dist -- --publish never` 返回 **exit 1**：dmg 与 `.app` 都正常生成，
失败发生在收尾的**发布阶段**（`GitHub Personal Access Token is not set`）——
electron-builder 即使收到 `--publish never`，未配置 token 时仍会尝试发布并报错。
**产物未受影响**，已用 `verify:installed 22/22` 证明。

两个连带问题（发 Release 前必须处理）：
- `latest-mac.yml` 仍是 **0.7.3 旧内容**（发布流程中断没重新生成）。
- dmg 文件名带空格（`DB Studio-0.8.0-arm64.dmg`），而 updater 期望连字符
  `DB-Studio-0.8.0-arm64.dmg` —— 原名上传会导致 updater 404。

另：`codesign --verify` 报「code has no resources」是 ad-hoc 签名的**已知假红**
（`--deep` 还会抹 Helper entitlements），不是包损坏，已用实际启动验证排除。