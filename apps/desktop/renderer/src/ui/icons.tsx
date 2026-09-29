/**
 * 内联 SVG 图标(lucide 风格线条,currentColor 跟随文字色)。
 *
 * UI 设计规范红线:禁止用 emoji 当图标(🔑✅❌⚠️ 等),所有界面图标统一从
 * 这里取。颜色不写死,由所在文字的 color 决定,方便浅色/深色两套主题。
 *
 * 线宽约定:外形图标 2,小尺寸(≤14px)下的加粗图标 2.4~2.6,保证 120Hz 屏上不发虚。
 */

interface IconProps {
  size?: number;
}

export function IconCheck({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconX({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 警示:圆角三角 + 感叹号 */
export function IconAlert({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.3 4.1 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 9.5v4.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 加号:新建(连接/查询) */
export function IconPlus({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** 齿轮:编辑连接 */
export function IconGear({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 2.8 13.4 5a7.3 7.3 0 0 1 2.6 1.1l2.5-.7 1.5 2.6-1.8 1.9a7.4 7.4 0 0 1 0 2.8l1.8 1.9-1.5 2.6-2.5-.7a7.3 7.3 0 0 1-2.6 1.1L12 21.2 10.6 19a7.3 7.3 0 0 1-2.6-1.1l-2.5.7-1.5-2.6 1.8-1.9a7.4 7.4 0 0 1 0-2.8L4 9.4l1.5-2.6 2.5.7A7.3 7.3 0 0 1 10.6 5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 刷新:重新拉取 schema */
export function IconRefresh({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M21 3v6h-6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 数据库(圆柱):连接/库节点 */
export function IconDatabase({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="8" ry="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** 表格:表节点 */
export function IconTable({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 9.5h17M9.5 9.5v10" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** 眼睛:视图节点 */
export function IconEye({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** 花括号:存储过程节点 */
export function IconBraces({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4c-2 0-3 1-3 3v2.5c0 1.5-1 2.5-2.5 2.5C4 12 5 13 5 14.5V17c0 2 1 3 3 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 4c2 0 3 1 3 3v2.5c0 1.5 1 2.5 2.5 2.5-1.5 0-2.5 1-2.5 2.5V17c0 2-1 3-3 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** 函数(λ):函数节点 */
export function IconFn({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h4M16 5h3M6 5c2.5 0 3.4 1.6 4.6 4.6l4 8.8c1 2.3 2 2.6 3.9 2.6M8.2 14.5h7.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 锁:只读标识 */
export function IconLock({ size = 11 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 终端提示符:SQL 查询 */
export function IconTerminal({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 7 5 5-5 5M12.5 17H19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 保存(软盘):保存改动 */
export function IconSave({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 3.5h11L20.5 8v11a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M8 3.5V8h7V3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <rect x="7.5" y="13" width="9" height="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** 漏斗:筛选 */
export function IconFilter({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 5h17l-6.5 7.6v6.4l-4-2v-4.4L3.5 5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/** 向下出托盘:导出 */
export function IconExport({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5v10m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15.5v3A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 向上进托盘:导入 */
export function IconImport({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 13.5v-10m0 0 4 4m-4-4-4 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15.5v3A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 两张叠页:复制 */
export function IconCopy({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** 剪贴板:粘贴 */
export function IconPaste({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4.5h6M9 4.5a1.5 1.5 0 0 0-1.5 1.5H6A2 2 0 0 0 4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-1.5A1.5 1.5 0 0 0 15 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="9" y="3" width="6" height="3.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** 笔尖加尺:设计表结构 */
export function IconDesign({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="m6.5 16.5 9.7-9.7a2 2 0 0 0 0-2.8 2 2 0 0 0-2.8 0L3.7 13.7 3 20l6.3-.7-2.8-2.8Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

/** 搜索:命令面板 */
export function IconSearch({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="m16.5 16.5 4 4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 插头:连接/断开握手 */
export function IconPlug({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3.5V8m6-4.5V8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round" />
      <path d="M12 17v3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 电源:断开 */
export function IconPower({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M7 6.3a7.5 7.5 0 1 0 10 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

// ---------- R1 并行研发新增（2026-09-26） ----------

/** 星形:收藏表（C5） */
export function IconStar({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.6Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

/** 实心星形:已收藏态（fill 跟随 currentColor） */
export function IconStarFilled({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.6Z" fill="currentColor" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

/** 多列:列显示/隐藏选择器（A5） */
export function IconColumns({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9.2 4.5v15M14.8 4.5v15" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

/** 折行:单元格换行显示（A18） */
export function IconWrap({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5h16M4 12h13a3.5 3.5 0 0 1 0 7h-3m0 0 2.2-2.2M14 19l2.2 2.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17.5h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** 二进制:HEX/BLOB 查看（A10） */
export function IconBinary({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M15.5 7.5h2m-11 11h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** 图片:图片预览（A10） */
export function IconImage({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="9" cy="9.5" r="1.7" fill="currentColor" stroke="none" />
      <path d="m4.5 17 4.7-4.7a1.5 1.5 0 0 1 2.1 0l5.2 5.2m-2.6-2.6 1.8-1.8a1.5 1.5 0 0 1 2.1 0l2.7 2.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 带码文件:.sql 文件（C8） */
export function IconFileCode({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M14 3.5V8h4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="m10 12-2 2.5 2 2.5m4-5 2 2.5-2 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 箭头到底线:跳转到行（A16） */
export function IconJumpDown({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 20h15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 放大镜加号:字体放大（F2） */
export function IconZoomIn({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="m16.5 16.5 4 4M8.2 11h5.6M11 8.2v5.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 放大镜减号:字体缩小（F2） */
export function IconZoomOut({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="m16.5 16.5 4 4M8.2 11h5.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 圆形感叹号:表信息/详情（C9） */
export function IconInfo({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="7.8" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 闪电:触发器节点（C1） */
export function IconZap({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12L13 3Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

/** 时钟:定时/事件节点（C1） */
export function IconClock({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v5.2l3.4 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 冻结列（V8）：左侧一块被竖线钉住的区域 */
export function IconFreeze({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9.5 4v16" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M3.4 8.5h5.8M3.4 13h5.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
    </svg>
  );
}

/** 转置（V12）：行列互换 —— 一个矩阵加一条对角翻转箭头 */
export function IconTranspose({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 20 20 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.5 4.5h5v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 外键链接（V9）：两个节点被一条引用线连起来 */
export function IconLink({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.2 13.8a3.8 3.8 0 0 0 5.6.3l2.4-2.4a3.9 3.9 0 0 0-5.5-5.5l-1.4 1.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.8 10.2a3.8 3.8 0 0 0-5.6-.3l-2.4 2.4a3.9 3.9 0 0 0 5.5 5.5l1.4-1.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 批量编辑（V13）：多行加一支笔 */
export function IconBatchEdit({ size = 12 }: IconProps) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5h7M4 12h5M4 17.5h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M13.6 17.4 20 11a2 2 0 0 0-2.9-2.8l-6.4 6.4-1 3.8 3.9-1Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}
