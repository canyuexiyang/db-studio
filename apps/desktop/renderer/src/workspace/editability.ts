/**
 * T14：「有定位键」与「当前可写」的**唯一判定处**。
 *
 * ## 为什么要拆成两件事
 *
 * 这两者过去被压成一个布尔值（`isEditable(table)`），于是：
 *
 *  - 只读连接下的表在 UI 上看起来「可编辑」—— 用户双击格子、粘贴、开批量条，
 *    一路标脏到点「保存」那一刻，才被主进程的 AST 守卫拦下；
 *    体验上是「先说能写，再反悔」。
 *  - 状态栏只写「可编辑：是」，用户无法区分「结构上能定位」与「现在真的能写」。
 *
 * 现在拆开：
 *
 * | 概念 | 含义 | 判定 |
 * |---|---|---|
 * | `locatable` | 表结构上有主键/唯一键，能安全定位行 | 只问 `isEditable(table)`（B5 红线） |
 * | `writable`  | 在此之上再叠加「连接不是只读」 | `locatable && !connReadOnly` |
 *
 * ## 边界
 *
 * - 本模块**不是**防线。真正拦写语句的是主进程的 `core-sql-guard`；
 *   这里只负责让入口**诚实地表达能不能做**，禁用时给出原因。
 * - 判定复用 `@dbstudio/core-mutation` 的 `isEditable()`，不自己看主键/唯一键
 *   （AGENTS.md 已定：可编辑判定只在一处）。
 */

import { isEditable } from '@dbstudio/core-mutation';
import type { TableMeta } from '@dbstudio/core-schema-cache';

export type EditabilityReason = 'ok' | 'no-locate-key' | 'read-only-conn';

export interface Editability {
  /** 结构上可安全定位行（B5 红线的技术前提） */
  locatable: boolean;
  /** 当前真的能写 = 有定位键 且 连接非只读 */
  writable: boolean;
  reason: EditabilityReason;
  /** 可直接展示的原因文案（reason === 'ok' 时为空串） */
  message: string;
}

/** 无定位键：表结构不支持安全定位，与连接是否只读无关 */
export const NO_LOCATE_KEY_MESSAGE =
  '该表无主键/唯一键，无法安全定位行，请使用 SQL 编辑。网格已置为只读。';

/** 只读连接：结构上能定位，但当前连接不允许写 */
export const READ_ONLY_CONN_MESSAGE =
  '该连接已标记为「只读」，网格已置为只读：写语句会被主进程的 AST 守卫拦截。如需修改，请到连接设置里取消只读。';

/** 树右键 / 工具栏等入口用的短原因（比 banner 更短，便于 title 与 toast） */
export const READ_ONLY_ACTION_REASON = '该连接已标记为只读，写语句会被主进程 AST 守卫拦截';

/**
 * 解析一张表在当前连接下的可编辑性。
 *
 * @param table       表元数据；`null`/`undefined`（无激活表）一律不可写
 * @param connReadOnly 该表所属连接是否只读
 */
export function resolveEditability(
  table: TableMeta | null | undefined,
  connReadOnly: boolean,
): Editability {
  const locatable = !!table && isEditable(table);
  if (!locatable) {
    return {
      locatable: false,
      writable: false,
      reason: 'no-locate-key',
      message: NO_LOCATE_KEY_MESSAGE,
    };
  }
  if (connReadOnly) {
    return {
      locatable: true,
      writable: false,
      reason: 'read-only-conn',
      message: READ_ONLY_CONN_MESSAGE,
    };
  }
  return { locatable: true, writable: true, reason: 'ok', message: '' };
}
