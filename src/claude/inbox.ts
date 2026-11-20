/**
 * The inbox (plan §5.4): `~/.devjack/inbox/<time>-<pid>-<signal>.json`, written by the hook command.
 * fs.watch plus a 1 s poll; each file is read once per window; the owning window deletes it after handling;
 * any window deletes files older than 2 minutes. File contents (prompts, tool input) are never logged.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SIGNALS, type Signal } from './hookCommand';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_AGE_MS = 2 * 60 * 1000;

/** Fields DevJack reads from a hook payload. Everything else is ignored. */
export interface HookPayload {
  session_id: string;
  prompt_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  notification_type?: string;
  tool_name?: string;
  source?: string;
  reason?: string;
  error?: string;
}

export interface InboxEvent {
  file: string;
  mtimeMs: number;
  signal: Signal;
  /** DEVJACK_WINDOW_ID of the process that ran the hook ('' if not set). */
  window: string;
  payload: HookPayload;
}

const str = (x: unknown) => (typeof x === 'string' ? x : undefined);

/** Parse one inbox file. Defensive: anything unexpected yields an error string, never a throw. */
export function parseInboxFile(file: string, text: string, mtimeMs: number): InboxEvent | { error: string } {
  if (text.length > MAX_FILE_BYTES) return { error: 'too large' };
  let j: unknown;
  try {
    j = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!j || typeof j !== 'object') return { error: 'not an object' };
  const o = j as Record<string, unknown>;
  if (o.v !== 2) return { error: 'unknown version' };
  const signal = o.signal;
  if (typeof signal !== 'string' || !(SIGNALS as readonly string[]).includes(signal)) return { error: 'unknown signal' };
  const window = typeof o.window === 'string' && /^[a-f0-9]*$/i.test(o.window) ? o.window.toLowerCase() : '';
  const p = o.payload;
  if (!p || typeof p !== 'object') return { error: 'no payload' };
  const q = p as Record<string, unknown>;
  const session_id = str(q.session_id);
  if (!session_id) return { error: 'no session_id' };
  const payload: HookPayload = {
    session_id,
    prompt_id: str(q.prompt_id),
    cwd: str(q.cwd),
    transcript_path: str(q.transcript_path),
    hook_event_name: str(q.hook_event_name),
    notification_type: str(q.notification_type),
    tool_name: str(q.tool_name),
    source: str(q.source),
    reason: str(q.reason),
    error: str(q.error),
  };
  return { file, mtimeMs, signal: signal as Signal, window, payload };
}

export interface InboxOptions {
  pollMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Watches the inbox folder and hands new events, in mtime order, to `onEvents`. */
export class Inbox {
  private seen = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private readonly pollMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(readonly dir: string, private readonly onEvents: (events: InboxEvent[]) => void, opts: InboxOptions = {}) {
    this.pollMs = opts.pollMs ?? 1000;
    this.maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.watcher = fs.watch(this.dir, () => this.schedule());
      this.watcher.on('error', () => this.stopWatcher());
    } catch {
      /* fs.watch unsupported here: polling covers it */
    }
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.scan();
  }

  stop(): void {
    this.stopWatcher();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = undefined;
  }

  /** Delete a handled file (the owning window does this). */
  remove(file: string): void {
    try {
      fs.rmSync(path.join(this.dir, file), { force: true });
    } catch {
      /* another window removed it */
    }
  }

  private stopWatcher() {
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = undefined;
  }

  private schedule() {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.scan();
    }, 30);
  }

  /** One pass over the folder. Public for tests. */
  scan(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const present = new Set(names);
    for (const n of this.seen) if (!present.has(n)) this.seen.delete(n);

    const now = this.now();
    const fresh: InboxEvent[] = [];
    for (const name of names) {
      const full = path.join(this.dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > this.maxAgeMs) {
        this.remove(name); // stale: any window cleans up (.tmp leftovers too)
        this.seen.delete(name);
        continue;
      }
      if (!name.endsWith('.json') || this.seen.has(name)) continue;
      this.seen.add(name);
      if (st.size > MAX_FILE_BYTES) {
        this.log(`inbox: ignored ${name} (too large)`);
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        this.seen.delete(name); // retry next pass
        continue;
      }
      const ev = parseInboxFile(name, text, st.mtimeMs);
      if ('error' in ev) {
        this.log(`inbox: ignored ${name} (${ev.error})`);
        continue;
      }
      fresh.push(ev);
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
    this.onEvents(fresh);
  }
}
