import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SchemaCache,
  buildColumnIndex,
  SCHEMA_CACHE_VERSION,
  type DatabaseMeta,
  type ColumnMeta,
} from './index.js';

let dir: string;
let cache: SchemaCache;

function col(name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
    ...extra,
  };
}

const sampleDb: DatabaseMeta[] = [
  {
    name: 'bench',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [
      {
        name: 'big_table',
        kind: 'table',
        comment: null,
        estimatedRows: 10_000_003,
        engine: 'InnoDB',
        collation: 'utf8mb4_general_ci',
        columns: [
          col('id', { dataType: 'bigint', isPrimaryKey: true, autoIncrement: true, nullable: false }),
          col('email', { isUnique: true }),
          col('created_at', { dataType: 'datetime(6)' }),
        ],
      },
      {
        name: 'no_key_table',
        kind: 'table',
        comment: null,
        estimatedRows: 50_000,
        engine: 'InnoDB',
        collation: 'utf8mb4_general_ci',
        columns: [col('a'), col('b')],
      },
      {
        name: 'v_summary',
        kind: 'view',
        comment: null,
        estimatedRows: null,
        engine: null,
        collation: null,
        columns: [col('id'), col('email')],
      },
    ],
  },
];

beforeEach(() => {
  dir = join(tmpdir(), `dbstudio-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cache = new SchemaCache(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SchemaCache — 落盘与读回', () => {
  it('保存后能读回，且带版本号', () => {
    cache.save('conn-1', sampleDb);
    const st = cache.load('conn-1');
    expect(st.snapshot).not.toBeNull();
    expect(st.snapshot!.version).toBe(SCHEMA_CACHE_VERSION);
    expect(st.snapshot!.databases.length).toBe(1);
    expect(st.compatible).toBe(true);
    expect(st.stale).toBe(false);
  });

  it('无快照时 stale=true 且 snapshot=null', () => {
    const st = cache.load('never-seen');
    expect(st.snapshot).toBeNull();
    expect(st.stale).toBe(true);
    expect(st.ageMs).toBeNull();
  });

  it('TTL 过期后标记 stale（但快照仍可用，供先渲染）', () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 天前
    cache.save('conn-1', sampleDb, old);
    const st = cache.load('conn-1');
    expect(st.stale).toBe(true);
    expect(st.snapshot).not.toBeNull(); // 仍能渲染，只是提示可能过期
    expect(st.ageMs!).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });

  it('版本不兼容时快照不可用（需整份重建）', () => {
    const p = join(dir, 'schema-cache', 'conn-1.json');
    mkdirSync(join(dir, 'schema-cache'), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 999, connectionId: 'conn-1', capturedAt: Date.now(), databases: [], columnIndex: {} }));
    const st = cache.load('conn-1');
    expect(st.compatible).toBe(false);
    expect(st.snapshot).toBeNull();
  });

  it('快照损坏时不抛异常，当作无快照', () => {
    const p = join(dir, 'schema-cache', 'conn-1.json');
    mkdirSync(join(dir, 'schema-cache'), { recursive: true });
    writeFileSync(p, '{ this is not json');
    const st = cache.load('conn-1');
    expect(st.snapshot).toBeNull();
  });

  it('C1：旧快照（无触发器字段）读入不崩，新快照的 trigger 字段可往返', () => {
    // 旧版本写出的快照：TableMeta 没有 triggerTable/triggerTiming/triggerEvent 键
    const legacy = {
      version: SCHEMA_CACHE_VERSION,
      connectionId: 'conn-legacy',
      capturedAt: Date.now(),
      databases: [
        {
          name: 'bench',
          charset: 'utf8mb4',
          collation: null,
          tables: [
            { name: 't1', kind: 'table', comment: null, estimatedRows: 1, engine: 'InnoDB', collation: null, columns: [] },
          ],
        },
      ],
      columnIndex: {},
    };
    const p = join(dir, 'schema-cache', 'conn-legacy.json');
    mkdirSync(join(dir, 'schema-cache'), { recursive: true });
    writeFileSync(p, JSON.stringify(legacy));
    const st = cache.load('conn-legacy');
    expect(st.snapshot).not.toBeNull();
    expect(cache.listTables(st.snapshot!, 'bench')).toHaveLength(1);

    // 新快照：trigger/event 字段落盘后原样读回
    const withTrigger: DatabaseMeta[] = [
      {
        name: 'bench',
        charset: 'utf8mb4',
        collation: null,
        tables: [
          {
            name: 'trg_audit',
            kind: 'trigger',
            comment: null,
            estimatedRows: null,
            engine: null,
            collation: null,
            columns: [],
            triggerTable: 't1',
            triggerTiming: 'AFTER',
            triggerEvent: 'INSERT',
          },
        ],
      },
    ];
    cache.save('conn-new', withTrigger);
    const back = cache.load('conn-new').snapshot!;
    expect(back.databases[0].tables[0].kind).toBe('trigger');
    expect(back.databases[0].tables[0].triggerTable).toBe('t1');
    expect(back.databases[0].tables[0].triggerTiming).toBe('AFTER');
    expect(back.databases[0].tables[0].triggerEvent).toBe('INSERT');
  });

  it('连接 ID 含路径分隔符时不会越权写入', () => {
    cache.save('../../evil', sampleDb);
    // 应被安全化成 ____evil 之类，落在 schema-cache 目录内
    const st = cache.load('../../evil');
    expect(st.snapshot).not.toBeNull();
  });

  it('remove 与 clear', () => {
    cache.save('a', sampleDb);
    cache.save('b', sampleDb);
    cache.remove('a');
    expect(cache.load('a').snapshot).toBeNull();
    expect(cache.load('b').snapshot).not.toBeNull();
    cache.clear();
    expect(cache.load('b').snapshot).toBeNull();
  });
});

describe('SchemaCache — 查询', () => {
  let snap: ReturnType<SchemaCache['load']>['snapshot'] extends null ? never : any;

  beforeEach(() => {
    snap = cache.save('conn-1', sampleDb);
  });

  it('listDatabases', () => {
    expect(cache.listDatabases(snap)).toEqual(['bench']);
  });

  it('listTables 可按类型过滤', () => {
    expect(cache.listTables(snap, 'bench').length).toBe(3);
    expect(cache.listTables(snap, 'bench', 'table').map((t) => t.name)).toEqual(['big_table', 'no_key_table']);
    expect(cache.listTables(snap, 'bench', 'view').map((t) => t.name)).toEqual(['v_summary']);
  });

  it('getTable', () => {
    expect(cache.getTable(snap, 'bench', 'big_table')!.estimatedRows).toBe(10_000_003);
    expect(cache.getTable(snap, 'bench', 'nope')).toBeNull();
  });

  it('Q2：按字段名反查表', () => {
    expect(cache.findTablesByColumn(snap, 'email')).toEqual(['bench.big_table', 'bench.v_summary']);
    expect(cache.findTablesByColumn(snap, 'EMAIL')).toEqual(['bench.big_table', 'bench.v_summary']); // 大小写不敏感
    expect(cache.findTablesByColumn(snap, 'nope')).toEqual([]);
  });
});

describe('SchemaCache — 行定位策略（B5 / R4 红线）', () => {
  it('有主键 → pk，可编辑', () => {
    const t = sampleDb[0].tables[0]; // big_table 有 id 主键
    expect(cache.locateStrategy(t)).toBe('pk');
    expect(cache.isEditable(t)).toBe(true);
    expect(cache.locateColumns(t).map((c) => c.name)).toEqual(['id']);
  });

  it('无主键但有唯一键 → unique，可编辑', () => {
    const t: any = {
      name: 't', kind: 'table', comment: null, estimatedRows: null, engine: null, collation: null,
      columns: [col('email', { isUnique: true, nullable: false })],
    };
    expect(cache.locateStrategy(t)).toBe('unique');
    expect(cache.isEditable(t)).toBe(true);
  });

  it('无主键无唯一键 → none，网格只读（红线）', () => {
    const t = sampleDb[0].tables[1]; // no_key_table
    expect(cache.locateStrategy(t)).toBe('none');
    expect(cache.isEditable(t)).toBe(false);
    expect(cache.locateColumns(t)).toEqual([]);
  });

  it('视图不可编辑（无列级主键信息时退化为 none）', () => {
    const v = sampleDb[0].tables[2]; // v_summary
    expect(cache.isEditable(v)).toBe(false);
  });
});

describe('buildColumnIndex 纯函数', () => {
  it('生成去重的大小写不敏感倒排索引', () => {
    const idx = buildColumnIndex(sampleDb);
    expect(idx['id']).toEqual(['bench.big_table', 'bench.v_summary']);
    expect(idx['created_at']).toEqual(['bench.big_table']);
    expect(Object.keys(idx)).toContain('email');
  });
});
