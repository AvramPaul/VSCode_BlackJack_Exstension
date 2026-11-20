import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRegistryFile, RegistryWatcher, type RegistryEvent } from '../../src/claude/registry';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures/registry', name), 'utf8');

describe('parseRegistryFile', () => {
  it('reads the fields DevJack uses', () => {
    const e = parseRegistryFile('12644.json', fx('waiting-permission.json'), 0)!;
    expect(e).toMatchObject({ pid: 12644, sessionId: 'b2ac16fd-20dd-44c2-a8fe-45e0fb3689d0', status: 'waiting', waitingFor: 'permission prompt', entrypoint: 'claude-vscode', version: '2.1.327', statusAt: 1795173578000 });
    expect(e.cwd).toBe('c:\\Users\\me\\Desktop\\vs_extension');
  });
  it('rejects other names (never the .key files), bad JSON and missing sessionId', () => {
    expect(parseRegistryFile('12644.e87.key', fx('busy.json'), 0)).toBeUndefined();
    expect(parseRegistryFile('12644.json', '{"pid":1', 0)).toBeUndefined();
    expect(parseRegistryFile('12644.json', '{"pid":1,"status":"idle"}', 0)).toBeUndefined();
  });
  it('falls back to updatedAt, then to the file time', () => {
    expect(parseRegistryFile('1.json', '{"sessionId":"s","status":"idle","updatedAt":5}', 9)!.statusAt).toBe(5);
    expect(parseRegistryFile('1.json', '{"sessionId":"s","status":"idle"}', 9)!.statusAt).toBe(9);
  });
});

describe('RegistryWatcher', () => {
  let dir: string;
  let events: RegistryEvent[];
  let w: RegistryWatcher;
  const logs: string[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-reg-'));
    events = [];
    logs.length = 0;
    w = new RegistryWatcher([dir, path.join(dir, 'missing')], (e) => events.push(e), { log: (m) => logs.push(m) });
  });
  afterEach(() => {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (name: string, content: string, mtime: number) => {
    fs.writeFileSync(path.join(dir, name), content);
    fs.utimesSync(path.join(dir, name), new Date(mtime), new Date(mtime));
  };

  it('emits on status changes only, ignores .key files, reports files that disappear', () => {
    write('12644.json', fx('busy.json'), 1_000_000);
    write('12644.abcdef.key', '{"peerToken":"secret"}', 1_000_000);
    w.scan();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status', entry: { status: 'busy' } });
    w.scan(); // unchanged
    expect(events).toHaveLength(1);
    write('12644.json', fx('busy.json').replace('"vs-extension-1"', '"renamed"'), 1_001_000); // same status, other field
    w.scan();
    expect(events).toHaveLength(1);
    write('12644.json', fx('waiting-input.json'), 1_002_000);
    w.scan();
    expect(events[1]).toMatchObject({ type: 'status', entry: { status: 'waiting', waitingFor: 'input needed' } });
    fs.rmSync(path.join(dir, '12644.json'));
    w.scan();
    expect(events[2]).toMatchObject({ type: 'gone', sessionId: 'b2ac16fd-20dd-44c2-a8fe-45e0fb3689d0' });
    expect(w.recognized).toBe(true);
    expect(w.bySession('b2ac16fd-20dd-44c2-a8fe-45e0fb3689d0')).toBeUndefined();
  });

  it('logs an unknown format once', () => {
    write('1.json', fx('unknown-status.json'), 1_000_000);
    write('2.json', fx('unknown-status.json').replace('12644', '2'), 1_000_000);
    w.scan();
    expect(logs.filter((l) => l.includes('format not recognized'))).toHaveLength(1);
    expect(w.recognized).toBe(false);
  });

  it("doesn't warn about a new session's file that has no status yet", () => {
    write('9.json', '{"sessionId":"s9","entrypoint":"cli"}', 1_000_000);
    w.scan();
    expect(logs.filter((l) => l.includes('format not recognized'))).toHaveLength(0);
  });

  it('skips a half-written file and reads it on the next change', () => {
    write('7.json', '{"sessionId":"s","sta', 1_000_000);
    w.scan();
    expect(events).toHaveLength(0);
    write('7.json', '{"sessionId":"s","status":"idle"}', 1_001_000);
    w.scan();
    expect(events).toHaveLength(1);
  });
});
