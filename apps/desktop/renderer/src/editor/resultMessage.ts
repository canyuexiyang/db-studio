/**
 * 0.7.1 需求 1：执行结果文案的**唯一真值**。
 *
 * ## 为什么必须下沉成纯函数
 *
 * 修之前，结果文案在三个地方各写了一遍（结果标签标题 / 消息行 / 内联耗时行），
 * 三处都只有 `rowCount` 一个数可用 —— 于是 UPDATE 在三处统统显示「0 行」。
 * 如果这次分别改三处，下一处新增的展示点必然又写成 `rowCount`，缺陷会复发。
 * 所以口径收在这里：**三个消费点只允许调用本文件的输出，不允许自己拼文案**。
 *
 * ## 一条不能省的规则（MySQL 语义 + 我们的连接标志）
 *
 * 🔴 **实测结论（2026-10-27 真库探针）**：mysql2 默认带 CLIENT_FOUND_ROWS，
 * 所以 OkPacket.affectedRows 对 UPDATE 是 **matched（匹配行数）**，不是 changed。
 * 同一句话的 info 会直接写明两者：
 *     `Rows matched: 3  Changed: 0  Warnings: 0`
 * 也就是说 `UPDATE t SET x = x`（值没变）在我们这里 affectedRows = 3 —— 如果直接
 * 拿它显示「已修改 3 行」，等于**夸大了实际变更**，用户会以为自己改动了 3 行数据。
 *
 * 因此 UPDATE 的主数字取 **changed**（从 info 解析，对连接标志不敏感），
 * matched 只作次信息。info 拿不到时才退回 affectedRows，且用中性措辞
 * 「已影响 N 行」而不是「已修改」—— 宁可模糊，不可撒谎。
 */

import { formatCount } from '@dbstudio/core-sql-editor';

/** 语句分类（与 QueryOutcomeDto.statementKind 同域，见 core-sql-guard.statementKindOf） */
export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';

export interface RunResultFacts {
  statementKind: StatementKind;
  /** 结果集行数（非 SELECT 恒 0） */
  rowCount: number;
  /**
   * 服务端 OkPacket.affectedRows。
   *
   * 🔴 对 UPDATE 是 **matched** 而不是 changed（我们的连接带 CLIENT_FOUND_ROWS）。
   *    INSERT/DELETE 不受影响（就是插入/删除的行数）。
   */
  affectedRows: number;
  insertId: number | null;
  /** OkPacket.info 原文（`Rows matched: 5  Changed: 2  Warnings: 0`） */
  info: string | null;
  warnings: number;
  cancelled: boolean;
  elapsedMs: number;
}

export interface RunResultText {
  /** 短标题：结果标签页用（宽度有限） */
  title: string;
  /** 次信息：消息行补充（可为 null） */
  detail: string | null;
  /** 消息行完整文案 = title · detail */
  headline: string;
  /** 内联耗时行：`耗时 12 ms · 已修改 2 行` */
  inline: string;
}

/**
 * 从 OkPacket.info 里取匹配行数。
 *
 * 服务端原文形如 `Rows matched: 5  Changed: 2  Warnings: 0`。
 * 取不到就返回 null —— **不拿 affectedRows 兜底**：对 UPDATE 它是 matched，
 * 用它冒充 matched 会把「信息缺失」伪装成「精确匹配数」。
 */
export function parseMatchedRows(info: string | null): number | null {
  if (!info) return null;
  const m = /Rows matched:\s*(\d+)/i.exec(info);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从 OkPacket.info 里取**真实变更**行数（`Changed: N`）。
 *
 * 为什么必须解析字符串而不是读 OkPacket.changedRows：`changedRows` 字段只有在
 * 连接启用 CLIENT_FOUND_ROWS 时才有意义（否则恒 0）。而 info 里的 `Changed:` 是
 * 服务端无条件给出的 —— 对连接标志不敏感，这也是「换驱动/改标志不改变文案」的保证。
 */
export function parseChangedRows(info: string | null): number | null {
  if (!info) return null;
  const m = /Changed:\s*(\d+)/i.exec(info);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 警告徽标文案：`2 条警告` */
function warningsSuffix(warnings: number): string | null {
  if (!Number.isFinite(warnings) || warnings <= 0) return null;
  return `${formatCount(warnings)} 条警告`;
}

/** 把非空的次信息用 ` · ` 拼起来（空的一律丢掉，不留 `· ` 尾巴） */
function joinDetail(parts: Array<string | null>): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== '');
  return kept.length === 0 ? null : kept.join(' · ');
}

/**
 * 主入口：把执行结果事实翻译成三处共用的文案。
 *
 * 文案口径（对齐竞品词汇，而不是照搬文案）：
 * | 语句   | 主文案        | 次信息                            |
 * |--------|---------------|-----------------------------------|
 * | SELECT | 返回 1,234 行 | （无；结果集没有「匹配」概念）      |
 * | INSERT | 已插入 3 行   | 自增 ID 起始 5001                 |
 * | UPDATE | 已修改 2 行   | 匹配 5 行 · 2 行有变化            |
 * | DELETE | 已删除 3 行   | （无）                            |
 * | DDL    | 执行成功      | （**绝不出现 0 行**：DDL 没有行数） |
 * | other  | 执行完成      | （判不出类型就不给口径）            |
 */
export function describeRunResult(f: RunResultFacts): RunResultText {
  const warn = warningsSuffix(f.warnings);

  if (f.cancelled) {
    const title = '已取消';
    return {
      title,
      detail: warn,
      headline: warn ? `${title} · ${warn}` : title,
      inline: `已取消 · ${f.elapsedMs} ms`,
    };
  }

  let title: string;
  let detail: string | null;

  switch (f.statementKind) {
    case 'select':
      title = `返回 ${formatCount(f.rowCount)} 行`;
      detail = warn;
      break;

    case 'insert':
      title = `已插入 ${formatCount(f.affectedRows)} 行`;
      // insertId = 0 / null 都表示「这条语句没有自增值」（驱动侧已归一成 null）
      detail = joinDetail([
        f.insertId !== null && f.insertId > 0 ? `自增 ID 起始 ${formatCount(f.insertId)}` : null,
        warn,
      ]);
      break;

    case 'update': {
      const matched = parseMatchedRows(f.info);
      const changed = parseChangedRows(f.info);
      if (changed === null) {
        // info 缺失：affectedRows 是 matched，用它说「已修改」会夸大实际变更。
        // 中性措辞「已影响 N 行」—— 宁可模糊，不可撒谎。
        title = `已影响 ${formatCount(f.affectedRows)} 行`;
        detail = joinDetail([matched !== null ? `匹配 ${formatCount(matched)} 行` : null, warn]);
        break;
      }
      title = `已修改 ${formatCount(changed)} 行`;
      let change: string | null = null;
      if (changed === 0 && matched !== null && matched > 0) {
        // 🔴 本需求最容易做错的一条：值未变化 ≠ 没匹配到
        change = `匹配 ${formatCount(matched)} 行 · 值未变化`;
      } else if (matched !== null && matched !== changed) {
        change = `匹配 ${formatCount(matched)} 行 · ${formatCount(changed)} 行有变化`;
      }
      detail = joinDetail([change, warn]);
      break;
    }

    case 'delete':
      title = `已删除 ${formatCount(f.affectedRows)} 行`;
      detail = warn;
      break;

    case 'ddl':
      title = '执行成功';
      detail = warn;
      break;

    default:
      title = '执行完成';
      detail = warn;
      break;
  }

  return {
    title,
    detail,
    headline: detail ? `${title} · ${detail}` : title,
    inline: `耗时 ${f.elapsedMs} ms · ${title}`,
  };
}
