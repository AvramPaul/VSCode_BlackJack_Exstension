/** The shoe (plan §7.1): N decks, Fisher–Yates with crypto randomness, cut card at about 75 %. */
import { fullDeck, type Card } from './cards';

/** Uniform integer in [0, maxExclusive). Injected so tests can be deterministic. */
export type RandomInt = (maxExclusive: number) => number;

/** crypto.getRandomValues with rejection sampling (no modulo bias). */
export const cryptoRandomInt: RandomInt = (max) => {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError('max must be a positive integer');
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
};

export function shuffleInPlace<T>(a: T[], rnd: RandomInt): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface ShoeState {
  decks: number;
  cards: Card[];
  /** Next card to deal. */
  pos: number;
  /** Cut card: reshuffle before the next round once `pos` reaches it. */
  cut: number;
}

/** Cut card between 72 % and 78 % of the shoe (one card for a single deck less, so a round can finish). */
export function cutFor(length: number, rnd: RandomInt): number {
  return Math.round(length * (0.72 + rnd(61) / 1000));
}

export function newShoe(decks: number, rnd: RandomInt): ShoeState {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) cards.push(...fullDeck());
  shuffleInPlace(cards, rnd);
  return { decks, cards, pos: 0, cut: cutFor(cards.length, rnd) };
}

export const pastCut = (s: ShoeState) => s.pos >= s.cut;

/**
 * Deal one card. If the shoe is empty mid-round (a long round from a single deck), the cards that are
 * not on the table are reshuffled into a fresh shoe first.
 */
export function drawCard(s: ShoeState, rnd: RandomInt, onTable: readonly Card[]): { card: Card; reshuffled: boolean } {
  let reshuffled = false;
  if (s.pos >= s.cards.length) {
    const remaining: Card[] = [];
    for (let d = 0; d < s.decks; d++) remaining.push(...fullDeck());
    for (const c of onTable) {
      const i = remaining.indexOf(c);
      if (i >= 0) remaining.splice(i, 1);
    }
    shuffleInPlace(remaining, rnd);
    s.cards = remaining;
    s.pos = 0;
    s.cut = cutFor(remaining.length, rnd);
    reshuffled = true;
  }
  return { card: s.cards[s.pos++]!, reshuffled };
}
