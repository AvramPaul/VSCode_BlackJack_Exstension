/**
 * Tracker sequences built from hook payloads recorded in the Phase 1 spike (test/fixtures/hooks),
 * plus the registry / transcript inputs the spike observed at those moments.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS } from '../../src/claude/hookCommand';
import type { HookPayload } from '../../src/claude/inbox';
import { SessionTracker, type TrackerInput } from '../../src/claude/sessionTracker';

interface Fixture {
  events: { t: number; event: string; payload: HookPayload & Record<string, unknown> }[];
}
const load = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/hooks', `${name}.json`), 'utf8'));
const SIGNAL = new Map(HOOK_EVENTS.map((h) => [h.event, h.signal]));
const T0 = 1_800_000_000_000;

/** Hook inputs DevJack would receive (only the events it installs). */
function hookInputs(f: Fixture): (TrackerInput & { event: string })[] {
  return f.events
    .filter((e) => SIGNAL.has(e.event))
    .map((e) => ({ kind: 'hook' as const, signal: SIGNAL.get(e.event)!, at: T0 + e.t, payload: e.payload, event: e.event }));
}
const reg = (sessionId: string, t: number, status: string, waitingFor?: string): TrackerInput => ({ kind: 'registry', sessionId, status, waitingFor, at: T0 + t });
const tOf = (f: Fixture, event: string, nth = 0, pred: (p: Record<string, unknown>) => boolean = () => true) => f.events.filter((e) => e.event === event && pred(e.payload))[nth]!.t;

/** Merge inputs by time and apply them; return the window state after each input. */
function play(inputs: TrackerInput[], tracker = new SessionTracker()) {
  const sorted = [...inputs].sort((a, b) => a.at - b.at);
  const states = sorted.map((i) => {
    tracker.apply(i);
    return { at: i.at - T0, input: i.kind === 'hook' ? i.signal : i.kind, state: tracker.windowState().state };
  });
  return { tracker, states, final: tracker.windowState() };
}

describe('CLI sequences', () => {
  it('permission prompt: working → waiting → (approved) working → idle; idle_prompt changes nothing', () => {
    const f = load('cli-permission-then-idle');
    const sid = f.events[0]!.payload.session_id;
    const approvedAt = tOf(f, 'PostToolUse') - 700;
    const { states, tracker } = play([...hookInputs(f), reg(sid, approvedAt, 'busy')]);
    expect(states.map((s) => `${s.input}:${s.state}`)).toEqual([
      'session:idle',
      'start:working',
      'waiting:waiting',
      'notify:waiting', // permission_prompt, 6 s later
      'registry:working', // approval
      'done:idle',
      'notify:idle', // idle_prompt
      'end:idle',
    ]);
    expect(tracker.sessions()).toHaveLength(0); // removed at SessionEnd
  });

  it('permission prompt without a registry: waiting until Stop', () => {
    const { states } = play(hookInputs(load('cli-permission-then-idle')));
    expect(states.find((s) => s.input === 'done')!.state).toBe('idle');
    expect(states.filter((s) => s.state === 'waiting').length).toBe(2);
  });

  it('a message sent mid-turn (same prompt_id) joins the running turn', () => {
    const f = load('cli-message-mid-turn');
    const ups = f.events.filter((e) => e.event === 'UserPromptSubmit');
    expect(ups).toHaveLength(2);
    expect(ups[0]!.payload.prompt_id).toBe(ups[1]!.payload.prompt_id);
    const sid = f.events[0]!.payload.session_id;
    const tracker = new SessionTracker();
    const { states } = play([...hookInputs(f), reg(sid, tOf(f, 'PermissionRequest') + 500, 'busy')], tracker);
    expect(states.map((s) => `${s.input}:${s.state}`)).toEqual(['session:idle', 'start:working', 'waiting:waiting', 'registry:working', 'start:working', 'done:idle', 'end:idle']);
  });

  it('StopFailure ends the turn', () => {
    const tracker = new SessionTracker();
    const { states } = play(hookInputs(load('cli-stop-failure')).filter((i) => i.event !== 'SessionEnd'), tracker);
    expect(states.map((s) => s.state)).toEqual(['idle', 'working', 'idle']);
    expect(tracker.sessions()[0]!.lastEnd).toBe('failed');
  });

  it('interrupts: transcript marker and registry idle end turns; nothing waits forever', () => {
    const f = load('cli-interrupts');
    const sid = f.events[0]!.payload.session_id;
    const ups2 = tOf(f, 'UserPromptSubmit', 1);
    const pr = tOf(f, 'PermissionRequest', 0);
    const extra: TrackerInput[] = [
      { kind: 'transcript', sessionId: sid, what: 'interrupt', at: T0 + ups2 - 500 }, // Esc #1 mid-stream
      reg(sid, pr + 600, 'busy'), // ping approved
      reg(sid, pr + 5600, 'idle'), // Esc #2 during the tool
    ];
    const { states } = play([...hookInputs(f).filter((i) => i.event !== 'SessionEnd'), ...extra]);
    expect(states.map((s) => `${s.input}:${s.state}`).slice(0, 7)).toEqual([
      'session:idle',
      'start:working',
      'transcript:idle',
      'start:working',
      'waiting:waiting',
      'registry:working',
      'registry:idle',
    ]);
  });

  it('early Esc: only the registry tells, even when its idle is processed before the start file', () => {
    const f = load('cli-early-esc');
    const sid = f.events[0]!.payload.session_id;
    const ups = tOf(f, 'UserPromptSubmit');
    const hooks = hookInputs(f).filter((i) => i.event !== 'SessionEnd');
    // In time order:
    expect(play([...hooks, reg(sid, ups + 1500, 'idle')]).final.state).toBe('idle');
    // Out of order: registry idle (newer) applied first, the start file read afterwards.
    const tracker = new SessionTracker();
    tracker.apply(hooks[0]!); // SessionStart
    tracker.apply(reg(sid, ups + 1500, 'idle'));
    tracker.apply(hooks[1]!); // late UserPromptSubmit
    expect(tracker.windowState().state).toBe('idle');
    expect(tracker.get(sid)!.lastEnd).toBe('registry');
  });

  it('plan rejected with Esc: waiting → idle via registry, the late Notification is ignored', () => {
    const f = load('cli-plan-rejected');
    const sid = f.events[0]!.payload.session_id;
    const pr = tOf(f, 'PermissionRequest', 0, (p) => p.tool_name === 'ExitPlanMode');
    const hooks = hookInputs(f).filter((i) => i.event !== 'SessionEnd');
    const { states } = play([...hooks, reg(sid, pr + 3000, 'idle')]); // Esc before the 6 s Notification
    expect(states.map((s) => `${s.input}:${s.state}`)).toEqual(['session:idle', 'start:working', 'waiting:waiting', 'registry:idle', 'notify:idle']);
  });

  it('AskUserQuestion fires PermissionRequest → waiting', () => {
    const f = load('cli-ask-user-question');
    expect(f.events.find((e) => e.event === 'PermissionRequest')!.payload.tool_name).toBe('AskUserQuestion');
    const { states } = play(hookInputs(f));
    expect(states.map((s) => s.state)).toEqual(['idle', 'working', 'waiting', 'waiting', 'idle', 'idle']);
  });
});

describe('panel sequences', () => {
  it('Stop button: registry idle ends the turn (no Stop hook)', () => {
    const f = load('panel-stop-button');
    const sid = f.events[0]!.payload.session_id;
    const seq = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/hooks/registry-status-sequence.json'), 'utf8')) as { events: { t: number; status: string | null }[] };
    const regInputs = seq.events.filter((e) => e.status).map((e) => reg(sid, e.t, e.status!));
    const { states, final } = play([...hookInputs(f), ...regInputs]);
    expect(states.map((s) => `${s.input}:${s.state}`)).toEqual(['session:idle', 'registry:idle', 'start:working', 'registry:working', 'registry:idle']);
    expect(final.state).toBe('idle');
  });

  it('throwaway sessions never look like work', () => {
    const { states, tracker } = play(hookInputs(load('panel-throwaway-session')));
    expect(states.every((s) => s.state === 'idle')).toBe(true);
    expect(tracker.sessions()).toHaveLength(0);
  });

  it('permission + question + Stop, then StopFailure', () => {
    const { states, tracker } = play(hookInputs(load('panel-permission-question-stop')));
    expect(states.some((s) => s.state === 'waiting')).toBe(true);
    expect(states[states.length - 1]!.state).toBe('idle');
    expect(tracker.sessions()[0]!.lastEnd).toBe('failed');
  });
});

describe('rules', () => {
  const p = (session_id: string, prompt_id?: string, extra: Partial<HookPayload> = {}): HookPayload => ({ session_id, prompt_id, ...extra });
  const hook = (signal: 'start' | 'waiting' | 'notify' | 'done' | 'end' | 'session', at: number, payload: HookPayload): TrackerInput => ({ kind: 'hook', signal, at, payload });

  it('window state: waiting beats working beats idle; counts sessions', () => {
    const t = new SessionTracker();
    t.apply(hook('start', 1, p('a', 'pa')));
    t.apply(hook('start', 2, p('b', 'pb')));
    expect(t.windowState()).toMatchObject({ state: 'working', working: 2, waiting: 0, since: 1 });
    t.apply(hook('waiting', 3, p('b', 'pb')));
    expect(t.windowState()).toMatchObject({ state: 'waiting', working: 1, waiting: 1 });
    t.apply(hook('done', 4, p('b', 'pb')));
    expect(t.windowState().state).toBe('working');
  });

  it('a late notify or waiting for a finished turn is ignored', () => {
    const t = new SessionTracker();
    t.apply(hook('start', 1, p('a', 'p1')));
    t.apply(hook('done', 2, p('a', 'p1')));
    t.apply(hook('notify', 3, p('a', 'p1', { notification_type: 'permission_prompt' })));
    t.apply(hook('waiting', 4, p('a', 'p1')));
    t.apply(hook('start', 5, p('a', 'p1')));
    expect(t.windowState().state).toBe('idle');
  });

  it('a registry observation older than the last hook event is ignored', () => {
    const t = new SessionTracker();
    t.apply(hook('start', 100, p('a', 'p1')));
    t.apply({ kind: 'registry', sessionId: 'a', status: 'idle', at: 50 }); // from before the prompt
    expect(t.windowState().state).toBe('working');
  });

  it('the registry never starts a turn, and unknown statuses do nothing', () => {
    const t = new SessionTracker();
    t.apply(hook('session', 1, p('a')));
    t.apply({ kind: 'registry', sessionId: 'a', status: 'busy', at: 2 });
    expect(t.windowState().state).toBe('idle');
    t.apply(hook('start', 3, p('a', 'p1')));
    t.apply({ kind: 'registry', sessionId: 'a', status: 'thinking-hard', at: 4 });
    expect(t.windowState().state).toBe('working');
  });

  it('a newer registry "busy" wins over a waiting read late', () => {
    const t = new SessionTracker();
    t.apply(hook('start', 1, p('a', 'p1')));
    t.apply({ kind: 'registry', sessionId: 'a', status: 'busy', at: 30 }); // approval at 30
    t.apply(hook('waiting', 20, p('a', 'p1'))); // the PermissionRequest file (20) read after it
    expect(t.windowState().state).toBe('working');
  });

  it('transcript growth clears waiting', () => {
    const t = new SessionTracker();
    t.apply(hook('waiting', 1, p('a', 'p1')));
    t.apply({ kind: 'transcript', sessionId: 'a', what: 'grew', at: 2 });
    expect(t.windowState().state).toBe('working');
  });

  it('stale sessions go idle after 30 min without any news', () => {
    const t = new SessionTracker();
    t.apply(hook('start', 0, p('a', 'p1')));
    t.apply({ kind: 'tick', at: 29 * 60_000 });
    expect(t.windowState().state).toBe('working');
    t.apply({ kind: 'tick', at: 31 * 60_000 });
    expect(t.windowState().state).toBe('idle');
    expect(t.get('a')!.lastEnd).toBe('stale');
  });

  it('registry file gone removes the session', () => {
    const t = new SessionTracker();
    t.apply(hook('start', 1, p('a', 'p1')));
    t.apply({ kind: 'registryGone', sessionId: 'a', at: 2 });
    expect(t.sessions()).toHaveLength(0);
    expect(t.windowState().state).toBe('idle');
  });

  it('a waiting for a turn whose start was missed still shows waiting', () => {
    const t = new SessionTracker();
    t.apply(hook('waiting', 1, p('a', 'p9')));
    expect(t.windowState()).toMatchObject({ state: 'waiting', since: 1 });
  });
});
