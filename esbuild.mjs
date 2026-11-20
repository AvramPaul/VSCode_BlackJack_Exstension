// Builds:
// - dist/extension.js (node, cjs, vscode external) and dist/uninstall.js
// - dist/webview/main.js + main.css (browser): the game
// - out/test/integration/*.js (integration tests; not shipped)
// - with --harness: webview/dev/build/harness.{js,css} (browser dev harness); --serve serves it with live reload
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const harness = process.argv.includes('--harness') || process.argv.includes('--serve');
const serve = process.argv.includes('--serve');

/** @type {esbuild.BuildOptions} */
const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // jsonc-parser's "main" is a UMD build with dynamic requires esbuild can't follow; use its ESM build.
  mainFields: ['module', 'main'],
};

/** @type {esbuild.BuildOptions} */
const browser = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  // VS Code 1.94 runs Electron 30 (Chromium 124).
  target: 'chrome120',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  { ...node, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  // Runs with VS Code's own Node at uninstall time: no vscode API available.
  { ...node, entryPoints: ['src/uninstall.ts'], outfile: 'dist/uninstall.js' },
  { ...browser, entryPoints: ['webview/main.ts'], outfile: 'dist/webview/main.js' },
];
if (!production) builds.push({ ...node, entryPoints: ['test/integration/behavior.test.ts', 'test/integration/pipeline.test.ts'], outdir: 'out/test/integration', external: ['vscode', 'mocha'] });
if (harness) builds.push({ ...browser, entryPoints: ['webview/dev/harness.ts'], outfile: 'webview/dev/build/harness.js', sourcemap: true });

if (watch || serve) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  if (serve) {
    const h = ctxs[ctxs.length - 1];
    const { port } = await h.serve({ servedir: 'webview/dev', port: 5179 });
    console.log(`\n  DevJack harness: http://localhost:${port}/  (?scenario=midhand&w=360&h=700)\n`);
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
