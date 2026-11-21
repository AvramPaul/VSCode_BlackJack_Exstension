/** Harness entry: idle instrumentation and mock first, then the real webview app, then the debug bar. */
import './idlecheck';
import { harness } from './mock';
import '../main';
import { setForceReducedMotion } from '../ui/motion';
import { SCENARIO_NAMES } from './scenarios';
import './harness.css';

const params = new URLSearchParams(location.search);
const frame = document.getElementById('frame')!;
const w = params.get('w');
const h = params.get('h');
if (w) frame.style.width = `${w}px`;
if (h) frame.style.height = `${h}px`;
if (params.has('reduced') && !params.has('motion')) setForceReducedMotion(true);
if (params.has('bare')) document.body.classList.add('bare');

// Errors become visible (also in headless screenshots).
const showError = (msg: string) => {
  const d = document.createElement('div');
  d.className = 'harness-error';
  d.textContent = `ERROR: ${msg}`;
  document.body.appendChild(d);
};
window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError(String(e.reason)));

// ?open=menu: open the in-game menu (screenshots).
if (params.get('open') === 'menu') setTimeout(() => document.getElementById('menu-btn')?.click(), 400);

// Keyboard-only autoplay: ?keys=space,h,s&every=900 (keys as KeyboardEvent.key; "space" = " ").
const keys = (params.get('keys') ?? '').split(',').filter(Boolean);
const every = Number(params.get('every') ?? 900);
keys.forEach((k, i) =>
  setTimeout(() => {
    const key = k === 'space' ? ' ' : k === 'backspace' ? 'Backspace' : k;
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }, 600 + i * every),
);

const bar = document.getElementById('bar')!;
const btn = (label: string, fn: () => void) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', fn);
  bar.appendChild(b);
};
const sep = (label: string) => {
  const s = document.createElement('span');
  s.textContent = label;
  bar.appendChild(s);
};

sep('Claude:');
for (const state of ['idle', 'working', 'waiting'] as const) {
  btn(state, () => {
    harness.status = { state, sessions: 1, since: Date.now() - 12_000 };
    harness.send({ type: 'status', v: 1, status: harness.status });
  });
}
sep('Done:');
for (const mode of ['soon', 'afterHand', 'keepOpen'] as const) {
  btn(mode, () => {
    harness.status = { state: 'idle', sessions: 0 };
    harness.send({ type: 'status', v: 1, status: harness.status });
    harness.send({ type: 'claudeDone', v: 1, mode });
  });
}
sep('Size:');
for (const [wd, ht] of [
  [360, 700],
  [700, 800],
  [1400, 900],
  [700, 460],
]) {
  btn(`${wd}×${ht}`, () => {
    frame.style.width = `${wd}px`;
    frame.style.height = `${ht}px`;
  });
}
sep('Scenario:');
const sel = document.createElement('select');
for (const n of ['', ...SCENARIO_NAMES]) sel.add(new Option(n || '(saved)', n));
sel.value = params.get('scenario') ?? '';
sel.addEventListener('change', () => {
  const p = new URLSearchParams(location.search);
  if (sel.value) p.set('scenario', sel.value);
  else p.delete('scenario');
  location.search = p.toString();
});
bar.appendChild(sel);
btn('reduced motion', () => setForceReducedMotion(true));
btn('reset save', () => {
  localStorage.clear();
  location.search = '';
});

const log = document.getElementById('log')!;
harness.onLog = (line) => {
  log.textContent = `${line}\n${log.textContent ?? ''}`.slice(0, 2000);
};
