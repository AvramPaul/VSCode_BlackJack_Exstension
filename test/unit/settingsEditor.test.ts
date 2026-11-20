import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildEntry, desiredHooks, MARKER } from '../../src/claude/hookCommand';
import { analyze, detectFormatting, planUpdate } from '../../src/claude/settingsEditor';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures/settings', name), 'utf8');
const D = desiredHooks('powershell-exec', "C:\\Users\\Ana Ștefan's\\.devjack");
const D_SH = desiredHooks('sh', '/home/me/.devjack');

function connect(text: string | undefined, desired = D) {
  const r = planUpdate(text, desired);
  if (!r.ok) throw new Error(`plan failed: ${r.problem}`);
  return r.changed ? r.text : text!;
}

describe('connect', () => {
  it('creates hooks in a missing or empty file', () => {
    for (const input of [undefined, '', '  \n', '{}']) {
      const out = connect(input);
      expect(analyze(out, D).hooks.state).toBe('current');
      expect(out.endsWith('\n')).toBe(input !== '{}'); // a new file gets a final newline; '{}' had none, so none is added
      expect(JSON.parse(out).hooks.Stop[0].hooks[0]).toEqual(D.Stop);
    }
  });

  it('keeps every user hook and setting, in order', () => {
    const input = fixture('user-hooks.json');
    const out = connect(input);
    const before = JSON.parse(input);
    const after = JSON.parse(out);
    expect(Object.keys(after)).toEqual(Object.keys(before)); // key order kept, hooks stays in place
    expect(after.permissions).toEqual(before.permissions);
    expect(after.hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
    expect(after.hooks.Stop[0]).toEqual(before.hooks.Stop[0]); // user's group untouched...
    expect(after.hooks.Stop[1]).toEqual({ hooks: [D.Stop] }); // ...ours appended after it
    expect(analyze(out, D).hooks.state).toBe('current');
    // The user's lines are untouched text (minimal edits, not a re-serialization).
    expect(out).toContain('"command": "node ~/.claude/hooks/guard.js",\n            "timeout": 10');
  });

  it('is idempotent: no write when already current', () => {
    const once = connect(fixture('user-hooks.json'));
    expect(planUpdate(once, D)).toEqual({ ok: true, changed: false });
  });

  it('removes all v1 entries (including PostToolUse) and keeps the user hook', () => {
    const out = connect(fixture('v1-entries.json'));
    expect(out).not.toContain('devjack-hook.cjs');
    const j = JSON.parse(out);
    expect(j.hooks.PostToolUse).toBeUndefined(); // only v1 was there
    expect(j.hooks.Stop[0].hooks[0].command).toContain('ntfy.sh');
    expect(analyze(out, D).hooks).toEqual({ state: 'current', ours: Object.keys(D).length, v1: 0 });
  });

  it('replaces outdated v2 entries in place', () => {
    const old = connect(fixture('user-hooks.json'), D_SH); // e.g. a different home or an older script
    expect(analyze(old, D).hooks.state).toBe('outdated');
    const out = connect(old, D);
    expect(analyze(out, D).hooks.state).toBe('current');
    expect(JSON.parse(out).hooks.Stop).toHaveLength(2); // user's + ours, no duplicate
  });

  it('removes a duplicate of ours', () => {
    const once = JSON.parse(connect('{}'));
    once.hooks.Stop.push({ hooks: [D.Stop] });
    const dup = JSON.stringify(once, null, 2);
    expect(analyze(dup, D).hooks.state).toBe('outdated');
    expect(JSON.parse(connect(dup)).hooks.Stop).toHaveLength(1);
  });

  it('keeps a BOM, CRLF line endings and tab indentation', () => {
    const input = '\uFEFF{\r\n\t"model": "opus",\r\n\t"hooks": {\r\n\t\t"Stop": []\r\n\t}\r\n}\r\n';
    const out = connect(input);
    expect(out.startsWith('\uFEFF{')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain('\r\n\t"model": "opus"');
    expect(out).toMatch(/\r\n\t\t"Stop": \[/);
    expect(out.endsWith('\r\n')).toBe(true);
    expect(analyze(out, D).hooks.state).toBe('current');
  });

  it('keeps 4-space indentation and a missing final newline', () => {
    const input = '{\n    "model": "opus"\n}';
    const out = connect(input);
    expect(out).toContain('\n    "model": "opus"');
    expect(out).toContain('\n    "hooks": {\n        "SessionStart"');
    expect(out.endsWith('}')).toBe(true);
  });

  it('marks our entries so they can be found again', () => {
    expect(connect('{}', D_SH)).toContain(MARKER);
  });
});

describe('never touches what it should not', () => {
  it.each([
    ['invalid-trailing-comma.json', 'invalidJson'],
    ['invalid-comment.json', 'invalidJson'],
    ['not-an-object.json', 'notAnObject'],
    ['hooks-not-object.json', 'hooksNotObject'],
    ['hook-event-not-array.json', 'hookEventNotArray'],
  ])('%s → %s, no change', (name, problem) => {
    const input = fixture(name);
    expect(analyze(input, D).problem).toBe(problem);
    expect(planUpdate(input, D)).toMatchObject({ ok: false, problem });
    expect(planUpdate(input, null)).toMatchObject({ ok: false, problem });
  });

  it('detects disableAllHooks (connection.ts refuses to write)', () => {
    expect(analyze(fixture('disable-all-hooks.json'), D).blockers).toEqual(['disableAllHooks']);
    expect(analyze('{"allowManagedHooksOnly": true}', D).blockers).toEqual(['allowManagedHooksOnly']);
    expect(analyze('{"disableAllHooks": false}', D).blockers).toEqual([]);
  });
});

describe('disconnect', () => {
  it('removes only ours and restores the user file content', () => {
    const input = fixture('user-hooks.json');
    const back = planUpdate(connect(input), null);
    expect(back.ok && back.changed).toBe(true);
    if (back.ok && back.changed) {
      expect(JSON.parse(back.text)).toEqual(JSON.parse(input));
      expect(analyze(back.text, D).hooks).toEqual({ state: 'missing', ours: 0, v1: 0 });
    }
  });

  it('drops the hooks key when only our entries were in it', () => {
    const back = planUpdate(connect('{\n  "model": "opus"\n}\n'), null);
    expect(back.ok && back.changed && JSON.parse(back.text)).toEqual({ model: 'opus' });
  });

  it('removes v1 entries too', () => {
    const back = planUpdate(fixture('v1-entries.json'), null);
    expect(back.ok && back.changed && back.text).not.toContain('devjack-hook.cjs');
  });

  it('does nothing when nothing of ours is there', () => {
    expect(planUpdate(fixture('user-hooks.json'), null)).toEqual({ ok: true, changed: false });
  });

  it('removes ours from a group shared with a user hook', () => {
    const shared = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }, buildEntry('sh', '/h', 'done')] }] } }, null, 2);
    const back = planUpdate(shared, null);
    expect(back.ok && back.changed && JSON.parse(back.text)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } });
  });
});

describe('detectFormatting', () => {
  it('defaults to 2 spaces and LF', () => {
    expect(detectFormatting('{}')).toEqual({ insertSpaces: true, tabSize: 2, eol: '\n' });
  });
});
