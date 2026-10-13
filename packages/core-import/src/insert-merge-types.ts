/**
 * insert-merge 的类型定义（零运行时依赖）。
 *
 * 与实现（runtime.cjs）一一对应。单独成文件是为了让 insert-merge.ts
 * 能`import type` 它而不把 runtime 拉进类型推导。
 */

export interface InsertShape {
  /** 是否是可合并的 INSERT */
  mergeable: boolean;
  /** 库（空串 = 未限定） */
  database: string;
  /** 表名（小写） */
  table: string;
  /** 列清单（小写、去引号），用于判等 */
  columns: string[];
  /** VALUES 子句的内容（已 trim），拼接时直接取用 */
  valuesClause: string;
}