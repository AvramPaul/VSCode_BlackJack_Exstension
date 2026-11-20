import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildEntry, desiredHooks, flavorFor } from '../../src/claude/hookCommand';
import { isClaudeCommandLine } from '../../src/claude/claudeCommandLine';
import { parseInboxFile } from '../../src/claude/inbox';
import { claudeConfigDir, devjackHome, panelConfigDirFromSetting } from '../../src/claude/paths';
import { SessionTracker } from '../../src/claude/sessionTracker';
import { SIM_STEPS, writeInboxEvent } from '../../src/claude/simulate';
import { belowMinimum, compareVersions, parseVersion } from '../../src/claude/versions';
import { inspect } from '../../src/claude/connection';
import { renderReport, runEntry, type DiagnosticsInput } from '../../src/diagnostics';

describe('isClaudeCommandLine', () => {
  it('recognizes claude invocations, not other commands', () => {
    for (const l of ['claude', 'claude -c', '  claude --resume x', 'claude.exe -p hi', '& "C:\\Users\\me\\.local\\bin\\claude.exe" -c', './claude', '/usr/local/bin/claude']) expect(isClaudeCommandLine(l)).toBe(true);
    for (const l of ['claudette', 'npm run claude-test', 'echo claude', 'git commit -m claude', 'cat claude.md']) expect(isClaudeCommandLine(l)).toBe(false);
  });
});

describe('paths', () => {
  it('honors absolute DEVJACK_HOME / CLAUDE_CONFIG_DIR only', () => {
    expect(devjackHome({ DEVJACK_HOME: path.resolve('/x/dj') }, '/home/me')).toBe(path.resolve('/x/dj'));
    expect(devjackHome({ DEVJACK_HOME: 'relative' }, '/home/me')).toBe(path.join('/home/me', '.devjack'));
    expect(claudeConfigDir({}, '/home/me')).toBe(path.join('/home/me', '.claude'));
  });
  it("reads the panel's CLAUDE_CONFIG_DIR from claudeCode.environmentVariables", () => {
    const abs = path.resolve('/cfg/panel');
    expect(panelConfigDirFromSetting([{ name: 'FOO', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: abs }])).toBe(abs);
    expect(panelConfigDirFromSetting([{ name: 'CLAUDE_CONFIG_DIR', value: 'rel' }])).toBeUndefined();
    expect(panelConfigDirFromSetting('nope')).toBeUndefined();
  });
});

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('2.1.328 (Claude Code)')).toBe('2.1.328');
    expect(compareVersions('2.1.139', '2.1.138')).toBe(1);
    expect(compareVersions('2.1.9', '2.1.139')).toBe(-1);
    expect(compareVersions('2.2.0', '2.1.999')).toBe(1);
    expect(belowMinimum([{ source: 'panel', version: '2.1.100' }, { source: 'cli', version: '2.1.328' }], '2.1.139')).toEqual([{ source: 'panel', version: '2.1.100' }]);
  });
});

describe('simulate', () => {
  it('writes real inbox envelopes that drive the tracker through start → waiting → working → idle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-sim-'));
    const t = new SessionTracker();
    const states: string[] = [];
    SIM_STEPS.forEach((step, i) => {
      const file = writeInboxEvent(dir, step.signal, 'abc', { session_id: 'devjack-sim-1', prompt_id: `p${step.prompt}`, cwd: dir, hook_event_name: step.event });
      const ev = parseInboxFile(path.basename(file), fs.readFileSync(file, 'utf8'), i);
      if ('error' in ev) throw new Error(ev.error);
      t.apply({ kind: 'hook', signal: ev.signal, at: i, payload: ev.payload });
      states.push(t.windowState().state);
    });
    expect(states).toEqual(['idle', 'working', 'waiting', 'working', 'idle', 'idle']);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('diagnostics', () => {
  it('renders every section and explains blockers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-diag-'));
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"disableAllHooks": true}');
    const D = desiredHooks('sh', '/h');
    const input: DiagnosticsInput = {
      platform: 'win32',
      flavor: 'powershell-exec',
      connections: [{ configDir: path.join(root, '.claude'), role: 'main', status: 'blocked (disableAllHooks)', inspection: inspect(path.join(root, '.claude'), D, path.join(root, 'none.json')) }],
      versions: [{ source: 'cli', version: '2.1.328' }],
      minVersion: '2.1.139',
      registryDirs: [path.join(root, '.claude', 'sessions')],
      registryRecognized: true,
      registrySessions: [],
      mySessionIds: new Set(),
      heartbeatAgeMs: 4000,
      devjackHome: '/h',
      windowId: 'abc',
      folders: [],
      selfTest: { ok: true, ms: 250, detail: 'delivered in 250 ms' },
    };
    const md = renderReport(input);
    for (const s of ['## Hooks', '## Claude Code', '## This window', '## Self-test', 'disableAllHooks', 'Minimum for DevJack on Windows: 2.1.139', '4 s ago', '✅']) expect(md).toContain(s);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runEntry runs a hook entry like Claude Code (silent, exit 0, stale heartbeat)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-run-'));
    const r = await runEntry(buildEntry(flavorFor(process.platform), home, 'session'), '{"session_id":"x"}', process.env);
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
