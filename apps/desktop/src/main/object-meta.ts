/**
 * 对象元数据查询 —— C2（定义查看）/ C9+A14（表信息、估算行数）的主进程实现。
 *
 * R1 并行研发契约：本模块由「模式/驱动层」子代理填充实现（driver → session → 这里）。
 * 两个函数保持桩阶段的签名不变（ipc-handlers 已注册调用它们），实现转发到
 * session 层：驱动层做 SHOW CREATE 的列名适配与 information_schema 映射，
 * 会话层做状态机推进（busy/断线）与错误归类（NOT_CONNECTED / NOT_FOUND / BUSY），
 * 这里只做桥接 —— 不再有自己的逻辑。
 *
 * 🔴 两条硬要求（落点在驱动与会话层，这里复述以便评审）：
 *  1. getTableInfo 只查 information_schema.TABLES 一行（估算行数），
 *     【绝不做 SELECT COUNT(*)】—— 千万行表上精确 COUNT 会拖死「最快查看器」。
 *  2. getObjectDdl 的对象类型（DbObjectKind）与 core-schema-cache 的 ObjectKind
 *     结构一致（含 trigger/event）；trigger/event 的 DDL 列名不同
 *     （SQL Original Statement / Create Event），适配在 core-driver-mysql。
 */

import type { SessionRegistry } from './session-registry.js';
import { type ObjectDdlRequest, type ObjectDdlResult, type TableInfoRequest, type TableInfoDto } from '../shared/ipc-channels.js';

export async function getObjectDdl(sessions: SessionRegistry, req: ObjectDdlRequest): Promise<ObjectDdlResult> {
  // ObjectKind（core-schema-cache）与 DbObjectKind（shared）是同一联合类型的两份定义，
  // 结构一致可直接互转；req 里多出的 connId 是会话层需要的入参
  return sessions.getObjectDdl(req.connId, req);
}

export async function getTableInfo(sessions: SessionRegistry, req: TableInfoRequest): Promise<TableInfoDto> {
  // 驱动层 TableInfo 与共享 TableInfoDto 字段一一对应（全可空），直接透传
  return sessions.getTableInfo(req.connId, req);
}
