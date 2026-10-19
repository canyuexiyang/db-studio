/**
 * 列头 → 条件条的桥（T24「列头快筛」）。
 *
 * ## 为什么是 context 而不是 DataGrid 的 prop
 *
 * 列头右键菜单由 `DataGrid` 渲染（`HeaderContextMenu` 是它的子组件），而
 * 「按此列加筛选」需要的是**宿主的 tab 上下文**（`tab.filter` / 表元数据 /
 * 重查链路）—— 只有 `TablePane` 有。让 DataGrid 透传一个新 prop 意味着动
 * DataGrid 的 props 面，而它这次不在改动范围内。
 *
 * React context 天然穿透中间层：TablePane 提供、DataGrid 原样渲染、
 * HeaderContextMenu 消费，DataGrid 一行都不用改。
 *
 * ## 为什么「没接桥」必须是禁用而不是静默 no-op
 *
 * 同一个 HeaderContextMenu 也被**查询结果网格**使用（SQL 编辑器的结果集），
 * 那里没有表元数据、也没有筛选真值 —— 「按此列筛选」点了不会有任何效果。
 * 所以 `useHeaderFilterBridge()` 返回 null 时菜单项一律 `disabled` 并写明原因
 * （项目红线：看起来可点就必须有真实回调，做不到就禁用 + 中文原因）。
 */

import { createContext, useContext } from 'react';

export type ColumnFilterMode = 'single' | 'in';

export interface HeaderFilterCapability {
  /** 能否做单值快筛（等于 / 包含 / 为空……） */
  canSingle: boolean;
  /** 能否做单列多值 IN */
  canIn: boolean;
  /** 做不到时的中文原因（做得到时为空串） */
  reason: string;
}

export interface HeaderFilterBridge {
  /** 按列名查能力（TablePane 持有列元数据，由它判） */
  capability: (column: string) => HeaderFilterCapability;
  /** 打开「按此列筛选」浮层并预选该列 */
  openColumnFilter: (column: string, mode: ColumnFilterMode) => void;
}

export const HeaderFilterContext = createContext<HeaderFilterBridge | null>(null);

/** 没有宿主接入时返回 null —— 调用方据此把入口置灰，绝不做静默 no-op */
export function useHeaderFilterBridge(): HeaderFilterBridge | null {
  return useContext(HeaderFilterContext);
}

/** 菜单在「没接桥」时用的兜底能力描述（纯展示，无回调） */
export const NO_BRIDGE_CAPABILITY: HeaderFilterCapability = {
  canSingle: false,
  canIn: false,
  reason: '当前网格没有接入表筛选链路（查询结果网格没有可筛选的表列）',
};
