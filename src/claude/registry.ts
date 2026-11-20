/**
 * Claude Code's session registry: `<config dir>/sessions/<pid>.json` (plan §5.7, undocumented, best effort).
 * One file per live session with `sessionId`, `cwd` (start directory), `status` (idle | busy | waiting)
 * and `waitingFor`. Only files named `<digits>.json` are read. The `<pid>.<hash>.key` files hold a secret
 * token and are never opened.
 */
import * as fs from 'fs';
import * as path from 'path';

export const REGISTRY_FILE = /^\d+\.json$/;
export const KNOWN_STATUSES = ['idle', 'busy', 'waiting'] as const;

export interface RegistryEntry {
  file: string;
  dir: string;
  pid: number;
  sessionId: string;
  cwd?: string;
  status?: string;
  waitingFor?: string;
  entrypoint?: string;
  version?: string;
  /** When `status` last changed (ms since epoch). */
  statusAt: number;
}

export function parseRegistryFile(file: string, text: string, fallbackAt: number): RegistryEntry | undefined {
  if (!REGISTRY_FILE.test(file)) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const o = j as Record<string, unknown>;
  if (typeof o.sessionId !== 'string' || !o.sessionId) return undefined;
  const s = (x: unknown) => (typeof x === 'string' ? x : undefined);
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  return {
    file,
    dir: '',
    pid: n(o.pid) ?? Number(file.slice(0, -5)),
    sessionId: o.sessionId,
    cwd: s(o.cwd),
    status: s(o.status),
    waitingFor: s(o.waitingFor),
    entrypoint: s(o.entrypoint),
    version: s(o.version),
    statusAt: n(o.statusUpdatedAt) ?? n(o.updatedAt) ?? fallbackAt,
  };
}

export type RegistryEvent = { type: 'status'; entry: RegistryEntry } | { type: 'gone'; sessionId: string; at: number };

export interface RegistryOptions {
  pollMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Watches one or more `sessions/` folders. Emits a 'status' event when a session's status changes. */
export class RegistryWatcher {
  private entries = new Map<string, RegistryEntry & { mtimeMs: number; sig: string }>(); // key: dir/file
  private timer: NodeJS.Timeout | undefined;
  private watchers: fs.FSWatcher[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private warned = false;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** True once at least one file with a known status was read. */
  recognized = false;

  constructor(private readonly dirs: readonly string[], private readonly onEvent: (ev: RegistryEvent) => void, opts: RegistryOptions = {}) {
    this.pollMs = opts.pollMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  start(): void {
    for (const dir of this.dirs) {
      try {
        const w = fs.watch(dir, () => this.schedule());
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        /* folder missing (old Claude Code, or not installed): polling picks it up if it appears */
      }
    }
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.scan();
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = undefined;
  }

  snapshot(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  bySession(sessionId: string): RegistryEntry | undefined {
    for (const e of this.entries.values()) if (e.sessionId === sessionId) return e;
    return undefined;
  }

  private schedule() {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.scan();
    }, 30);
  }

  /** One pass. Public for tests. */
  scan(): void {
    const seen = new Set<string>();
    for (const dir of this.dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!REGISTRY_FILE.test(name)) continue; // never *.key
        const key = path.join(dir, name);
        seen.add(key);
        let st: fs.Stats;
        try {
          st = fs.statSync(key);
        } catch {
          continue;
        }
        const prev = this.entries.get(key);
        if (prev && prev.mtimeMs === st.mtimeMs) continue;
        let text: string;
        try {
          text = fs.readFileSync(key, 'utf8');
        } catch {
          continue;
        }
        const e = parseRegistryFile(name, text, st.mtimeMs);
        if (!e) continue; // half-written or unknown shape: try again on the next change
        e.dir = dir;
        if (e.status && (KNOWN_STATUSES as readonly string[]).includes(e.status)) this.recognized = true;
        else if (!this.warned) {
          this.warned = true;
          this.log(`registry: format not recognized (status=${JSON.stringify(e.status)}); falling back to transcripts`);
        }
        const sig = `${e.status}|${e.waitingFor ?? ''}`;
        this.entries.set(key, { ...e, mtimeMs: st.mtimeMs, sig });
        if (!prev || prev.sig !== sig) this.onEvent({ type: 'status', entry: e });
      }
    }
    for (const [key, e] of this.entries) {
      if (!seen.has(key)) {
        this.entries.delete(key);
        this.onEvent({ type: 'gone', sessionId: e.sessionId, at: this.now() });
      }
    }
  }
}
