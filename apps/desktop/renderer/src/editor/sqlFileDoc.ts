/**
 * T41：SQL 文件文档的**纯状态机**（不依赖 React / DOM / IPC）。
 *
 * 拆出来的理由与 `sqlEditorMenuModel.ts` 一样：面板里有 CodeMirror 生命周期，
 * 而「脏不脏」「要不要问」「问了选保存/不保存/取消之后往哪走」是纯计算 ——
 * 留在组件里就只能靠手点复现，而「外部改了文件」这种状态根本点不出来。
 *
 * 三条语义红线（改之前先看）：
 *  1. **打开 ≠ 执行**：这里只管文本与文件状态，任何一条分支都不触发执行。
 *  2. **保存 ≠ 执行**：保存只写文件；入口文案必须由本文件的 `saveButtonTitle` 提供。
 *  3. **没打开文件就不谈脏**：草稿态的编辑器没有「可保存的文件目标」，
 *     把它算成脏会让每个新查询标签一出生就顶着「未保存」—— 那是谎报。
 */

/** 文件戳 —— 与主进程 SqlFileStamp 同形（渲染层只做搬运与比较，不自判） */
export interface SqlFileStamp {
  mtimeMs: number;
  size: number;
}

/** 当前挂载的 SQL 文件状态 */
export interface SqlFileState {
  /** 文件路径；null = 编辑器里是草稿，没有文件目标 */
  path: string | null;
  /** 最近一次读盘 / 存盘时**写入文件**的文本 —— 脏判定的唯一基线 */
  savedText: string;
  /** 打开时识别出的编码（用于写回提醒） */
  encoding: string;
  /** 打开时的文件戳（保存前的冲突比对基线） */
  stamp: SqlFileStamp | null;
}

export const NO_SQL_FILE: SqlFileState = { path: null, savedText: '', encoding: 'utf-8', stamp: null };

/**
 * 是否脏。
 *
 * 🔴 `path === null` 一律不脏：没有文件目标就没有「未保存的文件改动」这回事，
 *    草稿另有一套 localStorage 恢复机制（B3），不归这里管。
 */
export function isFileDirty(state: SqlFileState, doc: string): boolean {
  return state.path !== null && doc !== state.savedText;
}

/** 文件名（用于提示文案）；没有路径时返回「未命名」 */
export function fileDisplayName(path: string | null): string {
  if (path === null || path === '') return '未命名';
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

// ---------- 未保存保护 ----------

/**
 * 会丢掉未保存改动的动作。
 *
 * 四个分支**都必须有结论**（proceed 或 ask）—— 缺一个就是静默丢改动：
 *  - `open-another`：打开另一个文件（编辑器文本会被整个换掉）
 *  - `reload-file`：从磁盘重新载入当前文件
 *  - `close-tab`：关掉这个查询标签
 *  - `quit-app`：退出应用 / 关窗口
 */
export type UnsavedAction = 'open-another' | 'reload-file' | 'close-tab' | 'quit-app';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

export interface UnsavedChoiceView {
  id: UnsavedChoice;
  label: string;
  /** 主按钮（保存默认高亮） */
  primary?: boolean;
}

export interface UnsavedPrompt {
  title: string;
  detail: string;
  choices: UnsavedChoiceView[];
}

export type UnsavedDecision = { kind: 'proceed' } | { kind: 'ask'; prompt: UnsavedPrompt };

const ACTION_TEXT: Record<UnsavedAction, string> = {
  'open-another': '打开另一个文件',
  'reload-file': '从磁盘重新载入',
  'close-tab': '关闭这个标签',
  'quit-app': '退出应用',
};

/**
 * 决定「这个动作要不要先问一句」。
 *
 * 不脏 → proceed（问了就是骚扰）；脏 → 一律 ask，四个分支**没有例外** ——
 * 「退出时不用问」这类省事写法正是静默丢改动的来源。
 */
export function unsavedDecision(
  state: SqlFileState,
  doc: string,
  action: UnsavedAction,
): UnsavedDecision {
  if (!isFileDirty(state, doc)) return { kind: 'proceed' };
  const name = fileDisplayName(state.path ?? null);
  return {
    kind: 'ask',
    prompt: {
      title: `${name} 有未保存的改动`,
      detail: `${ACTION_TEXT[action]}会丢掉这些改动。`,
      choices: [
        { id: 'save', label: '保存', primary: true },
        { id: 'discard', label: '不保存' },
        { id: 'cancel', label: '取消' },
      ],
    },
  };
}

export interface UnsavedResolution {
  /** true = 放弃本次动作（用户选了取消，或保存没成功） */
  abort: boolean;
  /** true = 继续之前必须先落盘 */
  saveFirst: boolean;
}

/**
 * 把用户的选择翻译成「接下来怎么走」。
 *
 * 保存失败由调用方负责（它会拿到 saveFirst=true 并在失败时自行 abort）——
 * 这里刻意不掺异步，保持纯函数可测。
 */
export function resolveUnsaved(choice: UnsavedChoice): UnsavedResolution {
  switch (choice) {
    case 'save':
      return { abort: false, saveFirst: true };
    case 'discard':
      return { abort: false, saveFirst: false };
    default:
      return { abort: true, saveFirst: false };
  }
}

// ---------- 工具栏文案（保存与执行必须一眼可分） ----------

/**
 * 「保存」按钮的可见文案。
 *
 * 🔴 必须带【文件】二字：工具栏上并排着「执行」，只写「保存」会被读成
 *    「保存这次执行」—— 这正是 T41 表述约束要防的混淆。
 */
export function saveButtonLabel(state: SqlFileState, dirty: boolean): string {
  return state.path === null ? '另存为文件' : dirty ? '保存文件 *' : '保存文件';
}

export const SAVE_BUTTON_TITLE = '把编辑器内容写入 SQL 文件（只写文件，不执行任何语句）';
export const SAVE_AS_BUTTON_TITLE = '换一个文件名保存（只写文件，不执行任何语句）';
export const OPEN_BUTTON_TITLE = '打开 .sql 文件到编辑器（只装载内容，不会自动执行）';

/** 文件状态徽标：告诉用户编辑器里的东西现在属于哪个文件 */
export function fileBadgeText(state: SqlFileState, dirty: boolean): string {
  if (state.path === null) return '草稿（未关联文件）';
  return dirty ? `${fileDisplayName(state.path)} · 未保存` : fileDisplayName(state.path);
}
