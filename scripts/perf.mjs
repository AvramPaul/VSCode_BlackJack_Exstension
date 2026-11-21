// Phase 5 performance checks (plan §11): `npm run perf`.
// 1. Code loading of the production bundle (dist/extension.js) in fresh Node processes, vscode stubbed.
// 2. Micro-benchmark of the idle work (inbox and registry polls, heartbeat).
// 3. Table idle check in headless Chrome: timer / animation-frame callbacks and running animations.
// The in-VS Code part (activate() time, extension host CPU) is: DEVJACK_PERF=1 npm run test:integration
import { execFileSync } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

// Harness first: it also writes dev builds into dist/, which the production build then replaces.
execFileSync(process.execPath, ['esbuild.mjs', '--harness'], { stdio: 'ignore' });
execFileSync(process.execPath, ['esbuild.mjs', '--production'], { stdio: 'ignore' });

// ---------------------------------------------------------------- 1. code loading
const loader = `
const Module = require('module');
const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), construct: () => stub, apply: () => stub });
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? stub : orig.call(this, req, ...rest); };
const t = process.hrtime.bigint();
require(process.argv[1]);
console.log(Number(process.hrtime.bigint() - t) / 1e6);
`;
const loads = [];
for (let i = 0; i < 7; i++) loads.push(Number(execFileSync(process.execPath, ['-e', loader, path.resolve('dist/extension.js')]).toString().trim()));
loads.sort((a, b) => a - b);
console.log(`1. loading dist/extension.js (${(fs.statSync('dist/extension.js').size / 1024).toFixed(0)} KB): median ${loads[3].toFixed(1)} ms (min ${loads[0].toFixed(1)}, max ${loads[6].toFixed(1)})\n`);

// ---------------------------------------------------------------- 2. idle work
console.log('2. idle work (micro-benchmark)');
const bench = path.resolve('.dev/bench-idle.cjs');
await esbuild.build({ entryPoints: ['scripts/bench-idle.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bench, logLevel: 'silent' });
execFileSync(process.execPath, [bench], { stdio: 'inherit' });
console.log('');

// ---------------------------------------------------------------- 3. table idle (headless Chrome)
const browsers = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const browser = browsers.find((b) => fs.existsSync(b));
if (!browser) {
  console.log('3. table idle: skipped (no Chrome/Edge found)');
} else {
  console.log('3. table idle, 10 s after settling (headless Chrome)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-perf-'));
  const page = pathToFileURL(path.resolve('webview/dev/index.html')).href;
  try {
    for (const claude of ['idle', 'working', 'waiting']) {
      const url = `${page}?scenario=betting&bare&idlecheck=10000&claude=${claude}`;
      const dom = execFileSync(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--virtual-time-budget=15000', '--dump-dom', url], { timeout: 60000 }).toString();
      const m = /<pre id="idle-result">(.*?)<\/pre>/.exec(dom);
      const r = m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : undefined;
      console.log(`   Claude ${claude.padEnd(8)} ${r ? `timeouts ${r.timeout}, intervals ${r.interval}, animation frames ${r.raf}, running animations [${r.animations.join(', ')}]` : 'no result'}`);
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
