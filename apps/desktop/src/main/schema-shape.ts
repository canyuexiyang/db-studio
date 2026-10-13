/**
 * schema 形状比对 —— 判定「后台回源拿到的结构与手上这份是否真的不同」。
 *
 * 为什么要它：v0.6.0 修「刷新失效」时给快照路径接上了后台回源，
 * 但回源是**每次**连接后都会跑的。没有这道闸，introspect 每轮都会推送，
 * 渲染层每次都要重建整棵树（一个库几百张表 = 上千节点）——
 * 「反应最快」是这个产品的立基点，不能为了正确性牺牲它。
 *
 * 判定口径（刻意只比"用户看得见的形状"，不比统计值）：
 *  - 库名集合
 *  - 每个库下 `表名 + 类别` 的**有序**列表
 *
 * 🔴 为什么不比 TABLE_ROWS 等统计值：`information_schema` 里 InnoDB 的行数是
 *   估算值，同一份库两次 introspect 可以给出不同数字。把它算进"变化"会导致
 *   每次回源都推送，等于闸门失效。
 *
 * 🔴 为什么不比列定义：列级比对意味着每次都要深遍历全部列（几百表 × 几十列），
 *   本身就不便宜；而"新建/删除表"才是用户能感知、也是这个缺陷的原始诉求。
 *   列定义的增删跟着表走 —— 表没变就不需要重渲染整棵树。
 *   （若将来需要，改这里时应单独评估成本，而不是顺手加进去。）
 */

import type { DatabaseMeta } from '@dbstudio/core-schema-cache';

/** 单库内「表名 + 类别」的有序指纹 —— 空库返回空串 */
function shapeOfDatabase(db: DatabaseMeta): string {
  return db.tables.map((t) => `${t.name}\u0000${t.kind}`).join('\u0001');
}

/** 全部库的形状指纹：库名 + 各自形状，用不可能出现在库名里的分隔符隔开 */
function shapeOfAll(dbs: DatabaseMeta[] | null | undefined): string {
  return (dbs ?? []).map((db) => `${db.name}\u0000${shapeOfDatabase(db)}`).join('\u0002');
}

/**
 * 结构是否变化。
 *
 * @param before 手上那份（快照或上次 introspect 的结果）
 * @param after  本次回源的���果
 * @returns true = 形状不同，调用方应推送更新
 */
export function schemaShapeChanged(
  before: DatabaseMeta[] | null | undefined,
  after: DatabaseMeta[] | null | undefined,
): boolean {
  return shapeOfAll(before) !== shapeOfAll(after);
}