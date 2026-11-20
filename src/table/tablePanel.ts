/**
 * The table webview. Phase 2–3: a placeholder that shows Claude's status, the "needs you" strip with
 * Go to Claude, the done banners, and a toggle that pretends a hand is in progress (to exercise
 * close-after-hand before the game exists). The game (plan §7) replaces the HTML in Phase 4; the protocol stays.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { PROTOCOL_VERSION, type DoneMode, type FromWebview, type Prefs, type StatusInfo, type ToWebview } from '../../shared/protocol';
import type { Mode, PanelLike } from './tableController';

export const VIEW_TYPE = 'devjack.table';

export class TablePanel implements PanelLike, vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private queue: ToWebview[] = [];
  private disposed = false;
  private hand = false;
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly handEmitter = new vscode.EventEmitter<boolean>();
  private readonly goEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  readonly onHandState = this.handEmitter.event;
  readonly onGoToClaude = this.goEmitter.event;

  constructor(mode: Mode, status: StatusInfo, prefs: Prefs) {
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'DevJack', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false });
    this.panel.webview.html = html(this.panel.webview.cspSource);
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        this.ready = true;
        this.flush();
      } else if (m.type === 'handState') {
        this.hand = !!m.handInProgress;
        this.handEmitter.fire(this.hand);
      } else if (m.type === 'goToClaude') this.goEmitter.fire();
      else if (m.type === 'close') this.dispose();
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
      this.handEmitter.dispose();
      this.goEmitter.dispose();
    });
    this.post({ type: 'init', v: PROTOCOL_VERSION, mode, status, prefs });
  }

  get isDisposed() {
    return this.disposed;
  }
  /** The table's tab is active in its group and the window has focus. */
  get hasFocus() {
    return !this.disposed && this.panel.active && vscode.window.state.focused;
  }
  get handInProgress() {
    return this.hand;
  }

  status(status: StatusInfo) {
    this.post({ type: 'status', v: PROTOCOL_VERSION, status });
  }
  claudeDone(mode: DoneMode) {
    this.post({ type: 'claudeDone', v: PROTOCOL_VERSION, mode });
  }
  prefs(prefs: Prefs) {
    this.post({ type: 'prefs', v: PROTOCOL_VERSION, prefs });
  }
  reveal() {
    if (!this.disposed) this.panel.reveal(undefined, true);
  }

  private post(m: ToWebview) {
    if (this.disposed) return;
    this.queue.push(m);
    this.flush();
  }
  private flush() {
    if (!this.ready) return;
    for (const m of this.queue.splice(0)) void this.panel.webview.postMessage(m);
  }

  dispose() {
    if (!this.disposed) this.panel.dispose();
  }
}

function html(cspSource: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DevJack</title>
<style nonce="${nonce}">
  :root { --amber: var(--vscode-editorWarning-foreground, #d7a000); }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .strip { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent); min-height: 28px; }
  .strip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .strip.working .dot { background: var(--vscode-progressBar-background, #0e70c0); }
  .strip.waiting { background: color-mix(in srgb, var(--amber) 14%, transparent); }
  .strip.waiting .dot { background: var(--amber); animation: pulse 1.2s ease-in-out infinite; }
  .strip.done .dot { background: var(--vscode-testing-iconPassed, #3fb950); }
  .strip .label { font-weight: 600; }
  .strip .time { opacity: .7; font-variant-numeric: tabular-nums; }
  .strip .spacer { flex: 1; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  kbd { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .8; margin-left: 6px; }
  .banner { margin: 12px; padding: 10px 12px; border-left: 3px solid var(--amber); background: color-mix(in srgb, var(--amber) 10%, transparent); }
  .main { flex: 1; display: grid; place-items: center; text-align: center; padding: 24px; }
  .note { font-size: 12px; opacity: .6; margin-top: 16px; }
  .hidden { display: none; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .strip.waiting .dot { animation: none; } }
</style>
</head>
<body>
<div class="strip" id="strip" role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>
  <span class="label" id="label">DevJack</span>
  <span class="time" id="time"></span>
  <span class="spacer"></span>
  <button id="go" class="hidden" title="Go to Claude (G)">Go to Claude<kbd>G</kbd></button>
</div>
<div class="banner hidden" id="banner" role="status"></div>
<div class="main">
  <div>
    <div>Placeholder table. The game arrives in Phase 4.</div>
    <label class="note"><input type="checkbox" id="hand"> Pretend a hand is in progress</label>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let status = { state: 'idle', sessions: 0 };
  let done = null;
  let timer;
  const LABEL = { idle: 'Claude is idle', working: 'Claude is working', waiting: 'Claude needs you', done: 'Done ✓' };
  function render() {
    const state = done && status.state === 'idle' ? 'done' : status.state;
    $('strip').className = 'strip ' + state;
    $('label').textContent = LABEL[state] || state;
    let t = '';
    if ((state === 'working' || state === 'waiting') && status.since) {
      const s = Math.max(0, Math.floor((Date.now() - status.since) / 1000));
      t = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      if (status.sessions > 1) t += ' · ' + status.sessions + ' sessions';
    }
    $('time').textContent = t;
    $('go').classList.toggle('hidden', state !== 'waiting');
    const banner = done === 'afterHand' ? 'Claude finished, finish your hand.' : done === 'keepOpen' && state === 'done' ? 'Claude is done.' : '';
    $('banner').textContent = banner;
    $('banner').classList.toggle('hidden', !banner);
    // Tick only while Claude works: no CPU use when idle.
    const ticking = state === 'working' || state === 'waiting';
    if (ticking && !timer) timer = setInterval(render, 1000);
    if (!ticking && timer) { clearInterval(timer); timer = undefined; }
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'init' || m.type === 'status') { status = m.status; if (status.state !== 'idle') done = null; render(); }
    if (m.type === 'claudeDone') { done = m.mode; render(); }
  });
  $('go').addEventListener('click', () => vscode.postMessage({ type: 'goToClaude' }));
  $('hand').addEventListener('change', (e) => vscode.postMessage({ type: 'handState', handInProgress: e.target.checked }));
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'g' || e.key === 'G') && status.state === 'waiting') vscode.postMessage({ type: 'goToClaude' });
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
