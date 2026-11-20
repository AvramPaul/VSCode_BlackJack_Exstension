/**
 * The table webview (plan §7.4): loads the bundled game (dist/webview) through asWebviewUri, with a strict
 * CSP (default-src 'none', scripts by nonce, styles/images/fonts only from the webview's own source).
 * It only ever sends status values and numbers to the webview, never prompt or tool content.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { PROTOCOL_VERSION, type DoneMode, type FromWebview, type Prefs, type StatusInfo, type ToWebview } from '../../shared/protocol';
import type { Mode, PanelLike } from './tableController';

export const VIEW_TYPE = 'devjack.table';

export interface PanelOptions {
  extensionUri: vscode.Uri;
  mode: Mode;
  status: StatusInfo;
  prefs: Prefs;
  /** The last saved game (globalState): bankroll, stats, options, a round in progress. */
  saved: unknown;
  onSave(data: unknown): void;
}

export class TablePanel implements PanelLike, vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private queue: ToWebview[] = [];
  private disposed = false;
  private hand = false;
  private status_: StatusInfo;
  private done: DoneMode | undefined;
  private prefs_: Prefs;
  private saved: unknown;
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly handEmitter = new vscode.EventEmitter<boolean>();
  private readonly goEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  readonly onHandState = this.handEmitter.event;
  readonly onGoToClaude = this.goEmitter.event;

  constructor(private readonly opts: PanelOptions) {
    this.status_ = opts.status;
    this.prefs_ = opts.prefs;
    this.saved = opts.saved;
    const root = vscode.Uri.joinPath(opts.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'DevJack', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [root, vscode.Uri.joinPath(opts.extensionUri, 'media')], retainContextWhenHidden: false });
    this.panel.iconPath = vscode.Uri.joinPath(opts.extensionUri, 'media', 'tab-icon.svg');
    const w = this.panel.webview;
    w.html = html(w.cspSource, w.asWebviewUri(vscode.Uri.joinPath(root, 'main.js')).toString(), w.asWebviewUri(vscode.Uri.joinPath(root, 'main.css')).toString());
    w.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
      this.handEmitter.dispose();
      this.goEmitter.dispose();
    });
  }

  private onMessage(m: FromWebview) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        // Also after VS Code reloads a hidden webview: start over with the current picture.
        this.ready = true;
        this.queue = [];
        void this.panel.webview.postMessage({ type: 'init', v: PROTOCOL_VERSION, mode: this.opts.mode, status: this.status_, prefs: this.prefs_, saved: this.saved } satisfies ToWebview);
        if (this.done) void this.panel.webview.postMessage({ type: 'claudeDone', v: PROTOCOL_VERSION, mode: this.done } satisfies ToWebview);
        break;
      case 'handState':
        this.hand = !!m.handInProgress;
        this.handEmitter.fire(this.hand);
        break;
      case 'save':
        this.saved = m.data;
        this.opts.onSave(m.data);
        break;
      case 'goToClaude':
        this.goEmitter.fire();
        break;
      case 'close':
        this.dispose();
        break;
    }
  }

  get isDisposed() {
    return this.disposed;
  }
  /** The game script loaded (under the CSP) and said hello. */
  get isReady() {
    return this.ready && !this.disposed;
  }
  /** The table's tab is active in its group and the window has focus. */
  get hasFocus() {
    return !this.disposed && this.panel.active && vscode.window.state.focused;
  }
  get handInProgress() {
    return this.hand;
  }

  status(status: StatusInfo) {
    this.status_ = status;
    if (status.state !== 'idle') this.done = undefined;
    this.post({ type: 'status', v: PROTOCOL_VERSION, status });
  }
  claudeDone(mode: DoneMode) {
    this.done = mode;
    this.post({ type: 'claudeDone', v: PROTOCOL_VERSION, mode });
  }
  prefs(prefs: Prefs) {
    this.prefs_ = prefs;
    this.post({ type: 'prefs', v: PROTOCOL_VERSION, prefs });
  }
  reveal() {
    if (!this.disposed) this.panel.reveal(undefined, true);
  }

  private post(m: ToWebview) {
    if (this.disposed) return;
    if (!this.ready) {
      this.queue.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  dispose() {
    if (!this.disposed) this.panel.dispose();
  }
}

function html(cspSource: string, js: string, css: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource}; img-src ${cspSource} data:; font-src ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>DevJack</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
