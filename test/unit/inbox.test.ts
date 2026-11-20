import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Inbox, MAX_FILE_BYTES, parseInboxFile, type InboxEvent } from '../../src/claude/inbox';

const env = (o: Record<string, unknown>) => JSON.stringify({ v: 2, signal: 'start', window: 'abc', payload: { session_id: 's1', prompt_id: 'p1', cwd: 'C:\\x' }, ...o });

describe('parseInboxFile', () => {
  it('parses the hook envelope and keeps only the fields DevJack reads', () => {
    const ev = parseInboxFile('1-2-start.json', env({ payload: { session_id: 's1', prompt_id: 'p1', prompt: 'secret text', tool_input: { a: 1 }, cwd: 'C:\\ș' } }), 5);
    expect(ev).toMatchObject({ file: '1-2-start.json', mtimeMs: 5, signal: 'start', window: 'abc', payload: { session_id: 's1', prompt_id: 'p1', cwd: 'C:\\ș' } });
    expect(JSON.stringify(ev)).not.toContain('secret text'); // prompt content is dropped right here
  });
  it('accepts a BOM and lowercases the window id', () => {
    expect(parseInboxFile('f.json', '\uFEFF' + env({ window: 'ABC1' }), 0)).toMatchObject({ window: 'abc1' });
  });
  it.each([
    ['invalid JSON', '{"v":2,'],
    ['unknown version', env({ v: 1 })],
    ['unknown signal', env({ signal: 'tool' })],
    ['no payload', env({ payload: 'null' }).replace('"null"', 'null')],
    ['no session_id', env({ payload: { cwd: 'x' } })],
  ])('rejects %s', (error, text) => {
    expect(parseInboxFile('f.json', text, 0)).toEqual({ error });
  });
  it('treats a non-hex window as unset', () => {
    expect(parseInboxFile('f.json', env({ window: 'zz;rm' }), 0)).toMatchObject({ window: '' });
  });
  it('caps the size', () => {
    expect(parseInboxFile('f.json', ' '.repeat(MAX_FILE_BYTES + 1), 0)).toEqual({ error: 'too large' });
  });
});

describe('Inbox', () => {
  let dir: string;
  let got: InboxEvent[][];
  let inbox: Inbox;
  const now = 10_000_000;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-inbox-'));
    got = [];
    inbox = new Inbox(dir, (evs) => got.push(evs), { now: () => now, pollMs: 60_000 });
  });
  afterEach(() => {
    inbox.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const put = (name: string, text: string, mtime: number) => {
    fs.writeFileSync(path.join(dir, name), text);
    fs.utimesSync(path.join(dir, name), new Date(mtime), new Date(mtime));
  };

  it('delivers new files once, in mtime order, ignoring .tmp', () => {
    put('9-1-done.json', env({ signal: 'done' }), now - 1000);
    put('1-1-start.json', env({ signal: 'start' }), now - 2000);
    put('5-1-waiting.tmp', 'partial', now - 500);
    inbox.scan();
    expect(got).toHaveLength(1);
    expect(got[0]!.map((e) => e.signal)).toEqual(['start', 'done']);
    inbox.scan();
    expect(got).toHaveLength(1);
  });

  it('deletes files older than 2 minutes (any window) and handled files (owner)', () => {
    put('old.json', env({}), now - 3 * 60_000);
    put('old.tmp', 'x', now - 3 * 60_000);
    put('new.json', env({}), now - 1000);
    inbox.scan();
    expect(fs.readdirSync(dir)).toEqual(['new.json']);
    inbox.remove('new.json');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('skips broken files without throwing', () => {
    put('bad.json', 'not json', now);
    put('ok.json', env({}), now);
    inbox.scan();
    expect(got[0]!.map((e) => e.file)).toEqual(['ok.json']);
  });
});
