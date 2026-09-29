// C2 懒加载版（PRD 目标方案）：启动路径上【不】 require 任何重型依赖。
// 驱动(mysql2/pg/ssh2)、CodeMirror、node:sqlite 全部首次使用时才 import。
// 本探针只创建空壳窗口 + 最小渲染进程，以隔离「懒加载策略」对冷启动的影响。
import { startApp } from './timing.mjs';

startApp({ label: 'C2-lazy' });
