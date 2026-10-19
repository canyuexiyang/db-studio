/**
 * T31：「库中原值」与「当前待提交值」的判定与文案（**纯函数**，无 React 依赖）。
 *
 * ## 为什么必须显式区分（缺陷原文）
 *
 * 「查看完整值」拿到的一直是 `source.raw(row, col)` —— 库里的原值。当网格正在显示
 * **尚未保存的编辑**（`source.value()` 的脏单元格叠加层）时，弹窗显示的却是旧值，
 * 而界面上**没有任何标记**说明这一点：用户点「复制值」，复制走的是他看不见的旧数据。
 * 这类缺陷没有异常、没有日志，只在「用户拿着复制出去的东西和别人对账」时才炸。
 *
 * 所以：**判定 + 文案必须是一处纯逻辑**（可被单测覆盖），UI 只负责把返回的中文字串
 * 贴到按钮 title / 说明行上，不许在 JSX 里临场拼判据。
 *
 * ## 判定口径（写死在这里，避免各渲染点自由发挥）
 *
 *  - 宿主**没给**待提交值信息（`undefined`）→ `pendingProvided = false`：此时不能假装
 *    知道「没有修改」，必须如实写「宿主未提供待提交值信息」。**未知 ≠ 无差异**。
 *  - 宿主给了但 `dirty = false` → 确实没有待提交修改，正如实说「一致」。
 *  - 宿主给了且 `dirty = true` → 用**展示文本**逐字比对：相同就说相同
 *    （「已标记为待提交，但内容与库中原值一致」），不许装作有差异吓唬人。
 *  - NULL 与空串必须可区分（红线 6）：原值 `''` 与待提交 `null` 是**有差异**的。
 */

/** 单元格值的形态（影响能不能做文本比对、以及 NULL/空串的区分） */
export type CellValueShape =
  /** SQL NULL —— 显示为 `NULL`，与空串严格区分 */
  | 'null'
  /** 二进制（Uint8Array / ArrayBuffer）—— 不能按文本比对 */
  | 'binary'
  /** 空字符串 */
  | 'empty'
  /** 其它（数字 / 日期 / 普通文本…） */
  | 'text';

export interface CellSnapshot {
  /** 展示文本（NULL → 'NULL'；二进制 → 空串，字节数看 byteLength） */
  text: string;
  shape: CellValueShape;
  /** 二进制字节数；非二进制为 null */
  byteLength: number | null;
}

/**
 * 宿主提供的「当前待提交值」。
 *
 * dirty 与 value 必须分开传：脏单元格的合法值就是 `string | null`（null = 待写入 SQL
 * NULL）。如果只传 value，就没有任何办法区分「待写入 NULL」和「没有待提交修改」。
 */
export interface PendingCellValue {
  /** true = 该格存在未提交的修改 */
  dirty: boolean;
  /** dirty 为 true 时的待提交值；null = 待写入 SQL NULL */
  value: string | null;
  /** 校验失败原因（core-grid 判定不合法时给出） */
  invalid?: string;
}

export type CellValueSide = 'original' | 'pending';

export interface CellValueDiff {
  /** 宿主是否提供了待提交值信息；false 表示「未知」，不要把当 false 时用 */
  pendingProvided: boolean;
  /** 是否存在待提交修改 */
  hasPending: boolean;
  /** 待提交值与库中原值的展示文本是否不同 */
  differs: boolean;
  /** 直接给用户看的一句中文说明（含「一致」「未知」两种如实表述） */
  note: string;
}

/**
 * 取单元格快照。
 *
 * 🔴 `String(Uint8Array)` 会输出「137,80,78,71,…」这种垃圾文本，所以二进制**先判**，
 *    并且不生成展示文本（由 ImageViewer 用 HEX / 图片接管）。
 */
export function snapshotCellValue(value: unknown): CellSnapshot {
  if (value instanceof Uint8Array) return { text: '', shape: 'binary', byteLength: value.length };
  if (value instanceof ArrayBuffer) {
    return { text: '', shape: 'binary', byteLength: value.byteLength };
  }
  if (value === null || value === undefined) return { text: 'NULL', shape: 'null', byteLength: null };
  const s = String(value);
  return { text: s, shape: s === '' ? 'empty' : 'text', byteLength: null };
}

/** 待提交值转成展示文本（null → 'NULL'，与空串严格区分） */
export function pendingText(p: PendingCellValue): string {
  return p.value === null ? 'NULL' : p.value;
}

/**
 * 判定「库中原值」与「当前待提交值」的关系。
 *
 * @param original  库中原值（`source.raw()`）
 * @param pending   宿主提供的待提交值信息；undefined = 宿主没接这条线
 */
export function diffCellValues(original: unknown, pending: PendingCellValue | null | undefined): CellValueDiff {
  if (pending == null) {
    return {
      pendingProvided: false,
      hasPending: false,
      differs: false,
      note: '宿主未提供「当前待提交值」信息：本弹窗展示的是库中原值，若有未保存的网格编辑不会在这里体现',
    };
  }
  if (!pending.dirty) {
    return {
      pendingProvided: true,
      hasPending: false,
      differs: false,
      note: '该格没有未提交的修改：库中原值即当前值，两者复制结果相同',
    };
  }

  const o = snapshotCellValue(original);
  const invalidPrefix = pending.invalid ? `待提交值校验未通过（${pending.invalid}）；` : '';

  // 二进制：无法做文本比对 —— 保守报「有差异」，并把理由写清楚（不许输出原待提交值的文本）
  if (o.shape === 'binary') {
    return {
      pendingProvided: true,
      hasPending: true,
      differs: true,
      note: `${invalidPrefix}二进制列不做文本比对：库中原值 ${o.byteLength ?? 0} 字节，待提交值为 ${pending.value === null ? 'NULL' : `${pendingText(pending).length} 字符`}`,
    };
  }

  const same = o.text === pendingText(pending);
  return {
    pendingProvided: true,
    hasPending: true,
    differs: !same,
    note: same
      ? `${invalidPrefix}该格已标记为待提交，但内容与库中原值一致（复制两者结果相同）`
      : `${invalidPrefix}该格有未提交的修改：下面「当前待提交值」才是网格正在显示的值，保存后才会入库`,
  };
}

/**
 * 复制按钮的**标题**（必须说明复制对象）。
 *
 * 🔴 按钮上只写「复制」是不够的：T31 的整个缺陷就是「用户以为复制的是 A，实际拿到 B」。
 *    标题里带上「带不带未保存修改」，让 hover 与 e2e 都能读到确切语义。
 */
export function copyTargetTitle(side: CellValueSide, diff: CellValueDiff): string {
  if (side === 'original') {
    return '复制库中原值（数据库里现在的值，不含任何未保存的网格编辑）';
  }
  if (!diff.pendingProvided) {
    return '宿主未提供「当前待提交值」，无法复制；请先补全 App.tsx 接线（pending）';
  }
  if (!diff.hasPending) {
    return '该格没有未提交的修改，当前待提交值与库中原值相同';
  }
  return '复制当前待提交值（网格正在显示的新值，尚未保存入库）';
}

/** 复制按钮的**标签**（短文案，给人读；详情在 title 里） */
export function copyTargetLabel(side: CellValueSide): string {
  return side === 'original' ? '复制库中原值' : '复制当前待提交值';
}

/** 待提交值不可用时给按钮的中文禁用原因 */
export function pendingUnavailableReason(diff: CellValueDiff): string | null {
  if (diff.pendingProvided) {
    return diff.hasPending ? null : '该格没有未提交的修改';
  }
  return '宿主未提供待提交值（App.tsx 未接 pending）';
}
