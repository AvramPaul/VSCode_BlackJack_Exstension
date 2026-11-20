import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DevJackApi } from '../../src/devjack';

export const EXT_ID = 'todo-publisher.devjack';
export const cfgDir = () => process.env.CLAUDE_CONFIG_DIR!;
export const settingsPath = () => path.join(cfgDir(), 'settings.json');
export const workspace = () => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(what: string, cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Stays true for the whole period (polling), e.g. "the table never opens". */
export async function during(what: string, cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert.ok(cond(), `violated during the wait: ${what}`);
    await sleep(50);
  }
}

export async function activate(): Promise<DevJackApi> {
  const ext = vscode.extensions.getExtension<DevJackApi>(EXT_ID);
  assert.ok(ext, 'extension not found');
  const api = await ext!.activate();
  await until('connected', () => Object.values(api.connectionStatus()).includes('connected'));
  return api;
}

interface Entry {
  command: string;
  args?: string[];
}
function installed(event: string): Entry {
  const j = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  const groups = (j.hooks?.[event] ?? []) as { hooks: Entry[] }[];
  const e = groups.flatMap((g) => g.hooks).find((h) => h.command.includes('devjack') || h.command === 'powershell.exe');
  assert.ok(e, `no DevJack entry for ${event}`);
  return e!;
}

/** Sessions used by the current test; `endSessions` (in teardown) ends them so one failure can't cascade. */
const used = new Set<string>();
export async function endSessions() {
  for (const s of used) fire('SessionEnd', { session_id: s, reason: 'other' });
  used.clear();
  await sleep(1500); // let the inbox poll pick them up
}

/** Run the installed DevJack hook for `event` exactly like Claude Code (exec form: spawn with args; shell form: sh -c). */
export function fire(event: string, payload: Record<string, unknown>, window = '') {
  if (typeof payload.session_id === 'string' && event !== 'SessionEnd') used.add(payload.session_id);
  const e = installed(event);
  const input = JSON.stringify({ hook_event_name: event, ...payload });
  const opts = { input, env: { ...process.env, DEVJACK_WINDOW_ID: window }, windowsHide: true, timeout: 15000 };
  const r = e.args ? spawnSync(e.command, e.args, opts) : spawnSync('/bin/sh', ['-c', e.command], opts);
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  assert.strictEqual(String(r.stdout), '', 'hook printed to stdout');
}

/** Write a session-registry file the way Claude Code does. */
export function registry(sessionId: string, status: string, waitingFor?: string) {
  const dir = path.join(cfgDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const pid = 400000 + (Math.abs([...sessionId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 99999);
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: workspace(), status, waitingFor, statusUpdatedAt: Date.now() + 500 }));
  return () => fs.rmSync(path.join(dir, `${pid}.json`), { force: true });
}

export const tableTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('devjack.table'));

export async function setting(key: string, value: unknown) {
  await vscode.workspace.getConfiguration('devjack').update(key, value, vscode.ConfigurationTarget.Global);
}
