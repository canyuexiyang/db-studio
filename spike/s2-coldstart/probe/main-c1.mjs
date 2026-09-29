// C1 朴素版（反面基线）：所有重型依赖在启动路径上【同步 require】，
// 模拟「不做懒加载」的最坏情况。这里的 require 发生在 marks.moduleTop 之后、
// app.whenReady() 回调之前，因此全部计入 moduleTop→whenReady 阶段。
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite'; // 内置历史库（也故意在启动路径打开）
import { startApp } from './timing.mjs';

const require = createRequire(import.meta.url);

// 驱动：原生模块 + 大 JS 解析（最大的一块，主进程侧）
const mysql2 = require('mysql2');
const pg = require('pg');
const ssh2 = require('ssh2');
// 历史库：本应在首屏渲染完成后再开（node:sqlite 内置）
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE probe_history(id INTEGER PRIMARY KEY, sql TEXT)');

// 触发一点实际引用，避免被死代码消除
const _refs = [
  typeof mysql2.createConnection,
  typeof pg.Client,
  typeof ssh2.Client,
  db.prepare('INSERT INTO probe_history(id,sql) VALUES(?,?)'),
];
console.log('[S1-C1] eager deps loaded:', _refs.length);

startApp({ label: 'C1-eager' });
