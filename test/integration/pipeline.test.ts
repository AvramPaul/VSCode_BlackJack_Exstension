/**
 * Phase 2 end-to-end proof, inside a real VS Code (@vscode/test-cli), with temporary DEVJACK_HOME and
 * CLAUDE_CONFIG_DIR (see .vscode-test.mjs): DevJack auto-connects, then the *installed* hook commands
 * from the generated settings.json are run exactly as Claude Code would run them.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DevJackApi } from '../../src/devjack';
import { activate, endSessions, fire, registry, setting, settingsPath, sleep, tableTabs, until, workspace } from './helpers';

suite('DevJack pipeline (Phase 2)', function () {
  this.timeout(60000);
  let api: DevJackApi;

  suiteSetup(async () => {
    api = await activate();
  });
  teardown(async () => {
    await endSessions();
    await until('idle between tests', () => api.windowState().state === 'idle' && !api.isTableOpen(), 10000);
  });

  test('auto-connect wrote current hooks into the Claude config dir', () => {
    const text = fs.readFileSync(settingsPath(), 'utf8');
    assert.ok(text.includes('"UserPromptSubmit"') && text.includes('"PermissionRequest"'));
    assert.ok(!text.includes('PreToolUse'), 'no PreToolUse entry');
  });

  test('prompt → table opens (routed by cwd); permission → waiting; Stop → table closes', async () => {
    fire('UserPromptSubmit', { session_id: 'it-1', prompt_id: 'p1', cwd: workspace() });
    await until('table open', () => api.isTableOpen());
    assert.strictEqual(api.windowState().state, 'working');
    await until('one table tab', () => tableTabs().length === 1, 3000); // the tab model updates a moment later
    await until('the game loaded under the CSP and said ready', () => api.isTableReady(), 8000);
    fire('PermissionRequest', { session_id: 'it-1', prompt_id: 'p1', cwd: workspace(), tool_name: 'Bash' });
    await until('waiting', () => api.windowState().state === 'waiting');
    fire('Stop', { session_id: 'it-1', prompt_id: 'p1', cwd: workspace() });
    await until('table closed', () => !api.isTableOpen());
    await until('no table tab', () => tableTabs().length === 0, 3000);
  });

  test('routed by window id even outside the workspace', async () => {
    fire('UserPromptSubmit', { session_id: 'it-2', prompt_id: 'p1', cwd: path.parse(workspace()).root }, api.windowId);
    await until('table open', () => api.isTableOpen());
    fire('StopFailure', { session_id: 'it-2', prompt_id: 'p1', error: 'rate_limit' });
    await until('table closed', () => !api.isTableOpen());
  });

  test('another folder and another window: not mine, nothing opens', async () => {
    fire('UserPromptSubmit', { session_id: 'it-3', prompt_id: 'p1', cwd: path.join(path.parse(workspace()).root, 'some', 'other', 'project') }, 'ffff0000');
    await sleep(3500);
    assert.strictEqual(api.isTableOpen(), false);
    assert.strictEqual(api.windowState().state, 'idle');
  });

  test('closed by the user mid-turn: stays closed until the next prompt', async () => {
    fire('UserPromptSubmit', { session_id: 'it-4', prompt_id: 'p1', cwd: workspace() });
    await until('table open', () => api.isTableOpen());
    await until('table tab', () => tableTabs().length === 1, 3000);
    await vscode.window.tabGroups.close(tableTabs());
    await until('closed', () => !api.isTableOpen());
    fire('PermissionRequest', { session_id: 'it-4', prompt_id: 'p1', cwd: workspace(), tool_name: 'Bash' });
    const rm = registry('it-4', 'busy');
    await until('working again', () => api.windowState().state === 'working');
    await sleep(3500);
    assert.strictEqual(api.isTableOpen(), false, 'reopened after a dismissal');
    fire('Stop', { session_id: 'it-4', prompt_id: 'p1', cwd: workspace() });
    await until('idle', () => api.windowState().state === 'idle');
    fire('UserPromptSubmit', { session_id: 'it-4', prompt_id: 'p2', cwd: workspace() });
    await until('reopened on the next prompt', () => api.isTableOpen());
    fire('Stop', { session_id: 'it-4', prompt_id: 'p2', cwd: workspace() });
    await until('closed', () => !api.isTableOpen());
    rm(); // the registry file disappears only when the session's process exits, i.e. after its last turn
  });

  test('session registry "idle" (Esc / Stop button) closes the table without a Stop hook', async () => {
    fire('UserPromptSubmit', { session_id: 'it-5', prompt_id: 'p1', cwd: workspace() });
    await until('table open', () => api.isTableOpen());
    const rm = registry('it-5', 'idle');
    await until('table closed', () => !api.isTableOpen());
    rm();
  });

  test('Simulate Claude Run goes through the inbox and opens the table', async () => {
    void vscode.commands.executeCommand('devjack.simulate');
    await until('table open', () => api.isTableOpen(), 6000);
    await until('needs you', () => api.windowState().state === 'waiting', 10000);
    await until('closed after the run', () => !api.isTableOpen(), 20000);
  });

  // Opt-in (costs one small model call): DEVJACK_E2E_CLAUDE=1 npm run test:integration
  (process.env.DEVJACK_E2E_CLAUDE ? test : test.skip)('real Claude Code: `claude -p` fires the installed hooks, the table opens and closes', async () => {
    await setting('openDelaySeconds', 0);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE') && k !== 'DEVJACK_WINDOW_ID') env[k] = v; // real login, no nesting markers
    let sawOpen = false;
    const poll = setInterval(() => (sawOpen ||= api.isTableOpen()), 50);
    const { spawn } = await import('child_process');
    const code = await new Promise<number | null>((resolve) => {
      // Only DevJack's generated settings: --setting-sources project skips the user's own hooks.
      const p = spawn('claude', ['-p', 'Write three short sentences about playing cards.', '--model', 'haiku', '--setting-sources', 'project', '--settings', settingsPath(), '--no-session-persistence'], { cwd: workspace(), env, shell: process.platform === 'win32', windowsHide: true });
      p.on('close', resolve);
      p.on('error', () => resolve(null));
    });
    clearInterval(poll);
    await setting('openDelaySeconds', 2.5);
    assert.strictEqual(code, 0, 'claude -p failed');
    assert.ok(sawOpen, 'the table never opened while Claude worked');
    await until('table closed after Stop', () => !api.isTableOpen());
  });

  test('disconnect removes our entries and keeps the rest of the file; connect restores them', async () => {
    await vscode.commands.executeCommand('devjack.disconnect');
    const j = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    assert.deepStrictEqual(j, { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } });
    assert.ok(Object.values(api.connectionStatus()).includes('userDisconnected'));
    await vscode.commands.executeCommand('devjack.connect');
    await until('connected again', () => Object.values(api.connectionStatus()).includes('connected'));
    assert.ok(fs.readFileSync(settingsPath(), 'utf8').includes('"UserPromptSubmit"'));
  });
});
