/**
 * 网格 D 的纯逻辑单测（V14 列头类型 / V15 来源表 / V19 分组取值 / V22 加载更多）。
 *
 * 这些函数被刻意放在 useGridData.ts（不依赖 React、不碰 DOM），就是为了能在这里
 * 直接断言 —— 渲染层只负责把结果拼进 className / 文案，拼装部分由 DataGrid.test.ts 守。
 *
 * 断言纪律：每条断言都要能「改坏实现就变红」 —— 所以既测正确路径，也测
 * 「拿不到数据就该返回 null / 不显示」的降级路径（那正是线上最容易翻车的地方）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encodeColumnar, type ColumnDescriptor } from '@dbstudio/core-ipc-codec';
import {
  GridDataSource,
  SHOW_COLUMN_TYPES_KEY,
  columnTypeText,
  columnValues,
  loadMoreState,
  loadShowColumnTypes,
  matchColumnDescriptor,
  saveShowColumnTypes,
  sourceTableOf,
  typeCodeLabel,
} from './useGridData';

// ---------- localStorage 替身 ----------

/** 内存版 window.localStorage（node 环境没有 window） */
function installWindowStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
    writable: true,
  });
  return store;
}

/** 读写即抛的 localStorage（隐私模式 / 配额满的替身） */
function installThrowingStorage() {
  Object.defineProperty(globalThis, 'window', {
    value: {
      get localStorage(): never {
        throw new Error('SecurityError: localStorage denied');
      },
    },
    configurable: true,
    writable: true,
  });
}

const REAL_WINDOW = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  installWindowStorage();
});

afterEach(() => {
  // 还原成"没有 window"的原始环境，避免用例之间互相污染
  if (REAL_WINDOW === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    Object.defineProperty(globalThis, 'window', { value: REAL_WINDOW, configurable: true, writable: true });
  }
});

describe('V14 loadShowColumnTypes / saveShowColumnTypes', () => {
  it('默认关：空存储时读到 false', () => {
    expect(loadShowColumnTypes()).toBe(false);
  });

  it('开 → 落盘 → 再读仍是开（往返一致）', () => {
    saveShowColumnTypes(true);
    expect(loadShowColumnTypes()).toBe(true);
    saveShowColumnTypes(false);
    expect(loadShowColumnTypes()).toBe(false);
  });

  it('存的不是 "1"（旧值/手改）一律按关处理', () => {
    installWindowStorage({ [SHOW_COLUMN_TYPES_KEY]: 'yes' });
    expect(loadShowColumnTypes()).toBe(false);
    installWindowStorage({ [SHOW_COLUMN_TYPES_KEY]: 'true' });
    expect(loadShowColumnTypes()).toBe(false);
  });

  it('读写抛异常时静默降级：不抛、返回默认关', () => {
    installThrowingStorage();
    expect(() => loadShowColumnTypes()).not.toThrow();
    expect(loadShowColumnTypes()).toBe(false);
    expect(() => saveShowColumnTypes(true)).not.toThrow();
  });

  it('完全没有 window（如单测 node 环境）也不抛', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => loadShowColumnTypes()).not.toThrow();
    expect(loadShowColumnTypes()).toBe(false);
  });
});

describe('V14 typeCodeLabel / columnTypeText', () => {
  it('已知 typeCode 取名（来源 core-ipc-codec 的 TypeCode）', () => {
    expect(typeCodeLabel(1)).toBe('F64');
    expect(typeCodeLabel(2)).toBe('BOOL');
    expect(typeCodeLabel(3)).toBe('STR');
    expect(typeCodeLabel(4)).toBe('BIN');
    expect(typeCodeLabel(5)).toBe('DATE');
  });

  it('typeCode=NULL(0) 不显示 —— 它既表示整列 NULL 也表示没有类型信息', () => {
    expect(typeCodeLabel(0)).toBeNull();
  });

  it('表外的码 / 非数字一律 null（不许把 UNKNOWN(99) 显示给用户）', () => {
    expect(typeCodeLabel(99)).toBeNull();
    expect(typeCodeLabel(-1)).toBeNull();
    expect(typeCodeLabel(Number.NaN)).toBeNull();
    expect(typeCodeLabel(undefined)).toBeNull();
    expect(typeCodeLabel(null)).toBeNull();
  });

  it('宿主给了 dataType 就优先用它（表标签的 varchar(255) 等精确类型）', () => {
    expect(columnTypeText('varchar(255)', 3)).toBe('varchar(255)');
    // 即使 typeCode 是"拿不到"的 0，宿主的精确类型照样显示
    expect(columnTypeText('bigint unsigned', 0)).toBe('bigint unsigned');
  });

  it('dataType 为空（查询结果列常态）才退回 typeCode', () => {
    expect(columnTypeText('', 3)).toBe('STR');
    expect(columnTypeText(undefined, 1)).toBe('F64');
  });

  it('dataType 是空白串也算没有（不当有效类型显示）', () => {
    expect(columnTypeText('   ', 3)).toBe('STR');
  });

  it('两处都拿不到 → null（渲染层据此整个不渲染，绝不显示 undefined）', () => {
    expect(columnTypeText('', 0)).toBeNull();
    expect(columnTypeText('', undefined)).toBeNull();
    expect(columnTypeText(undefined, undefined)).toBeNull();
    expect(columnTypeText(null, 99)).toBeNull();
  });
});

describe('V15 sourceTableOf', () => {
  it('有来源表就原样返回', () => {
    expect(sourceTableOf({ name: 'id', typeCode: 1, sourceTable: 'users' })).toBe('users');
  });

  it('null / undefined / 空串 / 空白串一律归一为 null（渲染层只判一种空）', () => {
    expect(sourceTableOf({ name: 'id', typeCode: 1, sourceTable: null })).toBeNull();
    expect(sourceTableOf({ name: 'id', typeCode: 1 })).toBeNull();
    expect(sourceTableOf({ name: 'id', typeCode: 1, sourceTable: '' })).toBeNull();
    expect(sourceTableOf({ name: 'id', typeCode: 1, sourceTable: '   ' })).toBeNull();
    expect(sourceTableOf(null)).toBeNull();
    expect(sourceTableOf(undefined)).toBeNull();
  });
});

describe('V15 matchColumnDescriptor', () => {
  const payloadColumns: ColumnDescriptor[] = [
    { name: 'id', typeCode: 1, sourceTable: 'orders' },
    { name: 'name', typeCode: 3, sourceTable: 'users' },
    { name: 'total', typeCode: 1, sourceTable: null },
  ];

  const asCols = (...n: string[]) => n.map((name) => ({ name }));

  it('宿主按顺序建列 → 下标直接命中', () => {
    expect(matchColumnDescriptor(asCols('id', 'name', 'total'), payloadColumns, 1)?.sourceTable).toBe('users');
  });

  it('下标错位（宿主过滤/重排过列）→ 按列名回找，不会张冠李戴', () => {
    // 只渲染 name / total 两列：下标 0 对应的是 payload 的第 1 列
    expect(matchColumnDescriptor(asCols('name', 'total'), payloadColumns, 0)?.sourceTable).toBe('users');
    expect(matchColumnDescriptor(asCols('name', 'total'), payloadColumns, 1)?.sourceTable).toBeNull();
  });

  it('载荷里没有同名列 → null（降级，绝不猜）', () => {
    expect(matchColumnDescriptor(asCols('id', 'ghost'), payloadColumns, 1)).toBeNull();
    expect(matchColumnDescriptor([], payloadColumns, 0)).toBeNull();
    expect(matchColumnDescriptor(asCols('id'), [], 0)).toBeNull();
  });
});

describe('V19 columnValues（分组条纹的取值）', () => {
  function makeSource(): GridDataSource {
    const payload = encodeColumnar(
      [
        [1, 'a'],
        [2, 'a'],
        [3, 'b'],
      ],
      [
        { name: 'id', typeCode: 1 },
        { name: 'g', typeCode: 3 },
      ],
    );
    return new GridDataSource(payload);
  }

  it('取整列展示值（按列下标）', () => {
    const source = makeSource();
    expect(columnValues(source, 1)).toEqual(['a', 'a', 'b']);
    expect(columnValues(source, 0)).toEqual([1, 2, 3]);
  });

  it('走 source.value —— 脏单元格叠加层生效', () => {
    const source = makeSource();
    source.setDirty(1, 1, 'b'); // 把第二行的分组值改掉
    expect(columnValues(source, 1)).toEqual(['a', 'b', 'b']);
  });

  it('NULL 与空串严格区分（红线：不许混为一谈）', () => {
    const source = makeSource();
    source.setDirty(0, 1, null);
    source.setDirty(1, 1, '');
    const values = columnValues(source, 1);
    expect(values[0]).toBeNull();
    expect(values[1]).toBe('');
  });

  it('行数包含追加行（totalRows 口径）', () => {
    const source = makeSource();
    source.setExtraRows(1);
    expect(columnValues(source, 1)).toEqual(['a', 'a', 'b', null]);
  });
});

describe('V22 loadMoreState', () => {
  it('满页且没有估算 → 认为还有更多', () => {
    const s = loadMoreState({ loaded: 3000, estimated: null });
    expect(s.hasMore).toBe(true);
    expect(s.visible).toBe(true);
    expect(s.loadedText).toBe('已加载 3,000 行，可能还有更多');
    expect(s.estimateText).toBeNull();
  });

  it('没满页且没有估算 → 不显示提示条', () => {
    const s = loadMoreState({ loaded: 12, estimated: null });
    expect(s.hasMore).toBe(false);
    expect(s.visible).toBe(false);
  });

  it('truncated 为真时无论行数都认为还有更多', () => {
    const s = loadMoreState({ loaded: 3, estimated: null, truncated: true });
    expect(s.hasMore).toBe(true);
    expect(s.visible).toBe(true);
    expect(s.loadedText).toBe('已加载 3 行，可能还有更多');
  });

  it('有估算值 → 以估算为准（已加载 < 估算）', () => {
    const s = loadMoreState({ loaded: 3000, estimated: 5000 });
    expect(s.hasMore).toBe(true);
    expect(s.estimateText).toBe('约 5,000 行（InnoDB 估算）');
  });

  it('有估算值且已加载完 → 不显示（🔴 不能再用 limit 判，否则小表永远提示还有更多）', () => {
    const s = loadMoreState({ loaded: 3000, estimated: 3000 });
    expect(s.hasMore).toBe(false);
    expect(s.visible).toBe(false);
  });

  it('大表警告：估算超过阈值才给警告文案', () => {
    const big = loadMoreState({ loaded: 3000, estimated: 100_001 });
    expect(big.warnText).toContain('超过 100,000 行');
    expect(big.warnText).toContain('拉全表');
    expect(big.visible).toBe(true);

    const edge = loadMoreState({ loaded: 3000, estimated: 100_000 });
    expect(edge.warnText).toBeNull(); // 阈值是严格大于
  });

  it('即使已全部加载，命中大表警告也要提示（visible 由警告兜住）', () => {
    const s = loadMoreState({ loaded: 200_000, estimated: 200_000 });
    expect(s.hasMore).toBe(false);
    expect(s.visible).toBe(true);
    expect(s.warnText).not.toBeNull();
  });

  it('宿主什么都不传 → 不可见（零接线时网格外观不变）', () => {
    const s = loadMoreState({ loaded: 12, estimated: null });
    expect(s.visible).toBe(false);
    expect(s.warnText).toBeNull();
  });

  it('limit 可覆盖（宿主自定义分页大小）', () => {
    expect(loadMoreState({ loaded: 500, estimated: null, limit: 500 }).hasMore).toBe(true);
    expect(loadMoreState({ loaded: 499, estimated: null, limit: 500 }).hasMore).toBe(false);
  });

  it('畸形输入不炸：负数/小数被 loadState 收敛', () => {
    const s = loadMoreState({ loaded: -5, estimated: null });
    expect(s.loadedText).toBe('已加载 0 行，可能还有更多');
    expect(loadMoreState({ loaded: 10, estimated: Number.NaN }).estimateText).toBeNull();
  });
});
