/** Phase 3: table behavior (plan §5.8) in a real VS Code, through the installed hook commands. */
import * as assert from 'assert';
import type { DevJackApi } from '../../src/devjack';
import { activate, during, endSessions, fire, registry, setting, sleep, until, workspace } from './helpers';

suite('DevJack table behavior (Phase 3)', function () {
  this.timeout(60000);
  let api: DevJackApi;
  let n = 0;
  const sid = () => `beh-${++n}`;

  suiteSetup(async () => {
    api = await activate();
    await setting('openDelaySeconds', 2.5);
    await setting('closeBehavior', 'afterHand');
  });
  teardown(async () => {
    await setting('closeBehavior', 'afterHand');
    api.setPaused(undefined);
    await endSessions();
    await until('idle between tests', () => api.windowState().state === 'idle' && !api.isTableOpen(), 10000);
  });

  test('a quick answer (< 2.5 s) never shows the table', async () => {
    const s = sid();
    fire('UserPromptSubmit', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    await sleep(600);
    fire('Stop', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    await during('table stays closed', () => !api.isTableOpen(), 4000);
  });

  test('opens after the delay, then "Done ✓" for ~1 s and closes', async () => {
    const s = sid();
    fire('UserPromptSubmit', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    const t0 = Date.now();
    await until('open', () => api.isTableOpen(), 8000);
    assert.ok(Date.now() - t0 >= 1500, `opened too early (${Date.now() - t0} ms)`);
    fire('Stop', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    await until('idle', () => api.windowState().state === 'idle');
    assert.strictEqual(api.isTableOpen(), true, 'closed before the Done grace');
    await until('closed after the grace', () => !api.isTableOpen(), 4000);
  });

  test("doesn't open while Claude asks right away; opens after the approval", async () => {
    const s = sid();
    fire('UserPromptSubmit', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    fire('PermissionRequest', { session_id: s, prompt_id: 'p1', cwd: workspace(), tool_name: 'Bash' });
    await until('waiting', () => api.windowState().state === 'waiting');
    await during('no table while Claude waits', () => !api.isTableOpen(), 4000);
    const rm = registry(s, 'busy'); // the user approved
    await until('working', () => api.windowState().state === 'working');
    await until('open after the delay', () => api.isTableOpen(), 8000);
    fire('Stop', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    rm();
  });

  test('closeBehavior "immediately" closes without the grace', async () => {
    await setting('closeBehavior', 'immediately');
    const s = sid();
    fire('UserPromptSubmit', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    await until('open', () => api.isTableOpen(), 8000);
    fire('Stop', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    await until('idle', () => api.windowState().state === 'idle');
    await until('closed at once', () => !api.isTableOpen(), 600);
  });

  test('paused: Claude works, the table stays closed', async () => {
    api.setPaused('restart');
    const s = sid();
    fire('UserPromptSubmit', { session_id: s, prompt_id: 'p1', cwd: workspace() });
    await until('working', () => api.windowState().state === 'working');
    await during('table stays closed', () => !api.isTableOpen(), 4000);
    fire('Stop', { session_id: s, prompt_id: 'p1', cwd: workspace() });
  });
});
