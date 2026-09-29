import { describe, it, expect } from 'vitest';
import { quoteIdentifier, quoteQualified, joinIdentifiers, insertTemplate, IdentifierError } from './index.js';

describe('标识符转义', () => {
  it('普通名字加反引号', () => {
    expect(quoteIdentifier('order')).toBe('`order`');
  });

  it('内部反引号加倍（这是唯一的转义方式）', () => {
    expect(quoteIdentifier('we`ird')).toBe('`we``ird`');
  });

  it('保留字也能安全使用', () => {
    expect(quoteIdentifier('select')).toBe('`select`');
  });

  it('空名字 / 超长 / 含 NUL 一律拒绝', () => {
    expect(() => quoteIdentifier('')).toThrow(IdentifierError);
    expect(() => quoteIdentifier('a'.repeat(65))).toThrow(/上限/);
    expect(() => quoteIdentifier('a\0b')).toThrow(/NUL/);
  });

  it('64 字符是边界，刚好可用', () => {
    expect(quoteIdentifier('a'.repeat(64)).length).toBe(66);
  });
});

describe('限定名', () => {
  it('db.table 逐段转义', () => {
    expect(quoteQualified('db.tbl')).toBe('`db`.`tbl`');
    expect(quoteQualified(['db', 'tbl'])).toBe('`db`.`tbl`');
  });

  it('空段拒绝（"db." 这种格式错误）', () => {
    expect(() => quoteQualified('db.')).toThrow(IdentifierError);
    expect(() => quoteQualified([])).toThrow(IdentifierError);
  });
});

describe('列列表', () => {
  it('默认逗号分隔', () => {
    expect(joinIdentifiers(['a', 'b'])).toBe('`a`, `b`');
  });

  it('可指定分隔符', () => {
    expect(joinIdentifiers(['a', 'b'], ' AND ')).toBe('`a` AND `b`');
  });
});

describe('insertTemplate（C3 生成 INSERT 模板）', () => {
  it('带库：库表列全部转义，值用 ? 占位，尾带换行', () => {
    expect(
      insertTemplate('app_db', 'order', [{ name: 'id' }, { name: 'amount' }]),
    ).toBe('INSERT INTO `app_db`.`order` (`id`, `amount`) VALUES (?, ?);\n');
  });

  it('不带库：只限表名', () => {
    expect(insertTemplate(null, 't', [{ name: 'a' }])).toBe(
      'INSERT INTO `t` (`a`) VALUES (?);\n',
    );
  });

  it('特殊字符表名/列名：反引号加倍，注入无法逃逸', () => {
    const out = insertTemplate('d`b', 't`bl', [{ name: 'c`; DROP TABLE x; --' }]);
    // 内部反引号全部加倍 —— 拼出来仍是合法的引用名，不产生未转义的反引号边界
    expect(out).toBe(
      'INSERT INTO `d``b`.`t``bl` (`c``; DROP TABLE x; --`) VALUES (?);\n',
    );
  });

  it('空列返回空串（生成 () VALUES () 只会误导）', () => {
    expect(insertTemplate('db', 't', [])).toBe('');
  });

  it('空表名等非法标识符直接抛错（fail-closed）', () => {
    expect(() => insertTemplate(null, '', [{ name: 'a' }])).toThrow(IdentifierError);
  });
});
