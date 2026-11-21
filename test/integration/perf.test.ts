/**
 * Plan §11 Phase 5 performance (opt-in: DEVJACK_PERF=1 npm run test:integration):
 * under 50 ms of work at activation, and about zero CPU when idle.
 * process.cpuUsage() measures the whole extension host (DevJack plus VS Code's built-in extensions),
 * so the idle figure is an upper bound for DevJack.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { DevJackApi } from '../../src/devjack';
import { activate, sleep, until } from './helpers';

function cpuPercent(ms: number): Promise<number> {
  const c0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  return sleep(ms).then(() => {
    const c = process.cpuUsage(c0);
    const wall = Number(process.hrtime.bigint() - t0) / 1000; // µs
    return ((c.user + c.system) / wall) * 100;
  });
}

(process.env.DEVJACK_PERF ? suite : suite.skip)('DevJack performance (Phase 5)', function () {
  this.timeout(120000);
  let api: DevJackApi;

  suiteSetup(async () => {
    api = await activate();
  });

  test('activation takes under 50 ms', () => {
    console.log(`      activate(): ${api.activationMs?.toFixed(1)} ms`);
    assert.ok(api.activationMs !== undefined && api.activationMs < 50, `activation took ${api.activationMs} ms`);
  });

  test('idle, no table: extension host CPU about zero', async () => {
    await sleep(3000); // let startup work settle
    const pct = await cpuPercent(30_000);
    console.log(`      extension host CPU, idle, 30 s: ${pct.toFixed(3)} %`);
    assert.ok(pct < 1, `idle CPU ${pct.toFixed(2)} %`);
  });

  test('idle, table open (free play, betting): extension host CPU about zero', async () => {
    await vscode.commands.executeCommand('devjack.openTable');
    await until('table ready', () => api.isTableReady(), 10000);
    await sleep(3000);
    const pct = await cpuPercent(30_000);
    console.log(`      extension host CPU, table open and idle, 30 s: ${pct.toFixed(3)} %`);
    assert.ok(pct < 1, `idle CPU with the table open ${pct.toFixed(2)} %`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
