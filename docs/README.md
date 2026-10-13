# 文档索引

DB Studio 的全部文档资产。**日常开发只需要看 `AGENTS.md` + 本索引指向的三类文档**：需求看 `product/`，技术决策看 `engineering/`，踩坑记录看 `devlog/`。

```
docs/
├── RELEASES.md     版本发布记录与门禁基线（发版后追加；GitHub Release 说明从这里摘）
├── product/       产品需求（PRD 与需求增量）—— 改功能前先查这里
├── engineering/   技术评审、Spike 实测报告、专项决策实测
├── research/      竞品调研与功能路线图（唯一维护版本）
├── devlog/        每日开发日志（按日期，只追加不改写）
├── design-mockups/ 设计示意图、双主题真实截图、截图脚本
└── archive/       已被取代的历史文档（留档，不要据此实现）
```

---

## product/ — 产品需求

| 文档 | 说明 | 状态 |
|---|---|---|
| [`product/PRD-v1.0.md`](product/PRD-v1.0.md) | **PRD 定稿主文档**（1500 行）。问题定义、目标与成功标准、非目标清单、用户故事、Navicat 对标取舍、六大模块功能详述、性能预算硬约束、视觉与交互规范、快捷键体系、数据本地化、验收标准、验证方法论附录 | ✅ 唯一维护版本 |
| [`product/PRD-v1.1-功能增量.md`](product/PRD-v1.1-功能增量.md) | R1 竞品对齐轮的功能增量（按 §6.1~§6.7 模块组织） | ✅ 已交付 |
| [`product/PRD-v1.2-功能增量.md`](product/PRD-v1.2-功能增量.md) | v1.2 六大板块（P1-A/P1-B/P1-C/P2/S/W）+ 明确不做 + 红线复核清单 + 度量口径 | ✅ 已交付 |
| [`product/REQ-v1.2-SQL编辑器增强.md`](product/REQ-v1.2-SQL编辑器增强.md) | S0~S4 需求（EARS 表述）：格式化决策门、SQL 专属高亮、表名提示、字段属性提示 | ✅ 已交付 |
| [`product/REQ-v1.2-窗口原生控件.md`](product/REQ-v1.2-窗口原生控件.md) | W 板块需求：原生交通灯让位（含「明确不做自绘按钮」）。⚠️ **§一「灯已存在」的结论已被 v1.3 证伪**，见文首更正 | ⚠️ 部分作废 |
| [`product/REQ-v1.3-缺陷清理.md`](product/REQ-v1.3-缺陷清理.md) | 2026-09-29 用户真机反馈的 6 项缺陷：逐项根因、修复方案、验收口径与状态。含**推翻 v1.2 窗口结论的探针对照表** | ✅ 已交付（**v0.5.0 已发布**；剩 2 项人工终验） |
| [`product/REQ-0.7.0-研发任务清单.md`](product/REQ-0.7.0-研发任务清单.md) | **0.7.0 研发任务清单**：依据 2026-10-12 深度调研报告建立的 1 个版本大任务 + 52 个原子子任务。含任务总表、逐项详述（报告引用/问题点/任务内容与功能点/交付验收/依赖）、R01–R16 与 I01–I29 双向映射、P0 问题汇总、证据定位与待确认问题。⚠️ 按**软件版本号**命名（0.x），与 PRD 批次 v1.x 区分 | 🟡 待开始 |

## 发布记录

| 文档 | 说明 |
|---|---|
| [`RELEASES.md`](RELEASES.md) | **版本发布记录**：0.1.0~0.5.0 每版主题、门禁基线、分发方式、遗留项。**打包发版后追加一条**，GitHub Release 的说明从这里摘 |


## engineering/ — 技术决策与实测

| 文档 | 说明 |
|---|---|
| [`engineering/TECH-REVIEW-v1.0.md`](engineering/TECH-REVIEW-v1.0.md) | **技术评审报告**。依赖与版本核验、进程与边界架构、IPC 数据传输、原生玻璃三形态、核心机制工程方案（网格编辑红线 / 只读 AST 白名单 / 长查询取消 / mysql2 参数规范 / Schema 缓存 / SSH 隧道）、性能预算复核、工期评估。**代码注释里被大量按 §章节号引用** |
| [`engineering/SPIKE-REPORT-v1.0.md`](engineering/SPIKE-REPORT-v1.0.md) | **Spike 验证报告**。S1 玻璃窗 × 虚拟网格 FPS、S5 千万行 fixture + 列式 IPC、S2 冷启动、S3 百万行 xlsx 导出、S4 打包与签名。含推翻上游论证的两处更正 |
| [`engineering/S0-格式化体积实测-2026-09-29.md`](engineering/S0-格式化体积实测-2026-09-29.md) | S0 决策门实测报告：为什么拒绝 `sql-formatter` 而走自研轻量格式化（含判定规则、可复现口径、能力对照诚实清单） |

## research/ — 竞品调研

| 文档 | 说明 |
|---|---|
| [`research/竞品调研与功能路线图.md`](research/竞品调研与功能路线图.md) | **竞品路线图唯一维护入口**。顶部为 2026-10-12 最新结论与建议顺序；下文保留历史 8 款竞品对比、V1~V28 和附录编号。旧主观评分不再作为当前排名，最新 11 款竞品细节见下一行证据附件 |
| [`research/项目全景与竞品深度调研-2026-10-12.md`](research/项目全景与竞品深度调研-2026-10-12.md) | 0.6.0 工作区本轮证据附件：功能/菜单/交互盘点，11 款竞品官方资料，16 项发现和 29 项候选；附 DEMO 截图、文件指纹、实际验证日志。建议尚未批准实现，路线图仍以上一行主文档为唯一入口 |

## devlog/ — 每日开发日志

按日期只追加，不改写。记录当日交付清单、**真机/真库抓到的 bug（单测全绿也照样漏的那类）**、决策取舍、门禁结果、遗留项。

| 日志 | 主题 |
|---|---|
| [`devlog/DEV-PROGRESS-2026-09-21.md`](devlog/DEV-PROGRESS-2026-09-21.md) | 打通「连接→定位表→查改数据」闭环 |
| [`devlog/DEV-PROGRESS-2026-09-22.md`](devlog/DEV-PROGRESS-2026-09-22.md) | 网格交互层与可视化骨架、IPC 接线、方法论沉淀 |
| [`devlog/DEV-PROGRESS-2026-09-24.md`](devlog/DEV-PROGRESS-2026-09-24.md) | SSH 隧道（ssh2）落地 |
| [`devlog/DEV-PROGRESS-2026-09-26.md`](devlog/DEV-PROGRESS-2026-09-26.md) | v1.0 收尾冲刺收官 + 三轮追加（安装后缺陷修复 / 右键菜单 / 自动握手） |
| [`devlog/DEV-PROGRESS-2026-09-26-r1.md`](devlog/DEV-PROGRESS-2026-09-26-r1.md) | R1 竞品对齐轮（40 项） |
| [`devlog/DEV-PROGRESS-2026-09-27.md`](devlog/DEV-PROGRESS-2026-09-27.md) | 连接编辑器布局重排 + 库/表级 SQL 脚本导入 |
| [`devlog/DEV-PROGRESS-2026-09-27-grid-row-gutter.md`](devlog/DEV-PROGRESS-2026-09-27-grid-row-gutter.md) | 网格 C 轮：行号列与整行操作（A19~A22） |
| [`devlog/DEV-PROGRESS-2026-09-29.md`](devlog/DEV-PROGRESS-2026-09-29.md) | v1.2 P1-A：补断层 V1~V7、构建链环境适配 |
| [`devlog/DEV-PROGRESS-2026-09-29-p1b.md`](devlog/DEV-PROGRESS-2026-09-29-p1b.md) | v1.2 P1-B：网格编辑深度 V8~V13 |
| [`devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md`](devlog/DEV-PROGRESS-2026-09-29-v1.3-defects.md) | **v1.3 缺陷清理**（6 项真机反馈）。含「系统 API 静默无效」的探针定位过程、假绿断言自查、门禁脚本自身写错的教训；收尾轮把缺陷 1 的「真机等 10 分钟」压成秒级自动化，并修掉「陈旧会话快照恢复出指向已删连接的标签」（跨运行污染现场）。**§九为 v0.5.0 打包全流程与 CDP 冷启动窗口** |

## design-mockups/ — 设计资产

- `style-*.png` / `style-preview.html`：视觉风格探索稿（Apple / Cream / Mist / WeChat / Dark-Tech 五方案对比，最终拍板「Apple 原生精修」方案 E）
- `verify-*.png`：浅/深双主题真实截图（主界面、连接编辑器、SQL 脚本、网格行号列/右键菜单/横向滚动/行选中）
- `verify.mjs` / `verify-darktech.mjs` / `shot.mjs`：截图脚本（改样式后跑，人工比对双主题）
- `shots-installed/`：安装后真机截图（由 `scripts/capture-installed.mjs` 生成）

## archive/ — 历史留档（⚠️ 不要据此实现功能）

| 文档 | 被谁取代 | 保留原因 |
|---|---|---|
| `archive/REQUIREMENTS-v0.1.md` | `product/PRD-v1.0.md` | 最初的需求基线与技术选型论证；Redis/PG/Mongo 后续阶段能力矩阵设想 |
| `archive/PRD-v0.4.md` | `product/PRD-v1.0.md` | R1~R12 修订并入前的原始论证过程 |
| `archive/PRD-v0.5-修订增量.md` | `product/PRD-v1.0.md` | IPC 接线期原始增量、验证方法论最初表述 |
| `archive/R1-并行研发契约-2026-09-26.md` | `AGENTS.md` | 多代理并行协作的「文件所有权 + 预写共享管线」范式，可作模板 |
| `archive/竞品对比与功能迭代清单-2026-09-26.md` | `research/竞品调研与功能路线图.md` | 其他文档按 A19/B8/E4 编号引用时需要原始上下文 |
| `archive/概览-2026-09-28竞品调研.md` | `research/竞品调研与功能路线图.md` | 一页摘要的汇报样本 |

---

## 阅读顺序建议

**新人上手**：根目录 [`README.md`](../README.md)（架构与构建）→ [`AGENTS.md`](../AGENTS.md)（红线与规范）→ `product/PRD-v1.0.md` §一~§三（定位与非目标）。

**改功能前**：`product/PRD-v1.0.md` 对应 §6.x 小节 → `research/竞品调研与功能路线图.md` §3.5（确认不在「明确不抄」清单里）→ 相关 `devlog/`。

**做技术决策前**：`engineering/TECH-REVIEW-v1.0.md` + `engineering/SPIKE-REPORT-v1.0.md` —— 大量决策（E1~E4、D1~D7、R 系）有实测依据，**推翻决策要给实测数据**。

**遇到诡异问题时**：先翻 `devlog/`，真机踩坑基本都记在里面（尤其是「单测全绿但线上出错」的那类）。
