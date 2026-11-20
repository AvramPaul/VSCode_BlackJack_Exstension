// Integration tests (@vscode/test-cli). Temporary DEVJACK_HOME and CLAUDE_CONFIG_DIR: the real
// ~/.claude/settings.json is never touched. Runs against the `engines` minimum (1.94.0) by default;
// set DEVJACK_TEST_VSCODE=stable to use the latest.
import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-it-'));
const home = path.join(root, "Ana Ștefan's home", '.devjack');
const claude = path.join(root, '.claude');
const workspace = path.join(root, 'proiect ș');
fs.mkdirSync(claude, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
// A user settings file with one user hook, to prove it survives connect + disconnect.
console.log(`[devjack-it] root: ${root}`);
fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }, null, 2) + '\n');

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: process.env.DEVJACK_TEST_VSCODE || '1.94.0',
  workspaceFolder: workspace,
  // A fresh user-data dir per run: back-to-back runs never share workspace state or locks.
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(root, 'user-data')}`],
  env: { DEVJACK_HOME: home, CLAUDE_CONFIG_DIR: claude, DEVJACK_LOG_FILE: path.join(root, 'devjack.log'), DEVJACK_NO_WELCOME: '1' },
  mocha: { ui: 'tdd', timeout: 60000 },
});
