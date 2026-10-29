/**
 * 0.7.3 对象生命周期 DDL 的纯逻辑单测。
 *
 * 断言纪律（与项目既有单测同口径）：
 *  - 每条「会拼出 X」都配一条「错误输入必须被拒」——只测正例等于没测校验；
 *  - 标识符相关断言看的是**反引号包裹 + 内部反引号加倍**，这是注入面最后一道；
 *  - 模板类断言钉「单条语句」这一条约束（有 `;` 只能有一个且在末尾）。
 */

import { describe, it, expect } from 'vitest';
import {
  buildCopyTableSql,
  buildCreateDatabaseSql,
  buildDropDatabaseSql,
  buildMaintenanceSql,
  buildObjectTemplate,
  buildRenameTableSql,
  defaultCollationOf,
  toCreateOrReplaceView,
  validateBareToken,
  validateNewName,
  MAX_IDENT_LEN,
} from './ddlTemplates';

describe('对象名校验：先拒错，再谈通过', () => {
  it('空 / 纯空白一律拒，且文案说出「不能为空」', () => {
    for (const raw of ['', '   ']) {
      const r = validateNewName(raw, { label: '库名' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('库名不能为空');
    }
  });

  it('超长（> 64）拒绝并给出上限', () => {
    const r = validateNewName('a'.repeat(MAX_IDENT_LEN + 1), { label: '表名' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(String(MAX_IDENT_LEN));
    // 对照：正好 64 是合法的（边界不是「<」）
    expect(validateNewName('a'.repeat(MAX_IDENT_LEN)).ok).toBe(true);
  });

  it('含 . / : 会被拒（它们在本产品里有结构含义）', () => {
    expect(validateNewName('a.b').error).toContain('英文句点');
    expect(validateNewName('a:b').error).toContain('冒号');
    expect(validateNewName('a/b').error).toContain('斜杠');
    // 对照：普通中英文名字合法
    expect(validateNewName('订单归档 2026').ok).toBe(true);
  });

  it('重名检查大小写不敏感（MySQL 在 macOS 上常见大小写不敏感）', () => {
    const r = validateNewName('Orders', { existing: ['orders', 'user'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已存在同名对象');
    // 对照：不同的名字通过
    expect(validateNewName('order_items', { existing: ['orders'] }).ok).toBe(true);
  });

  it('首尾空白被归一后再判（「 x 」等于「x」）', () => {
    expect(validateNewName('  x  ')).toMatchObject({ ok: true, value: 'x' });
  });
});

describe('CREATE / DROP DATABASE', () => {
  it('只拼库名 → 不带字符集子句', () => {
    expect(buildCreateDatabaseSql({ name: 'demo_db' })).toBe('CREATE DATABASE `demo_db`;');
  });

  it('字符集 + 排序规则会进 SQL，且不替用户补默认值', () => {
    expect(
      buildCreateDatabaseSql({ name: 'demo', charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }),
    ).toBe('CREATE DATABASE `demo` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;');
    // 只给字符集时不拼 COLLATE（让服务端用自己的默认）
    expect(buildCreateDatabaseSql({ name: 'demo', charset: 'utf8mb4' })).toBe(
      'CREATE DATABASE `demo` CHARACTER SET utf8mb4;',
    );
  });

  it('🔴 非法字符集/排序规则被拒（这俩是裸值，必须过白名单）', () => {
    expect(() => buildCreateDatabaseSql({ name: 'd', charset: 'utf8mb4; DROP DATABASE x' })).toThrow(/字符集/);
    expect(() => buildCreateDatabaseSql({ name: 'd', charset: 'utf8mb4', collation: 'a`b' })).toThrow(/排序规则/);
    // 只给排序规则不给字符集 → 语义不完整，拒
    expect(() => buildCreateDatabaseSql({ name: 'd', collation: 'utf8mb4_general_ci' })).toThrow(/字符集/);
  });

  it('名字里的反引号被加倍转义（不是直接拼进 SQL）', () => {
    expect(buildCreateDatabaseSql({ name: 'we`ird' })).toBe('CREATE DATABASE `we``ird`;');
  });

  it('DROP DATABASE 走同一个标识符转义', () => {
    expect(buildDropDatabaseSql('demo')).toBe('DROP DATABASE `demo`;');
    expect(buildDropDatabaseSql('we`ird')).toBe('DROP DATABASE `we``ird`;');
    expect(() => buildDropDatabaseSql('  ')).toThrow(/库名不能为空/);
  });

  it('裸值校验：空值只在 required 时报错', () => {
    expect(validateBareToken('', '字符集')).toBeNull();
    expect(validateBareToken('', '字符集', { required: true })).toContain('不能为空');
    expect(validateBareToken('utf8mb4-1', '字符集')).toContain('只能包含字母');
  });
});

describe('RENAME / COPY / 维护', () => {
  it('RENAME TABLE 库名保持原样、新名走校验', () => {
    expect(buildRenameTableSql('shop', 'orders', 'orders_2025')).toBe(
      'RENAME TABLE `shop`.`orders` TO `shop`.`orders_2025`;',
    );
    expect(() => buildRenameTableSql('shop', 'orders', 'orders.2025')).toThrow(/英文句点/);
  });

  it('复制表：不带数据只有一条 CREATE … LIKE', () => {
    const sql = buildCopyTableSql({ database: 'shop', table: 'orders', newTable: 'orders_copy', withData: false });
    expect(sql).toEqual(['CREATE TABLE `shop`.`orders_copy` LIKE `shop`.`orders`;']);
  });

  it('复制表：带数据是两条（CREATE + INSERT … SELECT），顺序不能反', () => {
    const sql = buildCopyTableSql({ database: 'shop', table: 'orders', newTable: 'orders_copy', withData: true });
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('CREATE TABLE');
    expect(sql[1]).toBe('INSERT INTO `shop`.`orders_copy` SELECT * FROM `shop`.`orders`;');
  });

  it('复制表到别的库：两条语句都指向目标库', () => {
    const sql = buildCopyTableSql({
      database: 'shop',
      table: 'orders',
      newTable: 'orders_copy',
      targetDatabase: 'archive',
      withData: true,
    });
    expect(sql[0]).toBe('CREATE TABLE `archive`.`orders_copy` LIKE `shop`.`orders`;');
    expect(sql[1]).toBe('INSERT INTO `archive`.`orders_copy` SELECT * FROM `shop`.`orders`;');
  });

  it('复制表的重名/非法名被拒（不会把脏名字发到服务端）', () => {
    expect(() =>
      buildCopyTableSql({ database: 'shop', table: 'orders', newTable: 'a b', withData: true }),
    ).not.toThrow(); // 空格本身合法（标识符允许空格）
    expect(() =>
      buildCopyTableSql({ database: 'shop', table: 'orders', newTable: 'a/b', withData: true }),
    ).toThrow(/斜杠/);
  });

  it('维护语句三件套：动词正确、表名转义', () => {
    expect(buildMaintenanceSql('shop', 'orders', 'optimize')).toBe('OPTIMIZE TABLE `shop`.`orders`;');
    expect(buildMaintenanceSql('shop', 'orders', 'analyze')).toBe('ANALYZE TABLE `shop`.`orders`;');
    expect(buildMaintenanceSql('shop', 'orders', 'check')).toBe('CHECK TABLE `shop`.`orders`;');
  });
});

describe('新建对象模板：单条语句 = 编辑器能直接执行', () => {
  const kinds = ['view', 'procedure', 'function', 'trigger', 'event'] as const;

  it('每个模板都只有末尾一个分号（BEGIN…END 会被 splitStatements 切碎）', () => {
    for (const kind of kinds) {
      const sql = buildObjectTemplate(kind, 'shop');
      const semis = sql.split(';').length - 1;
      expect(semis, `${kind} 的分号数量`).toBe(1);
      expect(sql.trimEnd().endsWith(';'), `${kind} 必须以分号收尾`).toBe(true);
      // 不许出现块体关键字（那正是会被切碎的形态）
      expect(/\bBEGIN\b/i.test(sql), `${kind} 不应含 BEGIN`).toBe(false);
    }
  });

  it('模板带上库名与占位名，且都经过反引号转义', () => {
    const view = buildObjectTemplate('view', 'sh`op');
    expect(view).toContain('`sh``op`.`new_view`');
    // 占位名可以覆盖（用户在想好名字时也能直接传）
    expect(buildObjectTemplate('view', 'shop', 'v_ip')).toContain('`shop`.`v_ip`');
  });

  it('五类关键字各自正确（防止模板之间复制粘贴串味）', () => {
    expect(buildObjectTemplate('view', 's')).toContain('CREATE VIEW');
    expect(buildObjectTemplate('procedure', 's')).toContain('CREATE PROCEDURE');
    expect(buildObjectTemplate('function', 's')).toContain('CREATE FUNCTION');
    expect(buildObjectTemplate('trigger', 's')).toContain('CREATE TRIGGER');
    expect(buildObjectTemplate('event', 's')).toContain('CREATE EVENT');
  });
});

describe('视图定义 → CREATE OR REPLACE（P2-30 缓解）', () => {
  it('普通 CREATE VIEW 加上 OR REPLACE，并补回分号', () => {
    expect(toCreateOrReplaceView('CREATE VIEW `v` AS select 1')).toBe(
      'CREATE OR REPLACE VIEW `v` AS select 1;',
    );
  });

  it('带修饰子句（ALGORITHM/DEFINER/SQL SECURITY）时插在 CREATE 之后', () => {
    const ddl =
      "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1";
    expect(toCreateOrReplaceView(ddl)).toBe(
      "CREATE OR REPLACE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1;",
    );
  });

  it('已经是 OR REPLACE 的不叠第二遍（叠了就是语法错误）', () => {
    const out = toCreateOrReplaceView('CREATE OR REPLACE VIEW `v` AS select 1;');
    expect(out).toBe('CREATE OR REPLACE VIEW `v` AS select 1;');
    expect(out?.match(/OR REPLACE/gi)).toHaveLength(1);
  });

  it('前置注释不影响识别（SHOW CREATE 的注释头 / demo 占位）', () => {
    const out = toCreateOrReplaceView('-- 说明\n# 另一行\nCREATE VIEW `v` AS select 1');
    expect(out).toContain('-- 说明');
    expect(out).toContain('CREATE OR REPLACE VIEW `v`');
  });

  it('不是 CREATE 语句 → null（demo 占位不能伪装成可编辑模板）', () => {
    expect(toCreateOrReplaceView('-- demo 模式：view shop.v 的定义\nSHOW CREATE 在浏览器 demo 下不可用')).toBeNull();
    expect(toCreateOrReplaceView('   ')).toBeNull();
  });
});

describe('字符集候选', () => {
  it('默认排序规则来自候选表第一项；未知字符集返回空串（不瞎猜）', () => {
    expect(defaultCollationOf('utf8mb4')).toBe('utf8mb4_0900_ai_ci');
    expect(defaultCollationOf('nope')).toBe('');
  });
});
