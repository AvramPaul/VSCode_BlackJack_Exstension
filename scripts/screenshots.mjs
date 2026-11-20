// Screenshots of the game harness (plan §9: check the visuals at 360, 700 and 1400 px).
// Usage: node scripts/screenshots.mjs [scenario,...] [WxH,...]  → .dev/shots/<scenario>-<W>x<H>.png
// Needs Chrome or Edge; uses a throwaway profile so it never touches the user's browser.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const browsers = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = browsers.find((b) => fs.existsSync(b));
if (!browser) throw new Error('No Chrome/Edge found (set CHROME_PATH)');

const scenarios = (process.argv[2] ?? 'betting,midhand,split,insurance,blackjack,win').split(',');
const sizes = (process.argv[3] ?? '360x700,700x800,1400x900').split(',').map((s) => s.split('x').map(Number));
const extra = process.argv[4] ?? '';

execFileSync(process.execPath, ['esbuild.mjs', '--harness'], { stdio: 'ignore' });
const out = path.resolve('.dev/shots');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-shots-'));
const page = pathToFileURL(path.resolve('webview/dev/index.html')).href;

try {
  for (const sc of scenarios) {
    for (const [w, h] of sizes) {
      const file = path.join(out, `${sc}${extra ? '-' + extra.replace(/[^a-z0-9]+/gi, '_') : ''}-${w}x${h}.png`);
      const url = `${page}?scenario=${sc}&bare&reduced&w=${w}&h=${h}${extra ? '&' + extra : ''}`;
      const budget = /keys=/.test(extra) ? 2000 + extra.split(',').length * 1000 : 1500;
      execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, `--window-size=${w},${h}`, `--virtual-time-budget=${budget}`, `--screenshot=${file}`, url], { stdio: 'ignore', timeout: 60000 });
      console.log(file);
    }
  }
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
