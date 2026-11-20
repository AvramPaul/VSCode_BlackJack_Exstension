import { describe, expect, it } from 'vitest';
import { cardName, fullDeck, handValue, isTwoCard21, type Card } from '../../../webview/engine/cards';
import { cryptoRandomInt, cutFor, drawCard, newShoe, shuffleInPlace } from '../../../webview/engine/shoe';

const v = (...cards: Card[]) => handValue(cards);

describe('handValue', () => {
  it('counts hard and soft totals, promoting at most one ace', () => {
    expect(v('AS', '6H')).toEqual({ total: 17, soft: true });
    expect(v('AS', '6H', 'TC')).toEqual({ total: 17, soft: false });
    expect(v('AS', 'AD')).toEqual({ total: 12, soft: true });
    expect(v('AS', 'AD', '9C')).toEqual({ total: 21, soft: true });
    expect(v('AS', 'AD', 'AC', 'AH')).toEqual({ total: 14, soft: true });
    expect(v('KS', 'QD', '2C')).toEqual({ total: 22, soft: false });
    expect(v()).toEqual({ total: 0, soft: false });
  });
  it('two-card 21', () => {
    expect(isTwoCard21(['AS', 'JD'])).toBe(true);
    expect(isTwoCard21(['7S', '7D', '7C'])).toBe(false);
  });
  it('names cards for screen readers', () => {
    expect(cardName('QH')).toBe('Queen of hearts');
    expect(cardName('TS')).toBe('Ten of spades');
    expect(cardName('AC')).toBe('Ace of clubs');
  });
  it('a deck has 52 distinct cards', () => {
    expect(new Set(fullDeck()).size).toBe(52);
  });
});

describe('shoe', () => {
  it('holds N full decks, shuffled', () => {
    const s = newShoe(6, cryptoRandomInt);
    expect(s.cards).toHaveLength(312);
    const counts = new Map<string, number>();
    for (const c of s.cards) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 6)).toBe(true);
    expect(s.cards.slice(0, 52)).not.toEqual(fullDeck());
  });
  it('places the cut card at about 75 % (72–78 %)', () => {
    for (let i = 0; i < 200; i++) {
      const cut = cutFor(312, cryptoRandomInt);
      expect(cut).toBeGreaterThanOrEqual(Math.round(312 * 0.72));
      expect(cut).toBeLessThanOrEqual(Math.round(312 * 0.78));
    }
  });
  it('cryptoRandomInt stays in range and is roughly uniform', () => {
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 60000; i++) counts[cryptoRandomInt(6)]++;
    for (const n of counts) expect(Math.abs(n - 10000)).toBeLessThan(600);
    expect(() => cryptoRandomInt(0)).toThrow();
  });
  it('Fisher–Yates gives every position to every card (smoke check)', () => {
    const first = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const a = shuffleInPlace(['a', 'b', 'c', 'd'], cryptoRandomInt);
      first.set(a[0]!, (first.get(a[0]!) ?? 0) + 1);
    }
    for (const k of 'abcd') expect(Math.abs((first.get(k) ?? 0) - 1000)).toBeLessThan(150);
  });
  it('an exhausted shoe is rebuilt from the cards not on the table', () => {
    const s = newShoe(1, cryptoRandomInt);
    s.pos = s.cards.length;
    const table: Card[] = ['AS', 'KH', '7D'];
    const { card, reshuffled } = drawCard(s, cryptoRandomInt, table);
    expect(reshuffled).toBe(true);
    expect(s.cards).toHaveLength(49);
    expect(table).not.toContain(card);
    expect(s.cards.filter((c) => table.includes(c))).toEqual([]);
  });
});
