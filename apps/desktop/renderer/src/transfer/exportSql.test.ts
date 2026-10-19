import { describe, it, expect } from 'vitest';
import { buildColumnScopedExportSql, buildFilteredExportSql } from './exportSql';

describe('buildFilteredExportSql · 标识符走 core-sql-ident（T07/R08）', () => {
  it('普通库/表名加反引号', () => {
    expect(buildFilteredExportSql('order_db', 'orders', '`id` > 10'))
      .toBe('SELECT * FROM `order_db`.`orders` WHERE `id` > 10');
  });

  it('🔴 名字含反引号时内部反引号加倍（手拼会拼出语法错误的 SQL）', () => {
    expect(buildFilteredExportSql('we`ird', 'ta`ble', '1=1'))
      .toBe('SELECT * FROM `we``ird`.`ta``ble` WHERE 1=1');
  });

  it('名字含空格与 Unicode 原样包进反引号', () => {
    expect(buildFilteredExportSql('my db', '订单表', '`a` = 1'))
      .toBe('SELECT * FROM `my db`.`订单表` WHERE `a` = 1');
  });

  it('空 WHERE（含纯空白）返回 null —— 无筛选不重建 SQL', () => {
    expect(buildFilteredExportSql('d', 't', '')).toBeNull();
    expect(buildFilteredExportSql('d', 't', '   ')).toBeNull();
  });

  it('非法标识符（空名 / 含 NUL）抛错而不是拼出错误 SQL', () => {
    expect(() => buildFilteredExportSql('', 't', '1=1')).toThrow();
    expect(() => buildFilteredExportSql('d', 'a\0b', '1=1')).toThrow();
  });
});

describe('buildColumnScopedExportSql · 仅可见列（T40）', () => {
  it('显式列清单 + 筛选：列顺序即输出顺序', () => {
    expect(buildColumnScopedExportSql('d', 't', '`id` > 1', ['id', 'name']))
      .toBe('SELECT `id`, `name` FROM `d`.`t` WHERE `id` > 1');
  });

  it('无筛选时不带 WHERE（与 buildFilteredExportSql 的 null 语义不同：这里必须给出可执行 SQL）', () => {
    expect(buildColumnScopedExportSql('d', 't', '   ', ['id']))
      .toBe('SELECT `id` FROM `d`.`t`');
  });

  it('🔴 列名含反引号时加倍，不当成 SQL 片段', () => {
    expect(buildColumnScopedExportSql('d', 't', '', ['we`ird']))
      .toBe('SELECT `we``ird` FROM `d`.`t`');
  });

  it('列清单为空 / 列名非法时抛错，不拼出 SELECT  FROM', () => {
    expect(() => buildColumnScopedExportSql('d', 't', '', [])).toThrow('没有可导出的列');
    expect(() => buildColumnScopedExportSql('d', 't', '', ['a\0b'])).toThrow();
  });
});
