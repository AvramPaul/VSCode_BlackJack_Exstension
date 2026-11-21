import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', 'spike/**', '.vscode-test/**', '.dev/**', 'webview/dev/build/**', 'esbuild.mjs', 'eslint.config.mjs', '.vscode-test.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    // Node scripts; render-assets.mjs also passes callbacks into the browser page (window).
    languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', Buffer: 'readonly', window: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
);
