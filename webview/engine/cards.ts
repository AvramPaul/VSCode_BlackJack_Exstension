/** Cards as compact strings: rank + suit, e.g. "AS", "TH", "9C". Serializable as-is. */

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'] as const;
export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];
export type Card = `${Rank}${Suit}`;

export const rankOf = (c: Card) => c[0] as Rank;
export const suitOf = (c: Card) => c[1] as Suit;
export const isTenValue = (c: Card) => 'TJQK'.includes(c[0]!);
export const isAce = (c: Card) => c[0] === 'A';

/** Blackjack value of a rank, aces counted as 1 (handValue promotes one ace to 11 when it fits). */
export function rankPoints(r: Rank): number {
  if (r === 'A') return 1;
  if (r === 'T' || r === 'J' || r === 'Q' || r === 'K') return 10;
  return Number(r);
}

export interface HandValue {
  total: number;
  /** An ace is counted as 11. */
  soft: boolean;
}

export function handValue(cards: readonly Card[]): HandValue {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = rankOf(c);
    if (r === 'A') aces++;
    total += rankPoints(r);
  }
  if (aces && total + 10 <= 21) return { total: total + 10, soft: true };
  return { total, soft: false };
}

/** Two cards worth 21. (A split hand's 21 is not a blackjack: callers check `fromSplit`.) */
export const isTwoCard21 = (cards: readonly Card[]) => cards.length === 2 && handValue(cards).total === 21;

export function fullDeck(): Card[] {
  const out: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) out.push(`${r}${s}`);
  return out;
}

const RANK_NAME: Record<Rank, string> = { A: 'Ace', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King' };
const SUIT_NAME: Record<Suit, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

/** Accessible name, e.g. "Queen of hearts". */
export const cardName = (c: Card) => `${RANK_NAME[rankOf(c)]} of ${SUIT_NAME[suitOf(c)]}`;
