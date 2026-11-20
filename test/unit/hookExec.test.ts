/**
 * Runs the generated hook command for real on this OS (plan §9 "Hook command tests"):
 * Windows → powershell.exe exec form; macOS/Linux → `sh -c <command>`.
 * Checks: exit 0, nothing on stdout or stderr, the expected inbox file, byte-identical payload.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEntry, flavorFor, type HookEntry } from '../../src/claude/hookCommand';

const flavor = flavorFor(process.platform);
let root: string;
let home: string;

function run(entry: HookEntry, stdin: string, env: Record<string, string> = {}) {
  const opts = { input: Buffer.from(stdin, 'utf8'), env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 };
  const r = entry.args ? spawnSync(entry.command, entry.args, opts) : spawnSync('/bin/sh', ['-c', entry.command], opts);
  return { status: r.status, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '', error: r.error };
}
const inbox = () => path.join(home, 'inbox');
const files = () => (fs.existsSync(inbox()) ? fs.readdirSync(inbox()) : []);
const setHeartbeat = (ageMs: number | null) => {
  const hb = path.join(home, 'heartbeat');
  if (ageMs === null) return fs.rmSync(hb, { force: true });
  fs.writeFileSync(hb, '');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(hb, t, t);
};

const PAYLOAD = JSON.stringify({
  session_id: 's-1',
  prompt_id: 'p-1',
  cwd: process.platform === 'win32' ? "C:\\Users\\Ana Ștefan\\proiect ș 'x" : "/home/ana/proiect ș 'x",
  prompt: 'Salut — 🃏 "quotes" \\ backslash $HOME `tick`',
  hook_event_name: 'UserPromptSubmit',
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-exec-'));
  home = path.join(root, "Ana Ștefan's home", '.devjack');
  fs.mkdirSync(home, { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe(`hook command (${flavor})`, () => {
  it('writes the payload unchanged when the heartbeat is fresh', () => {
    setHeartbeat(0);
    fs.rmSync(inbox(), { recursive: true, force: true });
    const r = run(buildEntry(flavor, home, 'start'), PAYLOAD, { DEVJACK_WINDOW_ID: 'abc123XYZ;rm -rf' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    const names = files();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d+-\d+-start\.json$/);
    const j = JSON.parse(fs.readFileSync(path.join(inbox(), names[0]!), 'utf8'));
    expect(j.v).toBe(2);
    expect(j.signal).toBe('start');
    expect(j.window).toMatch(/^abc123/); // only [a-f0-9] survive
    expect(j.window).not.toMatch(/[^a-fA-F0-9]/);
    expect(JSON.stringify(j.payload)).toBe(PAYLOAD);
  });

  it('counts 90 s as fresh', () => {
    setHeartbeat(90_000);
    fs.rmSync(inbox(), { recursive: true, force: true });
    expect(run(buildEntry(flavor, home, 'done'), PAYLOAD).status).toBe(0);
    expect(files()).toHaveLength(1);
  });

  it.each([
    ['stale (150 s)', 150_000],
    ['missing', null],
  ])('exits 0 silently and writes nothing when the heartbeat is %s', (_label, age) => {
    setHeartbeat(age as number | null);
    fs.rmSync(inbox(), { recursive: true, force: true });
    const r = run(buildEntry(flavor, home, 'start'), PAYLOAD);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(fs.existsSync(inbox())).toBe(false);
  });

  it('survives empty stdin', () => {
    setHeartbeat(0);
    fs.rmSync(inbox(), { recursive: true, force: true });
    const r = run(buildEntry(flavor, home, 'end'), '');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(files()).toHaveLength(1);
  });

  it('leaves no .tmp files behind', () => {
    expect(files().filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
