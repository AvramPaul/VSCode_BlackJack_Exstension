/**
 * "Is this session mine?" (plan §5.5). Every window applies the same rules on its own:
 * 1. the event's window id equals ours; 2. the session's start directory is inside one of our folders.
 * The decision is cached per session_id, because later payloads carry the *current* cwd, which follows `cd`.
 */
import * as fs from 'fs';
import * as path from 'path';

export type Rule = 'window' | 'cwd' | 'cached' | 'none';
export interface Decision {
  mine: boolean;
  rule: Rule;
}

const caseInsensitive = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';

/** Comparable form of a path: absolute, one separator style, no trailing separator, folded case where the FS is case-insensitive. */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  let s = platform === 'win32' ? p.replace(/\//g, '\\') : p;
  s = lib.resolve(s);
  if (s.length > 1) s = s.replace(platform === 'win32' ? /\\+$/ : /\/+$/, '') || s;
  if (platform === 'win32' && /^[a-z]:$/i.test(s)) s += '\\';
  return caseInsensitive(platform) ? s.toLowerCase() : s;
}

export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normalizePath(child, platform);
  const p = normalizePath(parent, platform);
  if (c === p) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export interface RouteInput {
  sessionId: string;
  window: string;
  /** cwd from this payload (the session's current directory). */
  cwd?: string;
  /** The session's start directory, if known (registry `cwd`). Preferred over `cwd`. */
  startCwd?: string;
}

export class Router {
  private cache = new Map<string, boolean>();

  constructor(
    private readonly windowId: string,
    private readonly folders: () => readonly string[],
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly realpath: (p: string) => string = realpathOr,
  ) {}

  decide(ev: RouteInput): Decision {
    if (ev.window && ev.window === this.windowId) {
      this.cache.set(ev.sessionId, true);
      return { mine: true, rule: 'window' };
    }
    const cached = this.cache.get(ev.sessionId);
    if (cached !== undefined) return { mine: cached, rule: 'cached' };
    const dir = ev.startCwd ?? ev.cwd;
    if (!dir) return { mine: false, rule: 'none' }; // no cache: a later event with a cwd may still decide
    const real = this.realpath(dir);
    const mine = this.folders().some((f) => isInside(real, this.realpath(f), this.platform) || isInside(dir, f, this.platform));
    this.cache.set(ev.sessionId, mine);
    return { mine, rule: mine ? 'cwd' : 'none' };
  }

  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /** Workspace folders changed: undecided sessions get a fresh look; known ones keep their owner. */
  resetNegative(): void {
    for (const [k, v] of this.cache) if (!v) this.cache.delete(k);
  }
}
