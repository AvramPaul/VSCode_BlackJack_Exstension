/**
 * Session tracker (plan §5.6). Pure: time is passed in, no I/O.
 *
 * Hooks start sessions and turns. The session registry and the transcript only end turns or clear
 * "waiting" (they never start a turn). Inputs can arrive out of order (separate watchers, 1 s polls),
 * so every input carries the time it happened, and a registry observation newer than a hook event wins.
 */
import type { Signal } from './hookCommand';
import type { HookPayload } from './inbox';

export type SessionState = 'idle' | 'working' | 'waiting';

export type EndReason = 'done' | 'failed' | 'interrupted' | 'idle_prompt' | 'registry' | 'stale';

export interface SessionInfo {
  id: string;
  state: SessionState;
  promptId?: string;
  turnStartedAt?: number;
  /** Last time anything was heard about this session (hook, registry, transcript growth). */
  lastActivityAt: number;
  /** Time of the newest hook event applied. */
  lastHookAt: number;
  cwd?: string;
  transcriptPath?: string;
  waitingFor?: string;
  lastEnd?: EndReason;
  doneTurns: string[];
}

export type TrackerInput =
  | { kind: 'hook'; signal: Signal; at: number; payload: HookPayload }
  | { kind: 'registry'; sessionId: string; status: string; waitingFor?: string; at: number }
  | { kind: 'registryGone'; sessionId: string; at: number }
  | { kind: 'transcript'; sessionId: string; what: 'interrupt' | 'grew'; at: number }
  | { kind: 'tick'; at: number };

export interface Change {
  sessionId: string;
  from: SessionState | 'none';
  to: SessionState | 'removed';
  reason: string;
  at: number;
}

export interface WindowStateInfo {
  state: SessionState;
  working: number;
  waiting: number;
  sessions: number;
  /** Earliest turn start among working/waiting sessions. */
  since?: number;
}

interface RegistryObs {
  status: string;
  waitingFor?: string;
  at: number;
}

export const STALE_MS = 30 * 60 * 1000;
const MAX_DONE = 50;
const MAX_OBS = 200;

export class SessionTracker {
  private map = new Map<string, SessionInfo>();
  private obs = new Map<string, RegistryObs>();

  constructor(private readonly staleMs = STALE_MS) {}

  get(id: string): SessionInfo | undefined {
    return this.map.get(id);
  }

  sessions(): SessionInfo[] {
    return [...this.map.values()];
  }

  windowState(): WindowStateInfo {
    let working = 0;
    let waiting = 0;
    let since: number | undefined;
    for (const s of this.map.values()) {
      if (s.state === 'idle') continue;
      if (s.state === 'working') working++;
      else waiting++;
      if (s.turnStartedAt !== undefined) since = since === undefined ? s.turnStartedAt : Math.min(since, s.turnStartedAt);
    }
    const state: SessionState = waiting ? 'waiting' : working ? 'working' : 'idle';
    return { state, working, waiting, sessions: this.map.size, since };
  }

  apply(input: TrackerInput): Change[] {
    const changes: Change[] = [];
    switch (input.kind) {
      case 'hook':
        this.onHook(input, changes);
        break;
      case 'registry':
        this.onRegistry(input, changes);
        break;
      case 'registryGone': {
        this.obs.delete(input.sessionId);
        const s = this.map.get(input.sessionId);
        if (s) this.remove(s, 'registry file gone', input.at, changes);
        break;
      }
      case 'transcript': {
        const s = this.map.get(input.sessionId);
        if (!s) break;
        if (input.what === 'interrupt') {
          if (s.state !== 'idle') this.end(s, 'interrupted', input.at, changes);
        } else {
          s.lastActivityAt = Math.max(s.lastActivityAt, input.at);
          if (s.state === 'waiting') this.set(s, 'working', 'transcript grew', input.at, changes);
        }
        break;
      }
      case 'tick':
        for (const s of this.map.values()) {
          if (s.state !== 'idle' && input.at - s.lastActivityAt > this.staleMs) this.end(s, 'stale', input.at, changes);
        }
        break;
    }
    return changes;
  }

  // ---------------------------------------------------------------- hooks

  private onHook(input: Extract<TrackerInput, { kind: 'hook' }>, changes: Change[]) {
    const { signal, at, payload } = input;
    const id = payload.session_id;
    if (signal === 'end') {
      const s = this.map.get(id);
      if (s) this.remove(s, 'SessionEnd', at, changes);
      this.obs.delete(id);
      return;
    }
    const s = this.ensure(id, at, changes);
    s.lastHookAt = Math.max(s.lastHookAt, at);
    s.lastActivityAt = Math.max(s.lastActivityAt, at);
    if (payload.cwd && !s.cwd) s.cwd = payload.cwd;
    if (payload.transcript_path) s.transcriptPath = payload.transcript_path;
    const p = payload.prompt_id;
    const isDone = !!p && s.doneTurns.includes(p);

    switch (signal) {
      case 'session':
        return;
      case 'start':
        if (isDone) return;
        if (s.state !== 'idle' && p && p === s.promptId) return; // a message sent mid-turn joins the running turn
        s.promptId = p;
        s.turnStartedAt = at;
        s.waitingFor = undefined;
        this.set(s, 'working', 'start', at, changes);
        this.reconcile(s, at, changes);
        return;
      case 'waiting':
        if (isDone) return;
        if (p && p !== s.promptId) {
          s.promptId = p; // we missed this turn's start
          s.turnStartedAt = at;
        }
        this.set(s, 'waiting', 'permission request', at, changes);
        this.reconcile(s, at, changes);
        return;
      case 'notify': {
        const t = payload.notification_type;
        if (t === 'idle_prompt') {
          if (s.state !== 'idle') this.end(s, 'idle_prompt', at, changes);
          return;
        }
        if ((t === 'permission_prompt' || t === 'elicitation_dialog') && !isDone && s.state !== 'idle') {
          this.set(s, 'waiting', t, at, changes);
          this.reconcile(s, at, changes);
        }
        return;
      }
      case 'done':
      case 'failed':
        if (p && p !== s.promptId) this.markDone(s, p);
        if (s.state !== 'idle' || (p && p === s.promptId)) this.end(s, signal, at, changes);
        return;
    }
  }

  // ---------------------------------------------------------------- registry

  private onRegistry(input: Extract<TrackerInput, { kind: 'registry' }>, changes: Change[]) {
    const { sessionId, status, waitingFor, at } = input;
    const prev = this.obs.get(sessionId);
    if (prev && prev.at > at) return;
    this.obs.set(sessionId, { status, waitingFor, at });
    if (this.obs.size > MAX_OBS) this.obs.delete(this.obs.keys().next().value!);
    const s = this.map.get(sessionId);
    if (!s || at < s.lastHookAt) return; // unknown session, or older than what hooks already told us
    s.lastActivityAt = Math.max(s.lastActivityAt, at);
    this.applyObs(s, { status, waitingFor, at }, changes);
  }

  private applyObs(s: SessionInfo, o: RegistryObs, changes: Change[]) {
    if (o.status === 'idle') {
      if (s.state !== 'idle') this.end(s, 'registry', o.at, changes);
    } else if (o.status === 'busy') {
      if (s.state === 'waiting') this.set(s, 'working', 'registry busy', o.at, changes);
    } else if (o.status === 'waiting') {
      s.waitingFor = o.waitingFor;
      if (s.state === 'working') this.set(s, 'waiting', `registry waiting (${o.waitingFor ?? '?'})`, o.at, changes);
    }
  }

  /** A hook event at `at` set working/waiting; a registry observation made after it wins. */
  private reconcile(s: SessionInfo, at: number, changes: Change[]) {
    const o = this.obs.get(s.id);
    if (o && o.at > at) this.applyObs(s, o, changes);
  }

  // ---------------------------------------------------------------- helpers

  private ensure(id: string, at: number, changes: Change[]): SessionInfo {
    let s = this.map.get(id);
    if (!s) {
      s = { id, state: 'idle', lastActivityAt: at, lastHookAt: at, doneTurns: [] };
      this.map.set(id, s);
      changes.push({ sessionId: id, from: 'none', to: 'idle', reason: 'new session', at });
    }
    return s;
  }

  private set(s: SessionInfo, to: SessionState, reason: string, at: number, changes: Change[]) {
    if (s.state === to) return;
    changes.push({ sessionId: s.id, from: s.state, to, reason, at });
    s.state = to;
    if (to !== 'waiting') s.waitingFor = undefined;
  }

  private end(s: SessionInfo, reason: EndReason, at: number, changes: Change[]) {
    if (s.promptId) this.markDone(s, s.promptId);
    s.lastEnd = reason;
    this.set(s, 'idle', reason, at, changes);
  }

  private markDone(s: SessionInfo, p: string) {
    if (!s.doneTurns.includes(p)) s.doneTurns.push(p);
    if (s.doneTurns.length > MAX_DONE) s.doneTurns.shift();
  }

  private remove(s: SessionInfo, reason: string, at: number, changes: Change[]) {
    this.map.delete(s.id);
    changes.push({ sessionId: s.id, from: s.state, to: 'removed', reason, at });
  }
}
