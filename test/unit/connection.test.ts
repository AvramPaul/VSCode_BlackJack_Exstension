import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyToSettings, BACKUP_SUFFIX, decideAutoConnect, inspect, readState, updateState } from '../../src/claude/connection';
import { desiredHooks } from '../../src/claude/hookCommand';
import { analyze } from '../../src/claude/settingsEditor';

const D = desiredHooks(process.platform === 'win32' ? 'powershell-exec' : 'sh', '/tmp/home/.devjack');
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures/settings', name), 'utf8');

let root: string;
let cfg: string;
let noManaged: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-conn-'));
  cfg = path.join(root, '.claude');
  noManaged = path.join(root, 'no-managed-settings.json');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const settings = () => path.join(cfg, 'settings.json');

describe('applyToSettings', () => {
  it('never creates the Claude config folder', () => {
    expect(applyToSettings(cfg, D, { managedPath: noManaged }).outcome).toBe('claudeMissing');
    expect(fs.existsSync(cfg)).toBe(false);
  });

  it('creates settings.json in an existing config folder (no backup: nothing to back up)', () => {
    fs.mkdirSync(cfg);
    expect(applyToSettings(cfg, D, { managedPath: noManaged }).outcome).toBe('connected');
    expect(analyze(fs.readFileSync(settings(), 'utf8'), D).hooks.state).toBe('current');
    expect(fs.existsSync(settings() + BACKUP_SUFFIX)).toBe(false);
  });

  it('backs up once, then is idempotent, then disconnects cleanly', () => {
    fs.mkdirSync(cfg);
    const original = fixture('user-hooks.json');
    fs.writeFileSync(settings(), original);
    expect(applyToSettings(cfg, D, { managedPath: noManaged }).outcome).toBe('connected');
    expect(fs.readFileSync(settings() + BACKUP_SUFFIX, 'utf8')).toBe(original);
    const mtime = fs.statSync(settings()).mtimeMs;
    expect(applyToSettings(cfg, D, { managedPath: noManaged }).outcome).toBe('alreadyCurrent');
    expect(fs.statSync(settings()).mtimeMs).toBe(mtime); // no write at all
    fs.writeFileSync(settings() + BACKUP_SUFFIX, 'changed'); // the backup is one-time: never overwritten
    expect(applyToSettings(cfg, null).outcome).toBe('disconnected');
    expect(JSON.parse(fs.readFileSync(settings(), 'utf8'))).toEqual(JSON.parse(original));
    expect(fs.readFileSync(settings() + BACKUP_SUFFIX, 'utf8')).toBe('changed');
    expect(applyToSettings(cfg, null).outcome).toBe('alreadyDisconnected');
  });

  it.each(['invalid-trailing-comma.json', 'hooks-not-object.json', 'disable-all-hooks.json'])('blocked by %s: file untouched', (name) => {
    fs.mkdirSync(cfg);
    fs.writeFileSync(settings(), fixture(name));
    const r = applyToSettings(cfg, D, { managedPath: noManaged });
    expect(r.outcome).toBe('blocked');
    expect(fs.readFileSync(settings(), 'utf8')).toBe(fixture(name));
    expect(fs.existsSync(settings() + BACKUP_SUFFIX)).toBe(false);
  });

  it('managed settings with allowManagedHooksOnly block too', () => {
    fs.mkdirSync(cfg);
    const managed = path.join(root, 'managed.json');
    fs.writeFileSync(managed, '{"allowManagedHooksOnly": true}');
    expect(applyToSettings(cfg, D, { managedPath: managed })).toMatchObject({ outcome: 'blocked', blockers: ['allowManagedHooksOnly'] });
    expect(inspect(cfg, D, managed).managedBlockers).toEqual(['allowManagedHooksOnly']);
  });

  it('leaves no temp files', () => {
    fs.mkdirSync(cfg);
    applyToSettings(cfg, D, { managedPath: noManaged });
    expect(fs.readdirSync(cfg).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('state and auto-connect decisions', () => {
  const missing = analyze('{}', D);
  const current = analyze(JSON.stringify({ hooks: Object.fromEntries(Object.entries(D).map(([e, h]) => [e, [{ hooks: [h] }]])) }), D);
  const v1 = analyze(fixture('v1-entries.json'), D);

  it('connects once per config folder, never silently again', () => {
    const s = readState(root);
    expect(decideAutoConnect(s, cfg, missing, true)).toBe('connect');
    const after = updateState(root, (x) => x.autoConnected.push(cfg));
    expect(decideAutoConnect(after, cfg, missing, true)).toBe('removedAfterConnect');
    expect(decideAutoConnect(after, cfg, current, true)).toBe('none');
  });
  it('upgrades v1 or outdated entries; respects a manual disconnect and the setting', () => {
    const s = readState(root);
    expect(decideAutoConnect(s, cfg, v1, true)).toBe('upgrade');
    expect(decideAutoConnect(s, cfg, missing, false)).toBe('off');
    const d = updateState(root, (x) => x.manualDisconnect.push(cfg));
    expect(decideAutoConnect(d, cfg, missing, true)).toBe('userDisconnected');
  });
  it('survives a corrupt state file', () => {
    fs.writeFileSync(path.join(root, 'state.json'), '{nope');
    expect(readState(root)).toEqual({ v: 1, autoConnected: [], manualDisconnect: [], connected: [] });
  });
});
