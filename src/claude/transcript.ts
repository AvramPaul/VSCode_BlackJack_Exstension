/**
 * Transcript tail (plan §5.7, fallback for sessions the registry doesn't cover). Undocumented format.
 * - A new user entry whose text starts with `[Request interrupted by user` means the user interrupted.
 * - Growth alone (no format knowledge) clears "waiting".
 */
import * as fs from 'fs';

export const INTERRUPT_PREFIX = '[Request interrupted by user';

/** Does this transcript line record an interrupt? Content can be a string or a list of content blocks. */
export function isInterruptLine(line: string): boolean {
  if (!line.includes(INTERRUPT_PREFIX)) return false; // cheap pre-check
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return false;
  }
  const o = j as { type?: unknown; message?: { content?: unknown } };
  if (o?.type !== 'user') return false;
  const c = o.message?.content;
  if (typeof c === 'string') return c.startsWith(INTERRUPT_PREFIX);
  if (Array.isArray(c)) return c.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' && ((b as { text: string }).text).startsWith(INTERRUPT_PREFIX));
  return false;
}

export type TranscriptEvent = { sessionId: string; what: 'interrupt' | 'grew'; at: number };

interface Tail {
  path: string;
  offset: number;
  rest: string;
}

const MAX_READ = 4 * 1024 * 1024;

export class TranscriptWatcher {
  private tails = new Map<string, Tail>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onEvent: (ev: TranscriptEvent) => void, private readonly pollMs = 1000, private readonly now: () => number = Date.now) {}

  /** Start following a session's transcript from its current end. */
  watch(sessionId: string, file: string): void {
    const cur = this.tails.get(sessionId);
    if (cur && cur.path === file) return;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* not created yet */
    }
    this.tails.set(sessionId, { path: file, offset: size, rest: '' });
    if (!this.timer) this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  unwatch(sessionId: string): void {
    this.tails.delete(sessionId);
    if (!this.tails.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  stop(): void {
    this.tails.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Public for tests. */
  poll(): void {
    for (const [sessionId, t] of this.tails) {
      let size: number;
      try {
        size = fs.statSync(t.path).size;
      } catch {
        continue;
      }
      if (size < t.offset) {
        t.offset = size; // truncated or replaced: restart from the end
        t.rest = '';
        continue;
      }
      if (size === t.offset) continue;
      const len = Math.min(size - t.offset, MAX_READ);
      const buf = Buffer.alloc(len);
      let fd: number | undefined;
      try {
        fd = fs.openSync(t.path, 'r');
        fs.readSync(fd, buf, 0, len, t.offset);
      } catch {
        continue;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      t.offset += len;
      const text = t.rest + buf.toString('utf8');
      const lines = text.split('\n');
      t.rest = lines.pop() ?? '';
      if (t.rest.length > MAX_READ) t.rest = '';
      const at = this.now();
      this.onEvent({ sessionId, what: 'grew', at });
      if (lines.some(isInterruptLine)) this.onEvent({ sessionId, what: 'interrupt', at });
    }
  }
}
