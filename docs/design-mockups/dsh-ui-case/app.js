/* ============================================================================
   DB Studio · DSH 风格界面案例（交互层）
   ----------------------------------------------------------------------------
   这是一个**只读样张**：所有数据都是前端演示数据，不发请求、不连数据库。
   交互只用于检验 DSH 组件语言在数据库工具里是否成立：
     · 1/2/3/4 切四个界面，T 切深浅色
     · 树：单击看详情，双击开标签；可折叠；顶部搜索可筛
     · 标签：切换/关闭；关闭全部后显示空态
     · 表格：列排序、行选中、单元格选中、本地查找、列显隐、行高、跳行
     · 筛选：条件条、删除单条、清空、浮层编辑
     · ⌘K：命令面板（输入即筛、↑↓、Enter）
     · 保存：写入预演 + 生产表名门禁
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   0. 小工具
   -------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function icon(name, size = 14) {
  return `<svg class="ic" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function fmtInt(value) {
  return Number(value).toLocaleString('en-US');
}

function fmtAmount(value) {
  if (value == null) return '';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    /* 演示环境不保证剪贴板可用 */
  }
  area.remove();
}

/* --------------------------------------------------------------------------
   1. 演示数据
   -------------------------------------------------------------------------- */
const STATUS = {
  paid: { label: '已支付', tone: 'ok' },
  unpaid: { label: '未支付', tone: 'warn' },
  refunded: { label: '已退款', tone: 'err' },
};

function statusBadge(value) {
  const s = STATUS[value] || { label: value, tone: 'idle' };
  return `<span class="badge badge--${s.tone} cell-badge">${esc(s.label)}</span>`;
}

function datetimeCell(value) {
  if (!value) return '<span class="null">NULL</span>';
  const text = String(value);
  const dot = text.lastIndexOf('.');
  if (dot < 0) return `<span class="cell-time">${esc(text)}</span>`;
  return `<span class="cell-time">${esc(text.slice(0, dot))}<span class="micro">${esc(text.slice(dot))}</span></span>`;
}

function fkCell(value) {
  return `<a class="cell-link" href="#" data-fk="user">${esc(value)}</a>`;
}

const ORDER_COLUMNS = [
  { key: 'id', label: 'id', type: 'bigint', width: 58, mono: true, num: true, flags: ['PK', 'AI', 'NOT NULL'], comment: '订单主键，自增' },
  { key: 'order_no', label: 'order_no', type: 'varchar(32)', width: 118, mono: true, flags: ['NOT NULL'], comment: '业务订单号，全局唯一' },
  { key: 'user_id', label: 'user_id', type: 'bigint', width: 78, mono: true, flags: ['NOT NULL', 'FK'], comment: '下单用户 ID（关联 user.id）', fk: true },
  { key: 'amount', label: 'amount', type: 'decimal(12,2)', width: 96, mono: true, num: true, flags: ['NOT NULL'], comment: '订单金额（元，含税）' },
  { key: 'status', label: 'status', type: 'enum(...)', width: 92, flags: ['NOT NULL'], comment: '支付状态：已付/未付/已退款', render: (v) => statusBadge(v) },
  { key: 'created_at', label: 'created_at', type: 'datetime(6)', width: 186, flags: ['NOT NULL'], comment: '下单时间（含微秒）' },
  { key: 'remark', label: 'remark', type: 'varchar(255)', width: 192, flags: [], comment: '买家备注，可为空' },
];

const ORDER_ROWS = [
  { id: 1042, order_no: 'NO100041', user_id: 1024, amount: 1280, status: 'paid', created_at: '2026-11-17 14:21:09.481203', remark: '加急发货' },
  { id: 1041, order_no: 'NO100040', user_id: 1031, amount: 860.5, status: 'unpaid', created_at: '2026-11-17 14:18:42.120441', remark: null },
  { id: 1040, order_no: 'NO100039', user_id: 1018, amount: 4200, status: 'paid', created_at: '2026-11-17 14:12:03.902183', remark: '开票信息见附件' },
  { id: 1039, order_no: 'NO100038', user_id: 1007, amount: 315.8, status: 'refunded', created_at: '2026-11-17 14:05:51.338902', remark: '' },
  { id: 1038, order_no: 'NO100037', user_id: 1022, amount: 246, status: 'paid', created_at: '2026-11-17 13:58:20.041273', remark: '客户要求销毁' },
  { id: 1037, order_no: 'NO100036', user_id: 1014, amount: 780.25, status: 'paid', created_at: '2026-11-17 13:44:11.765420', remark: null },
  { id: 1036, order_no: 'NO100035', user_id: 1009, amount: 1599, status: 'unpaid', created_at: '2026-11-17 13:39:08.224081', remark: '等待财务确认' },
  { id: 1035, order_no: 'NO100034', user_id: 1028, amount: 88, status: 'refunded', created_at: '2026-11-17 13:31:55.610224', remark: null },
  { id: 1034, order_no: 'NO100033', user_id: 1011, amount: 612.4, status: 'paid', created_at: '2026-11-17 13:22:40.098713', remark: '工作日配送' },
  { id: 1033, order_no: 'NO100032', user_id: 1003, amount: 2048, status: 'paid', created_at: '2026-11-17 13:15:17.443902', remark: null },
  { id: 1032, order_no: 'NO100031', user_id: 1025, amount: 356.6, status: 'unpaid', created_at: '2026-11-17 13:02:05.871200', remark: '' },
  { id: 1031, order_no: 'NO100030', user_id: 1017, amount: 1180, status: 'paid', created_at: '2026-11-17 12:56:44.110377', remark: '老客户复购' },
  { id: 1030, order_no: 'NO100029', user_id: 1006, amount: 920.1, status: 'refunded', created_at: '2026-11-17 12:41:09.335520', remark: '退款原因：拍错' },
  { id: 1029, order_no: 'NO100028', user_id: 1030, amount: 66.5, status: 'paid', created_at: '2026-11-17 12:30:58.902411', remark: null },
  { id: 1028, order_no: 'NO100027', user_id: 1013, amount: 3250, status: 'paid', created_at: '2026-11-17 12:18:31.447805', remark: '企业采购' },
  { id: 1027, order_no: 'NO100026', user_id: 1020, amount: 512.9, status: 'unpaid', created_at: '2026-11-17 12:06:22.180934', remark: null },
  { id: 1026, order_no: 'NO100025', user_id: 1008, amount: 1499, status: 'paid', created_at: '2026-11-17 11:55:07.764312', remark: '' },
  { id: 1025, order_no: 'NO100024', user_id: 1016, amount: 230.4, status: 'paid', created_at: '2026-11-17 11:43:39.005612', remark: '门卫代收' },
  { id: 1024, order_no: 'NO100023', user_id: 1004, amount: 528, status: 'paid', created_at: '2026-11-17 11:31:22.887104', remark: null },
  { id: 1023, order_no: 'NO100022', user_id: 1027, amount: 1670, status: 'refunded', created_at: '2026-11-17 11:20:48.120910', remark: '退款已到账' },
  { id: 1022, order_no: 'NO100021', user_id: 1019, amount: 340, status: 'paid', created_at: '2026-11-17 11:09:13.660220', remark: null },
  { id: 1021, order_no: 'NO100020', user_id: 1005, amount: 760, status: 'paid', created_at: '2026-11-17 10:58:37.448012', remark: '需开发票' },
  { id: 1020, order_no: 'NO100019', user_id: 1021, amount: 128, status: 'refunded', created_at: '2026-11-17 10:46:04.003811', remark: '' },
  { id: 1019, order_no: 'NO100018', user_id: 1002, amount: 889, status: 'paid', created_at: '2026-11-17 10:35:52.771300', remark: null },
  { id: 1018, order_no: 'NO100017', user_id: 1026, amount: 1120, status: 'paid', created_at: '2026-11-17 10:24:18.390022', remark: '加急' },
  { id: 1017, order_no: 'NO100016', user_id: 1012, amount: 470, status: 'paid', created_at: '2026-11-17 10:12:41.552211', remark: null },
  { id: 1016, order_no: 'NO100015', user_id: 1023, amount: 244, status: 'paid', created_at: '2026-11-17 10:01:09.120448', remark: '' },
  { id: 1015, order_no: 'NO100014', user_id: 1001, amount: 1340, status: 'paid', created_at: '2026-11-17 09:50:33.884211', remark: '企业月结' },
];

const ORDER_ITEM_COLUMNS = [
  { key: 'id', label: 'id', type: 'bigint', width: 58, mono: true, num: true, flags: ['PK', 'AI'], comment: '明细主键' },
  { key: 'order_id', label: 'order_id', type: 'bigint', width: 78, mono: true, flags: ['NOT NULL', 'FK'], comment: '所属订单' },
  { key: 'sku', label: 'sku', type: 'varchar(32)', width: 110, mono: true, flags: ['NOT NULL'], comment: '商品 SKU' },
  { key: 'title', label: 'title', type: 'varchar(120)', width: 200, flags: ['NOT NULL'], comment: '商品标题快照' },
  { key: 'qty', label: 'qty', type: 'int', width: 60, mono: true, num: true, flags: ['NOT NULL'], comment: '数量' },
  { key: 'price', label: 'price', type: 'decimal(12,2)', width: 96, mono: true, num: true, flags: ['NOT NULL'], comment: '成交单价' },
  { key: 'created_at', label: 'created_at', type: 'datetime(6)', width: 186, flags: ['NOT NULL'], comment: '创建时间' },
];

const ORDER_ITEM_ROWS = [
  { id: 24018, order_id: 1042, sku: 'SKU-A-1180', title: '人体工学椅 · 标准版', qty: 1, price: 1180, created_at: '2026-11-17 14:21:09.481203' },
  { id: 24017, order_id: 1042, sku: 'SKU-B-0100', title: '椅背挂衣架', qty: 1, price: 100, created_at: '2026-11-17 14:21:09.481203' },
  { id: 24016, order_id: 1041, sku: 'SKU-C-860', title: '升降桌 · 1.4m 胡桃木', qty: 1, price: 860.5, created_at: '2026-11-17 14:18:42.120441' },
  { id: 24015, order_id: 1040, sku: 'SKU-D-2100', title: '显示器支架 · 双屏', qty: 2, price: 2100, created_at: '2026-11-17 14:12:03.902183' },
  { id: 24014, order_id: 1039, sku: 'SKU-E-315', title: '桌面理线槽', qty: 1, price: 315.8, created_at: '2026-11-17 14:05:51.338902' },
  { id: 24013, order_id: 1038, sku: 'SKU-F-246', title: 'USB-C 扩展坞', qty: 1, price: 246, created_at: '2026-11-17 13:58:20.041273' },
  { id: 24012, order_id: 1037, sku: 'SKU-G-399', title: '键盘 · 矮轴', qty: 1, price: 399, created_at: '2026-11-17 13:44:11.765420' },
  { id: 24011, order_id: 1037, sku: 'SKU-H-381', title: '掌托 · 木质', qty: 1, price: 381.25, created_at: '2026-11-17 13:44:11.765420' },
  { id: 24010, order_id: 1036, sku: 'SKU-I-1599', title: '4K 显示器 · 27 英寸', qty: 1, price: 1599, created_at: '2026-11-17 13:39:08.224081' },
  { id: 24009, order_id: 1035, sku: 'SKU-J-088', title: '鼠标垫 · 小号', qty: 1, price: 88, created_at: '2026-11-17 13:31:55.610224' },
];

const VIEW_COLUMNS = [
  { key: 'order_no', label: 'order_no', type: 'varchar(32)', width: 118, mono: true, flags: [], comment: '订单号' },
  { key: 'user_name', label: 'user_name', type: 'varchar(64)', width: 110, flags: [], comment: '用户昵称' },
  { key: 'item_count', label: 'item_count', type: 'int', width: 80, mono: true, num: true, flags: [], comment: '明细数量' },
  { key: 'total_amount', label: 'total_amount', type: 'decimal(12,2)', width: 110, mono: true, num: true, flags: [], comment: '订单总额' },
  { key: 'last_paid_at', label: 'last_paid_at', type: 'datetime(6)', width: 186, flags: [], comment: '最近支付时间' },
];

const VIEW_ROWS = [
  { order_no: 'NO100041', user_name: '林然', item_count: 2, total_amount: 1280, last_paid_at: '2026-11-17 14:21:09.481203' },
  { order_no: 'NO100039', user_name: '陈默', item_count: 1, total_amount: 4200, last_paid_at: '2026-11-17 14:12:03.902183' },
  { order_no: 'NO100037', user_name: '周予', item_count: 1, total_amount: 246, last_paid_at: '2026-11-17 13:58:20.041273' },
  { order_no: 'NO100036', user_name: '苏杭', item_count: 2, total_amount: 780.25, last_paid_at: '2026-11-17 13:44:11.765420' },
  { order_no: 'NO100033', user_name: '许知', item_count: 1, total_amount: 612.4, last_paid_at: '2026-11-17 13:22:40.098713' },
  { order_no: 'NO100032', user_name: '顾一', item_count: 1, total_amount: 2048, last_paid_at: '2026-11-17 13:15:17.443902' },
  { order_no: 'NO100030', user_name: '沈聿', item_count: 1, total_amount: 1180, last_paid_at: '2026-11-17 12:56:44.110377' },
  { order_no: 'NO100027', user_name: '陆声', item_count: 1, total_amount: 3250, last_paid_at: '2026-11-17 12:18:31.447805' },
];

const USER_COLUMNS = [
  { key: 'id', label: 'id', type: 'bigint', width: 58, mono: true, num: true, flags: ['PK', 'AI'], comment: '用户主键' },
  { key: 'name', label: 'name', type: 'varchar(64)', width: 110, flags: ['NOT NULL'], comment: '昵称' },
  { key: 'email', label: 'email', type: 'varchar(128)', width: 190, mono: true, flags: ['NOT NULL'], comment: '登录邮箱' },
  { key: 'city', label: 'city', type: 'varchar(32)', width: 80, flags: [], comment: '城市' },
  { key: 'created_at', label: 'created_at', type: 'datetime(6)', width: 186, flags: ['NOT NULL'], comment: '注册时间' },
  { key: 'status', label: 'status', type: 'tinyint', width: 92, flags: ['NOT NULL'], comment: '1 正常 / 0 停用', render: (v) => `<span class="badge ${v ? 'badge--ok' : 'badge--idle'} cell-badge">${v ? '正常' : '停用'}</span>` },
];

const USER_ROWS = [
  { id: 1024, name: '林然', email: 'linran@example.com', city: '上海', created_at: '2025-03-18 09:12:44.000211', status: 1 },
  { id: 1031, name: '陈默', email: 'chenmo@example.com', city: '北京', created_at: '2025-04-02 11:30:07.120044', status: 1 },
  { id: 1018, name: '周予', email: 'zhouyu@example.com', city: '杭州', created_at: '2025-01-27 16:05:31.000902', status: 1 },
  { id: 1007, name: '苏杭', email: 'suhang@example.com', city: '深圳', created_at: '2024-12-09 10:41:02.884120', status: 1 },
  { id: 1022, name: '许知', email: 'xuzhi@example.com', city: '成都', created_at: '2025-02-14 08:22:19.003371', status: 1 },
  { id: 1014, name: '顾一', email: 'guyi@example.com', city: '上海', created_at: '2025-01-03 19:08:52.610228', status: 0 },
  { id: 1009, name: '沈聿', email: 'shenyu@example.com', city: '广州', created_at: '2024-12-21 13:55:40.442019', status: 1 },
  { id: 1028, name: '陆声', email: 'lusheng@example.com', city: '南京', created_at: '2025-03-30 07:17:26.900153', status: 1 },
];

const LOG_COLUMNS = [
  { key: 'id', label: 'id', type: 'bigint', width: 58, mono: true, num: true, flags: ['PK'], comment: '日志主键' },
  { key: 'method', label: 'method', type: 'varchar(8)', width: 70, mono: true, flags: ['NOT NULL'], comment: 'HTTP 方法' },
  { key: 'path', label: 'path', type: 'varchar(255)', width: 220, mono: true, flags: ['NOT NULL'], comment: '请求路径' },
  { key: 'status', label: 'status', type: 'smallint', width: 70, mono: true, num: true, flags: ['NOT NULL'], comment: '响应状态码', render: (v) => `<span class="status-code${v >= 400 ? ' is-err' : ''}">${v}</span>` },
  { key: 'ip', label: 'ip', type: 'varchar(45)', width: 120, mono: true, flags: [], comment: '来源 IP' },
  { key: 'created_at', label: 'created_at', type: 'datetime(6)', width: 186, flags: ['NOT NULL'], comment: '记录时间' },
];

const LOG_ROWS = [
  { id: 88012, method: 'GET', path: '/api/orders', status: 200, ip: '10.12.4.18', created_at: '2026-11-17 14:30:11.402118' },
  { id: 88011, method: 'POST', path: '/api/orders/1042/refund', status: 201, ip: '10.12.4.22', created_at: '2026-11-17 14:29:47.118020' },
  { id: 88010, method: 'GET', path: '/api/users/1024', status: 200, ip: '10.12.4.18', created_at: '2026-11-17 14:29:02.774901' },
  { id: 88009, method: 'GET', path: '/api/orders?status=paid', status: 200, ip: '10.12.4.31', created_at: '2026-11-17 14:28:55.310440' },
  { id: 88008, method: 'PATCH', path: '/api/orders/1039', status: 204, ip: '10.12.4.22', created_at: '2026-11-17 14:28:17.006781' },
  { id: 88007, method: 'GET', path: '/healthz', status: 200, ip: '127.0.0.1', created_at: '2026-11-17 14:28:00.000003' },
  { id: 88006, method: 'GET', path: '/api/orders/1038', status: 404, ip: '10.12.4.31', created_at: '2026-11-17 14:27:42.881204' },
  { id: 88005, method: 'POST', path: '/api/login', status: 401, ip: '10.12.4.77', created_at: '2026-11-17 14:27:11.552018' },
];

const QUERY_COLUMNS = [
  { key: 'id', label: 'id', type: 'bigint', width: 58, mono: true, num: true, comment: '' },
  { key: 'order_no', label: 'order_no', type: 'varchar(32)', width: 118, mono: true, comment: '' },
  { key: 'user_name', label: 'user_name', type: 'varchar(64)', width: 100, comment: '' },
  { key: 'amount', label: 'amount', type: 'decimal(12,2)', width: 96, mono: true, num: true, comment: '' },
  { key: 'status', label: 'status', type: 'enum(...)', width: 92, comment: '', render: (v) => statusBadge(v) },
  { key: 'created_at', label: 'created_at', type: 'datetime(6)', width: 186, comment: '' },
  { key: 'city', label: 'city', type: 'varchar(32)', width: 88, comment: '' },
];

const QUERY_ROWS = [
  { id: 1042, order_no: 'NO100041', user_name: '林然', amount: 1280, status: 'paid', created_at: '2026-11-17 14:21:09.481203', city: '上海' },
  { id: 1040, order_no: 'NO100039', user_name: '周予', amount: 4200, status: 'paid', created_at: '2026-11-17 14:12:03.902183', city: '杭州' },
  { id: 1038, order_no: 'NO100037', user_name: '许知', amount: 246, status: 'paid', created_at: '2026-11-17 13:58:20.041273', city: '成都' },
  { id: 1037, order_no: 'NO100036', user_name: '顾一', amount: 780.25, status: 'paid', created_at: '2026-11-17 13:44:11.765420', city: '上海' },
  { id: 1034, order_no: 'NO100033', user_name: '沈聿', amount: 612.4, status: 'paid', created_at: '2026-11-17 13:22:40.098713', city: '广州' },
  { id: 1033, order_no: 'NO100032', user_name: '陆声', amount: 2048, status: 'paid', created_at: '2026-11-17 13:15:17.443902', city: '南京' },
  { id: 1031, order_no: 'NO100030', user_name: '陈默', amount: 1180, status: 'paid', created_at: '2026-11-17 12:56:44.110377', city: '北京' },
  { id: 1029, order_no: 'NO100028', user_name: '苏杭', amount: 66.5, status: 'paid', created_at: '2026-11-17 12:30:58.902411', city: '深圳' },
  { id: 1028, order_no: 'NO100027', user_name: '周予', amount: 3250, status: 'paid', created_at: '2026-11-17 12:18:31.447805', city: '杭州' },
  { id: 1026, order_no: 'NO100025', user_name: '顾一', amount: 1499, status: 'paid', created_at: '2026-11-17 11:55:07.764312', city: '上海' },
];

const TABLES = {
  order: {
    key: 'order',
    name: 'order',
    tabLabel: 'order',
    kind: 'table',
    kindLabel: '表',
    conn: 'prod_order',
    env: 'prod',
    envLabel: '生产',
    db: 'order_db',
    loaded: 500,
    totalRows: '12,450,000',
    queryMs: 12,
    strategy: '主键',
    writable: true,
    engine: 'InnoDB',
    collation: 'utf8mb4_0900_ai_ci',
    comment: '订单表（生产）',
    indexes: ['PRIMARY (id)', 'idx_user_id (user_id)', 'idx_created (created_at)'],
    columns: ORDER_COLUMNS,
    rows: ORDER_ROWS,
    detailColumns: ORDER_COLUMNS,
    ddlHtml: `<span class="tok-k">CREATE TABLE</span> <span class="tok-t">\`order\`</span> (
  <span class="tok-t">\`id\`</span> bigint <span class="tok-k">NOT NULL AUTO_INCREMENT</span>,
  <span class="tok-t">\`order_no\`</span> varchar(32) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`user_id\`</span> bigint <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`amount\`</span> decimal(12,2) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`status\`</span> enum(<span class="tok-s">'paid'</span>,<span class="tok-s">'unpaid'</span>,<span class="tok-s">'refunded'</span>) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`created_at\`</span> datetime(6) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`remark\`</span> varchar(255) <span class="tok-k">DEFAULT NULL</span>,
  <span class="tok-k">PRIMARY KEY</span> (<span class="tok-t">\`id\`</span>),
  <span class="tok-k">KEY</span> <span class="tok-t">\`idx_user_id\`</span> (<span class="tok-t">\`user_id\`</span>),
  <span class="tok-k">KEY</span> <span class="tok-t">\`idx_created\`</span> (<span class="tok-t">\`created_at\`</span>)
) <span class="tok-k">ENGINE</span>=InnoDB <span class="tok-k">DEFAULT CHARSET</span>=utf8mb4;`,
  },
  order_item: {
    key: 'order_item',
    name: 'order_item',
    tabLabel: 'order_item',
    kind: 'table',
    kindLabel: '表',
    conn: 'prod_order',
    env: 'prod',
    envLabel: '生产',
    db: 'order_db',
    loaded: 10,
    totalRows: '88,000,000',
    queryMs: 9,
    strategy: '主键',
    writable: true,
    engine: 'InnoDB',
    collation: 'utf8mb4_0900_ai_ci',
    comment: '订单明细表（生产）',
    indexes: ['PRIMARY (id)', 'idx_order_id (order_id)'],
    columns: ORDER_ITEM_COLUMNS,
    rows: ORDER_ITEM_ROWS,
    detailColumns: ORDER_ITEM_COLUMNS,
    ddlHtml: `<span class="tok-k">CREATE TABLE</span> <span class="tok-t">\`order_item\`</span> (
  <span class="tok-t">\`id\`</span> bigint <span class="tok-k">NOT NULL AUTO_INCREMENT</span>,
  <span class="tok-t">\`order_id\`</span> bigint <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`sku\`</span> varchar(32) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`title\`</span> varchar(120) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`qty\`</span> int <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`price\`</span> decimal(12,2) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`created_at\`</span> datetime(6) <span class="tok-k">NOT NULL</span>,
  <span class="tok-k">PRIMARY KEY</span> (<span class="tok-t">\`id\`</span>),
  <span class="tok-k">KEY</span> <span class="tok-t">\`idx_order_id\`</span> (<span class="tok-t">\`order_id\`</span>)
) <span class="tok-k">ENGINE</span>=InnoDB <span class="tok-k">DEFAULT CHARSET</span>=utf8mb4;`,
  },
  view: {
    key: 'view',
    name: 'v_order_summary',
    tabLabel: 'v_order_summary',
    kind: 'view',
    kindLabel: '视图',
    conn: 'prod_order',
    env: 'prod',
    envLabel: '生产',
    db: 'order_db',
    loaded: 8,
    totalRows: '8',
    queryMs: 4,
    strategy: '无（只读）',
    writable: false,
    engine: null,
    collation: 'utf8mb4_0900_ai_ci',
    comment: '已支付订单汇总（视图）',
    indexes: [],
    columns: VIEW_COLUMNS,
    rows: VIEW_ROWS,
    detailColumns: VIEW_COLUMNS,
    ddlHtml: `<span class="tok-k">CREATE ALGORITHM</span>=UNDEFINED <span class="tok-k">DEFINER</span>=\`app\`@\`%\`
<span class="tok-k">SQL SECURITY DEFINER VIEW</span> <span class="tok-t">\`v_order_summary\`</span> <span class="tok-k">AS</span>
<span class="tok-k">SELECT</span>
  o.order_no,
  u.name <span class="tok-k">AS</span> user_name,
  <span class="tok-fn">COUNT</span>(i.id) <span class="tok-k">AS</span> item_count,
  <span class="tok-fn">SUM</span>(i.price * i.qty) <span class="tok-k">AS</span> total_amount,
  <span class="tok-fn">MAX</span>(o.created_at) <span class="tok-k">AS</span> last_paid_at
<span class="tok-k">FROM</span> <span class="tok-t">\`order\`</span> o
<span class="tok-k">JOIN</span> <span class="tok-t">\`user\`</span> u <span class="tok-k">ON</span> u.id = o.user_id
<span class="tok-k">LEFT JOIN</span> <span class="tok-t">\`order_item\`</span> i <span class="tok-k">ON</span> i.order_id = o.id
<span class="tok-k">WHERE</span> o.status = <span class="tok-s">'paid'</span>
<span class="tok-k">GROUP BY</span> o.id;`,
  },
  user: {
    key: 'user',
    name: 'user',
    tabLabel: 'user',
    kind: 'table',
    kindLabel: '表',
    conn: 'prod_order',
    env: 'prod',
    envLabel: '生产',
    db: 'order_db',
    loaded: 8,
    totalRows: '320,000',
    queryMs: 7,
    strategy: '主键',
    writable: true,
    engine: 'InnoDB',
    collation: 'utf8mb4_0900_ai_ci',
    comment: '用户表（生产）',
    indexes: ['PRIMARY (id)', 'uk_email (email)'],
    columns: USER_COLUMNS,
    rows: USER_ROWS,
    detailColumns: USER_COLUMNS,
    ddlHtml: `<span class="tok-k">CREATE TABLE</span> <span class="tok-t">\`user\`</span> (
  <span class="tok-t">\`id\`</span> bigint <span class="tok-k">NOT NULL AUTO_INCREMENT</span>,
  <span class="tok-t">\`name\`</span> varchar(64) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`email\`</span> varchar(128) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`city\`</span> varchar(32) <span class="tok-k">DEFAULT NULL</span>,
  <span class="tok-t">\`created_at\`</span> datetime(6) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`status\`</span> tinyint <span class="tok-k">NOT NULL DEFAULT</span> <span class="tok-n">1</span>,
  <span class="tok-k">PRIMARY KEY</span> (<span class="tok-t">\`id\`</span>),
  <span class="tok-k">UNIQUE KEY</span> <span class="tok-t">\`uk_email\`</span> (<span class="tok-t">\`email\`</span>)
) <span class="tok-k">ENGINE</span>=InnoDB <span class="tok-k">DEFAULT CHARSET</span>=utf8mb4;`,
  },
  access_log: {
    key: 'access_log',
    name: 'access_log',
    tabLabel: 'access_log',
    kind: 'table',
    kindLabel: '表',
    conn: 'prod_order',
    env: 'prod',
    envLabel: '生产',
    db: 'log_db',
    loaded: 8,
    totalRows: '5,400,000',
    queryMs: 18,
    strategy: '主键',
    writable: true,
    engine: 'InnoDB',
    collation: 'utf8mb4_0900_ai_ci',
    comment: '访问日志（生产）',
    indexes: ['PRIMARY (id)', 'idx_created (created_at)'],
    columns: LOG_COLUMNS,
    rows: LOG_ROWS,
    detailColumns: LOG_COLUMNS,
    ddlHtml: `<span class="tok-k">CREATE TABLE</span> <span class="tok-t">\`access_log\`</span> (
  <span class="tok-t">\`id\`</span> bigint <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`method\`</span> varchar(8) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`path\`</span> varchar(255) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`status\`</span> smallint <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`ip\`</span> varchar(45) <span class="tok-k">DEFAULT NULL</span>,
  <span class="tok-t">\`created_at\`</span> datetime(6) <span class="tok-k">NOT NULL</span>,
  <span class="tok-k">PRIMARY KEY</span> (<span class="tok-t">\`id\`</span>),
  <span class="tok-k">KEY</span> <span class="tok-t">\`idx_created\`</span> (<span class="tok-t">\`created_at\`</span>)
) <span class="tok-k">ENGINE</span>=InnoDB <span class="tok-k">DEFAULT CHARSET</span>=utf8mb4;`,
  },
  dev_order: {
    key: 'dev_order',
    name: 'order',
    tabLabel: 'order · dev',
    kind: 'table',
    kindLabel: '表',
    conn: 'local_dev',
    env: 'dev',
    envLabel: '开发',
    db: 'dev',
    loaded: 6,
    totalRows: '1,200',
    queryMs: 3,
    strategy: '主键',
    writable: true,
    engine: 'InnoDB',
    collation: 'utf8mb4_0900_ai_ci',
    comment: '订单表（本地开发）',
    indexes: ['PRIMARY (id)'],
    columns: ORDER_COLUMNS,
    rows: ORDER_ROWS.slice(0, 6),
    detailColumns: ORDER_COLUMNS,
    ddlHtml: `<span class="tok-k">CREATE TABLE</span> <span class="tok-t">\`order\`</span> (
  <span class="tok-t">\`id\`</span> bigint <span class="tok-k">NOT NULL AUTO_INCREMENT</span>,
  <span class="tok-t">\`order_no\`</span> varchar(32) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`user_id\`</span> bigint <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`amount\`</span> decimal(12,2) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`status\`</span> enum(<span class="tok-s">'paid'</span>,<span class="tok-s">'unpaid'</span>,<span class="tok-s">'refunded'</span>) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`created_at\`</span> datetime(6) <span class="tok-k">NOT NULL</span>,
  <span class="tok-t">\`remark\`</span> varchar(255) <span class="tok-k">DEFAULT NULL</span>,
  <span class="tok-k">PRIMARY KEY</span> (<span class="tok-t">\`id\`</span>)
) <span class="tok-k">ENGINE</span>=InnoDB;`,
  },
};

/* 写入脏状态：2 个单元格 + 1 行待删除 = 3 处 */
const DIRTY = {
  order: {
    cells: new Set(['1042:amount', '1039:status']),
    deleted: new Set([1038]),
  },
};

const HISTORY = [
  { sql: "SELECT * FROM order WHERE status = 'paid' LIMIT 100", meta: '3 分钟前 · 100 行', ms: '12ms' },
  { sql: 'SELECT COUNT(*) FROM order_item WHERE order_id = 1042', meta: '12 分钟前 · 1 行', ms: '4ms' },
  { sql: 'UPDATE order SET status = \'refunded\' WHERE id = 1039', meta: '昨天 18:02 · 影响 1 行', ms: '8ms' },
  { sql: 'SELECT id, name FROM user WHERE city = \'上海\'', meta: '昨天 16:40 · 128 行', ms: '6ms' },
  { sql: 'EXPLAIN SELECT * FROM order WHERE status = \'paid\'', meta: '昨天 14:11 · 计划', ms: '2ms' },
];

const TREE = [
  {
    type: 'group',
    key: 'group:prod',
    label: '生产环境',
    children: [
      {
        type: 'conn',
        key: 'conn:prod',
        name: 'prod_order',
        meta: '生产',
        state: 'ok',
        children: [
          {
            type: 'db',
            key: 'db:prod:order_db',
            name: 'order_db',
            children: [
              {
                type: 'category',
                key: 'cat:prod:order_db:tables',
                name: '表',
                icon: 'table',
                children: [
                  { type: 'object', key: 'obj:prod:order_db:order', name: 'order', tableKey: 'order', icon: 'table', dirty: true },
                  { type: 'object', key: 'obj:prod:order_db:order_item', name: 'order_item', tableKey: 'order_item', icon: 'table' },
                  { type: 'object', key: 'obj:prod:order_db:user', name: 'user', tableKey: 'user', icon: 'table' },
                ],
              },
              {
                type: 'category',
                key: 'cat:prod:order_db:views',
                name: '视图',
                icon: 'view',
                children: [
                  { type: 'object', key: 'obj:prod:order_db:view', name: 'v_order_summary', tableKey: 'view', icon: 'view', readonly: true },
                ],
              },
            ],
          },
          {
            type: 'db',
            key: 'db:prod:log_db',
            name: 'log_db',
            children: [
              {
                type: 'category',
                key: 'cat:prod:log_db:tables',
                name: '表',
                icon: 'table',
                children: [
                  { type: 'object', key: 'obj:prod:log_db:access_log', name: 'access_log', tableKey: 'access_log', icon: 'table' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    type: 'group',
    key: 'group:dev',
    label: '开发环境',
    children: [
      {
        type: 'conn',
        key: 'conn:dev',
        name: 'local_dev',
        meta: '开发',
        state: 'ok',
        children: [
          {
            type: 'db',
            key: 'db:dev:dev',
            name: 'dev',
            children: [
              {
                type: 'category',
                key: 'cat:dev:dev:tables',
                name: '表',
                icon: 'table',
                children: [
                  { type: 'object', key: 'obj:dev:dev:order', name: 'order', tableKey: 'dev_order', icon: 'table' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

const PALETTE_COMMANDS = [
  {
    id: 'cmd.filter',
    group: '命令',
    title: '筛选当前表',
    sub: '按列加条件，可临时停用某条',
    badge: '命令',
    icon: 'filter',
    action: 'filter',
    kbd: '⌘⇧F',
  },
  {
    id: 'cmd.newQuery',
    group: '命令',
    title: '新建查询标签',
    sub: '打开一个 SQL 编辑器',
    badge: '命令',
    icon: 'terminal',
    action: 'new-query',
    kbd: '⌘T',
  },
  {
    id: 'cmd.export',
    group: '命令',
    title: '导出当前表',
    sub: '含当前筛选条件，CSV / Excel',
    badge: '命令',
    icon: 'export',
    action: 'export',
    kbd: '⌘E',
  },
  {
    id: 'cmd.design',
    group: '命令',
    title: '设计表结构',
    sub: '字段、索引、外键',
    badge: '命令',
    icon: 'braces',
    action: 'design',
  },
  {
    id: 'cmd.theme',
    group: '命令',
    title: '切换主题',
    sub: '浅色 / 深色',
    badge: '命令',
    icon: 'moon',
    action: 'theme',
  },
];

const PALETTE_HISTORY = [
  {
    id: 'hist.1',
    group: '历史',
    title: "SELECT * FROM order WHERE status = 'paid' LIMIT 100",
    sub: '3 分钟前 · 100 行 · 12ms',
    badge: '历史',
    icon: 'history',
    action: 'history',
  },
  {
    id: 'hist.2',
    group: '历史',
    title: 'SELECT COUNT(*) FROM order_item WHERE order_id = 1042',
    sub: '12 分钟前 · 1 行 · 4ms',
    badge: '历史',
    icon: 'history',
    action: 'history',
  },
];

/* --------------------------------------------------------------------------
   2. 状态
   -------------------------------------------------------------------------- */
const S = {
  theme: 'light',
  screen: 'workspace',
  overlay: null,
  activeKey: 'order',
  tabs: ['order', 'order_item', 'view', 'query'],
  selectedTreeKey: 'obj:prod:order_db:order',
  detailKey: 'order',
  selectedRowId: 1039,
  selectedCell: null,
  sort: { key: 'created_at', dir: 'desc' },
  search: '',
  hiddenCols: new Set(),
  detailCollapsed: false,
  treeQuery: '',
  expanded: new Set([
    'conn:prod',
    'db:prod:order_db',
    'cat:prod:order_db:tables',
    'cat:prod:order_db:views',
  ]),
  filters: {
    order: [
      { col: 'status', op: '!=', value: 'unpaid' },
      { col: 'amount', op: '>', value: '100' },
    ],
  },
  resultTab: 'result',
  querySelected: 1042,
  query: { running: false, elapsed: 38, rows: 200, timer: null },
  palette: { query: '', index: 0, results: [] },
  menu: null,
  toastTimer: null,
  resultSort: { key: 'created_at', dir: 'desc' },
};

const dom = {};

/* --------------------------------------------------------------------------
   3. 数据派生
   -------------------------------------------------------------------------- */
function activeTable() {
  return S.activeKey && TABLES[S.activeKey] ? TABLES[S.activeKey] : null;
}

function isQueryScreen() {
  return S.activeKey === 'query';
}

function dirtyFor(key) {
  const d = DIRTY[key];
  if (!d) return 0;
  return d.cells.size + d.deleted.size;
}

function dirtyInfo(key) {
  const d = DIRTY[key];
  return {
    cells: d ? d.cells.size : 0,
    deleted: d ? d.deleted.size : 0,
    total: dirtyFor(key),
  };
}

function tableFilters(key) {
  return S.filters[key] || [];
}

function ensureSort(table) {
  if (!S.sort || !table.columns.some((c) => c.key === S.sort.key)) {
    S.sort = { key: table.columns[0].key, dir: 'asc' };
  }
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true });
}

function rowMatchesFilter(row, f) {
  const v = row[f.col];
  const target = f.value;
  if (f.op === '=') {
    if (typeof v === 'number') return Number(target) === v;
    return String(v) === String(target);
  }
  if (f.op === '!=') {
    if (typeof v === 'number') return Number(target) !== v;
    return String(v) !== String(target);
  }
  if (f.op === '>') return Number(v) > Number(target);
  if (f.op === '<') return Number(v) < Number(target);
  if (f.op === 'contains') return String(v ?? '').toLowerCase().includes(String(target).toLowerCase());
  return true;
}

function visibleRows(table) {
  let rows = table.rows.slice();
  const filters = tableFilters(table.key);
  if (filters.length) rows = rows.filter((row) => filters.every((f) => rowMatchesFilter(row, f)));
  if (S.search.trim()) {
    const q = S.search.trim().toLowerCase();
    const statusLabels = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label]));
    rows = rows.filter((row) =>
      table.columns.some((col) => {
        const v = row[col.key];
        const text = `${v ?? ''} ${col.key === 'status' ? statusLabels[v] || '' : ''}`.toLowerCase();
        return text.includes(q);
      }),
    );
  }
  ensureSort(table);
  const { key, dir } = S.sort;
  rows.sort((a, b) => compareValues(a[key], b[key]) * (dir === 'asc' ? 1 : -1));
  return rows;
}

function visibleColumns(table) {
  return table.columns.filter((c) => !S.hiddenCols.has(c.key));
}

function renderCell(table, col, row) {
  const value = row[col.key];
  if (value === null || value === undefined) return '<span class="null">NULL</span>';
  if (value === '') return `<span class="empty-str">''</span>`;
  if (col.render) return col.render(value, row);
  if (col.key === 'created_at' || col.key === 'last_paid_at') return datetimeCell(value);
  if (col.key === 'amount' || col.key === 'price' || col.key === 'total_amount') return fmtAmount(value);
  if (col.fk || col.key === 'user_id' || col.key === 'order_id') return fkCell(value);
  if (typeof value === 'number') return fmtInt(value);
  return esc(value);
}

function cellClasses(col, row, table) {
  const cls = [];
  if (col.mono) cls.push('cell-mono');
  if (col.num) cls.push('cell-num');
  if (col.key === 'created_at' || col.key === 'last_paid_at') cls.push('cell-date');
  const dirty = DIRTY[table.key];
  if (dirty && dirty.cells.has(`${row.id}:${col.key}`)) cls.push('cell-dirty');
  if (S.selectedCell && S.selectedCell.id === row.id && S.selectedCell.col === col.key) cls.push('is-active-cell');
  return cls.join(' ');
}

/* --------------------------------------------------------------------------
   4. 网格渲染
   -------------------------------------------------------------------------- */
function tableHtml(table, opts) {
  const cols = opts.columns || table.columns;
  const rows = opts.rows;
  const sort = opts.sort || { key: '', dir: 'asc' };
  const dirty = DIRTY[table.key];
  const selectedId = opts.selectedId;
  const minWidth = opts.minWidth || 860;

  const colgroup = `<colgroup><col style="width:44px">${cols.map((c) => `<col style="width:${c.width}px">`).join('')}</colgroup>`;
  const head = `<thead><tr><th class="rownum" scope="col" aria-label="行号"></th>${cols
    .map((c) => {
      const sorted = sort.key === c.key;
      const arrow = sorted
        ? icon(sort.dir === 'asc' ? 'chevron-up' : 'chevron-down', 10)
        : icon('chevron-down', 10);
      return `<th scope="col" data-sort="${c.key}" class="${sorted ? 'is-sorted' : ''}" title="${esc(c.type)}"${
        sorted ? ` aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"` : ''
      }><span class="th-inner"><span class="th-name">${esc(c.label)}</span><span class="sort-ind">${arrow}</span></span></th>`;
    })
    .join('')}</tr></thead>`;

  const body = rows.length
    ? `<tbody>${rows
        .map((row, index) => {
          const deleted = dirty && dirty.deleted.has(row.id);
          const selected = row.id === selectedId;
          const rowCls = [selected ? 'is-selected' : '', deleted ? 'is-deleted' : ''].filter(Boolean).join(' ');
          const rownum = deleted
            ? `<span class="row-delete-mark" title="待删除">${icon('trash', 10)}</span>`
            : String(index + 1);
          const cells = cols
            .map(
              (c) =>
                `<td data-col="${c.key}" class="${cellClasses(c, row, table)}">${renderCell(table, c, row)}</td>`,
            )
            .join('');
          return `<tr data-row-id="${row.id}" class="${rowCls}"><th class="rownum" scope="row">${rownum}</th>${cells}</tr>`;
        })
        .join('')}</tbody>`
    : '';

  return `<table class="data-grid" style="min-width:${minWidth}px">${colgroup}${head}${body}</table>`;
}

function renderWorkspaceGrid() {
  const table = activeTable();
  if (!table) return;
  ensureSort(table);
  const rows = visibleRows(table);
  const cols = visibleColumns(table);
  dom.gridWrap.innerHTML = rows.length
    ? tableHtml(table, { rows, columns: cols, sort: S.sort, selectedId: S.selectedRowId })
    : `<div class="grid-empty">
        <span class="empty-ico">${icon('search', 18)}</span>
        <strong>没有匹配的行</strong>
        <span>${tableFilters(table.key).length ? '当前筛选没有命中任何行，可以清空筛选后再看。' : '换个关键词试试，或清空搜索。'}</span>
        <button class="btn is-ghost is-sm" type="button" data-act="clear-search">清空查找与筛选</button>
      </div>`;

  const filters = tableFilters(table.key);
  const total = table.totalRows;
  const loaded = table.loaded;
  dom.gridFoot.innerHTML = `<span class="dot ${table.writable ? '' : 'is-idle'}"></span>
    <span><b>${rows.length}</b> 行${filters.length ? '（筛选后）' : ''} · 已加载 ${fmtInt(loaded)}</span>
    <span>共 ${total} 行</span>
    <span>${table.writable ? '滚动到底部自动加载下一页' : '视图只读 · 不加载下一页'}</span>
    <span class="spacer"></span>
    ${table.writable ? '<button class="btn is-ghost is-xs" type="button" data-act="load-more">加载更多</button>' : ''}`;

  dom.gtMeta.innerHTML = `<span><b>${rows.length}</b> 行</span><span class="dot"></span><span class="loaded-extra">已加载 <b>${fmtInt(loaded)}</b></span>`;

  const readonly = !table.writable;
  dom.readonlyBanner.hidden = !readonly;
}

function renderResultGrid() {
  if (!dom.resultGridWrap) return;
  const rows = QUERY_ROWS.slice().sort((a, b) => compareValues(a[S.resultSort.key], b[S.resultSort.key]) * (S.resultSort.dir === 'asc' ? 1 : -1));
  dom.resultGridWrap.innerHTML = tableHtml(
    { key: 'query', columns: QUERY_COLUMNS },
    { rows, columns: QUERY_COLUMNS, sort: S.resultSort, selectedId: S.querySelected, minWidth: 760 },
  );
}

/* --------------------------------------------------------------------------
   5. 标签 / 工具栏 / 状态栏
   -------------------------------------------------------------------------- */
function tabIcon(key) {
  if (key === 'query') return 'terminal';
  const t = TABLES[key];
  return t && t.kind === 'view' ? 'view' : 'table';
}

function tabLabel(key) {
  if (key === 'query') return '查询 1';
  return TABLES[key] ? TABLES[key].tabLabel : key;
}

function renderTabs() {
  dom.tabs.innerHTML = S.tabs
    .map((key) => {
      const active = key === S.activeKey;
      const dirty = dirtyFor(key);
      const label = tabLabel(key);
      const t = TABLES[key];
      const title =
        key === 'query'
          ? '查询 1 · order_db'
          : t
            ? `${t.conn} / ${t.db} / ${t.name}`
            : label;
      return `<button class="tab${active ? ' is-active' : ''}" type="button" role="tab" aria-selected="${active}" data-tab="${key}" title="${esc(title)}">
        ${icon(tabIcon(key), 12)}
        <span class="tab-label">${esc(label)}</span>
        ${dirty ? `<span class="tab-dirty" title="${dirty} 处未保存改动"></span>` : ''}
        <span class="tab-close" data-close-tab="${key}" role="button" tabindex="-1" aria-label="关闭 ${esc(label)}" title="关闭标签">${icon('x', 9)}</span>
      </button>`;
    })
    .join('');
}

function envTag(env, label) {
  return `<span class="env-tag is-${env}">${esc(label)}</span>`;
}

function renderToolbar() {
  const table = activeTable();
  let identity = '';
  let actions = '';
  let meta = '';

  if (!table && !isQueryScreen()) {
    identity = `<span class="identity"><span class="muted">未打开表</span></span>`;
  } else if (isQueryScreen()) {
    identity = `<div class="identity">
      <span class="id-conn">prod_order</span><span class="id-sep">/</span>
      ${envTag('prod', '生产')}<span class="id-sep">/</span>
      <span class="id-db">order_db</span><span class="id-sep">/</span>
      <span class="id-object">${icon('terminal', 12)}查询 1</span>
    </div>`;
  } else if (table) {
    identity = `<div class="identity">
      <span class="id-conn" title="${esc(table.conn)}">${esc(table.conn)}</span><span class="id-sep">/</span>
      ${envTag(table.env, table.envLabel)}<span class="id-sep">/</span>
      <span class="id-db">${esc(table.db)}</span><span class="id-sep">/</span>
      <span class="id-object is-mono" title="${esc(table.name)}">${esc(table.name)}</span>
    </div>`;
  }

  actions += `<button class="icon-btn" type="button" data-act="palette" title="命令面板（⌘K）" aria-label="命令面板">${icon('search', 15)}</button>`;
  actions += `<button class="icon-btn" type="button" data-act="new-query" title="新建查询标签（⌘T）" aria-label="新建查询标签">${icon('terminal', 15)}</button>`;

  if (isQueryScreen()) {
    const running = S.query.running;
    actions += `<span class="toolbar-divider"></span>
      <button class="btn is-primary" type="button" data-act="run-query" ${running ? 'disabled' : ''} title="执行编辑器中的所有语句（⌘R）">
        ${running ? '<span class="spinner"></span> 执行中' : `${icon('play', 12)}执行 <span class="kbd">⌘R</span>`}
      </button>
      <button class="btn is-ghost is-sm" type="button" data-act="run-current" ${running ? 'disabled' : ''} title="执行光标所在语句（⌘⏎）">执行当前</button>
      <button class="icon-btn" type="button" data-act="explain" ${running ? 'disabled' : ''} title="执行计划（⇧⌘X）" aria-label="执行计划">${icon('info', 15)}</button>
      <button class="icon-btn" type="button" data-act="stop" ${running ? '' : 'disabled'} title="取消查询（⌘.）" aria-label="取消查询">${icon('stop', 14)}</button>
      <span class="toolbar-divider"></span>
      <button class="icon-btn" type="button" data-act="format" title="格式化 SQL（⌘I）" aria-label="格式化">${icon('braces', 15)}</button>
      <button class="icon-btn" type="button" data-act="save-file" title="保存 SQL 文件" aria-label="保存文件">${icon('save', 14)}</button>
      <select class="select" id="query-db" title="查询目标库" aria-label="查询目标库">
        <option>order_db</option>
        <option>log_db</option>
      </select>`;
    meta = `<div class="toolbar-meta">
      <span class="meta-item"><i class="dot ${S.query.running ? 'is-warn' : 'is-err'}"></i>${S.query.running ? '执行中' : 'prod_order · 生产'}</span>
      <span class="meta-item meta-extra">${S.query.elapsed} ms</span>
    </div>`;
  } else if (table) {
    const dirty = dirtyInfo(table.key);
    const filterCount = tableFilters(table.key).length;
    actions += `<span class="toolbar-divider"></span>
      <button class="btn is-primary" type="button" data-act="save" ${dirty.total ? '' : 'disabled'} title="${dirty.total ? '预览并提交未保存改动（⌘S）' : '没有待保存的改动'}">
        ${icon('save', 12)}${dirty.total ? `保存 ${dirty.total}` : '已保存'}
      </button>
      <button class="icon-btn" type="button" data-act="refresh" title="刷新数据：按当前排序与筛选重新查询" aria-label="刷新数据">${icon('refresh', 15)}</button>
      <button class="btn is-ghost is-sm" type="button" data-act="filter" title="筛选：按列加条件（⌘⇧F）">
        ${icon('filter', 12)}筛选${filterCount ? ` <span class="fb-count">${filterCount}</span>` : ''}
      </button>
      <button class="icon-btn" type="button" data-act="export" title="导出当前表（含筛选）" aria-label="导出">${icon('export', 15)}</button>
      <button class="icon-btn" type="button" data-act="more" title="更多操作" aria-label="更多操作">${icon('more', 15)}</button>`;
    meta = `<div class="toolbar-meta">
      <span class="meta-item"><i class="dot"></i>定位策略：${esc(table.strategy)}</span>
      <span class="meta-item meta-extra">最近同步 14:32</span>
    </div>`;
  }

  dom.toolbar.innerHTML = `${identity}<div class="toolbar-actions">${actions}</div>${meta}`;
}

function renderStatus() {
  const table = activeTable();
  const filters = table ? tableFilters(table.key) : [];
  let left = '';
  let right = '';

  if (isQueryScreen()) {
    left = `<span class="st"><b>返回 ${S.query.rows} 行</b></span>
      <span class="st">${S.query.elapsed} ms</span>
      <span class="st">1 条语句</span>
      <span class="st">结果已加载</span>`;
    right = `<span class="st"><i class="dot"></i>prod_order / order_db</span>
      <span class="st">只读结果集</span>`;
  } else if (!table) {
    left = `<span class="st">标签：${S.tabs.length}</span><span class="st">未打开表</span>`;
    right = `<span class="st">⌘K 命令面板</span>`;
  } else {
    const rows = visibleRows(table);
    const dirty = dirtyInfo(table.key);
    const selected = rows.find((r) => r.id === S.selectedRowId);
    left = `<span class="st">${filters.length ? `<b>${rows.length}</b> 行（筛选后）` : `<b>${table.totalRows}</b> 行`}</span>
      <span class="st">查询 ${table.queryMs} ms</span>
      <span class="st">${selected ? `选中 1 行 · ${table.columns.length} 格` : '未选中行'}</span>
      <span class="st">排序 ${esc(S.sort.key)} ${S.sort.dir === 'asc' ? '↑' : '↓'}</span>
      ${dirty.total ? `<span class="st is-warn"><b>未保存 ${dirty.cells} 格${dirty.deleted ? ` · 待删 ${dirty.deleted} 行` : ''}</b></span>` : ''}`;
    right = `<span class="st"><i class="dot ${table.writable ? '' : 'is-idle'}"></i>${table.writable ? `定位键 ${esc(table.strategy)}` : '只读视图'}</span>
      <span class="st">可写 <b>${table.writable ? '是' : '否'}</b></span>
      <span class="st">${esc(table.conn)}</span>`;
  }

  dom.statusbar.innerHTML = `${left}<span class="spacer"></span><div class="right">${right}</div>`;
}

/* --------------------------------------------------------------------------
   6. 左侧树
   -------------------------------------------------------------------------- */
function filterTree(nodes, query) {
  const q = query.trim().toLowerCase();
  const out = [];
  for (const node of nodes) {
    if (node.type === 'group') {
      const children = filterTree(node.children, query);
      if (children.length) out.push({ ...node, children, forceOpen: true });
      continue;
    }
    const name = String(node.name || node.label || '').toLowerCase();
    const children = node.children ? filterTree(node.children, query) : [];
    if (name.includes(q)) {
      out.push({ ...node, children: node.children || [], forceOpen: true });
    } else if (children.length) {
      out.push({ ...node, children, forceOpen: true });
    }
  }
  return out;
}

function treeRow(node, depth) {
  const key = node.key;
  const open = S.expanded.has(key) || node.forceOpen;
  const hasChildren = node.children && node.children.length > 0;
  const selected = S.selectedTreeKey === key;
  const kind = node.type;
  let ico = node.icon || (kind === 'conn' || kind === 'db' ? 'database' : 'table');
  if (kind === 'category' && node.name === '视图') ico = 'view';
  const meta = node.meta ? `<span class="tree-meta">${esc(node.meta)}</span>` : '';
  const count = hasChildren && kind !== 'conn' ? `<span class="tree-count">${node.children.length}</span>` : '';
  const dirty = node.dirty ? '<span class="dirty-dot" title="有未保存改动"></span>' : '';
  const twisty = hasChildren
    ? `<span class="twisty">${icon(open ? 'chevron-down' : 'chevron', 9)}</span>`
    : '<span class="twisty"></span>';
  return `<button class="tree-row is-${kind}${selected ? ' is-selected' : ''}" type="button" role="treeitem"
      aria-expanded="${hasChildren ? open : 'false'}" aria-selected="${selected}"
      data-key="${esc(key)}" data-kind="${kind}" ${node.tableKey ? `data-table="${esc(node.tableKey)}"` : ''}
      style="--depth:${depth}" title="${esc(node.name || node.label)}">
      ${twisty}${kind === 'group' ? '' : `<span class="tree-ico">${icon(ico, 13)}</span>`}
      <span class="tree-name">${esc(node.name || node.label)}</span>${dirty}${meta}${count}
    </button>`;
}

function renderTreeNode(node, depth) {
  if (node.type === 'group') {
    return `<div class="tree-group-label">${esc(node.label)}</div>${node.children
      .map((child) => renderTreeNode(child, depth))
      .join('')}`;
  }
  const open = S.expanded.has(node.key) || node.forceOpen;
  const self = treeRow(node, depth);
  if (node.children && node.children.length && open) {
    return self + node.children.map((child) => renderTreeNode(child, depth + 1)).join('');
  }
  return self;
}

function renderTree() {
  const nodes = S.treeQuery ? filterTree(TREE, S.treeQuery) : TREE;
  if (!nodes.length) {
    dom.tree.innerHTML = '<div class="tree-empty">没有匹配的连接或表。</div>';
    return;
  }
  dom.tree.innerHTML = nodes.map((node) => renderTreeNode(node, 0)).join('');
}

/* --------------------------------------------------------------------------
   7. 条件条 / 详情面板
   -------------------------------------------------------------------------- */
function renderFilterbar() {
  const table = activeTable();
  const filters = table ? tableFilters(table.key) : [];
  if (!table || isQueryScreen() || !filters.length) {
    dom.filterbar.hidden = true;
    dom.filterbar.innerHTML = '';
    return;
  }
  dom.filterbar.hidden = false;
  const chips = filters
    .map((f, i) => {
      const quote = f.col === 'status' || f.col === 'order_no' || f.col === 'path';
      return `<span class="fb-chip" data-filter-idx="${i}">
        <span class="col">${esc(f.col)}</span><span class="op">${esc(f.op)}</span>
        <span class="val${quote ? ' is-string' : ''}">${quote ? `'${esc(f.value)}'` : esc(f.value)}</span>
        <button class="fb-chip-del" type="button" data-remove-filter="${i}" title="删除这条条件并立即重新查询" aria-label="删除条件">${icon('x', 8)}</button>
      </span>`;
    })
    .join('');
  const where = `WHERE ${filters.map((f) => `${f.col} ${f.op} ${f.col === 'status' ? `'${f.value}'` : f.value}`).join(' AND ')}`;
  dom.filterbar.innerHTML = `<span class="fb-label">${icon('filter', 11)}筛选<span class="count">${filters.length}</span></span>
    ${chips}
    <span class="fb-preview" title="${esc(where)}">${esc(where)}</span>
    <button class="fb-clear" type="button" data-act="clear-filters">清空</button>`;
}

function detailColumnsHtml(table) {
  return (table.detailColumns || table.columns)
    .map((c) => {
      const flags = (c.flags || [])
        .map((f) => {
          const cls = f === 'PK' ? 'pk' : f === 'AI' ? 'ai' : f === 'UQ' ? 'uq' : '';
          return `<em class="dc-tag ${cls}">${esc(f)}</em>`;
        })
        .join('');
      return `<div class="detail-col">
        <span class="dc-head"><span class="name" title="${esc(c.label || c.key)}">${esc(c.label || c.key)}</span><span class="flags">${flags}</span></span>
        <span class="dc-meta"><span class="type">${esc(c.type)}</span>${c.comment ? `<span class="dc-comment" title="${esc(c.comment)}">${esc(c.comment)}</span>` : ''}</span>
      </div>`;
    })
    .join('');
}

function execSummaryHtml() {
  const elapsed = S.query.running ? null : S.query.elapsed;
  const net = elapsed == null ? 0 : Math.max(1, Math.round(elapsed * 0.21));
  const parse = elapsed == null ? 0 : Math.max(1, Math.round(elapsed * 0.08));
  const exec = elapsed == null ? 0 : elapsed - net - parse;
  return `<div class="exec-state">${S.query.running ? '<span class="spinner"></span>正在执行…' : '<i class="dot"></i>执行成功 · 14:32:08'}</div>
    <div class="exec-hero">
      <div class="exec-metric"><div class="value">${elapsed == null ? '—' : elapsed}<small>ms</small></div><div class="label">总耗时</div></div>
      <div class="exec-metric"><div class="value">${S.query.rows}</div><div class="label">返回行</div></div>
      <div class="exec-metric"><div class="value">1</div><div class="label">语句</div></div>
    </div>
    <div class="detail-section">
      <h4>执行目标</h4>
      <dl class="detail-kv">
        <dt>连接</dt><dd>prod_order · 生产</dd>
        <dt>数据库</dt><dd class="mono">order_db</dd>
        <dt>语句类型</dt><dd>SELECT</dd>
        <dt>扫描行数</dt><dd>1,284</dd>
        <dt>结果集</dt><dd>已加载 10 / ${S.query.rows} 行</dd>
      </dl>
    </div>
    <div class="detail-section">
      <h4>耗时构成</h4>
      <div class="timing">
        <div class="timing-row"><span>网络</span><span class="timing-track"><span class="timing-fill is-net" style="width:${elapsed ? Math.round((net / elapsed) * 100) : 0}%;display:block"></span></span><span class="ms">${elapsed == null ? '—' : net} ms</span></div>
        <div class="timing-row"><span>解析</span><span class="timing-track"><span class="timing-fill is-parse" style="width:${elapsed ? Math.round((parse / elapsed) * 100) : 0}%;display:block"></span></span><span class="ms">${elapsed == null ? '—' : parse} ms</span></div>
        <div class="timing-row"><span>执行</span><span class="timing-track"><span class="timing-fill" style="width:${elapsed ? Math.round((exec / elapsed) * 100) : 0}%;display:block"></span></span><span class="ms">${elapsed == null ? '—' : exec} ms</span></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>最近执行</h4>
      <div class="recent-list">
        ${HISTORY.slice(0, 4)
          .map(
            (h) => `<div class="recent-item" data-history-sql="${esc(h.sql)}" title="${esc(h.sql)}">
              <span class="sql">${esc(h.sql)}</span><span class="time">${esc(h.meta.split(' · ')[0])}</span><span class="ms">${esc(h.ms)}</span>
            </div>`,
          )
          .join('')}
      </div>
    </div>
    <button class="btn is-ghost is-sm" type="button" data-act="save-snippet">${icon('plus', 12)}保存为片段</button>`;
}

function renderDetailHead(title, name, badge, collapse = true) {
  return `<span class="detail-title">${esc(title)}${name ? `<span class="name">${esc(name)}</span>` : ''}${badge ? `<span class="badge badge--plain">${esc(badge)}</span>` : ''}</span>
    ${collapse ? `<button class="icon-btn is-sm" type="button" data-act="collapse-detail" title="折叠详情" aria-label="折叠详情">${icon('chevron', 13)}</button>` : ''}`;
}

function renderDetail() {
  dom.detail.classList.toggle('is-collapsed', S.detailCollapsed);

  if (isQueryScreen()) {
    dom.detailHead.innerHTML = renderDetailHead('本次执行', '查询 1', '成功', true);
    dom.detailBody.innerHTML = execSummaryHtml();
    return;
  }

  const table = TABLES[S.detailKey] || activeTable();
  if (!table) {
    dom.detailHead.innerHTML = renderDetailHead('详情', '', '', true);
    dom.detailBody.innerHTML = `<div class="detail-empty">在左侧树中单击一张表即可查看它的信息、字段与建表语句。</div>`;
    return;
  }

  const facts = [
    ['类型', table.kindLabel],
    ['引擎', table.engine || '—'],
    ['排序规则', table.collation || '—'],
    ['估算行数', table.totalRows],
    ['字段', `${table.detailColumns.length}`],
    ['索引', `${table.indexes.length}`],
    ['注释', table.comment],
  ];
  const indexTags = table.indexes.length
    ? table.indexes.map((x) => `<span class="tag">${esc(x)}</span>`).join('')
    : '<span class="muted" style="font-size:10.5px">视图无索引</span>';
  const ddl = table.ddlHtml || '<span class="muted">暂无建表语句</span>';

  dom.detailHead.innerHTML = renderDetailHead('表详情', table.name, table.kindLabel, true);
  dom.detailBody.innerHTML = `
    <div class="detail-section">
      <h4>表信息</h4>
      <dl class="detail-kv">
        ${facts
          .map(
            ([k, v]) =>
              `<dt>${esc(k)}</dt><dd class="${k === '排序规则' || k === '引擎' ? 'mono' : ''}" title="${esc(v)}">${esc(v)}</dd>`,
          )
          .join('')}
      </dl>
    </div>
    <div class="detail-section">
      <h4>字段 <span class="meta">${table.detailColumns.length}</span></h4>
      <div class="detail-cols">${detailColumnsHtml(table)}</div>
    </div>
    <div class="detail-section">
      <h4>索引</h4>
      <div class="index-list">${indexTags}</div>
    </div>
    <div class="detail-section">
      <h4>表结构语句 <span class="spacer"></span><button class="copy-btn" type="button" data-act="copy-ddl" title="复制完整建表语句">${icon('copy', 10)}复制</button></h4>
      <pre class="detail-ddl">${ddl}</pre>
    </div>
    <div class="detail-actions">
      <button class="btn is-ghost is-sm" type="button" data-act="design">${icon('braces', 12)}打开表设计</button>
      <button class="btn is-ghost is-sm" type="button" data-act="copy-name" title="复制限定名">${icon('copy', 12)}复制名</button>
    </div>`;
}

/* --------------------------------------------------------------------------
   8. 查询结果区
   -------------------------------------------------------------------------- */
function resultMessageHtml() {
  if (S.query.running) {
    return `<span class="spinner"></span><span class="msg-main">执行中…</span><span>KILL QUERY 可用</span><span class="spacer"></span><span>⌘. 取消</span>`;
  }
  if (S.resultTab === 'result') {
    return `<span class="msg-main">返回 ${S.query.rows} 行</span>
      <span class="dur${S.query.elapsed > 1000 ? ' is-slow' : ''}">${S.query.elapsed}ms</span>
      <span>结果已截断到 200 行</span>
      <span class="spacer"></span>
      <div class="mini-actions">
        <button class="btn is-ghost is-xs" type="button" data-act="export-result">${icon('export', 11)}导出</button>
        <button class="btn is-ghost is-xs" type="button" data-act="open-source">${icon('external', 11)}打开源表</button>
      </div>`;
  }
  if (S.resultTab === 'explain') {
    return `<span class="msg-main">执行计划</span>
      <span>未执行 · 预估扫描 1,284 行</span>
      <span class="dur">2ms</span>
      <span class="spacer"></span>
      <div class="mini-actions">
        <button class="btn is-ghost is-xs" type="button" data-act="copy-plan">${icon('copy', 11)}复制计划</button>
      </div>`;
  }
  return `<span class="msg-main">最近 12 条执行记录</span>
    <span>保存在本机，不上传</span>
    <span class="spacer"></span>
    <div class="mini-actions">
      <button class="btn is-ghost is-xs" type="button" data-act="clear-history">${icon('trash', 11)}清空历史</button>
    </div>`;
}

function renderResults() {
  if (!dom.resultTabs) return;
  $$('.rtab', dom.resultTabs).forEach((tab) => {
    const active = tab.dataset.result === S.resultTab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#result-view-result').hidden = S.resultTab !== 'result';
  $('#result-view-explain').hidden = S.resultTab !== 'explain';
  $('#result-view-history').hidden = S.resultTab !== 'history';
  dom.resultMessage.innerHTML = resultMessageHtml();

  if (S.resultTab === 'result') renderResultGrid();

  if (S.resultTab === 'history' && !$('#history-list').dataset.rendered) {
    $('#history-list').innerHTML = HISTORY.map(
      (h) => `<div class="history-row" data-history-sql="${esc(h.sql)}" title="点击载入这条 SQL">
        <span class="h-ico">${icon('terminal', 12)}</span>
        <div class="h-main"><div class="h-sql">${esc(h.sql)}</div><div class="h-meta">${esc(h.meta)}</div></div>
        <span class="h-dur">${esc(h.ms)}</span>
      </div>`,
    ).join('');
    $('#history-list').dataset.rendered = '1';
  }
}

/* --------------------------------------------------------------------------
   9. 命令面板
   -------------------------------------------------------------------------- */
function paletteModeOf(query) {
  if (query.startsWith(':')) return 'command';
  if (query.startsWith('@')) return 'history';
  return 'table';
}

function paletteResults() {
  const raw = S.palette.query;
  const mode = paletteModeOf(raw);
  const q = raw.replace(/^[:@]\s*/, '').trim().toLowerCase();
  const tables = [
    ['order', 'order', 'prod_order / order_db', '表', 'table'],
    ['order_item', 'order_item', 'prod_order / order_db', '表', 'table'],
    ['v_order_summary', 'view', 'prod_order / order_db', '视图', 'view'],
    ['user', 'user', 'prod_order / order_db', '表', 'table'],
    ['access_log', 'access_log', 'prod_order / log_db', '表', 'table'],
  ].map(([title, tableKey, sub, badge, iconName]) => ({
    id: `table.${tableKey}`,
    group: '表与视图',
    title,
    sub,
    badge,
    icon: iconName,
    action: 'open-table',
    tableKey,
  }));

  let pool = [];
  if (mode === 'command') pool = PALETTE_COMMANDS;
  else if (mode === 'history') pool = PALETTE_HISTORY;
  else pool = [...tables, ...PALETTE_COMMANDS, ...PALETTE_HISTORY];

  const filtered = q
    ? pool.filter((item) => `${item.title} ${item.sub || ''}`.toLowerCase().includes(q))
    : pool;
  return filtered.slice(0, 10);
}

function paletteIcon(item) {
  return icon(item.icon || 'table', 14);
}

function renderPalette() {
  const results = paletteResults();
  S.palette.results = results;
  if (S.palette.index >= results.length) S.palette.index = Math.max(0, results.length - 1);
  const mode = paletteModeOf(S.palette.query);
  $('#palette-mode').textContent = mode === 'command' ? '命令' : mode === 'history' ? '历史' : '表';
  $('#palette-input').placeholder =
    mode === 'command'
      ? '执行命令…'
      : mode === 'history'
        ? '搜索查询历史（⌘S 星标 · ⌘⌫ 删除）'
        : '搜索表、命令或历史（: 命令 · @ 历史）';

  if (!results.length) {
    dom.paletteBody.innerHTML = `<div class="palette-empty">${icon('search', 20)}<span>没有匹配项</span><span style="font-size:10px">换个关键词，或用 : / @ 切换模式</span></div>`;
    return;
  }

  let lastGroup = '';
  dom.paletteBody.innerHTML = results
    .map((item, i) => {
      const head = item.group !== lastGroup ? `<div class="palette-group">${esc(item.group)}</div>` : '';
      lastGroup = item.group;
      return `${head}<button class="palette-row${i === S.palette.index ? ' is-active' : ''}" type="button" data-palette-index="${i}" data-palette-id="${esc(item.id)}">
        <span class="row-ico">${paletteIcon(item)}</span>
        <span class="row-main"><span class="row-title">${esc(item.title)}</span><span class="row-sub">${esc(item.sub || '')}</span></span>
        ${item.badge ? `<span class="badge badge--plain">${esc(item.badge)}</span>` : ''}
        ${item.kbd ? `<kbd class="kbd row-kbd">${esc(item.kbd)}</kbd>` : i === S.palette.index ? '<kbd class="kbd row-kbd">↵</kbd>' : ''}
      </button>`;
    })
    .join('');
}

function setPaletteIndex(index) {
  if (!S.palette.results.length) return;
  S.palette.index = (index + S.palette.results.length) % S.palette.results.length;
  $$('.palette-row', dom.paletteBody).forEach((row, i) => {
    row.classList.toggle('is-active', i === S.palette.index);
  });
}

function choosePaletteItem(item) {
  if (!item) return;
  closePalette();
  if (item.action === 'open-table') {
    openTab(item.tableKey);
    showToast(`已打开 ${item.tableKey}（案例）`);
    return;
  }
  if (item.action === 'new-query') {
    openTab('query');
    return;
  }
  if (item.action === 'filter') {
    routeTo('workspace');
    requestAnimationFrame(() => {
      const anchor = $('[data-act="filter"]');
      if (anchor) openFilterMenu(anchor);
    });
    return;
  }
  if (item.action === 'export') {
    showToast('导出当前表（含筛选）：案例未展开文件选择器', 'ok');
    return;
  }
  if (item.action === 'design') {
    showToast('表设计器是独立界面，本案例的四个界面里没有展开', 'ok');
    return;
  }
  if (item.action === 'theme') {
    toggleTheme();
    return;
  }
  if (item.action === 'history') {
    openTab('query');
    showToast('已载入历史 SQL（案例）');
    return;
  }
}

function openPalette(prefill = '') {
  closeMenu();
  S.overlay = 'palette';
  S.palette.query = prefill;
  S.palette.index = 0;
  if (!S.tabs.includes('query') && S.activeKey === 'query') S.activeKey = S.tabs[0] || null;
  dom.paletteInput.value = prefill;
  renderPalette();
  syncOverlays();
  setHash('palette');
  requestAnimationFrame(() => {
    dom.paletteInput.focus();
    dom.paletteInput.select();
  });
}

function closePalette() {
  S.overlay = null;
  syncOverlays();
  setHash(S.activeKey === 'query' ? 'query' : 'workspace');
}

/* --------------------------------------------------------------------------
   10. 菜单 / 筛选浮层 / 列设置
   -------------------------------------------------------------------------- */
function closeMenu() {
  S.menu = null;
  dom.menuRoot.innerHTML = '';
  dom.popoverScrim.hidden = true;
}

function placeMenu(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - width - margin);
  left = Math.max(margin, left);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 6);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function showMenu(html, anchor, cls = '') {
  closeMenu();
  dom.popoverScrim.hidden = false;
  dom.menuRoot.innerHTML = `<div class="menu ${cls}">${html}</div>`;
  const el = dom.menuRoot.firstElementChild;
  placeMenu(el, anchor);
  S.menu = { el };
}

function openMoreMenu(anchor) {
  const t = activeTable();
  showMenu(
    `<div class="menu-group-label">对象</div>
     <button class="menu-item" type="button" data-menu-action="design">${icon('braces', 14)}<span class="menu-text">设计表结构…</span></button>
     <button class="menu-item" type="button" data-menu-action="import">${icon('import', 14)}<span class="menu-text">从 CSV / Excel 导入…</span><span class="menu-kbd">⇧⌘I</span></button>
     <button class="menu-item" type="button" data-menu-action="paste">${icon('copy', 14)}<span class="menu-text">粘贴多行</span><span class="menu-kbd">⌘V</span></button>
     <div class="menu-sep"></div>
     <button class="menu-item" type="button" data-menu-action="new-window">${icon('external', 14)}<span class="menu-text">在新窗口打开</span><span class="menu-kbd">⇧⌘N</span></button>
     <div class="menu-sep"></div>
     <button class="menu-item is-danger" type="button" data-menu-action="truncate">${icon('trash', 14)}<span class="menu-text">清空表数据…</span></button>`,
    anchor,
  );
  if (t) {
    // 菜单文案里用当前表名，避免「对象」是泛称
    const design = $('[data-menu-action="design"] .menu-text', dom.menuRoot);
    if (design) design.textContent = `设计 ${t.name} 结构…`;
  }
}

function openExportMenu(anchor) {
  showMenu(
    `<div class="menu-group-label">导出 ${esc(activeTable()?.name || '当前表')}</div>
     <button class="menu-item" type="button" data-menu-action="export-csv">${icon('export', 14)}<span class="menu-text">导出为 CSV</span><span class="menu-kbd">⌘E</span></button>
     <button class="menu-item" type="button" data-menu-action="export-xlsx">${icon('export', 14)}<span class="menu-text">导出为 Excel</span></button>
     <div class="menu-sep"></div>
     <button class="menu-item" type="button" data-menu-action="copy-insert">${icon('copy', 14)}<span class="menu-text">复制为 INSERT 语句</span></button>`,
    anchor,
  );
}

function openColumnsMenu(anchor) {
  const table = activeTable();
  if (!table) return;
  const items = table.columns
    .map(
      (c) => `<label class="col-item">
        <input type="checkbox" data-col-toggle="${c.key}" ${S.hiddenCols.has(c.key) ? '' : 'checked'}>
        <span class="col-check">${icon('check', 10)}</span>
        <span class="col-name">${esc(c.key)}</span>
        <span class="col-type">${esc(c.type)}</span>
      </label>`,
    )
    .join('');
  showMenu(
    `<div class="menu-head"><span>显示列</span><span class="spacer"></span><button class="icon-btn" type="button" data-menu-action="show-all" title="全部显示">${icon('refresh', 12)}</button></div>${items}`,
    anchor,
    'col-menu',
  );
}

function openFilterMenu(anchor) {
  const table = activeTable();
  if (!table) return;
  const filters = tableFilters(table.key);
  const rows = [
    filters[0] || { col: table.columns[0].key, op: '=', value: '' },
    filters[1] || { col: table.columns[1].key, op: '=', value: '' },
  ];
  const colOptions = (selected) =>
    table.columns
      .map((c) => `<option value="${c.key}"${c.key === selected ? ' selected' : ''}>${esc(c.key)}</option>`)
      .join('');
  const opOptions = (selected) =>
    ['=', '!=', '>', '<', 'contains']
      .map((op) => `<option value="${op}"${op === selected ? ' selected' : ''}>${op}</option>`)
      .join('');
  const cond = (f, i) =>
    `<div class="cond-row">
      <select class="select" data-cond-col="${i}" aria-label="列">${colOptions(f.col)}</select>
      <select class="select" data-cond-op="${i}" aria-label="操作符">${opOptions(f.op)}</select>
      <input class="input" data-cond-val="${i}" value="${esc(f.value ?? '')}" placeholder="值" aria-label="值">
    </div>`;

  showMenu(
    `<h3>筛选 <span class="filter-target">${esc(table.name)}</span></h3>
     ${cond(rows[0], 0)}
     ${cond(rows[1], 1)}
     <div class="filter-foot">
       <button class="btn is-ghost is-xs" type="button" data-menu-action="filter-clear">清空</button>
       <span class="spacer"></span>
       <button class="btn is-ghost is-xs" type="button" data-menu-action="filter-cancel">取消</button>
       <button class="btn is-primary is-xs" type="button" data-menu-action="filter-apply">应用筛选</button>
     </div>`,
    anchor,
    'filter-pop',
  );
  requestAnimationFrame(() => $('[data-cond-val="0"]', dom.menuRoot)?.focus());
}

function applyFilterMenu() {
  const table = activeTable();
  if (!table) return;
  const next = [];
  for (let i = 0; i < 2; i += 1) {
    const col = $(`[data-cond-col="${i}"]`, dom.menuRoot)?.value;
    const op = $(`[data-cond-op="${i}"]`, dom.menuRoot)?.value;
    const value = $(`[data-cond-val="${i}"]`, dom.menuRoot)?.value.trim();
    if (col && op && value) next.push({ col, op, value });
  }
  S.filters[table.key] = next;
  closeMenu();
  renderToolbar();
  renderFilterbar();
  renderWorkspaceGrid();
  renderStatus();
  showToast(next.length ? `已应用 ${next.length} 条筛选` : '已清空筛选', 'ok');
}

function toggleTheme() {
  S.theme = S.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  renderToolbar();
  renderDetail();
  renderDemoBar();
}

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  const btn = $('#btn-theme');
  if (btn) {
    btn.title = S.theme === 'dark' ? '切换到浅色（T）' : '切换到深色（T）';
    btn.innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon', 14);
  }
}

/* --------------------------------------------------------------------------
   11. 写入预演
   -------------------------------------------------------------------------- */
function openPreview() {
  const table = activeTable();
  if (!table || !dirtyFor(table.key)) {
    showToast('没有待保存的改动', 'ok');
    return;
  }
  closeMenu();
  // 预演固定用 order 的批改；若当前不是 order，先切过去，避免背景与弹窗对不上
  if (S.activeKey !== 'order') {
    if (!S.tabs.includes('order')) S.tabs.unshift('order');
    S.activeKey = 'order';
    S.screen = 'workspace';
    S.detailKey = 'order';
  }
  S.detailKey = 'order';
  S.overlay = 'preview';
  renderAll();
  dom.gateInput.value = '';
  dom.previewConfirm.disabled = true;
  dom.gateHint.textContent = '输入 order 后才能提交';
  syncOverlays();
  setHash('preview');
  requestAnimationFrame(() => dom.gateInput.focus());
}

function closePreview() {
  S.overlay = null;
  syncOverlays();
  setHash(S.activeKey === 'query' ? 'query' : 'workspace');
}

function confirmPreview() {
  if (dom.gateInput.value.trim() !== 'order') return;
  const d = DIRTY.order;
  const deleted = d ? d.deleted.size : 0;
  const cells = d ? d.cells.size : 0;
  if (d) {
    d.cells.clear();
    d.deleted.clear();
  }
  const idx = TABLES.order.rows.findIndex((r) => r.id === 1038);
  if (idx >= 0) TABLES.order.rows.splice(idx, 1);
  S.overlay = null;
  syncOverlays();
  setHash('workspace');
  renderAll();
  showToast(`已提交 3 条语句 · 影响 3 行（${cells} 格 + ${deleted} 行删除）`, 'ok');
}

/* --------------------------------------------------------------------------
   12. 查询执行
   -------------------------------------------------------------------------- */
function runQuery() {
  if (S.query.running) return;
  S.query.running = true;
  renderToolbar();
  renderResults();
  renderDetail();
  renderStatus();
  clearTimeout(S.query.timer);
  S.query.timer = setTimeout(() => {
    S.query.running = false;
    S.query.elapsed = 42;
    S.query.rows = 200;
    S.resultTab = 'result';
    renderToolbar();
    renderResults();
    renderDetail();
    renderStatus();
    showToast('执行完成 · 200 行 · 42 ms', 'ok');
  }, 950);
}

function stopQuery() {
  if (!S.query.running) return;
  clearTimeout(S.query.timer);
  S.query.running = false;
  renderToolbar();
  renderResults();
  renderDetail();
  renderStatus();
  showToast('已取消查询（案例）', 'warn');
}

/* --------------------------------------------------------------------------
   13. 标签 / 树 / 路由
   -------------------------------------------------------------------------- */
function openTab(key) {
  if (!key || !TABLES[key]) return;
  if (!S.tabs.includes(key)) S.tabs.push(key);
  S.activeKey = key;
  S.screen = 'workspace';
  S.overlay = null;
  S.detailKey = key;
  S.selectedTreeKey = treeKeyForTable(key);
  setHash('workspace');
  renderAll();
}

function treeKeyForTable(key) {
  if (key === 'view') return 'obj:prod:order_db:view';
  if (key === 'dev_order') return 'obj:dev:dev:order';
  if (key === 'access_log') return 'obj:prod:log_db:access_log';
  return `obj:prod:order_db:${key}`;
}

function closeTab(key) {
  const i = S.tabs.indexOf(key);
  if (i < 0) return;
  S.tabs.splice(i, 1);
  if (S.activeKey === key) {
    const next = S.tabs[Math.min(i, S.tabs.length - 1)] || null;
    S.activeKey = next;
    S.screen = next === 'query' ? 'query' : 'workspace';
    S.detailKey = next && TABLES[next] ? next : null;
  }
  setHash(S.activeKey === 'query' ? 'query' : 'workspace');
  renderAll();
}

function routeTo(route) {
  closeMenu();
  if (route === 'palette') {
    openPalette('');
    return;
  }
  if (route === 'preview') {
    openPreview();
    return;
  }
  S.overlay = null;
  if (route === 'query') {
    if (!S.tabs.includes('query')) S.tabs.push('query');
    S.activeKey = 'query';
    S.screen = 'query';
  } else {
    S.screen = 'workspace';
    if (!S.tabs.includes(S.activeKey) || S.activeKey === 'query') {
      S.activeKey = S.tabs.find((k) => k !== 'query') || null;
    }
    if (S.activeKey && TABLES[S.activeKey]) S.detailKey = S.activeKey;
  }
  setHash(route);
  renderAll();
}

function setHash(route) {
  if (location.hash !== `#${route}`) history.replaceState(null, '', `#${route}`);
}

/* --------------------------------------------------------------------------
   14. 总渲染
   -------------------------------------------------------------------------- */
function syncOverlays() {
  dom.paletteOverlay.hidden = S.overlay !== 'palette';
  dom.previewOverlay.hidden = S.overlay !== 'preview';
  if (S.overlay === 'palette') {
    requestAnimationFrame(() => dom.paletteInput.focus());
  }
}

function renderPanes() {
  const hasTabs = S.tabs.length > 0;
  const isQuery = isQueryScreen();
  dom.paneWorkspace.hidden = isQuery || !hasTabs;
  dom.paneQuery.hidden = !isQuery;
  dom.paneEmpty.hidden = hasTabs;
  dom.filterbar.hidden = true;
}

function renderAll() {
  applyTheme();
  dom.app.dataset.screen = isQueryScreen() ? 'query' : 'workspace';
  renderTabs();
  renderToolbar();
  renderPanes();
  renderTree();
  if (!isQueryScreen() && activeTable()) {
    renderWorkspaceGrid();
    renderFilterbar();
  } else {
    dom.filterbar.hidden = true;
    dom.filterbar.innerHTML = '';
  }
  renderStatus();
  renderDetail();
  renderResults();
  renderDemoBar();
  syncOverlays();
}

function renderDemoBar() {
  $$('[data-demo-screen]', dom.demoBar).forEach((btn) => {
    const route = btn.dataset.demoScreen;
    const active =
      route === 'workspace'
        ? S.overlay === null && !isQueryScreen()
        : route === 'query'
          ? S.overlay === null && isQueryScreen()
          : S.overlay === route;
    btn.classList.toggle('is-active', active);
  });
  const label = $('#demo-theme-label');
  if (label) label.textContent = S.theme === 'dark' ? '浅色' : '深色';
}

/* --------------------------------------------------------------------------
   15. 事件
   -------------------------------------------------------------------------- */
function showToast(text, tone = 'ok') {
  clearTimeout(S.toastTimer);
  dom.toast.dataset.tone = tone;
  dom.toast.innerHTML = `${icon(tone === 'error' ? 'alert' : tone === 'warn' ? 'alert' : 'check', 13)}<span>${esc(text)}</span>`;
  dom.toast.classList.add('is-show');
  S.toastTimer = setTimeout(() => dom.toast.classList.remove('is-show'), 3200);
}

function onAct(action) {
  switch (action) {
    case 'palette':
      openPalette('');
      break;
    case 'new-query':
      openTab('query');
      break;
    case 'save':
      openPreview();
      break;
    case 'refresh':
      showToast('数据已刷新 · 12 ms（案例）', 'ok');
      break;
    case 'refresh-schema':
      showToast('结构已刷新 · 2 个连接 / 14 张表（案例）', 'ok');
      break;
    case 'new-connection':
      showToast('新建连接：连接编辑器不在本案例的四个界面里', 'ok');
      break;
    case 'filter': {
      const anchor = $('[data-act="filter"]');
      if (anchor) openFilterMenu(anchor);
      break;
    }
    case 'export': {
      const anchor = $('[data-act="export"]');
      if (anchor) openExportMenu(anchor);
      break;
    }
    case 'more': {
      const anchor = $('[data-act="more"]');
      if (anchor) openMoreMenu(anchor);
      break;
    }
    case 'columns': {
      const anchor = $('[data-act="columns"]');
      if (anchor) openColumnsMenu(anchor);
      break;
    }
    case 'copy-row':
      copySelectedRow();
      break;
    case 'copy-ddl': {
      const t = TABLES[S.detailKey] || activeTable();
      if (t) {
        copyText(t.ddlHtml.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
        showToast('已复制建表语句', 'ok');
      }
      break;
    }
    case 'copy-name': {
      const t = TABLES[S.detailKey] || activeTable();
      if (t) {
        copyText(`${t.db}.${t.name}`);
        showToast('已复制限定名', 'ok');
      }
      break;
    }
    case 'design':
      showToast('表设计器是独立界面，本案例的四个界面里没有展开', 'ok');
      break;
    case 'browse':
      showToast('对象浏览：完整版会把清单铺满主区域并支持双击打开', 'ok');
      break;
    case 'settings':
      showToast('偏好设置：快捷键、外观、编辑行为（案例未展开）', 'ok');
      break;
    case 'load-more':
      showToast('已加载下一批 500 行（案例）', 'ok');
      break;
    case 'clear-search':
      S.search = '';
      dom.gridSearch.value = '';
      if (activeTable()) S.filters[activeTable().key] = [];
      renderFilterbar();
      renderWorkspaceGrid();
      renderToolbar();
      renderStatus();
      showToast('已清空查找与筛选', 'ok');
      break;
    case 'clear-filters': {
      const t = activeTable();
      if (t) S.filters[t.key] = [];
      renderFilterbar();
      renderWorkspaceGrid();
      renderToolbar();
      renderStatus();
      showToast('已清空筛选', 'ok');
      break;
    }
    case 'collapse-detail':
      S.detailCollapsed = !S.detailCollapsed;
      renderDetail();
      break;
    case 'run-query':
      runQuery();
      break;
    case 'run-current':
      runQuery();
      break;
    case 'stop':
      stopQuery();
      break;
    case 'explain':
      S.resultTab = 'explain';
      renderResults();
      showToast('执行计划已生成 · 命中 2 个索引（案例）', 'ok');
      break;
    case 'format':
      showToast('SQL 已格式化（案例）', 'ok');
      break;
    case 'save-file':
      showToast('查询 1.sql 已保存（案例）', 'ok');
      break;
    case 'save-snippet':
      showToast('已保存为片段「已支付订单汇总」（案例）', 'ok');
      break;
    case 'export-result':
      showToast('已导出当前结果集（案例）', 'ok');
      break;
    case 'open-source':
      openTab('order');
      showToast('已打开源表 order（案例）', 'ok');
      break;
    case 'copy-plan':
      showToast('已复制执行计划（案例）', 'ok');
      break;
    case 'clear-history':
      showToast('执行历史已清空（案例）', 'ok');
      break;
    default:
      break;
  }
}

function copySelectedRow() {
  const table = activeTable();
  if (!table) return;
  const row = table.rows.find((r) => r.id === S.selectedRowId);
  if (!row) {
    showToast('先选中一行再复制', 'warn');
    return;
  }
  const text = table.columns.map((c) => String(row[c.key] ?? 'NULL')).join('\t');
  copyText(text);
  showToast('已复制选中行（TSV）', 'ok');
}

function bindEvents() {
  // 演示条
  dom.demoBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-demo-screen]');
    if (btn) {
      routeTo(btn.dataset.demoScreen);
      return;
    }
    if (e.target.closest('#demo-theme')) toggleTheme();
  });

  // 侧栏
  $('#btn-theme').addEventListener('click', toggleTheme);
  dom.tree.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const kind = row.dataset.kind;
    const key = row.dataset.key;
    if (kind === 'conn' || kind === 'db' || kind === 'category') {
      if (S.expanded.has(key)) S.expanded.delete(key);
      else S.expanded.add(key);
      renderTree();
      return;
    }
    if (kind === 'object') {
      S.selectedTreeKey = key;
      S.detailKey = row.dataset.table;
      // 只改选中态，不重渲染整棵树：重渲染会把这一行换掉，紧接着的 dblclick 就丢了
      // （Playwright 的 dblclick 也是两次 click；第一次 click 一换 DOM，第二次就落空）。
      $$('.tree-row', dom.tree).forEach((r) => {
        const on = r.dataset.key === key;
        r.classList.toggle('is-selected', on);
        r.setAttribute('aria-selected', String(on));
      });
      if (!isQueryScreen()) renderDetail();
    }
  });
  dom.tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row || row.dataset.kind !== 'object') return;
    const tableKey = row.dataset.table;
    if (tableKey) openTab(tableKey);
  });
  dom.treeSearch.addEventListener('input', () => {
    S.treeQuery = dom.treeSearch.value;
    renderTree();
  });
  dom.treeSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dom.treeSearch.value = '';
      S.treeQuery = '';
      renderTree();
      dom.treeSearch.blur();
      return;
    }
    if (e.key === 'Enter') {
      const first = dom.tree.querySelector('.tree-row.is-object');
      if (first) {
        const tableKey = first.dataset.table;
        if (tableKey) openTab(tableKey);
      }
    }
  });

  // 标签栏
  dom.tabs.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close-tab]');
    if (close) {
      e.stopPropagation();
      closeTab(close.dataset.closeTab);
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    const key = tab.dataset.tab;
    S.activeKey = key;
    S.screen = key === 'query' ? 'query' : 'workspace';
    S.detailKey = TABLES[key] ? key : null;
    if (TABLES[key]) S.selectedTreeKey = treeKeyForTable(key);
    setHash(S.screen);
    renderAll();
  });

  // 标签栏右侧按钮
  $('.tabstrip-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) onAct(btn.dataset.act);
  });

  // 工具栏（事件委托；每次重渲染后依然有效）
  dom.toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) onAct(btn.dataset.act);
  });
  dom.toolbar.addEventListener('change', (e) => {
    if (e.target.id === 'query-db') showToast(`查询目标库：${e.target.value}（案例）`, 'ok');
  });

  // 条件条
  dom.filterbar.addEventListener('click', (e) => {
    const del = e.target.closest('[data-remove-filter]');
    if (del) {
      const t = activeTable();
      if (!t) return;
      const idx = Number(del.dataset.removeFilter);
      S.filters[t.key] = tableFilters(t.key).filter((_, i) => i !== idx);
      renderFilterbar();
      renderWorkspaceGrid();
      renderToolbar();
      renderStatus();
      showToast('已删除该条件并重新查询', 'ok');
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) onAct(act.dataset.act);
  });

  // 网格
  dom.gridWrap.addEventListener('click', (e) => {
    const fk = e.target.closest('.cell-link');
    if (fk) {
      e.preventDefault();
      showToast('打开关联表 user，并按 id 定位（案例）', 'ok');
      return;
    }
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (S.sort.key === key) S.sort.dir = S.sort.dir === 'asc' ? 'desc' : 'asc';
      else S.sort = { key, dir: 'asc' };
      renderWorkspaceGrid();
      renderStatus();
      showToast(`按 ${key} ${S.sort.dir === 'asc' ? '升序' : '降序'}排序`, 'ok');
      return;
    }
    const row = e.target.closest('tr[data-row-id]');
    if (!row) return;
    const id = Number(row.dataset.rowId);
    S.selectedRowId = id;
    const td = e.target.closest('td[data-col]');
    S.selectedCell = td ? { id, col: td.dataset.col } : null;
    // 同理：选中不要重建整张表，否则双击单元格时第二下 click 会落在已被替换的节点上。
    $$('tbody tr[data-row-id]', dom.gridWrap).forEach((tr) => {
      tr.classList.toggle('is-selected', Number(tr.dataset.rowId) === id);
    });
    $$('td.is-active-cell', dom.gridWrap).forEach((cell) => cell.classList.remove('is-active-cell'));
    if (td) td.classList.add('is-active-cell');
    renderStatus();
  });
  dom.gridWrap.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('td[data-col]');
    if (!cell) return;
    showToast('双击单元格：打开完整值（案例）', 'ok');
  });

  // 网格工具条
  dom.gridSearch.addEventListener('input', () => {
    S.search = dom.gridSearch.value;
    renderWorkspaceGrid();
    renderStatus();
  });
  dom.gridRowheight.addEventListener('change', () => {
    document.documentElement.style.setProperty('--case-row-h', `${dom.gridRowheight.value}px`);
    showToast(`行高：${dom.gridRowheight.value}px`, 'ok');
  });
  dom.gridJump.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const n = Number(dom.gridJump.value);
    if (!n || n < 1) return;
    const table = activeTable();
    if (!table) return;
    const rows = visibleRows(table);
    const target = rows[Math.min(n - 1, rows.length - 1)];
    if (target) {
      S.selectedRowId = target.id;
      renderWorkspaceGrid();
      renderStatus();
      showToast(`已定位到第 ${n} 行`, 'ok');
    }
  });
  $('.grid-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) onAct(btn.dataset.act);
  });

  // 详情
  dom.detail.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) onAct(act.dataset.act);
    const recent = e.target.closest('[data-history-sql]');
    if (recent) showToast('已把这条 SQL 载入查询编辑器（案例）', 'ok');
  });
  $('#btn-detail-expand').addEventListener('click', () => {
    S.detailCollapsed = false;
    renderDetail();
  });

  // 结果区
  dom.resultTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-result]');
    if (!tab) return;
    S.resultTab = tab.dataset.result;
    renderResults();
  });
  dom.resultMessage.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) onAct(btn.dataset.act);
  });
  dom.resultGridWrap.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (S.resultSort.key === key) S.resultSort.dir = S.resultSort.dir === 'asc' ? 'desc' : 'asc';
      else S.resultSort = { key, dir: 'asc' };
      renderResultGrid();
      return;
    }
    const row = e.target.closest('tr[data-row-id]');
    if (row) {
      S.querySelected = Number(row.dataset.rowId);
      renderResultGrid();
    }
  });
  $('#history-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-history-sql]');
    if (row) showToast('已载入历史 SQL（案例）', 'ok');
  });

  // 命令面板
  dom.paletteOverlay.addEventListener('mousedown', (e) => {
    if (e.target === dom.paletteOverlay) closePalette();
  });
  dom.paletteInput.addEventListener('input', () => {
    S.palette.query = dom.paletteInput.value;
    S.palette.index = 0;
    renderPalette();
  });
  dom.paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setPaletteIndex(S.palette.index + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      choosePaletteItem(S.palette.results[S.palette.index]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });
  dom.paletteBody.addEventListener('click', (e) => {
    const row = e.target.closest('[data-palette-index]');
    if (!row) return;
    const idx = Number(row.dataset.paletteIndex);
    S.palette.index = idx;
    choosePaletteItem(S.palette.results[idx]);
  });
  dom.paletteBody.addEventListener('mouseover', (e) => {
    const row = e.target.closest('[data-palette-index]');
    if (row) setPaletteIndex(Number(row.dataset.paletteIndex));
  });

  // 弹窗
  dom.previewOverlay.addEventListener('mousedown', (e) => {
    if (e.target === dom.previewOverlay) closePreview();
  });
  $('#preview-close').addEventListener('click', closePreview);
  $('#preview-cancel').addEventListener('click', closePreview);
  dom.gateInput.addEventListener('input', () => {
    const ok = dom.gateInput.value.trim() === 'order';
    dom.previewConfirm.disabled = !ok;
    dom.gateHint.textContent = ok ? '匹配，可以提交' : '输入 order 后才能提交';
    dom.gateHint.style.color = ok ? 'var(--dsw-alias-state-success-primary)' : '';
  });
  dom.gateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !dom.previewConfirm.disabled) confirmPreview();
  });
  dom.previewConfirm.addEventListener('click', confirmPreview);

  // 菜单
  dom.popoverScrim.addEventListener('mousedown', closeMenu);
  dom.menuRoot.addEventListener('click', (e) => {
    const item = e.target.closest('[data-menu-action]');
    if (!item) return;
    const action = item.dataset.menuAction;
    if (action === 'filter-apply') {
      applyFilterMenu();
      return;
    }
    if (action === 'filter-clear') {
      const t = activeTable();
      if (t) S.filters[t.key] = [];
      closeMenu();
      renderToolbar();
      renderFilterbar();
      renderWorkspaceGrid();
      renderStatus();
      showToast('已清空筛选', 'ok');
      return;
    }
    if (action === 'filter-cancel') {
      closeMenu();
      return;
    }
    if (action === 'show-all') {
      S.hiddenCols.clear();
      renderWorkspaceGrid();
      closeMenu();
      showToast('已显示全部列', 'ok');
      return;
    }
    if (action === 'export-csv' || action === 'export-xlsx' || action === 'copy-insert') {
      closeMenu();
      showToast(
        action === 'export-csv'
          ? '已按当前筛选导出 CSV（案例）'
          : action === 'export-xlsx'
            ? '已按当前筛选导出 Excel（案例）'
            : '已复制 INSERT 语句（案例）',
        'ok',
      );
      return;
    }
    if (action === 'import') {
      closeMenu();
      showToast('导入向导不在本案例的四个界面里，但组件语言可以复用', 'ok');
      return;
    }
    if (action === 'new-window') {
      closeMenu();
      showToast('已在新窗口打开 order（案例）', 'ok');
      return;
    }
    if (action === 'truncate') {
      closeMenu();
      showToast('清空表数据需要二次确认与表名门禁（案例未展开）', 'warn');
      return;
    }
    if (action === 'design') {
      closeMenu();
      onAct('design');
      return;
    }
    if (action === 'paste') {
      closeMenu();
      showToast('粘贴多行：从剪贴板按列对齐（案例）', 'ok');
    }
  });
  dom.menuRoot.addEventListener('change', (e) => {
    const input = e.target.closest('[data-col-toggle]');
    if (!input) return;
    const table = activeTable();
    if (!table) return;
    const key = input.dataset.colToggle;
    if (input.checked) S.hiddenCols.delete(key);
    else {
      const visible = table.columns.filter((c) => !S.hiddenCols.has(c.key));
      if (visible.length <= 1) {
        input.checked = true;
        showToast('至少保留一列', 'warn');
        return;
      }
      S.hiddenCols.add(key);
    }
    renderWorkspaceGrid();
  });

  // 键盘
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (S.overlay === 'palette') closePalette();
      else openPalette('');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
      e.preventDefault();
      openTab('query');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r' && isQueryScreen()) {
      e.preventDefault();
      runQuery();
      return;
    }
    if (e.key === 'Escape') {
      if (S.menu) {
        closeMenu();
        return;
      }
      if (S.overlay === 'palette') {
        closePalette();
        return;
      }
      if (S.overlay === 'preview') {
        closePreview();
        return;
      }
    }
    if (S.overlay) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (isQueryScreen()) onAct('save-file');
      else openPreview();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f' && !isQueryScreen()) {
      e.preventDefault();
      const anchor = $('[data-act="filter"]');
      if (anchor) openFilterMenu(anchor);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !isQueryScreen()) {
      e.preventDefault();
      dom.gridSearch.focus();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && isQueryScreen()) {
      e.preventDefault();
      runQuery();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (S.menu) return;
    if (e.key === '1') routeTo('workspace');
    if (e.key === '2') routeTo('query');
    if (e.key === '3') routeTo('palette');
    if (e.key === '4') routeTo('preview');
    if (e.key.toLowerCase() === 't') toggleTheme();
  });

  window.addEventListener('hashchange', () => {
    const route = (location.hash || '#workspace').slice(1);
    if (route === 'palette') {
      S.overlay = 'palette';
      S.palette.query = '';
      S.palette.index = 0;
      dom.paletteInput.value = '';
      renderPalette();
      syncOverlays();
      return;
    }
    if (route === 'preview') {
      S.activeKey = 'order';
      S.screen = 'workspace';
      S.detailKey = 'order';
      S.overlay = 'preview';
      renderAll();
      dom.gateInput.value = '';
      dom.previewConfirm.disabled = true;
      dom.gateHint.textContent = '输入 order 后才能提交';
      syncOverlays();
      return;
    }
    S.overlay = null;
    if (route === 'query') {
      S.activeKey = 'query';
      S.screen = 'query';
    } else {
      S.screen = 'workspace';
      if (!S.activeKey || S.activeKey === 'query') S.activeKey = S.tabs.find((k) => k !== 'query') || null;
    }
    renderAll();
  });

  window.addEventListener('resize', () => {
    if (S.menu) closeMenu();
  });
}

/* --------------------------------------------------------------------------
   16. 启动
   -------------------------------------------------------------------------- */
function init() {
  dom.app = $('#app');
  dom.demoBar = $('#demo-bar');
  dom.tree = $('#tree');
  dom.treeSearch = $('#tree-search');
  dom.tabs = $('#tabs');
  dom.toolbar = $('#toolbar');
  dom.filterbar = $('#filterbar');
  dom.paneWorkspace = $('#pane-workspace');
  dom.paneQuery = $('#pane-query');
  dom.paneEmpty = $('#pane-empty');
  dom.gridWrap = $('#grid-wrap');
  dom.gridFoot = $('#grid-foot');
  dom.gtMeta = $('#gt-meta');
  dom.gridSearch = $('#grid-search');
  dom.gridRowheight = $('#grid-rowheight');
  dom.gridJump = $('#grid-jump');
  dom.readonlyBanner = $('#readonly-banner');
  dom.statusbar = $('#statusbar');
  dom.detail = $('#detail');
  dom.detailHead = $('#detail-head');
  dom.detailBody = $('#detail-body');
  dom.resultTabs = $('#result-tabs');
  dom.resultMessage = $('#result-message');
  dom.resultGridWrap = $('#result-grid-wrap');
  dom.paletteOverlay = $('#palette-overlay');
  dom.paletteInput = $('#palette-input');
  dom.paletteBody = $('#palette-body');
  dom.previewOverlay = $('#preview-overlay');
  dom.gateInput = $('#gate-input');
  dom.gateHint = $('#gate-hint');
  dom.previewConfirm = $('#preview-confirm');
  dom.popoverScrim = $('#popover-scrim');
  dom.menuRoot = $('#menu-root');
  dom.toast = $('#toast');

  const params = new URLSearchParams(location.search);
  S.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  if (params.get('clean') === '1') document.documentElement.classList.add('clean');

  const route = (location.hash || '#workspace').slice(1);
  if (route === 'query') {
    S.activeKey = 'query';
    S.screen = 'query';
  } else {
    S.activeKey = 'order';
    S.screen = 'workspace';
    if (route === 'palette') {
      S.overlay = 'palette';
      S.palette.query = '';
    } else if (route === 'preview') {
      S.overlay = 'preview';
    }
  }

  bindEvents();
  renderAll();
  if (S.overlay === 'palette') {
    dom.paletteInput.value = S.palette.query;
    renderPalette();
    requestAnimationFrame(() => {
      dom.paletteInput.focus();
      dom.paletteInput.select();
    });
  }
  if (S.overlay === 'preview') {
    dom.gateInput.value = '';
    dom.previewConfirm.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', init);