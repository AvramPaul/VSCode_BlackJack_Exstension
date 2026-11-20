import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoneMode, StatusInfo } from '../../shared/protocol';
import type { WindowStateInfo } from '../../src/claude/sessionTracker';
import { AFTER_HAND_MAX_MS, TableController, type ControllerSettings, type PanelLike } from '../../src/table/tableController';

class Emitter<T> {
  private ls: ((e: T) => unknown)[] = [];
  event = (l: (e: T) => unknown) => {
    this.ls.push(l);
    return { dispose: () => (this.ls = this.ls.filter((x) => x !== l)) };
  };
  fire(e: T) {
    for (const l of [...this.ls]) l(e);
  }
}

class FakePanel implements PanelLike {
  isDisposed = false;
  hasFocus = false;
  handInProgress = false;
  statuses: StatusInfo[] = [];
  done: DoneMode[] = [];
  private d = new Emitter<void>();
  private h = new Emitter<boolean>();
  private g = new Emitter<void>();
  onDidDispose = this.d.event;
  onHandState = this.h.event;
  onGoToClaude = this.g.event;
  status(s: StatusInfo) {
    this.statuses.push(s);
  }
  claudeDone(m: DoneMode) {
    this.done.push(m);
  }
  reveal() {}
  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.d.fire();
  }
  /** The user closes the tab. */
  userClose() {
    this.dispose();
  }
  hand(inProgress: boolean) {
    this.handInProgress = inProgress;
    this.h.fire(inProgress);
  }
  clickGoToClaude() {
    this.g.fire();
  }
}

const W = (state: WindowStateInfo['state'], since = 1): WindowStateInfo => ({ state, working: state === 'working' ? 1 : 0, waiting: state === 'waiting' ? 1 : 0, sessions: 1, since });

let settings: ControllerSettings;
let paused: boolean;
let panels: FakePanel[];
let focus: string[];
let alerts: number;
let c: TableController;
const panel = () => panels[panels.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  settings = { autoOpen: true, openDelayMs: 2500, closeBehavior: 'afterHand', alertWhenNeedsYou: true };
  paused = false;
  panels = [];
  focus = [];
  alerts = 0;
  c = new TableController({
    createPanel: () => {
      const p = new FakePanel();
      panels.push(p);
      return p;
    },
    settings: () => settings,
    paused: () => paused,
    focusClaude: (r) => focus.push(r),
    needsYou: () => alerts++,
    log: () => undefined,
  });
});
afterEach(() => vi.useRealTimers());

describe('opening', () => {
  it('waits for the open delay; a quick answer never shows the table', () => {
    c.update(W('working'), true, true);
    vi.advanceTimersByTime(1500);
    c.update(W('idle'), true, false);
    vi.advanceTimersByTime(5000);
    expect(panels).toHaveLength(0);

    c.update(W('working'), true, true);
    vi.advanceTimersByTime(2499);
    expect(c.isOpen).toBe(false);
    vi.advanceTimersByTime(1);
    expect(c.isOpen).toBe(true);
  });

  it("doesn't open while Claude asks right away; opens once it works again", () => {
    c.update(W('working'), true, true);
    vi.advanceTimersByTime(500);
    c.update(W('waiting'), true, false);
    vi.advanceTimersByTime(5000);
    expect(panels).toHaveLength(0);
    c.update(W('working'), true, false); // approved
    vi.advanceTimersByTime(2500);
    expect(c.isOpen).toBe(true);
  });

  it('never opens for replayed events, when paused, or with autoOpen off', () => {
    c.update(W('working'), false, true);
    vi.advanceTimersByTime(5000);
    c.update(W('idle'), true, false);
    paused = true;
    c.update(W('working'), true, true);
    vi.advanceTimersByTime(5000);
    c.update(W('idle'), true, false);
    paused = false;
    settings.autoOpen = false;
    c.update(W('working'), true, true);
    vi.advanceTimersByTime(5000);
    expect(panels).toHaveLength(0);
  });

  it('pausing during the delay cancels the open', () => {
    c.update(W('working'), true, true);
    paused = true;
    vi.advanceTimersByTime(3000);
    expect(panels).toHaveLength(0);
  });

  it('a delay of 0 opens at once; only one table', () => {
    settings.openDelayMs = 0;
    c.update(W('working'), true, true);
    c.update(W('working'), true, true);
    expect(panels).toHaveLength(1);
  });

  it('closed by the user: stays closed until the next turn', () => {
    settings.openDelayMs = 0;
    c.update(W('working'), true, true);
    panel().userClose();
    c.update(W('waiting'), true, false);
    c.update(W('working'), true, false);
    expect(panels).toHaveLength(1);
    c.update(W('working'), true, true); // next turn (another prompt)
    expect(panels).toHaveLength(2);
  });
});

describe('closing', () => {
  beforeEach(() => {
    settings.openDelayMs = 0;
    c.update(W('working'), true, true);
  });

  it('afterHand, no hand in progress: "Done ✓" for 1 s, then close', () => {
    c.update(W('idle'), true, false);
    expect(panel().done).toEqual(['soon']);
    expect(c.isOpen).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(c.isOpen).toBe(false);
  });

  it('afterHand, hand in progress: closes when the hand settles', () => {
    panel().hand(true);
    c.update(W('idle'), true, false);
    expect(panel().done).toEqual(['afterHand']);
    vi.advanceTimersByTime(30_000);
    expect(c.isOpen).toBe(true);
    panel().hand(false);
    expect(c.isOpen).toBe(false);
  });

  it('afterHand: at most 60 s', () => {
    panel().hand(true);
    c.update(W('idle'), true, false);
    vi.advanceTimersByTime(AFTER_HAND_MAX_MS);
    expect(c.isOpen).toBe(false);
  });

  it('new work during the grace period cancels the close', () => {
    c.update(W('idle'), true, false);
    c.update(W('working'), true, true);
    vi.advanceTimersByTime(5000);
    expect(c.isOpen).toBe(true);
    expect(panels).toHaveLength(1);
    expect(panel().statuses[panel().statuses.length - 1]!.state).toBe('working');
  });

  it('immediately and keepOpen', () => {
    settings.closeBehavior = 'immediately';
    c.update(W('idle'), true, false);
    expect(c.isOpen).toBe(false);
    settings.closeBehavior = 'keepOpen';
    c.update(W('working'), true, true);
    c.update(W('idle'), true, false);
    vi.advanceTimersByTime(120_000);
    expect(c.isOpen).toBe(true);
    expect(panel().done).toEqual(['keepOpen']);
  });

  it('returns focus to Claude only if the table had focus', () => {
    settings.closeBehavior = 'immediately';
    c.update(W('idle'), true, false);
    expect(focus).toEqual([]);
    c.update(W('working'), true, true);
    panel().hasFocus = true;
    c.update(W('idle'), true, false);
    expect(focus).toEqual(['close']);
  });

  it('a free-play table never closes automatically', () => {
    c.openFreePlay();
    c.update(W('idle'), true, false);
    vi.advanceTimersByTime(120_000);
    expect(c.isOpen).toBe(true);
  });
});

describe('needs you', () => {
  it('alerts once per wait, only while the table is open, and Go to Claude focuses', () => {
    c.update(W('waiting'), true, true);
    expect(alerts).toBe(0); // table not open
    settings.openDelayMs = 0;
    c.update(W('working'), true, true);
    c.update(W('waiting'), true, false);
    c.update(W('waiting'), true, false);
    expect(alerts).toBe(1);
    settings.alertWhenNeedsYou = false;
    c.update(W('working'), true, false);
    c.update(W('waiting'), true, false);
    expect(alerts).toBe(1);
    panel().clickGoToClaude();
    expect(focus).toEqual(['button']);
  });
});
