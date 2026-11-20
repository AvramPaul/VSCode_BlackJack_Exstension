/**
 * When the table opens and closes (plan §5.8). No vscode import: unit tested with fake timers.
 *
 * Opening: when the window has been working for `openDelayMs` (quick answers never flash the table);
 * not while Claude waits for the user; never for replayed events; at most one table; never reopened
 * after the user closed it, until the next turn.
 * Closing (auto tables only): `afterHand` = "Done ✓" then close, or let the user finish the hand
 * (at most 60 s); `immediately`; `keepOpen`. If the table had focus, focus goes back to Claude.
 */
import type { DoneMode, StatusInfo } from '../../shared/protocol';
import type { WindowStateInfo } from '../claude/sessionTracker';

export type CloseBehavior = 'afterHand' | 'immediately' | 'keepOpen';
export type Mode = 'auto' | 'free';

export interface ControllerSettings {
  autoOpen: boolean;
  openDelayMs: number;
  closeBehavior: CloseBehavior;
  alertWhenNeedsYou: boolean;
}

type Event<T> = (listener: (e: T) => unknown) => { dispose(): unknown };

export interface PanelLike {
  readonly isDisposed: boolean;
  readonly hasFocus: boolean;
  readonly handInProgress: boolean;
  readonly onDidDispose: Event<void>;
  readonly onHandState: Event<boolean>;
  readonly onGoToClaude: Event<void>;
  status(s: StatusInfo): void;
  claudeDone(mode: DoneMode): void;
  reveal(): void;
  dispose(): void;
}

export interface ControllerDeps {
  createPanel(mode: Mode, status: StatusInfo): PanelLike;
  settings(): ControllerSettings;
  paused(): boolean;
  /** Move focus to Claude (the session's terminal or the panel). */
  focusClaude(reason: 'close' | 'button'): void;
  /** Claude needs a decision while the table is open (toast with "Go to Claude"). */
  needsYou(): void;
  log(msg: string): void;
}

export const DONE_SOON_MS = 1000;
export const AFTER_HAND_MAX_MS = 60_000;

export const toStatus = (w: WindowStateInfo): StatusInfo => ({ state: w.state, sessions: w.working + w.waiting, since: w.since });

export class TableController {
  private panel: PanelLike | undefined;
  private mode: Mode = 'auto';
  private closingByUs = false;
  private dismissed = false;
  private pendingOpen: ReturnType<typeof setTimeout> | undefined;
  private closing: { kind: DoneMode; timer?: ReturnType<typeof setTimeout> } | undefined;
  private last: WindowStateInfo = { state: 'idle', working: 0, waiting: 0, sessions: 0 };

  constructor(private readonly deps: ControllerDeps) {}

  get isOpen() {
    return !!this.panel && !this.panel.isDisposed;
  }
  get isPendingOpen() {
    return !!this.pendingOpen;
  }
  get closingKind() {
    return this.closing?.kind;
  }

  /**
   * @param live false for events replayed at activation or read late (> 10 s old): never open for those.
   * @param newTurn a session started a new turn (resets a dismissal).
   */
  update(w: WindowStateInfo, live: boolean, newTurn: boolean): void {
    const prev = this.last.state;
    this.last = w;
    if (newTurn || w.state === 'idle') this.dismissed = false;

    if (w.state === 'working') {
      this.cancelClosing();
      if (this.isOpen) this.panel!.status(toStatus(w));
      else if ((prev !== 'working' || newTurn) && live) this.scheduleOpen();
    } else if (w.state === 'waiting') {
      this.cancelPendingOpen(); // the user needs to answer first
      this.cancelClosing();
      if (this.isOpen) {
        this.panel!.status(toStatus(w));
        if (prev !== 'waiting' && this.deps.settings().alertWhenNeedsYou) this.deps.needsYou();
      }
    } else {
      this.cancelPendingOpen();
      if (this.isOpen) {
        this.panel!.status(toStatus(w));
        if (this.mode === 'auto' && prev !== 'idle') this.finish();
      }
    }
  }

  /** "Open Blackjack Table": free play, never closes automatically (also converts an auto table). */
  openFreePlay(): void {
    this.mode = 'free';
    this.cancelClosing();
    if (this.isOpen) this.panel!.reveal();
    else this.open('free');
  }

  /** "Go to Claude" from the table, a toast or the status bar. */
  goToClaude(): void {
    this.deps.focusClaude('button');
  }

  dispose(): void {
    this.cancelPendingOpen();
    this.cancelClosing();
    this.close(false);
  }

  // ---------------------------------------------------------------- opening

  private scheduleOpen() {
    if (this.pendingOpen || !this.canAutoOpen()) return;
    const delay = Math.max(0, this.deps.settings().openDelayMs);
    if (delay === 0) return this.open('auto');
    this.pendingOpen = setTimeout(() => {
      this.pendingOpen = undefined;
      if (this.last.state === 'working' && !this.isOpen && this.canAutoOpen()) this.open('auto');
    }, delay);
  }

  private canAutoOpen() {
    return !this.dismissed && !this.deps.paused() && this.deps.settings().autoOpen;
  }

  private cancelPendingOpen() {
    if (this.pendingOpen) clearTimeout(this.pendingOpen);
    this.pendingOpen = undefined;
  }

  private open(mode: Mode) {
    this.deps.log(`table: opening (${mode})`);
    this.mode = mode;
    const p = this.deps.createPanel(mode, toStatus(this.last));
    this.panel = p;
    p.onDidDispose(() => {
      if (this.panel !== p) return;
      this.panel = undefined;
      this.cancelClosing();
      if (!this.closingByUs && this.last.state !== 'idle') {
        this.dismissed = true;
        this.deps.log('table: closed by the user while Claude works; staying closed until the next turn');
      }
    });
    p.onHandState((inProgress) => {
      if (!inProgress && this.closing?.kind === 'afterHand' && this.panel === p) {
        this.deps.log('table: hand settled, closing');
        this.close(true);
      }
    });
    p.onGoToClaude(() => this.deps.focusClaude('button'));
  }

  // ---------------------------------------------------------------- closing

  private finish() {
    const behavior = this.deps.settings().closeBehavior;
    const p = this.panel!;
    if (behavior === 'immediately') {
      this.deps.log('table: Claude is done, closing');
      return this.close(true);
    }
    if (behavior === 'keepOpen') {
      p.claudeDone('keepOpen');
      return;
    }
    if (p.handInProgress) {
      this.deps.log('table: Claude is done; closing after the hand');
      p.claudeDone('afterHand');
      this.closing = { kind: 'afterHand', timer: setTimeout(() => this.close(true), AFTER_HAND_MAX_MS) };
    } else {
      p.claudeDone('soon');
      this.closing = { kind: 'soon', timer: setTimeout(() => this.close(true), DONE_SOON_MS) };
    }
  }

  private cancelClosing() {
    if (this.closing?.timer) clearTimeout(this.closing.timer);
    this.closing = undefined;
  }

  private close(returnFocus: boolean) {
    this.cancelClosing();
    const p = this.panel;
    if (!p || p.isDisposed) return;
    const hadFocus = p.hasFocus;
    this.closingByUs = true;
    try {
      p.dispose();
    } finally {
      this.closingByUs = false;
      this.panel = undefined;
    }
    if (returnFocus && hadFocus) this.deps.focusClaude('close');
  }
}
