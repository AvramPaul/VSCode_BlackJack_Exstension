import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isInterruptLine, TranscriptWatcher, type TranscriptEvent } from '../../src/claude/transcript';

const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });

describe('isInterruptLine', () => {
  it('matches both markers seen in the spike, as text blocks or a string', () => {
    expect(isInterruptLine(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toBe(true);
    expect(isInterruptLine(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toBe(true);
    expect(isInterruptLine(user('[Request interrupted by user]'))).toBe(true);
  });
  it('does not match quotes of the marker or other entry types', () => {
    expect(isInterruptLine(user([{ type: 'text', text: 'what does "[Request interrupted by user]" mean?' }]))).toBe(false);
    expect(isInterruptLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBe(false);
    expect(isInterruptLine(user([{ type: 'tool_result', content: '[Request interrupted by user]' }]))).toBe(false);
    expect(isInterruptLine('{"type":"user", broken [Request interrupted by user')).toBe(false);
  });
});

describe('TranscriptWatcher', () => {
  it('follows from the current end, reports growth and interrupts, handles partial lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-tx-'));
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, user([{ type: 'text', text: '[Request interrupted by user]' }]) + '\n'); // old: ignored
    const evs: TranscriptEvent[] = [];
    const w = new TranscriptWatcher((e) => evs.push(e), 60_000, () => 42);
    w.watch('s', file);
    w.poll();
    expect(evs).toEqual([]);
    const marker = user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
    fs.appendFileSync(file, '{"type":"assistant"}\n' + marker.slice(0, 20));
    w.poll();
    expect(evs).toEqual([{ sessionId: 's', what: 'grew', at: 42 }]);
    fs.appendFileSync(file, marker.slice(20) + '\n');
    w.poll();
    expect(evs.slice(1)).toEqual([
      { sessionId: 's', what: 'grew', at: 42 },
      { sessionId: 's', what: 'interrupt', at: 42 },
    ]);
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
