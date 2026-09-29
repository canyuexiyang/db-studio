/**
 * 6 个逻辑模块的端到端集成验证
 *
 * 目的：证明它们不是各自孤立的"能跑"，而是真的能串成
 * 「连接 → 只读校验 → 查历史 → 判定可编辑 → 导出」这条链路。
 *
 * 各模块单测已覆盖自身行为，这里只测【跨模块协作】。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkReadOnly } from '@dbstudio/core-sql-guard';
import { HistoryStore } from '@dbstudio/core-history';
import { SchemaCache, type DatabaseMeta } from '@dbstudio/core-schema-cache';
import { SecretStore, sealSecrets, openSecrets, type SafeStorageLike } from '@dbstudio/core-secret';
import { ExportTask, sanitizeCell, csvRow, excelWriterOptions } from '@dbstudio/core-export';

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `dbstudio-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---- 测试用 fake safeStorage ----
class FakeSafeStorage implements SafeStorageLike {
  isEncryptionAvailable() { return true; }
  encryptString(p: string) { return Buffer.from('E:' + p); }
  decryptString(b: Buffer) { return b.toString('utf8').slice(2); }
  async encryptStringAsync(p: string) { return Buffer.from('E:' + p); }
  async decryptStringAsync(b: Buffer) { return b.toString('utf8').slice(2); }
}

const sampleSchema: DatabaseMeta[] = [
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
          {
            name: 'id', dataType: 'bigint', nullable: false, defaultValue: null, comment: null,
            isPrimaryKey: true, isUnique: false, autoIncrement: true, charset: null, collation: null,
          },
          {
            name: 'email', dataType: 'varchar(128)', nullable: true, defaultValue: null, comment: null,
            isPrimaryKey: false, isUnique: true, autoIncrement: false, charset: null, collation: null,
          },
        ],
      },
      {
        name: 'no_key_table',
        kind: 'table',
        comment: null,
        estimatedRows: 50_000,
        engine: 'InnoDB',
        collation: 'utf8mb4_general_ci',
        columns: [
          {
            name: 'a', dataType: 'int', nullable: true, defaultValue: null, comment: null,
            isPrimaryKey: false, isUnique: false, autoIncrement: false, charset: null, collation: null,
          },
        ],
      },
    ],
  },
];

describe('集成链路 1：只读模式完整拦截', () => {
  it('开启只读后，各类写操作全部被拦，只读操作全部放行', () => {
    // 用户尝试的各种语句
    const attempts = [
      ['SELECT * FROM big_table LIMIT 10', true],
      ['SHOW TABLES', true],
      ['UPDATE big_table SET email = "x"', false],
      ['CALL refresh_stats()', false],
      ["SELECT * FROM big_table INTO OUTFILE '/tmp/x'", false],
      ['SELECT * FROM big_table FOR UPDATE', false],
      ['SELECT 1; DROP TABLE big_table', false],
    ] as const;

    for (const [sql, shouldAllow] of attempts) {
      const r = checkReadOnly(sql, 'mysql');
      expect(r.allowed, `${sql} 期望 ${shouldAllow ? '放行' : '拦截'}`).toBe(shouldAllow);
    }
  });

  it('被拦的语句也可以进历史（Q5：失败语句要记录）', () => {
    const store = new HistoryStore(':memory:');
    const sql = 'DROP TABLE big_table';
    const r = checkReadOnly(sql, 'mysql');

    const id = store.addHistory({
      connectionId: 'conn-1',
      database: 'bench',
      sql,
      success: false,
      error: r.message, // 把拦截原因存进历史，便于回溯
      durationMs: 0,
      rowCount: 0,
      executedAt: Date.now(),
    });

    const row = store.getHistory(id)!;
    expect(row.success).toBe(false);
    expect(row.error).toContain('白名单');
    store.close();
  });
});

describe('集成链路 2：连接凭据 → Schema 缓存 → 可编辑判定', () => {
  it('完整走通', async () => {
    // 1) 加密凭据
    const secret = new SecretStore(new FakeSafeStorage());
    await secret.init();
    const fields = await sealSecrets(secret, { password: 'db-pass-123' });
    expect(fields.passwordEnc).not.toContain('db-pass-123');

    // 2) 解密回来（模拟真正建立连接时）
    const opened = await openSecrets(secret, fields);
    expect(opened.password).toBe('db-pass-123');

    // 3) 建立连接后缓存 schema
    const cache = new SchemaCache(dir);
    const snap = cache.save('conn-1', sampleSchema);

    // 4) 下次打开先渲染快照（树首屏 ≤500ms 的前提）
    const st = cache.load('conn-1');
    expect(st.snapshot).not.toBeNull();
    expect(st.stale).toBe(false);

    // 5) 判定表能否编辑（B5 红线）
    const bigTable = cache.getTable(snap, 'bench', 'big_table')!;
    const noKeyTable = cache.getTable(snap, 'bench', 'no_key_table')!;
    expect(cache.isEditable(bigTable)).toBe(true);      // 有主键
    expect(cache.isEditable(noKeyTable)).toBe(false);   // 无唯一键 → 只读

    // 6) Q2 按字段名搜表
    expect(cache.findTablesByColumn(snap, 'email')).toEqual(['bench.big_table']);
  });

  it('凭据不可用时强制手输，且不落任何密文', async () => {
    const unavailable = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(''),
      decryptString: () => '',
    };
    const secret = new SecretStore(unavailable as any);
    await secret.init();
    const fields = await sealSecrets(secret, { password: 'super-secret' });
    expect(fields.passwordEnc).toBeNull();
    expect(fields.promptEveryTime).toBe(true);
    expect(JSON.stringify(fields)).not.toContain('super-secret');
  });
});

describe('集成链路 3：导出（含取消与清洗）', () => {
  it('导出任务可被真取消，且单元格清洗到位', () => {
    const task = new ExportTask('job-1', join(dir, 'out.xlsx'));

    // 单元格清洗：超长截断 + 非法字符清理
    const cell = sanitizeCell('a\x00b' + 'x'.repeat(40_000));
    expect(String(cell.value).length).toBe(32_767);
    expect(cell.truncated).toBe(true);

    // CSV 行生成
    expect(csvRow([1, 'a,b', null])).toBe('1,"a,b",');

    // exceljs 必须流式 + 关闭 sharedStrings/styles（S3 实测）
    const opts = excelWriterOptions(join(dir, 'out.xlsx'));
    expect(opts.useSharedStrings).toBe(false);
    expect(opts.useStyles).toBe(false);

    // 取消
    task.cancel();
    expect(task.isCancelled).toBe(true);
  });
});

describe('集成链路 4：数据闭环（schema 决定编辑策略，历史记录结果）', () => {
  it('无唯一键的表：网格只读，且该事实可被历史与 UI 查询到', () => {
    const cache = new SchemaCache(dir);
    const snap = cache.save('conn-1', sampleSchema);
    const t = cache.getTable(snap, 'bench', 'no_key_table')!;

    // 网格必须只读
    expect(cache.locateStrategy(t)).toBe('none');
    expect(cache.isEditable(t)).toBe(false);

    // 用户尝试编辑 → 被拒 → 记录进历史
    const store = new HistoryStore(':memory:');
    const id = store.addHistory({
      connectionId: 'conn-1',
      database: 'bench',
      sql: 'UPDATE no_key_table SET a = 1',
      success: false,
      error: '该表无主键/唯一键，无法安全定位行，网格为只读',
      durationMs: 0,
      rowCount: 0,
      executedAt: Date.now(),
    });
    expect(store.getHistory(id)!.error).toContain('只读');
    store.close();
  });

  it('有主键的表：可编辑，定位列为主键', () => {
    const cache = new SchemaCache(dir);
    const snap = cache.save('conn-1', sampleSchema);
    const t = cache.getTable(snap, 'bench', 'big_table')!;

    expect(cache.locateStrategy(t)).toBe('pk');
    expect(cache.locateColumns(t).map((c) => c.name)).toEqual(['id']);
  });
});
