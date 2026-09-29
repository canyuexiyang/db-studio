import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 根 Vitest 配置。
 *
 * 各包通过 alias 互相引用（@dbstudio/*），这样集成测试能直接按包名 import，
 * 不必等打包产物 —— 开发期更快，也让"模块间契约"可被测试守住。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dbstudio/core-sql-guard': resolve(__dirname, 'packages/core-sql-guard/src/index.ts'),
      '@dbstudio/core-sql-ident': resolve(__dirname, 'packages/core-sql-ident/src/index.ts'),
      '@dbstudio/core-history': resolve(__dirname, 'packages/core-history/src/index.ts'),
      '@dbstudio/core-schema-cache': resolve(__dirname, 'packages/core-schema-cache/src/index.ts'),
      '@dbstudio/core-secret': resolve(__dirname, 'packages/core-secret/src/index.ts'),
      '@dbstudio/core-export': resolve(__dirname, 'packages/core-export/src/index.ts'),
      '@dbstudio/core-connection': resolve(__dirname, 'packages/core-connection/src/index.ts'),
      '@dbstudio/core-driver-mysql': resolve(__dirname, 'packages/core-driver-mysql/src/index.ts'),
      '@dbstudio/core-ipc-codec': resolve(__dirname, 'packages/core-ipc-codec/src/index.ts'),
      '@dbstudio/core-mutation': resolve(__dirname, 'packages/core-mutation/src/index.ts'),
      '@dbstudio/core-grid-view': resolve(__dirname, 'packages/core-grid-view/src/index.ts'),
      '@dbstudio/core-clipboard': resolve(__dirname, 'packages/core-clipboard/src/index.ts'),
      '@dbstudio/core-filter': resolve(__dirname, 'packages/core-filter/src/index.ts'),
      '@dbstudio/core-tree-view': resolve(__dirname, 'packages/core-tree-view/src/index.ts'),
      '@dbstudio/core-command-palette': resolve(__dirname, 'packages/core-command-palette/src/index.ts'),
      '@dbstudio/core-sql-editor': resolve(__dirname, 'packages/core-sql-editor/src/index.ts'),
      '@dbstudio/core-sql-editor/facts': resolve(__dirname, 'packages/core-sql-editor/src/facts.ts'),
      '@dbstudio/core-sql-editor/tokens': resolve(__dirname, 'packages/core-sql-editor/src/tokens.ts'),
      '@dbstudio/core-sql-editor/formatter': resolve(__dirname, 'packages/core-sql-editor/src/formatter.ts'),
      '@dbstudio/core-sql-editor/lint': resolve(__dirname, 'packages/core-sql-editor/src/lint.ts'),
      '@dbstudio/core-sql-editor/hints': resolve(__dirname, 'packages/core-sql-editor/src/hints.ts'),
      '@dbstudio/core-ssh-tunnel': resolve(__dirname, 'packages/core-ssh-tunnel/src/index.ts'),
      '@dbstudio/core-table-designer': resolve(__dirname, 'packages/core-table-designer/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // node:sqlite 会打 ExperimentalWarning，不影响结果，静音保持输出干净
    silent: false,
  },
});
