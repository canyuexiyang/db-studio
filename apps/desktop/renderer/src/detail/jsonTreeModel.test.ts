import { describe, it, expect } from 'vitest';
import {
  parseJsonRoot,
  childrenOf,
  flattenVisible,
  defaultExpanded,
  jsonPointer,
  escapePointerToken,
  buildRowSearchIndex,
  rowOfOffset,
  matchesToRows,
  MAX_VISIBLE_JSON_NODES,
} from './jsonTreeModel';

/**
 * T35 折叠树行模型：指针语义（RFC 6901）、懒加载、展开上限、搜索索引。
 * 🔴 所有测试直接用源串下标对拍 —— 大整数不经 Number（红线 6）。
 */

const DOC = '{"id":9007199254740993,"user name":"顾","tags":["a","b"],"nested":{"deep":{"x":1}}}';

describe('JSON Pointer（RFC 6901）', () => {
  it('转义规则：~ → ~0，/ → ~1', () => {
    expect(escapePointerToken('a~b')).toBe('a~0b');
    expect(escapePointerToken('a/b')).toBe('a~1b');
  });

  it('子指针拼装：数字 token 不转义，字符串 token 转义', () => {
    expect(jsonPointer('', 'a')).toBe('/a');
    expect(jsonPointer('/a', 0)).toBe('/a/0');
    expect(jsonPointer('', 'user name')).toBe('/user name');
    expect(jsonPointer('', 'a/b')).toBe('/a~1b');
  });

  it('根节点指针是空串（RFC 6901 whole document）', () => {
    const root = parseJsonRoot(DOC);
    expect(root).not.toBeNull();
    expect(root!.pointer).toBe('');
    expect(root!.kind).toBe('object');
  });
});

describe('parseJsonRoot · 非法输入返回 null（退回原文视图，不丢值）', () => {
  it('尾随内容 / 未闭合 / 空串', () => {
    expect(parseJsonRoot('{"a":1} extra')).toBeNull();
    expect(parseJsonRoot('{"a":1')).toBeNull();
    expect(parseJsonRoot('')).toBeNull();
    expect(parseJsonRoot('  ')).toBeNull();
  });

  it('尾随逗号拒绝', () => {
    expect(parseJsonRoot('[1,]')).toBeNull();
    expect(parseJsonRoot('{"a":1,}')).toBeNull();
  });

  it('顶层标量也可解析（JSON 列的合法标量）', () => {
    const root = parseJsonRoot('42');
    expect(root!.kind).toBe('number');
    expect(root!.valueText).toBe('42');
  });
});

describe('childrenOf · 懒加载直属子项', () => {
  it('对象的子项带 key 与指针；数组子项带 index', () => {
    const root = parseJsonRoot(DOC)!;
    const kids = childrenOf(DOC, root);
    expect(kids.map((k) => k.key)).toEqual(['id', 'user name', 'tags', 'nested']);
    expect(kids[0].pointer).toBe('/id');
    expect(kids[1].pointer).toBe('/user name');

    const tags = kids[2];
    const tagKids = childrenOf(DOC, tags);
    expect(tagKids[0].index).toBe(0);
    expect(tagKids[0].pointer).toBe('/tags/0');
    expect(tagKids[0].valueText).toBe('"a"');
  });

  it('叶子节点 childrenOf 返回空数组', () => {
    const root = parseJsonRoot(DOC)!;
    const leaf = childrenOf(DOC, root)[0];
    expect(childrenOf(DOC, leaf)).toEqual([]);
  });

  it('🔴 数字原文保真（9007199254740993 不经 Number）', () => {
    const root = parseJsonRoot(DOC)!;
    const id = childrenOf(DOC, root)[0];
    expect(id.valueText).toBe('9007199254740993');
    // 证伪：JSON.parse 会把它变成 ...992
    expect(String(JSON.parse(DOC).id)).toBe('9007199254740992');
  });

  it('字符串转义解码到 key（\\u 转义）', () => {
    const doc = '{"a\\u0041": 1}';
    const root = parseJsonRoot(doc)!;
    const kids = childrenOf(doc, root);
    expect(kids[0].key).toBe('aA');
  });
});

describe('flattenVisible · 折叠/展开与视觉顺序', () => {
  it('全折叠：只有根行', () => {
    const root = parseJsonRoot(DOC)!;
    const r = flattenVisible(DOC, root, new Set());
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].node.kind).toBe('object');
    expect(r.rows[0].childCount).toBeNull(); // 未展开不知道有几个
    expect(r.truncated).toBe(false);
  });

  it('展开根：4 个子行，childCount 已知', () => {
    const root = parseJsonRoot(DOC)!;
    const r = flattenVisible(DOC, root, new Set(['']));
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0].childCount).toBe(4);
    expect(r.rows[0].expanded).toBe(true);
  });

  it('嵌套展开：深度优先先序', () => {
    const root = parseJsonRoot(DOC)!;
    const r = flattenVisible(DOC, root, new Set(['', '/nested']));
    const ptrs = r.rows.map((x) => x.node.pointer);
    expect(ptrs).toEqual(['', '/id', '/user name', '/tags', '/nested', '/nested/deep']);
  });

  it('折叠容器的 ownText 含原始片段全文（搜索靠它命中折叠子树）', () => {
    const root = parseJsonRoot(DOC)!;
    const collapsed = flattenVisible(DOC, root, new Set());
    expect(collapsed.rows[0].ownText).toContain('9007199254740993');
    // 展开后 ownText 变摘要，子内容归子行
    const expanded = flattenVisible(DOC, root, new Set(['']));
    expect(expanded.rows[0].ownText).toBe('{…}');
  });

  it('🔴 展开上限：超过 maxNodes 停止并报 truncated（不许静默少渲染）', () => {
    // 宽 JSON：一个对象 5000 个键
    const keys = Array.from({ length: 5000 }, (_, i) => `"k${i}":${i}`).join(',');
    const doc = `{${keys}}`;
    const root = parseJsonRoot(doc)!;
    const r = flattenVisible(doc, root, new Set(['']), 100);
    expect(r.rows.length).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
    // 默认上限是 2000
    expect(MAX_VISIBLE_JSON_NODES).toBe(2000);
  });
});

describe('defaultExpanded · 初次展开两层且受上限约束', () => {
  it('depth<2 的容器默认展开', () => {
    const root = parseJsonRoot(DOC)!;
    const exp = defaultExpanded(DOC, root, 2);
    expect(exp.has('')).toBe(true); // depth 0
    expect(exp.has('/nested')).toBe(true); // depth 1
    expect(exp.has('/nested/deep')).toBe(false); // depth 2 不展开
  });

  it('巨大 JSON 不铺满：maxNodes 卡住', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `"k${i}":{"inner":1}`).join(',');
    const doc = `{${keys}}`;
    const root = parseJsonRoot(doc)!;
    const exp = defaultExpanded(doc, root, 2, 500);
    expect(exp.size).toBeLessThanOrEqual(1000); // 根 + ≤500 个二层容器
    // 展开集合不超过 maxNodes 数量级
    expect(exp.size).toBeLessThanOrEqual(501);
  });

  it('深层嵌套在引导深度上限内不爆栈（MAX_BOOTSTRAP_DEPTH 防线）', () => {
    // scanChildren/skipValue 是互相递归，实际能扫的深度受 JS 栈帧限制（千级安全，
    // 数万级会爆 —— jsonTreeModel 的 defaultExpanded 用 MAX_BOOTSTRAP_DEPTH=100
    // 防住「走下去」，这里取 90 层验证防线内一切正常且展开集合只在前两层。
    const depth = 90;
    const doc = '['.repeat(depth) + ']'.repeat(depth);
    const root = parseJsonRoot(doc);
    expect(root).not.toBeNull();
    const exp = defaultExpanded(doc, root!, 2, 2000);
    expect(exp.has('')).toBe(true);
    expect(exp.has('/0')).toBe(true);
    expect(exp.has('/0/0')).toBe(false); // depth 2 不展开
    expect(() => flattenVisible(doc, root!, exp)).not.toThrow();
  });
});

describe('搜索索引（行 → 可搜串 → 命中行号）', () => {
  it('索引拼装与行偏移回查一致', () => {
    const root = parseJsonRoot(DOC)!;
    const r = flattenVisible(DOC, root, new Set(['']));
    const idx = buildRowSearchIndex(r.rows);
    expect(idx.text).toContain('9007199254740993');
    // 每行的 ownText 在索引里都能定位回自己
    for (let i = 0; i < r.rows.length; i++) {
      const off = idx.text.indexOf(r.rows[i].ownText.split(' ')[0] ?? '');
      if (off >= 0) expect(rowOfOffset(idx, off)).toBe(i);
    }
  });

  it('matchesToRows：一行多处命中只算一处，去重升序', () => {
    const root = parseJsonRoot(DOC)!;
    const r = flattenVisible(DOC, root, new Set(['']));
    const idx = buildRowSearchIndex(r.rows);
    // 在「tags」键行与「user name」行都命中 'a'/'name' 这类词
    const rows = matchesToRows(idx, [idx.text.indexOf('tags'), idx.text.indexOf('tags') + 1, idx.text.indexOf('name')]);
    expect(rows).toEqual([...new Set(rows)].sort((a, b) => a - b));
  });

  it('分隔符上的偏移返回 -1', () => {
    const root = parseJsonRoot(DOC)!;
    const r = flattenVisible(DOC, root, new Set(['']));
    const idx = buildRowSearchIndex(r.rows);
    expect(rowOfOffset(idx, idx.ends[0])).toBe(-1); // 尾后 = 分隔符位置
  });
});
