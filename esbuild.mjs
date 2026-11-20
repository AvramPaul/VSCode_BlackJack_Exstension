// Builds the extension host bundle (node, cjs, vscode external) and the uninstall script.
// The game webview bundle (browser) is added in Phase 4.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // jsonc-parser's "main" is a UMD build with dynamic requires esbuild can't follow; use its ESM build.
  mainFields: ['module', 'main'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  // Runs with VS Code's own Node at uninstall time: no vscode API available.
  { ...common, entryPoints: ['src/uninstall.ts'], outfile: 'dist/uninstall.js' },
  // Integration tests (Phase 2 end-to-end proof); not shipped.
  { ...common, entryPoints: ['test/integration/behavior.test.ts', 'test/integration/pipeline.test.ts'], outdir: 'out/test/integration', external: ['vscode', 'mocha'] },
];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
