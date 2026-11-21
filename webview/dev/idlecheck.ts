/**
 * ?idlecheck=MS — plan §7.2 "no CPU use when idle": count timer and animation-frame callbacks that run
 * while the table sits idle, and the animations still playing. Imported first by the harness.
 * Result: <pre id="idle-result">{json}</pre> (read by scripts/perf.mjs via headless --dump-dom).
 */
const params = new URLSearchParams(location.search);
const windowMs = Number(params.get('idlecheck') ?? 0);

if (windowMs > 0) {
  const counts = { timeout: 0, interval: 0, raf: 0 };
  let counting = false;
  const realTimeout = window.setTimeout.bind(window); // unwrapped: the check's own timers aren't counted
  const w = window as unknown as Record<string, unknown>;
  const wrap = (name: 'setTimeout' | 'setInterval' | 'requestAnimationFrame', key: keyof typeof counts) => {
    const orig = (w[name] as (...a: unknown[]) => number).bind(window);
    w[name] = (fn: (...a: unknown[]) => void, ...rest: unknown[]) =>
      orig((...args: unknown[]) => {
        if (counting) counts[key]++;
        fn(...args);
      }, ...rest);
  };
  wrap('setTimeout', 'timeout');
  wrap('setInterval', 'interval');
  wrap('requestAnimationFrame', 'raf');

  const settle = 3000;
  realTimeout(() => {
    counting = true;
    realTimeout(() => {
      counting = false;
      const animations = document.getAnimations().map((a) => (a as CSSAnimation).animationName ?? 'web-animation');
      const pre = document.createElement('pre');
      pre.id = 'idle-result';
      pre.textContent = JSON.stringify({ windowMs, ...counts, animations });
      document.body.appendChild(pre);
    }, windowMs);
  }, settle);
}
