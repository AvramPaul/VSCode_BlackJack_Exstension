/** Webview entry: connects the table to the extension (or to the dev harness mock). */
import './styles/table.css';
import { App, type Host } from './app';
import type { ToWebview } from '../shared/protocol';

interface VsCodeApi {
  postMessage(m: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const host: Host = { post: (m) => vscode.postMessage(m), getState: () => vscode.getState(), setState: (s) => vscode.setState(s) };
const root = document.getElementById('app')!;
let app: App | undefined;

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (!app && m.type === 'init') app = new App(root, host, m.saved);
  app?.receive(m);
});
vscode.postMessage({ type: 'ready' });
