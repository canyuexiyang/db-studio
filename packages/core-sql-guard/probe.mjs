import pkg from 'node-sql-parser';
const { Parser } = pkg;
const p = new Parser();
const cases = [
  ['SELECT * FROM t', 'MySQL'],
  ['SELECT 1; DROP TABLE t', 'MySQL'],
  ['CALL some_proc()', 'MySQL'],
  ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'MySQL'],
  ['SELECT * FROM t FOR UPDATE', 'MySQL'],
  ['SET autocommit=0', 'MySQL'],
  ['SET NAMES utf8mb4', 'MySQL'],
  ['TRUNCATE TABLE t', 'MySQL'],
  ['DELETE FROM t WHERE id=1', 'MySQL'],
  ['UPDATE t SET a=1', 'MySQL'],
  ['CREATE TEMPORARY TABLE x (id INT)', 'MySQL'],
  ['SHOW TABLES', 'MySQL'],
  ['DESCRIBE t', 'MySQL'],
  ['EXPLAIN SELECT * FROM t', 'MySQL'],
  ['USE db1', 'MySQL'],
  ['SELECT update_time FROM t', 'MySQL'],
  ["SELECT * FROM t WHERE name='delete'", 'MySQL'],
  ['WITH x AS (SELECT 1) UPDATE t SET a=1', 'PostgreSQL'],
  ['SELCT * FROM', 'MySQL'],
  ['SELECT * FROM t; SELECT 2', 'MySQL'],
];

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

for (const [sql, db] of cases) {
  try {
    const ast = p.astify(sql, { database: db });
    if (Array.isArray(ast)) {
      console.log('[MULTI] ' + pad(sql.slice(0, 42), 44) + ' -> ' + ast.map((a) => a.type).join(', '));
    } else {
      console.log('[' + pad(ast.type, 10) + '] ' + pad(sql.slice(0, 42), 44) + ' keys=' + Object.keys(ast).slice(0, 10).join('|'));
    }
  } catch (e) {
    console.log('[ERROR  ] ' + pad(sql.slice(0, 42), 44) + ' -> ' + e.message.slice(0, 70));
  }
}

// 深挖 SELECT 的 into / lock 字段
console.log('\n--- SELECT 写副作用字段探测 ---');
for (const sql of ['SELECT * FROM t', "SELECT * FROM t INTO OUTFILE '/tmp/x'", 'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t LOCK IN SHARE MODE']) {
  try {
    const ast = p.astify(sql, { database: 'MySQL' });
    console.log(sql.slice(0, 42).padEnd(44) + ' into=' + JSON.stringify(ast.into) + ' lock=' + JSON.stringify(ast.lock) + ' options=' + JSON.stringify(ast.options));
  } catch (e) {
    console.log(sql.slice(0, 42).padEnd(44) + ' ERROR ' + e.message.slice(0, 50));
  }
}

// SET 内部结构
console.log('\n--- SET 结构探测 ---');
for (const sql of ['SET NAMES utf8mb4', 'SET autocommit=0', 'SET SESSION time_zone="+00:00"', 'SET @@global.read_only=1']) {
  try {
    const ast = p.astify(sql, { database: 'MySQL' });
    console.log(sql.slice(0, 40).padEnd(42) + ' -> ' + JSON.stringify(ast).slice(0, 220));
  } catch (e) {
    console.log(sql.slice(0, 40).padEnd(42) + ' -> ERROR ' + e.message.slice(0, 50));
  }
}
