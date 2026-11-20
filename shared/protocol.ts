/**
 * Messages between the extension and the table webview (plan §7.4). Versioned; shared by both bundles.
 * The webview never receives prompt or tool content: only status values and numbers.
 */
export const PROTOCOL_VERSION = 1;

export type ClaudeStatus = 'idle' | 'working' | 'waiting' | 'done';

export interface StatusInfo {
  state: ClaudeStatus;
  /** Sessions working or waiting in this window. */
  sessions: number;
  /** When the current work started (ms since epoch), for the elapsed timer. */
  since?: number;
}

/**
 * How the table ends after Claude is done:
 * - 'soon': no hand in progress; "Done ✓" for about 1 s, then the table closes;
 * - 'afterHand': "Claude finished, finish your hand"; closes when the hand settles (at most 60 s);
 * - 'keepOpen': shows that Claude is done and stays open.
 */
export type DoneMode = 'soon' | 'afterHand' | 'keepOpen';

export interface Prefs {
  sound: boolean;
}

export type ToWebview =
  | { type: 'init'; v: typeof PROTOCOL_VERSION; mode: 'auto' | 'free'; status: StatusInfo; prefs: Prefs }
  | { type: 'status'; v: typeof PROTOCOL_VERSION; status: StatusInfo }
  | { type: 'claudeDone'; v: typeof PROTOCOL_VERSION; mode: DoneMode }
  | { type: 'prefs'; v: typeof PROTOCOL_VERSION; prefs: Prefs };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'goToClaude' }
  | { type: 'close' }
  | { type: 'handState'; handInProgress: boolean }
  | { type: 'save'; data: unknown };
