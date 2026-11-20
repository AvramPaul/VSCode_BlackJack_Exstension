import { describe, expect, it } from 'vitest';
import {
  HOOK_EVENTS,
  MARKER,
  buildEntry,
  classifyEntry,
  decodePowerShell,
  desiredHooks,
  encodePowerShell,
  jsonEqual,
  psQuote,
  psScript,
  shCommand,
  shQuote,
} from '../../src/claude/hookCommand';

const ODD_HOME = "C:\\Users\\Ana Ștefan's PC\\.devjack";

describe('quoting', () => {
  it('PowerShell doubles single quotes', () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(psQuote(ODD_HOME)).toBe("'C:\\Users\\Ana Ștefan''s PC\\.devjack'");
  });
  it('sh closes, escapes and reopens', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote('/home/a b/$x')).toBe("'/home/a b/$x'");
  });
});

describe('scripts', () => {
  it('bakes the home and signal into the PowerShell script, marker on the first line', () => {
    const s = psScript(ODD_HOME, 'start');
    expect(s.split('\n')[0]).toBe(`# ${MARKER}`);
    expect(s).toContain(psQuote(ODD_HOME));
    expect(s).toContain('-start');
    expect(s).toContain('"signal":"start"');
    expect(s).not.toMatch(/Test-Path|Join-Path|Get-Item|Move-Item|New-Object/); // no cmdlets (no module auto-load)
  });
  it('ends the sh command with the marker comment', () => {
    const c = shCommand("/home/ana ș/it's/.devjack", 'done');
    expect(c.endsWith(`# ${MARKER}`)).toBe(true);
    expect(c.startsWith(`d='/home/ana ș/it'\\''s/.devjack';`)).toBe(true);
    expect(c).toContain('"signal":"done"');
  });
  it('round-trips the encoded PowerShell script', () => {
    const s = psScript(ODD_HOME, 'waiting');
    expect(decodePowerShell(encodePowerShell(s))).toBe(s);
    expect(decodePowerShell('not base64!')).toBeUndefined();
  });
});

describe('entries', () => {
  it('Windows: exec form with powershell.exe and args', () => {
    const e = buildEntry('powershell-exec', ODD_HOME, 'start');
    expect(e.command).toBe('powershell.exe');
    expect(e.args?.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(e.timeout).toBe(5);
    expect(Object.keys(e).sort()).toEqual(['args', 'command', 'timeout', 'type']); // no keys newer than 2.1.139
  });
  it('POSIX: shell form, no args', () => {
    const e = buildEntry('sh', '/home/me/.devjack', 'start');
    expect(e.args).toBeUndefined();
    expect(Object.keys(e).sort()).toEqual(['command', 'timeout', 'type']);
  });
  it('one entry per §5.1 event, no PreToolUse/PostToolUse', () => {
    const d = desiredHooks('sh', '/h');
    expect(Object.keys(d)).toEqual(HOOK_EVENTS.map((h) => h.event));
    expect(Object.keys(d)).not.toContain('PreToolUse');
    expect(Object.keys(d)).not.toContain('PostToolUse');
  });
});

describe('classifyEntry', () => {
  it('recognizes our entries of every generation', () => {
    expect(classifyEntry(buildEntry('powershell-exec', ODD_HOME, 'start'))).toBe('v2');
    expect(classifyEntry(buildEntry('sh', '/h', 'start'))).toBe('v2');
    // first-draft Windows shell-form string (plan §5.2, not used any more)
    expect(classifyEntry({ type: 'command', command: `powershell.exe -NoLogo -EncodedCommand AAAA # ${MARKER}` })).toBe('v2');
    expect(classifyEntry({ type: 'command', command: 'node "C:/Users/me/.devjack/devjack-hook.cjs" start' })).toBe('v1');
  });
  it('leaves user hooks alone', () => {
    expect(classifyEntry({ type: 'command', command: 'curl -s https://ntfy.sh/x' })).toBeUndefined();
    expect(classifyEntry({ type: 'command', command: 'powershell.exe', args: ['-EncodedCommand', encodePowerShell('Write-Host hi')] })).toBeUndefined();
    expect(classifyEntry({ type: 'http', url: 'http://x' })).toBeUndefined();
    expect(classifyEntry(null)).toBeUndefined();
    expect(classifyEntry('devjack-hook-v2')).toBeUndefined();
  });
});

describe('jsonEqual', () => {
  it('ignores key order, not values', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });
});
