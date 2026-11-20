/**
 * Animation helpers (plan §7.2): Web Animations API on transform and opacity only, no permanent
 * requestAnimationFrame loop, `prefers-reduced-motion` respected, and a fast-forward for impatient players.
 */

let fast = false;
const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
let forceReduce = false;

export const reducedMotion = () => forceReduce || !!reduceQuery?.matches;
/** Dev harness toggle. */
export function setForceReducedMotion(on: boolean) {
  forceReduce = on;
}

const running = new Set<Animation>();

/** Finish everything that is playing now and play the rest of the current timeline instantly. */
export function fastForward() {
  fast = true;
  for (const a of running) a.finish();
}
export function endFastForward() {
  fast = false;
}

export function animate(el: Element, keyframes: Keyframe[], ms: number, easing = 'cubic-bezier(.2,.7,.2,1)', delay = 0): Promise<void> {
  if (reducedMotion() || fast || ms <= 0) return Promise.resolve();
  const a = el.animate(keyframes, { duration: ms, easing, delay, fill: 'backwards' });
  running.add(a);
  // Never let the timeline depend on animation frames: a hidden document (or headless virtual time)
  // may not advance them, and `finished` would never resolve.
  const timeout = new Promise<void>((r) => setTimeout(r, delay + ms + 60));
  return Promise.race([a.finished.then(() => undefined, () => undefined), timeout]).then(() => void running.delete(a));
}

export const wait = (ms: number) => (reducedMotion() || fast ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)));

/** FLIP: animate `el` from where `from` is to where it is now. */
export function flyFrom(el: HTMLElement, from: DOMRect, ms: number, extra: { rotate?: number; scale?: number } = {}): Promise<void> {
  const to = el.getBoundingClientRect();
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return animate(
    el,
    [
      { transform: `translate(${dx}px, ${dy}px) rotate(${extra.rotate ?? -12}deg) scale(${extra.scale ?? 0.85})`, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ],
    ms,
  );
}

export function shake(el: Element): Promise<void> {
  return animate(el, [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], 360, 'ease-out');
}

export function pop(el: Element): Promise<void> {
  return animate(el, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], 320);
}
