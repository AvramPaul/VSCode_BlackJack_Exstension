/**
 * Browser harness (plan §7.4): a mock `acquireVsCodeApi` so the game runs in a normal browser.
 * Must be imported before main.ts. State lives in localStorage.
 */
import type { FromWebview, StatusInfo, ToWebview } from '../../shared/protocol';
import { scenario } from './scenarios';

const params = new URLSearchParams(location.search);
const SAVED_KEY = 'devjack-harness-saved';
const STATE_KEY = 'devjack-harness-state';

export const harness = {
  status: { state: (params.get('claude') as StatusInfo['state']) || 'idle', sessions: 1, since: Date.now() - 42_000 } as StatusInfo,
  log: [] as string[],
  onLog: (_line: string) => undefined as void,
  send(m: ToWebview) {
    window.postMessage(m, '*');
  },
};

function logLine(s: string) {
  harness.log.push(s);
  harness.onLog(s);
}

const sc = params.get('scenario');
if (sc || params.has('reset')) {
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(SAVED_KEY);
}
const preset = sc ? scenario(sc) : undefined;

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(m: FromWebview) {
    if (m.type === 'ready') {
      const saved = preset ?? JSON.parse(localStorage.getItem(SAVED_KEY) ?? 'null');
      setTimeout(() => harness.send({ type: 'init', v: 1, mode: (params.get('mode') as 'auto' | 'free') || 'auto', status: harness.status, prefs: { sound: true }, saved }), 0);
    } else if (m.type === 'save') localStorage.setItem(SAVED_KEY, JSON.stringify(m.data));
    else logLine(JSON.stringify(m));
  },
  getState: () => (preset ? undefined : JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null')),
  setState: (s: unknown) => localStorage.setItem(STATE_KEY, JSON.stringify(s)),
});
