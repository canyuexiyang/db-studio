#!/usr/bin/env node
/**
 * T11 / T50：从动作目录生成「菜单 / 快捷键」事实表文档。
 *
 * 🔴 为什么必须是**生成**而不是手写：报告 §4.2 的病根就是「同一份键位被三处各写一遍」。
 *    手写文档会成为第四处，且一定会漂移。这里让文档 = `action-catalog.ts` 的投影，
 *    改键位只改一处，跑一次脚本文档自动跟上（`npm run gen:actions`）。
 *
 * 用法：npm run gen:actions            # 写入 docs/product/ACTION-CATALOG-自动生成.md
 *       npm run gen:actions -- --check # 只校验（CI/verify 用）：文档过期则 exit 1
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIONS,
  findAcceleratorConflicts,
  findCrossLayerConflicts,
} from '../apps/desktop/src/shared/action-catalog.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'docs/product/ACTION-CATALOG-自动生成.md');

const SCOPE_LABEL = {
  global: '全局',
  table: '表标签',
  grid: '网格',
  sql: 'SQL 编辑器',
  tree: '对象树',
  dialog: '弹窗',
};

const SURFACE_LABEL = {
  menu: '原生菜单',
  palette: '命令面板',
  toolbar: '顶部工具栏',
  'grid-toolbar': '网格工具栏',
  'tree-context': '树右键',
  'grid-context': '网格右键',
  'cell-context': '单元格右键',
  'column-context': '列头右键',
  'tab-context': '标签右键',
  'sql-toolbar': 'SQL 工具栏',
  'sql-context': 'SQL 右键',
};

/** T15：目标对象的中文名 */
const TARGET_LABEL = {
  app: '应用本身',
  connection: '连接',
  database: '数据库',
  table: '表',
  row: '行',
  cell: '单元格',
  tab: '标签',
  sql: 'SQL 编辑器',
  window: '窗口',
};


function render() {
  const conflicts = findAcceleratorConflicts();
  const crossLayer = findCrossLayerConflicts();

  const lines = [];
  lines.push('# 动作 / 菜单 / 快捷键 事实表（自动生成）');
  lines.push('');
  lines.push('> ⚠️ **本文件由 `npm run gen:actions` 从 `apps/desktop/src/shared/action-catalog.ts` 生成，请勿手改。**');
  lines.push('> 改键位请改目录源文件，然后重跑生成脚本。手改本文件会在校验时被判为过期。');
  lines.push('');
  lines.push('## 冲突自检');
  lines.push('');
  lines.push(`- 同层键位冲突：**${conflicts.length === 0 ? '无' : conflicts.length + ' 处'}**`);
  for (const c of conflicts) lines.push(`  - ❌ ${c}`);
  lines.push(`- 跨层键位冲突（局部键被原生菜单抢先拦截）：**${crossLayer.length === 0 ? '无' : crossLayer.length + ' 处'}**`);
  for (const c of crossLayer) lines.push(`  - ❌ ${c}`);
  lines.push('');

  // 按 scope 分组
  const byScope = new Map();
  for (const a of ACTIONS) {
    const list = byScope.get(a.scope) ?? [];
    list.push(a);
    byScope.set(a.scope, list);
  }

  for (const scope of ['global', 'table', 'grid', 'sql', 'tree', 'dialog']) {
    const list = byScope.get(scope);
    if (!list || list.length === 0) continue;
    lines.push(`## ${SCOPE_LABEL[scope] ?? scope}（scope: \`${scope}\`）`);
    lines.push('');
    // T15：四个维度（目标对象 / 可用条件 / 只改草稿 / 需确认 SQL）全在表里
    lines.push('| 动作 | 键位 | 目标对象 | 入口 | 可用条件 | 只改草稿 | 需确认 SQL |');
    lines.push('| --- | --- | --- | --- | --- | :---: | :---: |');
    for (const a of list) {
      const acc = a.display ? `\`${a.display}\`` : '—';
      const surfaces = a.surfaces.map((s) => SURFACE_LABEL[s] ?? s).join('、');
      const target = TARGET_LABEL[a.target] ?? a.target;
      lines.push(
        `| ${a.label}<br><sub>\`${a.id}\`</sub> | ${acc} | ${target} | ${surfaces} | ${a.availableWhen} | ${
          a.localDraftOnly ? '是' : '否'
        } | ${a.requiresSqlConfirm ? '是' : '否'} |`,
      );
    }
    lines.push('');
  }

  // 裁定记录
  const notes = ACTIONS.filter((a) => a.note);
  if (notes.length > 0) {
    lines.push('## 键位裁定记录（报告 §4.2 的落点）');
    lines.push('');
    for (const a of notes) {
      lines.push(`### ${a.label}（\`${a.id}\`）`);
      lines.push('');
      lines.push(`- 键位：${a.display ? `\`${a.display}\`` : '无'}`);
      lines.push(`- ${a.note}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`共 ${ACTIONS.length} 条动作。`);
  lines.push('');
  return lines.join('\n');
}

const content = render();

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (current !== content) {
    console.error(
      '[gen:actions] ❌ docs/product/ACTION-CATALOG-自动生成.md 已过期。\n' +
        '           跑 `npm run gen:actions` 重新生成后一并提交。',
    );
    process.exit(1);
  }
  console.log('[gen:actions] ✅ 事实表文档与动作目录一致');
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, content, 'utf8');
console.log(`[gen:actions] ✅ 已写入 ${OUT.replace(ROOT + '/', '')}（${ACTIONS.length} 条动作）`);

const conflicts = findAcceleratorConflicts();
const crossLayer = findCrossLayerConflicts();
if (conflicts.length || crossLayer.length) {
  console.error('[gen:actions] ❌ 动作目录存在键位冲突：');
  for (const c of [...conflicts, ...crossLayer]) console.error('  - ' + c);
  process.exit(1);
}
