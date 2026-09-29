import { describe, it, expect } from 'vitest';
import {
  MySqlDriver,
  R10_DRIVER_OPTIONS,
  SYSTEM_SCHEMAS,
  buildOpenTableSql,
  buildReferencedValuesSql,
  escapeLikeKeyword,
  REFERENCED_VALUE_LIMIT_DEFAULT,
  REFERENCED_VALUE_LIMIT_MAX,
  mysqlConnectionOptions,
  normalizeError,
  DriverError,
  SHOW_CREATE_DDL_COLUMN,
} from './index.js';
import { quoteIdentifier, quoteQualified, joinIdentifiers, IdentifierError } from '@dbstudio/core-sql-ident';
import type { DriverConn, MySqlModuleLike, TunnelHandle } from './index.js';
import type { ObjectKind } from '@dbstudio/core-schema-cache';

// ---------- 测试替身：不连真库也能测驱动逻辑 ----------
function fakeModule(responder: (sql: string) => [unknown, unknown]): MySqlModuleLike {
  return {
    createConnection: async () => {
      const conn: DriverConn = {
        query: async (sql) => responder(sql),
        end: async () => undefined,
      };
      return conn;
    },
  };
}

const versionOnly = (): [unknown, unknown] => [
  [['8.0.46', 42]],
  [{ name: 'v' }, { name: 'id' }],
];

describe('R10 驱动参数（数据正确性）', () => {
  it('BIGINT 精度：supportBigNumbers + bigNumberStrings 必须开', () => {
    expect(R10_DRIVER_OPTIONS.supportBigNumbers).toBe(true);
    expect(R10_DRIVER_OPTIONS.bigNumberStrings).toBe(true);
  });

  it('DATETIME(6) 微秒：dateStrings 必须开（保留服务端原文）', () => {
    expect(R10_DRIVER_OPTIONS.dateStrings).toBe(true);
  });

  it('JSON 大整数：jsonStrings 必须开（不自动 parse）', () => {
    expect(R10_DRIVER_OPTIONS.jsonStrings).toBe(true);
  });

  it('DECIMAL 保持字符串，不转 float', () => {
    expect(R10_DRIVER_OPTIONS.decimalNumbers).toBe(false);
  });

  it('多语句默认禁用（注入面）', () => {
    expect(R10_DRIVER_OPTIONS.multipleStatements).toBe(false);
  });

  it('大结果集用数组而非对象（省内存省 GC）', () => {
    expect(R10_DRIVER_OPTIONS.rowsAsArray).toBe(true);
  });

  it('连接选项合并：用户覆盖项生效，但不含明文密码字段以外的泄漏', () => {
    const opts = mysqlConnectionOptions({ host: 'h', port: 3306, user: 'u', password: 'p' });
    expect(opts.host).toBe('h');
    expect(opts.password).toBe('p');
    expect(opts.supportBigNumbers).toBe(true);
  });

  it('未指定 database 时不下发 database 键', () => {
    const opts = mysqlConnectionOptions({ host: 'h', port: 3306, user: 'u', password: null });
    expect('database' in opts).toBe(false);
    expect(opts.password).toBe('');
  });
});

describe('标识符转义（防注入）', () => {
  it('普通标识符加反引号', () => {
    expect(quoteIdentifier('order')).toBe('`order`');
  });

  it('内部反引号加倍', () => {
    expect(quoteIdentifier('we`ird')).toBe('`we``ird`');
  });

  it('空名拒绝', () => {
    expect(() => quoteIdentifier('')).toThrow(IdentifierError);
  });

  it('超长名拒绝（MySQL 上限 64）', () => {
    expect(() => quoteIdentifier('a'.repeat(65))).toThrow(/上限/);
  });

  it('含 NUL 字符拒绝', () => {
    expect(() => quoteIdentifier('a\0b')).toThrow(/NUL/);
  });

  it('限定名 db.table 分别转义', () => {
    expect(quoteQualified('db.tbl')).toBe('`db`.`tbl`');
    expect(quoteQualified(['db', 'tbl'])).toBe('`db`.`tbl`');
  });

  it('列名列表拼接', () => {
    expect(joinIdentifiers(['a', 'b'])).toBe('`a`, `b`');
  });

  it('注入式名字无法逃逸反引号', () => {
    const evil = 'a` DROP TABLE x; --';
    expect(quoteIdentifier(evil)).toBe('`a`` DROP TABLE x; --`');
  });
});

describe('驱动生命周期', () => {
  it('connect 返回服务端版本与耗时', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      { loadModule: () => Promise.resolve(fakeModule(versionOnly)) },
    );
    const r = await d.connect();
    expect(r.serverVersion).toBe('8.0.46');
    expect(d.connectionId).toBe(42);
    expect(d.isConnected).toBe(true);
    await d.close();
    expect(d.isConnected).toBe(false);
  });

  it('取消走管理连接 KILL QUERY（MySQL 无带内取消）', async () => {
    const seen: string[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              seen.push(sql);
              return versionOnly();
            }),
          ),
      },
    );
    await d.connect();
    expect(await d.cancel()).toBe(true);
    // KILL 不支持占位符参数（真库实测 e2e 暴露）：必须内联整数 id
    expect(seen.some((s) => s === 'KILL QUERY 42')).toBe(true);
    await d.close();
  });

  it('connectionId 非法时取消返回 false，不拼接脏值', async () => {
    const seen: string[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              seen.push(sql);
              // 模拟取不到 connection id
              return [[['8.0.46', null]], []];
            }),
          ),
      },
    );
    await d.connect();
    expect(await d.cancel()).toBe(false);
    expect(seen.some((s) => s.includes('KILL'))).toBe(false);
    await d.close();
  });

  it('未连接时取消返回 false，不抛异常', async () => {
    const d = new MySqlDriver({ host: 'h', port: 3306, user: 'u', password: null }, {}, {
      loadModule: () => Promise.resolve(fakeModule(versionOnly)),
    });
    expect(await d.cancel()).toBe(false);
  });

  it('未连接时查询抛 DriverError', async () => {
    const d = new MySqlDriver({ host: 'h', port: 3306, user: 'u', password: null }, {}, {
      loadModule: () => Promise.resolve(fakeModule(versionOnly)),
    });
    await expect(d.query('SELECT 1')).rejects.toThrow(DriverError);
  });

  it('max_execution_time 作为兜底在连接后下发', async () => {
    const seen: string[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      { maxExecutionTimeMs: 30000 },
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              seen.push(sql);
              return versionOnly();
            }),
          ),
      },
    );
    await d.connect();
    expect(seen.some((s) => s.includes('max_execution_time = 30000'))).toBe(true);
    await d.close();
  });

  it('服务端不支持 session guard 时静默跳过，不让连接失败', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      { maxExecutionTimeMs: 1000, enforceTransactionReadOnly: true },
      {
        loadModule: () =>
          Promise.resolve({
            createConnection: async () => ({
              query: async (sql: string) => {
                if (sql.startsWith('SET SESSION')) throw new Error('unknown variable');
                return versionOnly();
              },
              end: async () => undefined,
            }),
          }),
      },
    );
    const r = await d.connect();
    expect(r.serverVersion).toBe('8.0.46');
    await d.close();
  });

  it('错误归一化保留原始错误码（UI 展示原文，不翻译）', () => {
    const e = normalizeError({ message: 'Access denied', code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 });
    expect(e.code).toBe('ER_ACCESS_DENIED_ERROR');
    expect(e.errno).toBe(1045);
    expect(e.message).toBe('Access denied');
  });

  it('testConnection 失败时返回错误与耗时，不抛', async () => {
    const r = await MySqlDriver.testConnection(
      { host: 'h', port: 3306, user: 'u', password: null },
      {
        loadModule: () =>
          Promise.resolve({
            createConnection: async () => {
              throw new Error('ECONNREFUSED');
            },
          }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('ECONNREFUSED');
      expect(typeof r.elapsedMs).toBe('number');
    }
  });

  it('testConnection 成功返回版本', async () => {
    const r = await MySqlDriver.testConnection(
      { host: 'h', port: 3306, user: 'u', password: null },
      { loadModule: () => Promise.resolve(fakeModule(versionOnly)) },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.serverVersion).toBe('8.0.46');
  });
});

describe('网格打开 SQL 构造（§6.3.1）', () => {
  it('快速打开默认 LIMIT 3000', () => {
    const { sql, params } = buildOpenTableSql({ database: 'db', table: 't', limit: 3000 });
    expect(sql).toBe('SELECT * FROM `db`.`t` LIMIT ?');
    expect(params).toEqual([3000]);
  });

  it('分页打开带 OFFSET', () => {
    const { sql, params } = buildOpenTableSql({ database: 'db', table: 't', limit: 3000, offset: 3000 });
    expect(sql).toBe('SELECT * FROM `db`.`t` LIMIT ? OFFSET ?');
    expect(params).toEqual([3000, 3000]);
  });

  it('排序在服务端执行（不是前端排序）', () => {
    const { sql } = buildOpenTableSql({
      database: 'db',
      table: 't',
      limit: 10,
      orderBy: [{ column: 'id', direction: 'DESC' }],
    });
    expect(sql).toContain('ORDER BY `id` DESC');
  });

  it('多列排序按点击顺序生成', () => {
    const { sql } = buildOpenTableSql({
      database: 'db',
      table: 't',
      limit: 10,
      orderBy: [
        { column: 'status', direction: 'ASC' },
        { column: 'id', direction: 'DESC' },
      ],
    });
    expect(sql).toContain('ORDER BY `status` ASC, `id` DESC');
  });

  it('完整打开（不带 LIMIT）', () => {
    const { sql, params } = buildOpenTableSql({ database: 'db', table: 't' });
    expect(sql).toBe('SELECT * FROM `db`.`t`');
    expect(params).toEqual([]);
  });

  it('表名含特殊字符也被转义', () => {
    const { sql } = buildOpenTableSql({ database: 'd`b', table: 't`bl', limit: 1 });
    expect(sql).toContain('`d``b`.`t``bl`');
  });
});

describe('元数据 introspect', () => {
  it('把 information_schema 结果组装成 DatabaseMeta[]', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('SCHEMATA') && sql.includes('DEFAULT_CHARACTER_SET_NAME')) {
                return [[['bench', 'utf8mb4', 'utf8mb4_0900_ai_ci']], []];
              }
              if (sql.includes('information_schema.TABLES')) {
                return [[['bench', 'big_table', 'BASE TABLE', 'InnoDB', 9930343, '大表', 'utf8mb4_0900_ai_ci']], []];
              }
              if (sql.includes('information_schema.COLUMNS')) {
                return [
                  [
                    ['bench', 'big_table', 'id', 'bigint unsigned', 'NO', null, '', 'PRI', 'auto_increment', null, null],
                    ['bench', 'big_table', 'email', 'varchar(128)', 'NO', null, '邮箱', 'UNI', '', 'utf8mb4', 'utf8mb4_0900_ai_ci'],
                    ['bench', 'big_table', 'amount', 'decimal(12,2)', 'NO', '0.00', '', '', '', null, null],
                  ],
                  [],
                ];
              }
              if (sql.includes('information_schema.STATISTICS')) {
                return [[['bench', 'big_table', 'email', 'email', 0, 1]], []];
              }
              return [[], []];
            }),
          ),
      },
    );
    await d.connect();
    const dbs = await d.introspect(['bench']);
    expect(dbs).toHaveLength(1);
    expect(dbs[0].name).toBe('bench');
    expect(dbs[0].tables).toHaveLength(1);
    const t = dbs[0].tables[0];
    expect(t.name).toBe('big_table');
    expect(t.kind).toBe('table');
    expect(t.estimatedRows).toBe(9930343);
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'email', 'amount']);
    expect(t.columns[0].isPrimaryKey).toBe(true);
    expect(t.columns[0].autoIncrement).toBe(true);
    expect(t.columns[1].isUnique).toBe(true);
    expect(t.columns[2].isPrimaryKey).toBe(false);
    await d.close();
  });

  it('视图被识别为 view', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('information_schema.TABLES')) {
                return [[['db', 'v1', 'VIEW', null, null, '', null]], []];
              }
              return [[], []];
            }),
          ),
      },
    );
    await d.connect();
    const dbs = await d.introspect(['db']);
    expect(dbs[0].tables[0].kind).toBe('view');
    await d.close();
  });

  it('复合唯一键按索引组记录（单列判定会过约束）', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('information_schema.TABLES')) {
                return [[['db', 't', 'BASE TABLE', 'InnoDB', 10, '', null]], []];
              }
              if (sql.includes('information_schema.COLUMNS')) {
                return [
                  [
                    ['db', 't', 'a', 'int', 'NO', null, '', '', '', null, null],
                    ['db', 't', 'b', 'int', 'NO', null, '', '', '', null, null],
                  ],
                  [],
                ];
              }
              if (sql.includes('information_schema.STATISTICS')) {
                return [
                  [
                    ['db', 't', 'uk_ab', 'a', 0, 1],
                    ['db', 't', 'uk_ab', 'b', 0, 2],
                  ],
                  [],
                ];
              }
              return [[], []];
            }),
          ),
      },
    );
    await d.connect();
    const dbs = await d.introspect(['db']);
    const t = dbs[0].tables[0] as any;
    expect(t.uniqueGroups).toEqual([['a', 'b']]);
    expect(t.columns.every((c: any) => c.isUnique)).toBe(true);
    await d.close();
  });

  it('排除系统库', async () => {
    const seen: unknown[][] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('SCHEMA_NAME FROM information_schema.SCHEMATA')) {
                seen.push([sql]);
                return [[['bench']], []];
              }
              return [[], []];
            }),
          ),
      },
    );
    await d.connect();
    const list = await d.listDatabases();
    expect(list).toEqual(['bench']);
    // 系统库名单作为参数下发（4 个占位符），不拼进 SQL 文本
    const sql = String(seen[0][0]);
    expect(sql).toContain('NOT IN (?,?,?,?)');
    expect(SYSTEM_SCHEMAS).toContain('mysql');
    expect(SYSTEM_SCHEMAS).toContain('sys');
    await d.close();
  });

  it('空库列表返回空数组，不发起后续查询', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              return [[], []];
            }),
          ),
      },
    );
    await d.connect();
    expect(await d.introspect([])).toEqual([]);
    await d.close();
  });

  it('C1：触发器/事件进入 introspect 结果（kind=trigger/event）', async () => {
    const seen: string[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              seen.push(sql);
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('information_schema.TABLES')) {
                return [[['bench', 'big_table', 'BASE TABLE', 'InnoDB', 10, '', null]], []];
              }
              if (sql.includes('information_schema.TRIGGERS')) {
                return [[['bench', 'trg_audit', 'big_table', 'AFTER', 'INSERT']], []];
              }
              if (sql.includes('information_schema.EVENTS')) {
                return [[['bench', 'evt_nightly']], []];
              }
              return [[], []];
            }),
          ),
      },
    );
    await d.connect();
    const dbs = await d.introspect(['bench']);
    const kinds = dbs[0].tables.map((t) => [t.name, t.kind]);
    expect(kinds).toContainEqual(['trg_audit', 'trigger']);
    expect(kinds).toContainEqual(['evt_nightly', 'event']);

    const trg = dbs[0].tables.find((t) => t.name === 'trg_audit')!;
    expect(trg.triggerTable).toBe('big_table');
    expect(trg.triggerTiming).toBe('AFTER');
    expect(trg.triggerEvent).toBe('INSERT');
    expect(trg.columns).toEqual([]); // 触发器没有列，不参与列装配

    // 查询形态：TRIGGERS 按库参数过滤；EVENTS 只列启用中的
    expect(seen.some((s) => s.includes('FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (?)'))).toBe(true);
    expect(seen.some((s) => s.includes("FROM information_schema.EVENTS") && s.includes("STATUS = 'ENABLED'"))).toBe(true);
    await d.close();
  });

  it('C1：触发器/事件查询失败不拖垮 introspect（权限不足/老版本服务端）', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('information_schema.TABLES')) {
                return [[['bench', 'big_table', 'BASE TABLE', 'InnoDB', 10, '', null]], []];
              }
              if (sql.includes('information_schema.TRIGGERS') || sql.includes('information_schema.EVENTS')) {
                throw new Error('Access denied');
              }
              return [[], []];
            }),
          ),
      },
    );
    await d.connect();
    const dbs = await d.introspect(['bench']);
    expect(dbs[0].tables.filter((t) => t.kind === 'table')).toHaveLength(1); // 核心库表树照常
    expect(dbs[0].tables.filter((t) => t.kind === 'trigger' || t.kind === 'event')).toHaveLength(0);
    await d.close();
  });
});

// ---------- 对象定义与表信息（C2 / C9+A14） ----------

describe('C2：showCreateObject（SHOW CREATE 列名逐类型适配）', () => {
  it('六类对象的 DDL 列名映射（触发器是 SQL Original Statement）', () => {
    expect(SHOW_CREATE_DDL_COLUMN.table).toBe('Create Table');
    expect(SHOW_CREATE_DDL_COLUMN.view).toBe('Create View');
    expect(SHOW_CREATE_DDL_COLUMN.procedure).toBe('Create Procedure');
    expect(SHOW_CREATE_DDL_COLUMN.function).toBe('Create Function');
    expect(SHOW_CREATE_DDL_COLUMN.trigger).toBe('SQL Original Statement');
    expect(SHOW_CREATE_DDL_COLUMN.event).toBe('Create Event');
  });

  it('按列名取 DDL（各类型列位置不同：PROCEDURE 第 3 列、EVENT 第 4 列）', async () => {
    const cases: { kind: ObjectKind; verb: string; fields: { name: string }[]; row: unknown[]; ddl: string }[] = [
      {
        kind: 'table',
        verb: 'SHOW CREATE TABLE',
        fields: [{ name: 'Table' }, { name: 'Create Table' }],
        row: ['t', 'CREATE TABLE `t` (`id` int)'],
        ddl: 'CREATE TABLE `t` (`id` int)',
      },
      {
        // VIEW 的结果还带 character_set_client 等列，只取 DDL
        kind: 'view',
        verb: 'SHOW CREATE VIEW',
        fields: [
          { name: 'View' },
          { name: 'Create View' },
          { name: 'character_set_client' },
          { name: 'collation_connection' },
        ],
        row: ['v', 'CREATE VIEW `v` AS SELECT 1', 'utf8mb4', 'utf8mb4_0900_ai_ci'],
        ddl: 'CREATE VIEW `v` AS SELECT 1',
      },
      {
        kind: 'procedure',
        verb: 'SHOW CREATE PROCEDURE',
        fields: [{ name: 'Procedure' }, { name: 'sql_mode' }, { name: 'Create Procedure' }],
        row: ['p', '', 'CREATE PROCEDURE `p`() BEGIN END'],
        ddl: 'CREATE PROCEDURE `p`() BEGIN END',
      },
      {
        kind: 'function',
        verb: 'SHOW CREATE FUNCTION',
        fields: [{ name: 'Function' }, { name: 'sql_mode' }, { name: 'Create Function' }],
        row: ['f', '', 'CREATE FUNCTION `f`() RETURNS int RETURN 1'],
        ddl: 'CREATE FUNCTION `f`() RETURNS int RETURN 1',
      },
      {
        kind: 'trigger',
        verb: 'SHOW CREATE TRIGGER',
        fields: [{ name: 'Trigger' }, { name: 'sql_mode' }, { name: 'SQL Original Statement' }],
        row: ['tg', '', 'CREATE TRIGGER `tg` AFTER INSERT ON `t` FOR EACH ROW SET @x=1'],
        ddl: 'CREATE TRIGGER `tg` AFTER INSERT ON `t` FOR EACH ROW SET @x=1',
      },
      {
        kind: 'event',
        verb: 'SHOW CREATE EVENT',
        fields: [{ name: 'Event' }, { name: 'sql_mode' }, { name: 'time_zone' }, { name: 'Create Event' }],
        row: ['ev', '', 'SYSTEM', 'CREATE EVENT `ev` ON SCHEDULE EVERY 1 DAY DO SELECT 1'],
        ddl: 'CREATE EVENT `ev` ON SCHEDULE EVERY 1 DAY DO SELECT 1',
      },
    ];

    for (const c of cases) {
      const seen: string[] = [];
      const d = new MySqlDriver(
        { host: 'h', port: 3306, user: 'u', password: null },
        {},
        {
          loadModule: () =>
            Promise.resolve(
              fakeModule((sql) => {
                seen.push(sql);
                if (sql.includes('SELECT VERSION()')) return versionOnly();
                return [[c.row], c.fields];
              }),
            ),
        },
      );
      await d.connect();
      const ddl = await d.showCreateObject('db', 'x', c.kind);
      expect(ddl).toBe(c.ddl);
      expect(seen.some((s) => s.startsWith(`${c.verb} `))).toBe(true);
      await d.close();
    }
  });

  it('标识符走转义（带反引号的名字不能拼坏语句）', async () => {
    const seen: string[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              seen.push(sql);
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              return [[['t', 'CREATE TABLE `t` (`id` int)']], [{ name: 'Table' }, { name: 'Create Table' }]];
            }),
          ),
      },
    );
    await d.connect();
    await d.showCreateObject('d`b', 't`bl', 'table');
    expect(seen.some((s) => s.includes('`d``b`.`t``bl`'))).toBe(true);
    await d.close();
  });

  it('结果为空 → DriverError 且带 ER_NO_SUCH_TABLE（会话层归类 NOT_FOUND 的依据）', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => (sql.includes('SELECT VERSION()') ? versionOnly() : [[], []])),
          ),
      },
    );
    await d.connect();
    await expect(d.showCreateObject('db', 'ghost', 'table')).rejects.toMatchObject({
      code: 'ER_NO_SUCH_TABLE',
    });
    await d.close();
  });

  it('服务端报错原样透出（code/errno 保留，UI 展示原文）', async () => {
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve({
            createConnection: async () => ({
              query: async (sql: string) => {
                if (sql.includes('SELECT VERSION()')) return versionOnly();
                throw Object.assign(new Error("Table 'db.ghost' doesn't exist"), {
                  code: 'ER_NO_SUCH_TABLE',
                  errno: 1146,
                });
              },
              end: async () => undefined,
            }),
          }),
      },
    );
    await d.connect();
    await expect(d.showCreateObject('db', 'ghost', 'table')).rejects.toMatchObject({
      code: 'ER_NO_SUCH_TABLE',
      errno: 1146,
    });
    await d.close();
  });
});

describe('C9/A14：getTableInfo（information_schema.TABLES 单行）', () => {
  /** row 为 null = 查询结果为空（表不存在） */
  function driverWithTableRow(row: unknown[] | null): MySqlDriver {
    const seen: string[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              seen.push(sql);
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('information_schema.TABLES WHERE TABLE_SCHEMA')) {
                return [row == null ? [] : [row], []];
              }
              return [[], []];
            }),
          ),
      },
    );
    (d as unknown as { __seen: string[] }).__seen = seen;
    return d;
  }

  it('映射成 TableInfo：BIGINT 字符串转数字、字符集从 collation 前缀推导', async () => {
    const d = driverWithTableRow([
      'InnoDB',
      '9930343',
      '123456789',
      '9876543',
      'utf8mb4_0900_ai_ci',
      '大表',
      '2026-01-02 03:04:05',
      '10001',
    ]);
    await d.connect();
    const info = await d.getTableInfo('bench', 'big_table');
    expect(info).toEqual({
      engine: 'InnoDB',
      rowsEstimate: 9930343,
      dataLength: 123456789,
      indexLength: 9876543,
      charset: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci',
      comment: '大表',
      createTime: '2026-01-02 03:04:05',
      autoIncrement: 10001,
    });
    // 🔴 红线：绝不出现 COUNT(*) —— 行数只来自 TABLE_ROWS 估算
    const seen = (d as unknown as { __seen: string[] }).__seen;
    expect(seen.some((s) => /COUNT\s*\(/i.test(s))).toBe(false);
    // 库表名走参数绑定
    expect(seen.some((s) => s.includes('TABLE_SCHEMA = ? AND TABLE_NAME = ?'))).toBe(true);
    await d.close();
  });

  it('字段缺失给 null（视图/无注释/无自增）', async () => {
    const d = driverWithTableRow([null, null, null, null, null, '', null, null]);
    await d.connect();
    const info = await d.getTableInfo('bench', 'v1');
    expect(info).toEqual({
      engine: null,
      rowsEstimate: null,
      dataLength: null,
      indexLength: null,
      charset: null,
      collation: null,
      comment: null,
      createTime: null,
      autoIncrement: null,
    });
    await d.close();
  });

  it('空结果返回 null（表不存在，由会话层抛 NOT_FOUND）', async () => {
    const d = driverWithTableRow(null);
    await d.connect();
    expect(await d.getTableInfo('bench', 'ghost')).toBeNull();
    await d.close();
  });
});

// ---------- V9：外键导航与候选值 ----------

describe('V9：buildReferencedValuesSql（候选值查询构造）', () => {
  it('🔴 必带 LIMIT（红线：绝不为下拉做全表扫描）', () => {
    const { sql, params } = buildReferencedValuesSql({
      database: 'shop',
      table: 'user',
      valueColumn: 'id',
    });
    expect(sql).toMatch(/LIMIT \?$/);
    // 默认 200 条，多取 1 行用于判断截断
    expect(params[params.length - 1]).toBe(REFERENCED_VALUE_LIMIT_DEFAULT + 1);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
  });

  it('limit 被钳到 [1, 500]（渲染层传什么都不会变成全量）', () => {
    expect(buildReferencedValuesSql({ database: 'd', table: 't', valueColumn: 'c', limit: 99999 }).limit)
      .toBe(REFERENCED_VALUE_LIMIT_MAX);
    expect(buildReferencedValuesSql({ database: 'd', table: 't', valueColumn: 'c', limit: 0 }).limit).toBe(1);
    expect(buildReferencedValuesSql({ database: 'd', table: 't', valueColumn: 'c', limit: -5 }).limit).toBe(1);
    expect(buildReferencedValuesSql({ database: 'd', table: 't', valueColumn: 'c', limit: 2.9 }).limit).toBe(2);
  });

  it('标识符走 quoteIdentifier，值走 ? 绑定（红线 5：不手拼反引号）', () => {
    const { sql, params } = buildReferencedValuesSql({
      database: 'order_db',
      table: 'order',
      valueColumn: 'user_id',
      displayColumn: 'name',
    });
    expect(sql).toContain('`order_db`.`order`');
    expect(sql).toContain('`user_id`, `name`');
    expect(sql).toContain('ORDER BY `user_id`');
    // 没有关键字就不该有任何绑定值（除了 LIMIT）
    expect(params).toEqual([REFERENCED_VALUE_LIMIT_DEFAULT + 1]);
  });

  it('displayColumn 与 valueColumn 相同/为空 → 只查一列（不做无意义的重复投影）', () => {
    const same = buildReferencedValuesSql({
      database: 'd', table: 't', valueColumn: 'id', displayColumn: 'id',
    });
    expect(same.hasDisplayColumn).toBe(false);
    expect(same.sql).toContain('SELECT `id` FROM');

    const none = buildReferencedValuesSql({ database: 'd', table: 't', valueColumn: 'id', displayColumn: null });
    expect(none.hasDisplayColumn).toBe(false);
  });

  it('keyword → 服务端 LIKE，参数顺序在 LIMIT 之前（反了会喂错值）', () => {
    const { sql, params } = buildReferencedValuesSql({
      database: 'd', table: 't', valueColumn: 'id', displayColumn: 'name', keyword: '张',
    });
    expect(sql).toContain('WHERE `name` LIKE ? ESCAPE');
    // 🔴 顺序契约：keyword 在前、LIMIT 在后（与 buildOpenTableSql 同源教训）
    expect(params).toEqual(['%张%', REFERENCED_VALUE_LIMIT_DEFAULT + 1]);
  });

  it('无 displayColumn 时 LIKE 打在值列上', () => {
    const { sql } = buildReferencedValuesSql({ database: 'd', table: 't', valueColumn: 'id', keyword: 'ab' });
    expect(sql).toContain('WHERE `id` LIKE ?');
  });

  it('纯空白 keyword 视为无过滤（不给用户一个查不到的空结果）', () => {
    const { params } = buildReferencedValuesSql({ database: 'd', table: 't', valueColumn: 'id', keyword: '   ' });
    expect(params).toEqual([REFERENCED_VALUE_LIMIT_DEFAULT + 1]);
  });
});

describe('V9：escapeLikeKeyword（通配符转义）', () => {
  it('% _ \\ 三个元字符被转义（不转义会让用户搜 "100%" 匹配到一切）', () => {
    expect(escapeLikeKeyword('100%')).toBe('100\\%');
    expect(escapeLikeKeyword('a_b')).toBe('a\\_b');
    expect(escapeLikeKeyword('c\\d')).toBe('c\\\\d');
    expect(escapeLikeKeyword('%_\\')).toBe('\\%\\_\\\\');
  });

  it('普通字符不动（中文/数字/字母原样）', () => {
    expect(escapeLikeKeyword('张三')).toBe('张三');
    expect(escapeLikeKeyword('abc123')).toBe('abc123');
    expect(escapeLikeKeyword('')).toBe('');
  });
});

describe('V9：listForeignKeys（外键元数据装配）', () => {
  /**
   * 替身按 KEY_COLUMN_USAGE JOIN REFERENTIAL_CONSTRAINTS 的 SELECT 列顺序返回：
   * CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME,
   * REFERENCED_COLUMN_NAME, DELETE_RULE, UPDATE_RULE, ORDINAL_POSITION
   */
  function driverWithFkRows(rows: unknown[][]): { d: MySqlDriver; seen: { sql: string; values: unknown[] }[] } {
    const seen: { sql: string; values: unknown[] }[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve(
            fakeModule((sql) => {
              seen.push({ sql, values: [] });
              if (sql.includes('SELECT VERSION()')) return versionOnly();
              if (sql.includes('KEY_COLUMN_USAGE')) return [rows, []];
              return [[], []];
            }),
          ),
      },
    );
    (d as unknown as { __seen: { sql: string; values: unknown[] }[] }).__seen = seen;
    return { d, seen };
  }

  it('单列外键装配正确（含 ON DELETE/UPDATE 规则）', async () => {
    const { d } = driverWithFkRows([
      ['fk_order_user', 'user_id', 'shop', 'user', 'id', 'RESTRICT', 'CASCADE', 1],
    ]);
    await d.connect();
    const fks = await d.listForeignKeys('shop', 'order');
    expect(fks).toEqual([
      {
        constraintName: 'fk_order_user',
        columns: ['user_id'],
        referencedDatabase: 'shop',
        referencedTable: 'user',
        referencedColumns: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
    ]);
    await d.close();
  });

  it('🔴 复合外键按约束名分组，且 columns/referencedColumns 顺序一一对应', async () => {
    // 顺序错位 = 「本表第1列 对 引用表第2列」→ 跳转定位到错误的行，且不报错
    const { d } = driverWithFkRows([
      ['fk_ab', 'a', 'shop', 'other', 'x', null, null, 1],
      ['fk_ab', 'b', 'shop', 'other', 'y', null, null, 2],
      ['fk_c', 'c', 'shop', 'third', 'z', 'SET NULL', 'NO ACTION', 1],
    ]);
    await d.connect();
    const fks = await d.listForeignKeys('shop', 'order');
    expect(fks).toHaveLength(2);
    const ab = fks.find((f) => f.constraintName === 'fk_ab');
    expect(ab?.columns).toEqual(['a', 'b']);
    expect(ab?.referencedColumns).toEqual(['x', 'y']);
    expect(ab?.onDelete).toBeNull();
    const c = fks.find((f) => f.constraintName === 'fk_c');
    expect(c?.onDelete).toBe('SET NULL');
    expect(c?.onUpdate).toBe('NO ACTION');
    await d.close();
  });

  it('没有外键 → 空数组（调用方据此不画链接，不是错误）', async () => {
    const { d } = driverWithFkRows([]);
    await d.connect();
    expect(await d.listForeignKeys('shop', 'plain')).toEqual([]);
    await d.close();
  });

  it('查询带库表参数绑定，且过滤掉 REFERENCED_TABLE_NAME IS NULL（非外键约束）', async () => {
    const { d, seen } = driverWithFkRows([]);
    await d.connect();
    await d.listForeignKeys('shop', 'order');
    const fkSql = seen.map((s) => s.sql).find((s) => s.includes('KEY_COLUMN_USAGE')) ?? '';
    expect(fkSql).toContain('REFERENCED_TABLE_NAME IS NOT NULL');
    expect(fkSql).toContain('TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?');
    // 排序必须显式：复合外键的列顺序全靠它
    expect(fkSql).toContain('ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION');
    await d.close();
  });
});

describe('V9：lookupReferencedValues（结果整形与截断判定）', () => {
  /** 自建替身（不用 fakeModule）：需要同时捕获 sql 与 values 才能断言参数绑定 */
  function driverWithRows(rows: unknown[][]): {
    d: MySqlDriver;
    seen: { sql: string; values: unknown[] }[];
  } {
    const seen: { sql: string; values: unknown[] }[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      {
        loadModule: () =>
          Promise.resolve({
            createConnection: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                seen.push({ sql, values: values ?? [] });
                if (sql.includes('SELECT VERSION()')) return versionOnly();
                return [rows, []];
              },
              end: async () => undefined,
            }),
          }),
      },
    );
    return { d, seen };
  }

  it('🔴 返回行数 > limit → truncated=true，且**丢掉多取的那一行**（不给用户看不该看的）', async () => {
    // limit=3 → SQL 请求 4 行；返回 4 行说明还有更多
    const { d } = driverWithRows([[1], [2], [3], [4]]);
    await d.connect();
    const r = await d.lookupReferencedValues({ database: 'd', table: 't', valueColumn: 'id', limit: 3 });
    expect(r.truncated).toBe(true);
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.value)).toEqual([1, 2, 3]);
    await d.close();
  });

  it('返回行数 <= limit → truncated=false（全部展示）', async () => {
    const { d } = driverWithRows([[1], [2]]);
    await d.connect();
    const r = await d.lookupReferencedValues({ database: 'd', table: 't', valueColumn: 'id', limit: 3 });
    expect(r.truncated).toBe(false);
    expect(r.items).toHaveLength(2);
    await d.close();
  });

  it('有 displayColumn → label 取第二列；无则 label = value', async () => {
    const { d: d1 } = driverWithRows([[7, '张三']]);
    await d1.connect();
    const withDisplay = await d1.lookupReferencedValues({
      database: 'd', table: 'user', valueColumn: 'id', displayColumn: 'name', limit: 5,
    });
    expect(withDisplay.items[0]).toEqual({ value: 7, label: '张三' });
    await d1.close();

    const { d: d2 } = driverWithRows([[7]]);
    await d2.connect();
    const noDisplay = await d2.lookupReferencedValues({
      database: 'd', table: 'user', valueColumn: 'id', limit: 5,
    });
    expect(noDisplay.items[0]).toEqual({ value: 7, label: '7' });
    await d2.close();
  });

  it('keyword 被转义后作为 LIKE 参数下发（% _ 不会变成通配符）', async () => {
    const { d, seen } = driverWithRows([]);
    await d.connect();
    await d.lookupReferencedValues({ database: 'd', table: 't', valueColumn: 'id', keyword: '100%', limit: 5 });
    const call = seen.find((s) => s.sql.includes('LIKE ?'));
    expect(call?.values[0]).toBe('%100\\%%');
    expect(call?.values[1]).toBe(6); // limit+1
    await d.close();
  });

  it('空结果 → items 空数组、truncated=false（不是错误）', async () => {
    const { d } = driverWithRows([]);
    await d.connect();
    const r = await d.lookupReferencedValues({ database: 'd', table: 't', valueColumn: 'id', limit: 5 });
    expect(r).toEqual({ items: [], truncated: false });
    await d.close();
  });
});

// ---------- SSH 隧道承载 ----------

describe('驱动走 SSH 隧道', () => {
  it('🔴 主连接与管理连接各开一条独立 channel（共用一条会串包）', async () => {
    // 每条 mysql2 连接占一个 socket，两条连接复用同一条 SSH channel
    // 会让第二条握手卡死 —— 真机实测过，所以工厂必须被调用两次。
    const streams: object[] = [];
    let n = 0;
    const d = new MySqlDriver(
      {
        host: '10.0.0.5',
        port: 3306,
        user: 'u',
        password: null,
        streamFactory: async () => {
          const s = { id: ++n };
          streams.push(s);
          return s;
        },
      },
      {},
      { loadModule: () => Promise.resolve(fakeModule(versionOnly)) },
    );
    await d.connect();
    expect(streams).toHaveLength(2);
    expect(streams[0]).not.toBe(streams[1]);
    await d.close();
  });

  it('🔴 stream 以【对象】形态传给 mysql2（不是函数，也不是 Promise）', async () => {
    // mysql2 的 stream 若传函数是同步调用，返回 Promise 会让它
    // 拿到 Promise 再 .on() → "this.stream.on is not a function"。
    const seen: Record<string, unknown>[] = [];
    const mod: MySqlModuleLike = {
      createConnection: async (opts) => {
        seen.push(opts);
        const conn: DriverConn = {
          query: async (sql) => (sql.includes('SELECT VERSION()') ? versionOnly() : [[], []]),
          end: async () => undefined,
        };
        return conn;
      },
    };
    const stream = { marker: 'channel-1' };
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null, streamFactory: async () => stream },
      {},
      { loadModule: () => Promise.resolve(mod) },
    );
    await d.connect();
    expect(seen[0].stream).toBe(stream);
    expect(typeof seen[0].stream).toBe('object');
    await d.close();
  });

  it('不走隧道时不带 stream 字段', async () => {
    const seen: Record<string, unknown>[] = [];
    const mod: MySqlModuleLike = {
      createConnection: async (opts) => {
        seen.push(opts);
        const conn: DriverConn = {
          query: async (sql) => (sql.includes('SELECT VERSION()') ? versionOnly() : [[], []]),
          end: async () => undefined,
        };
        return conn;
      },
    };
    const d = new MySqlDriver({ host: 'h', port: 3306, user: 'u', password: null }, {}, { loadModule: () => Promise.resolve(mod) });
    await d.connect();
    expect(seen[0].stream).toBeUndefined();
    await d.close();
  });

  it('🔴 close 时隧道一并释放（PRD §6.1.2 不残留孤儿进程）', async () => {
    let closed = 0;
    const tunnel: TunnelHandle = { close: async () => { closed++; } };
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      { tunnel },
      { loadModule: () => Promise.resolve(fakeModule(versionOnly)) },
    );
    await d.connect();
    await d.close();
    expect(closed).toBe(1);
  });

  it('隧道关闭失败不吞掉 DB 连接的真实错误', async () => {
    const tunnel: TunnelHandle = {
      close: async () => {
        throw new Error('tunnel close boom');
      },
    };
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      { tunnel },
      { loadModule: () => Promise.resolve(fakeModule(versionOnly)) },
    );
    await d.connect();
    await expect(d.close()).rejects.toThrow(/tunnel close boom/);
  });

  it('隧道建连失败时，驱动不会因为没连上而二次报错', async () => {
    let closed = 0;
    const tunnel: TunnelHandle = { close: async () => { closed++; } };
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      { tunnel },
      { loadModule: () => Promise.resolve({ createConnection: async () => { throw new Error('ECONNREFUSED'); } }) },
    );
    await expect(d.connect()).rejects.toThrow();
    // 未建连时驱动自己没持有隧道的释放责任 —— 由建隧道的那一方收尾
    expect(closed).toBe(0);
  });
});

// ---------- SSL/TLS 材料映射（P2-1） ----------

describe('mysqlConnectionOptions 的 SSL 映射', () => {
  it('启用 SSL：文件内容映射成 ssl 选项对象，rejectUnauthorized 缺省 true', () => {
    const opts = mysqlConnectionOptions({
      host: 'h',
      port: 3306,
      user: 'u',
      password: null,
      ssl: { ca: 'CA-PEM', cert: 'CERT-PEM', key: 'KEY-PEM' },
    });
    expect(opts.ssl).toEqual({ ca: 'CA-PEM', cert: 'CERT-PEM', key: 'KEY-PEM', rejectUnauthorized: true });
  });

  it('ssl 为 null 时【不出现】ssl 键（mysql2 靠有无 ssl 对象判定是否启用 TLS）', () => {
    const opts = mysqlConnectionOptions({ host: 'h', port: 3306, user: 'u', password: null, ssl: null });
    expect('ssl' in opts).toBe(false);
  });

  it('未给 ssl 字段时同样不出现 ssl 键（与既有连接行为完全一致）', () => {
    const opts = mysqlConnectionOptions({ host: 'h', port: 3306, user: 'u', password: null });
    expect('ssl' in opts).toBe(false);
  });

  it('只给 ca 时只映射 ca（部分配置合法，rejectUnauthorized 仍缺省 true）', () => {
    const opts = mysqlConnectionOptions({
      host: 'h',
      port: 3306,
      user: 'u',
      password: null,
      ssl: { ca: 'CA-PEM' },
    });
    expect(opts.ssl).toEqual({ ca: 'CA-PEM', rejectUnauthorized: true });
  });

  it('🔴 rejectUnauthorized:false 必须原样透传（这是"关闭校验"警示的依据）', () => {
    const opts = mysqlConnectionOptions({
      host: 'h',
      port: 3306,
      user: 'u',
      password: null,
      ssl: { ca: 'CA-PEM', rejectUnauthorized: false },
    });
    expect((opts.ssl as Record<string, unknown>).rejectUnauthorized).toBe(false);
  });

  it('空 ssl 对象一项都映射不上 → 不产生 ssl 键（不误开加密握手）', () => {
    const opts = mysqlConnectionOptions({
      host: 'h',
      port: 3306,
      user: 'u',
      password: null,
      ssl: {},
    });
    expect('ssl' in opts).toBe(false);
  });

  it('SSL 映射不影响 R10 固定参数', () => {
    const opts = mysqlConnectionOptions({
      host: 'h',
      port: 3306,
      user: 'u',
      password: null,
      ssl: { ca: 'CA-PEM' },
    });
    expect(opts.supportBigNumbers).toBe(true);
    expect(opts.bigNumberStrings).toBe(true);
    expect(opts.rowsAsArray).toBe(true);
    expect(opts.multipleStatements).toBe(false);
  });
});

describe('驱动层 SSL 透传（捕获 createConnection 收到的 opts）', () => {
  /** 捕获 createConnection 收到的完整参数，便于断言 ssl 是否原样到达 mysql2 */
  function captureModule(seen: Record<string, unknown>[]): MySqlModuleLike {
    return {
      createConnection: async (opts) => {
        seen.push(opts);
        const conn: DriverConn = {
          query: async (sql) => (sql.includes('SELECT VERSION()') ? versionOnly() : [[], []]),
          end: async () => undefined,
        };
        return conn;
      },
    };
  }

  it('ssl 材料透传到 createConnection（主连接与管理连接都要走 TLS）', async () => {
    const seen: Record<string, unknown>[] = [];
    const d = new MySqlDriver(
      {
        host: 'h',
        port: 3306,
        user: 'u',
        password: null,
        ssl: { ca: 'CA-PEM', cert: 'CERT-PEM', key: 'KEY-PEM', rejectUnauthorized: false },
      },
      {},
      { loadModule: () => Promise.resolve(captureModule(seen)) },
    );
    await d.connect();
    expect(seen).toHaveLength(2);
    const want = { ca: 'CA-PEM', cert: 'CERT-PEM', key: 'KEY-PEM', rejectUnauthorized: false };
    expect(seen[0].ssl).toEqual(want);
    expect(seen[1].ssl).toEqual(want);
    await d.close();
  });

  it('未启用 ssl 时 createConnection 收到的 opts 里没有 ssl 键', async () => {
    const seen: Record<string, unknown>[] = [];
    const d = new MySqlDriver(
      { host: 'h', port: 3306, user: 'u', password: null },
      {},
      { loadModule: () => Promise.resolve(captureModule(seen)) },
    );
    await d.connect();
    expect('ssl' in seen[0]).toBe(false);
    expect('ssl' in seen[1]).toBe(false);
    await d.close();
  });

  it('隧道与 SSL 可叠加：stream 对象与 ssl 材料同时在场', async () => {
    const seen: Record<string, unknown>[] = [];
    const stream = { marker: 'channel' };
    const d = new MySqlDriver(
      {
        host: 'h',
        port: 3306,
        user: 'u',
        password: null,
        streamFactory: async () => stream,
        ssl: { ca: 'CA-PEM' },
      },
      {},
      { loadModule: () => Promise.resolve(captureModule(seen)) },
    );
    await d.connect();
    expect(seen[0].stream).toBe(stream);
    expect(seen[0].ssl).toEqual({ ca: 'CA-PEM', rejectUnauthorized: true });
    await d.close();
  });
});
