import { describe, it, expect } from 'vitest';
import { checkDdlStatement, checkMutationStatement } from './index.js';

const M = 'mysql' as const;

/**
 * 0.7.3：DDL 入口对「库里真会这么拼的语句」到底收不收。
 *
 * 这组测试的存在理由：0.7.3 的四个新入口（建库 / 删库 / 重命名表 / 复制表 / 表维护）
 * 全部走同一个 `mutationApply(mode:'ddl')` 通道，构造语句的是 `ddlTemplates.ts`。
 * 「SQL 文本看起来对」和「守卫放它过」是两件事 —— 实测 node-sql-parser 5.4.0
 * **不认**带反引号的 `DROP DATABASE`、也不认 `OPTIMIZE/ANALYZE/CHECK TABLE`。
 * 如果只写渲染层单测，这四个功能会到真机上才炸（而且是「点了没反应」的形态）。
 *
 * 🔴 乐观用例必须与 `ddlTemplates.ts` 生成的**原文形态**逐字一致：
 *    构造器改了拼接方式而这里没跟着改，等于测试在验证一段没人发的 SQL。
 */
describe('0.7.3 DDL 入口：对象生命周期的语句能被放行', () => {
  const allowed: Array<[string, string]> = [
    // P0-19 新建库
    ['CREATE DATABASE `order_archive`', 'create'],
    ['CREATE DATABASE `order_archive` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci', 'create'],
    // P0-20 删除库 —— 带反引号这一形态解析器过不去，走文本兜底
    ['DROP DATABASE `order_archive`', 'drop'],
    ['DROP SCHEMA `order_archive`', 'drop'],
    ['DROP DATABASE order_archive', 'drop'],
    // P1-22 重命名表
    ['RENAME TABLE `order_db`.`t1` TO `order_db`.`t2`', 'rename'],
    // P2-28 复制表（结构 / 结构+数据）
    ['CREATE TABLE `order_db`.`t_copy` LIKE `order_db`.`t`', 'create'],
    // P2-27 表维护
    ['OPTIMIZE TABLE `order_db`.`t`', 'maintenance'],
    ['ANALYZE TABLE `order_db`.`t`', 'maintenance'],
    ['CHECK TABLE `order_db`.`t`', 'maintenance'],
    ['OPTIMIZE NO_WRITE_TO_BINLOG TABLE `order_db`.`t`', 'maintenance'],
  ];

  for (const [sql, type] of allowed) {
    it(`放行：${sql}`, () => {
      const r = checkDdlStatement(sql, M);
      expect(r.allowed, r.message).toBe(true);
      expect(r.statementType).toBe(type);
    });
  }

  /**
   * 复制表的第二条数据语句走的是**写语句**链路（不是 ddl）。
   * 它必须能过 —— 否则「勾了带数据」的复制会在第二步才失败。
   */
  it('复制表的数据语句（INSERT … SELECT）能过写语句白名单', () => {
    const r = checkMutationStatement('INSERT INTO `order_db`.`t_copy` SELECT * FROM `order_db`.`t`', M);
    expect(r.allowed, r.message).toBe(true);
  });
});

/**
 * 反向用例 —— 兜底只有「更窄」才有意义。
 * 每一条都是有人真的会尝试的注入/误拼接形态；任何一个被放行，兜底就等于开了后门。
 */
describe('0.7.3 DDL 入口：文本兜底不能成为绕过口', () => {
  const rejected: Array<[string, string]> = [
    ['分号拼第二条 DROP', 'DROP DATABASE `a`; DROP TABLE `b`'],
    ['分号拼第二条 DELETE', 'DROP DATABASE `a`; DELETE FROM `b`'],
    ['维护语句后面接写语句', 'OPTIMIZE TABLE `a`; DELETE FROM `a`'],
    ['可执行注释里藏语句', 'DROP DATABASE `a` /*!50000 ; DROP TABLE `b` */'],
    ['维护语句 + 可执行注释', 'OPTIMIZE TABLE `a` /*!50000 , (SELECT 1) */'],
    ['缺库名', 'DROP DATABASE'],
    ['缺表名', 'OPTIMIZE TABLE'],
    ['不认识的前缀', 'SET GLOBAL max_connections = 1000'],
    ['维护语句后接额外 token', 'OPTIMIZE TABLE `a` EXTENDED'],
    ['库名带引号注入', 'DROP DATABASE `a` OR 1=1'],
  ];

  for (const [label, sql] of rejected) {
    it(`拒绝：${label}`, () => {
      const r = checkDdlStatement(sql, M);
      expect(r.allowed, `意外放行：${sql}`).toBe(false);
    });
  }
});

/**
 * 兜底不能顺手改变**已能解析**语句的判定：
 * `SELECT` / `INSERT` 依旧不许从 DDL 入口执行（哪怕它看起来无害）。
 */
describe('0.7.3 DDL 入口：白名单没有被兜底放宽', () => {
  for (const sql of ['SELECT * FROM `t`', 'INSERT INTO `t` VALUES (1)', 'UPDATE `t` SET a = 1 WHERE id = 1']) {
    it(`仍然拒绝非 DDL：${sql}`, () => {
      expect(checkDdlStatement(sql, M).allowed).toBe(false);
    });
  }
});
