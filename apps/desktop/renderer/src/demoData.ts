/**
 * Demo 数据集 —— 让 UI 可以独立于主进程开发。
 *
 * 接真数据时替换 `buildDemoPayload()` 的返回值即可，组件不用改。
 * 刻意造了 5 万行：网格必须在这个量级下验证"只解可视区"真的生效。
 */

import { encodeColumnar } from '@dbstudio/core-ipc-codec';import { buildTree, type TreeNode } from '@dbstudio/core-tree-view';
import type { TableMeta, ColumnMeta, DatabaseMeta } from '@dbstudio/core-schema-cache';
import type { PaletteItem } from '@dbstudio/core-command-palette';
import { defaultConnectionConfig, type ConnectionConfig } from '@dbstudio/core-connection';

function col(name: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
    ...over,
  };
}

export const DEMO_TABLE_META: TableMeta = {
  name: 'order',
  kind: 'table',
  comment: '订单表（demo）',
  estimatedRows: 12_450_000,
  engine: 'InnoDB',
  collation: 'utf8mb4_general_ci',
  /**
   * 🔴 每列都带 comment（缺陷 5 的验证靶子）：详情面板的字段区现在把注释
   * 常驻显示在第二行。demo 数据不带注释的话，e2e:ui 与浏览器 dev 模式下
   * 这块永远是空的 —— 改了样式却看不出效果，等于没验证。
   */
  columns: [
    col('id', { dataType: 'bigint', isPrimaryKey: true, autoIncrement: true, nullable: false, comment: '订单主键，自增' }),
    col('order_no', { dataType: 'varchar(32)', nullable: false, comment: '业务订单号，全局唯一' }),
    col('user_id', { dataType: 'bigint', nullable: false, comment: '下单用户 ID（关联 user.id）' }),
    col('amount', { dataType: 'decimal(12,2)', nullable: false, comment: '订单金额（元，含税）' }),
    col('status', { dataType: "enum('paid','unpaid','refunded')", nullable: false, comment: '支付状态：已付/未付/已退款' }),
    // T37：刻意用 datetime(6) 且**带微秒** —— 日期控件的保真断言需要一个会丢微秒的靶子
    col('created_at', { dataType: 'datetime(6)', nullable: false, comment: '下单时间（含微秒）' }),
    col('remark', { dataType: 'varchar(255)', comment: '买家备注，可为空' }),
  ],
};

const STATUSES = ['paid', 'unpaid', 'refunded'];

/** 造 rows。刻意让部分行为 NULL，用来验证 NULL 与空串的视觉区分 */
export function buildDemoPayload(n: number) {
  const rows: unknown[][] = new Array(n);
  for (let r = 0; r < n; r++) {
    rows[r] = [
      String(r + 1), // R10 副作用：BIGINT 也是字符串
      `NO${String(100000 + r)}`,
      String(1000 + (r % 900)),
      (r % 5000) === 0 ? null : ((r * 37) % 100000 / 100).toFixed(2),
      STATUSES[r % 3],
      // 微秒随行号递增，任何「过一遍 Date」的实现都会把它抹成 .000 或四舍五入到毫秒
      `2026-09-${String(1 + (r % 28)).padStart(2, '0')} 15:04:05.${String(r % 1_000_000).padStart(6, '0')}`,
      r % 17 === 0 ? null : r % 5 === 0 ? '' : `备注 ${r}`,
    ];
  }
  // 第三参传列定义 dataType：把数值列还原成真正的数值（R10 字符串化的逆操作）
  return encodeColumnar(
    rows,
    DEMO_TABLE_META.columns.map((c) => c.name),
    DEMO_TABLE_META.columns.map((c) => c.dataType),
  );
}

/**
 * 0.7.1：非结果集语句（UPDATE / INSERT / DELETE / DDL）的载荷。
 *
 * 真主进程对这类语句返回的是「0 列 0 行」的合法空载荷（MySQL 只回 OkPacket）。
 * demo 必须同形，否则「非结果集不画空网格」这条在 demo 上永远测不到。
 */
export function buildDemoEmptyPayload() {
  return encodeColumnar([], [], []);
}

/** demo 后端内存态：连接列表可被"新增/删除"改写，便于 UI 联动验证 */
export const DEMO_CONNECTIONS: ConnectionConfig[] = [
  { ...defaultConnectionConfig(), id: 'c1', name: 'prod_order', group: '生产环境', colorTag: 'red' as const, host: '127.0.0.1', port: 3306, user: 'root' },
  { ...defaultConnectionConfig(), id: 'c2', name: 'local_dev', group: '开发环境', colorTag: 'blue' as const, host: '127.0.0.1', port: 3306, user: 'root' },
];

/**
 * V8 宽表（40 列）—— 冻结列与横向滚动的真机验证靶子。
 *
 * 🔴 为什么必须单独造一张：`order` 只有 7 列（总宽 ~1000px），在 1440 视口里
 *    几乎滚不动，`scrollLeft = 600` 会被钳到 ~200px —— 「冻结列钉住了」
 *    和「根本没滚动」在断言里长得一样，等于没测。
 *    PRD 的验收口径是「宽表横向滚动可用性」，那就得真有一张宽表。
 *
 * 列名刻意带业务语义（metric_01…）而不是 col1…：转置视图（V12）的字段名列
 * 也要靠它验证「列名可读、类型可辨」。
 */
const WIDE_COLUMNS: ColumnMeta[] = [
  col('id', { dataType: 'bigint', isPrimaryKey: true, autoIncrement: true, nullable: false }),
  col('name', { dataType: 'varchar(64)', nullable: false }),
];
for (let i = 1; i <= 38; i++) {
  const n = String(i).padStart(2, '0');
  WIDE_COLUMNS.push(
    col(`metric_${n}`, {
      dataType: i % 3 === 0 ? 'varchar(32)' : i % 3 === 1 ? 'decimal(12,2)' : 'int',
      nullable: i % 5 === 0,
      comment: `宽表指标列 ${i}`,
    }),
  );
}

export const DEMO_WIDE_TABLE_META: TableMeta = {
  name: 'wide_metrics',
  kind: 'table',
  comment: '宽表（40 列，V8 冻结列 / V12 转置的验证靶子）',
  estimatedRows: 240_000,
  engine: 'InnoDB',
  collation: 'utf8mb4_general_ci',
  columns: WIDE_COLUMNS,
};

/** 宽表名（demoBackend 靠它路由到匹配的 payload） */
export const DEMO_WIDE_TABLE_NAME = DEMO_WIDE_TABLE_META.name;

/**
 * 造宽表 payload。
 *
 * 🔴 列数必须与 DEMO_WIDE_TABLE_META 一致 —— payload 与 TableMeta 不匹配时，
 *    网格会用 columns[39] 去读一个只有 7 列的 reader，值全是 null，
 *    而**不报错**（这是最难查的一类假绿）。
 * 行数刻意给 2000（不是 50000）：宽表的验证重点是横向，
 * 少一点行数让 e2e 打开更快，纵向虚拟滚动的压力测试已由 order 表覆盖。
 */
export function buildDemoWidePayload(n = 2000) {
  const rows: unknown[][] = new Array(n);
  for (let r = 0; r < n; r++) {
    const vals: unknown[] = [String(r + 1), `实体 ${r + 1}`];
    for (let i = 1; i <= 38; i++) {
      if (i % 3 === 0) vals.push(i % 7 === 0 ? null : `v${i}-${r % 100}`);
      else if (i % 3 === 1) vals.push(((r * 13 + i * 7) % 99999 / 100).toFixed(2));
      else vals.push((r + i) % 1000);
    }
    rows[r] = vals;
  }
  return encodeColumnar(
    rows,
    WIDE_COLUMNS.map((c) => c.name),
    WIDE_COLUMNS.map((c) => c.dataType),
  );
}

/**
 * C1：触发器/事件的 demo 形态 —— 也走 TableMeta，kind 用 ObjectKind 的
 * trigger/event 扩展（模式/驱动层已落地，core-tree-view 会为它们出
 * 「触发器/事件」类别容器）。触发器/事件没有列与行数：
 * columns 置空、estimatedRows/engine/collation 置 null。
 */
const DEMO_TRIGGER_META: TableMeta = {
  name: 'tr_order_after_update',
  kind: 'trigger',
  comment: '订单更新后同步汇总（demo）',
  estimatedRows: null,
  engine: null,
  collation: null,
  columns: [],
};

const DEMO_EVENT_META: TableMeta = {
  name: 'ev_daily_rollup',
  kind: 'event',
  comment: '每日凌晨汇总订单统计（demo）',
  estimatedRows: null,
  engine: null,
  collation: null,
  columns: [],
};

/** demo 的库元数据。真 IPC 下由 schemaGet 返回同结构的数据 */
export const DEMO_DATABASES: DatabaseMeta[] = [
  {
    name: 'order_db',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [
      { ...DEMO_TABLE_META },
      { ...DEMO_TABLE_META, name: 'order_item', estimatedRows: 88_000_000 },
      { ...DEMO_TABLE_META, name: 'user', estimatedRows: 320_000 },
      // V8：宽表（40 列）—— 冻结列/横向滚动的真机验证靶子
      { ...DEMO_WIDE_TABLE_META },
      { ...DEMO_TABLE_META, name: 'v_order_summary', kind: 'view', estimatedRows: null },
      { ...DEMO_TRIGGER_META },
      { ...DEMO_EVENT_META },
    ],
  },
  {
    name: 'log_db',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [{ ...DEMO_TABLE_META, name: 'access_log', estimatedRows: 5_400_000 }],
  },
];

const DEMO_DEV_DATABASES: DatabaseMeta[] = [
  {
    name: 'dev',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [{ ...DEMO_TABLE_META, name: 'order', estimatedRows: 1200 }],
  },
];

export function buildDemoTree(): TreeNode[] {
  return buildTree({
    connections: DEMO_CONNECTIONS,
    schemas: {
      c1: DEMO_DATABASES,
      c2: DEMO_DEV_DATABASES,
    },
  });
}

export const DEMO_TREE_ROOTS = buildDemoTree();

export function buildPaletteItems(): PaletteItem[] {
  return [
    { id: 't1', title: 'order', subtitle: 'prod_order / order_db', badge: '表', lastUsedAt: Date.now() - 60_000, useCount: 12 },
    { id: 't2', title: 'order_item', subtitle: 'prod_order / order_db', badge: '表', lastUsedAt: Date.now() - 3600_000, useCount: 4 },
    { id: 't3', title: 'user', subtitle: 'prod_order / order_db', badge: '表' },
    { id: 't4', title: 'access_log', subtitle: 'prod_order / log_db', badge: '表' },
    { id: 'v1', title: 'v_order_summary', subtitle: 'prod_order / order_db', badge: '视图' },
  ];
}
