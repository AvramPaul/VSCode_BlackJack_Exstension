import { describe, expect, it } from 'vitest';
import type { Card } from '../../../webview/engine/cards';
import { handValue } from '../../../webview/engine/cards';
import {
  apply,
  canDouble,
  canSplit,
  handInProgress,
  legalActions,
  MAX_BET,
  newGame,
  START_BANKROLL,
  visibleDealer,
  type Action,
  type GameEvent,
  type GameState,
} from '../../../webview/engine/game';
import type { RandomInt } from '../../../webview/engine/shoe';

/** Deterministic RNG for tests (mulberry32). */
function seeded(seed: number): RandomInt {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}
const rnd = seeded(42);

/** A game whose shoe deals `cards` in order: player, dealer up, player, dealer hole, then draws. */
function stacked(cards: Card[], opts: Partial<GameState['options']> = {}, bet = 100): GameState {
  const s = newGame(opts, rnd);
  s.shoe = { decks: s.options.decks, cards: [...cards, ...s.shoe.cards], pos: 0, cut: 10_000 };
  s.bet = bet;
  return s;
}

/** Apply actions in order, failing on any error; returns the final state and all events. */
function play(s: GameState, ...actions: Action[]) {
  const events: GameEvent[] = [];
  for (const a of actions) {
    const r = apply(s, a, rnd);
    if (r.error) throw new Error(`${a.type}: ${r.error}`);
    s = r.state;
    events.push(...r.events);
  }
  return { s, events };
}
const D: Action = { type: 'deal' };
const H: Action = { type: 'hit' };
const S: Action = { type: 'stand' };
const types = (evs: GameEvent[]) => evs.map((e) => e.type);

describe('betting', () => {
  it('chips add up to the maximum; clear resets; deal needs the minimum', () => {
    let s = newGame({}, rnd);
    s = play(s, { type: 'clearBet' }, { type: 'chip', value: 500 }).s;
    expect(s.bet).toBe(500);
    expect(apply(s, { type: 'chip', value: 5 }).error).toMatch(/maximum/);
    s = play(s, { type: 'clearBet' }).s;
    expect(apply(s, D).error).toMatch(/minimum/);
    expect(MAX_BET).toBe(500);
  });

  it('the maximum is the bankroll when smaller', () => {
    let s = newGame({}, rnd);
    s.bankroll = 30;
    s.bet = 0;
    s = play(s, { type: 'chip', value: 25 }, { type: 'chip', value: 5 }).s;
    expect(apply(s, { type: 'chip', value: 5 }).error).toBeDefined();
  });

  it('an illegal action changes nothing and reports why', () => {
    const s = newGame({}, rnd);
    for (const a of [H, S, { type: 'double' }, { type: 'split' }, { type: 'insurance', take: true }] as Action[]) {
      const r = apply(s, a);
      expect(r.error).toBeDefined();
      expect(r.state).toBe(s);
      expect(r.events).toEqual([]);
    }
  });

  it('deals player, dealer up, player, dealer hole (face down)', () => {
    const { s, events } = play(stacked(['9S', '7H', '5D', 'KC']), D);
    expect(s.hands[0]!.cards).toEqual(['9S', '5D']);
    expect(s.dealer).toEqual(['7H', 'KC']);
    expect(visibleDealer(s)).toEqual(['7H', null]);
    const cards = events.filter((e) => e.type === 'card');
    expect(cards).toEqual([
      { type: 'card', to: 0, card: '9S' },
      { type: 'card', to: 'dealer', card: '7H' },
      { type: 'card', to: 0, card: '5D' },
      { type: 'card', to: 'dealer', faceDown: true },
    ]);
    expect(s.bankroll).toBe(START_BANKROLL - 100);
    expect(handInProgress(s)).toBe(true);
  });
});

describe('payouts', () => {
  it('blackjack pays 3:2 (dealer shows a 9: no peek)', () => {
    const { s, events } = play(stacked(['AS', '9H', 'KD', '7C']), D);
    expect(s.phase).toBe('betting');
    expect(s.hands[0]!.result).toBe('blackjack');
    expect(s.bankroll).toBe(START_BANKROLL + 150);
    expect(s.lastNet).toBe(150);
    expect(s.stats).toMatchObject({ blackjacks: 1, wins: 1, handsPlayed: 1, net: 150, biggestWin: 150 });
    expect(types(events)).toEqual(['betPlaced', 'card', 'card', 'card', 'card', 'handDone', 'reveal', 'dealerDone', 'settled', 'roundOver']);
  });

  it('3:2 on a 5 bet pays 7.5', () => {
    expect(play(stacked(['AS', '9H', 'KD', '7C'], {}, 5), D).s.bankroll).toBe(START_BANKROLL + 7.5);
  });

  it('win pays 1:1', () => {
    expect(play(stacked(['TS', '9H', 'TD', '8C']), D, S).s.bankroll).toBe(START_BANKROLL + 100); // 20 vs 17
  });

  it('push and loss', () => {
    const push = play(stacked(['TS', '9H', '9D', 'TC']), D, S).s; // 19 vs 19
    expect(push.hands[0]!.result).toBe('push');
    expect(push.bankroll).toBe(START_BANKROLL);
    const lose = play(stacked(['TS', '9H', '7D', 'TC']), D, S).s; // 17 vs 19
    expect(lose.hands[0]!.result).toBe('lose');
    expect(lose.bankroll).toBe(START_BANKROLL - 100);
  });

  it('bust loses even if the dealer would bust; the dealer then draws nothing', () => {
    const { s } = play(stacked(['TS', '6H', '6D', 'TC', 'KS']), D, H); // 22
    expect(s.hands[0]!.result).toBe('lose');
    expect(s.dealer).toHaveLength(2);
  });

  it('dealer bust: every standing hand wins', () => {
    const { s } = play(stacked(['TS', '6H', '8D', 'TC', 'KS']), D, S); // dealer 16 + K
    expect(handValue(s.dealer).total).toBe(26);
    expect(s.hands[0]!.result).toBe('win');
  });
});

describe('dealer peek and insurance', () => {
  it('ten up with a hidden ace: blackjack is checked at once and the hand is over', () => {
    const { s, events } = play(stacked(['9S', 'KH', '9D', 'AC']), D);
    expect(types(events)).toContain('peek');
    expect(s.phase).toBe('betting');
    expect(s.hands[0]!.result).toBe('lose');
    expect(s.bankroll).toBe(START_BANKROLL - 100);
  });

  it('ten up, no blackjack: play continues', () => {
    const { s, events } = play(stacked(['9S', 'KH', '9D', '7C']), D);
    expect(events.find((e) => e.type === 'peek')).toEqual({ type: 'peek', blackjack: false });
    expect(s.phase).toBe('playerTurn');
  });

  it('ace up: insurance offered; taken and dealer has blackjack → 2:1, main bet lost (net 0)', () => {
    let s = play(stacked(['9S', 'AH', '9D', 'KC']), D).s;
    expect(s.phase).toBe('insurance');
    expect(legalActions(s)).toEqual(new Set(['insurance', 'setOptions', 'resetStats']));
    const r = play(s, { type: 'insurance', take: true });
    s = r.s;
    expect(r.events).toContainEqual({ type: 'insuranceResult', won: true, payout: 150 });
    expect(s.bankroll).toBe(START_BANKROLL);
    expect(s.lastNet).toBe(0);
  });

  it('ace up: insurance taken, no blackjack → insurance lost, play continues', () => {
    const { s, events } = play(stacked(['9S', 'AH', '9D', '7C']), D, { type: 'insurance', take: true });
    expect(events).toContainEqual({ type: 'insuranceResult', won: false, payout: 0 });
    expect(s.phase).toBe('playerTurn');
    expect(s.bankroll).toBe(START_BANKROLL - 150);
  });

  it('player blackjack vs dealer blackjack (declined insurance) is a push', () => {
    const { s } = play(stacked(['AS', 'AH', 'KD', 'QC']), D, { type: 'insurance', take: false });
    expect(s.hands[0]!.result).toBe('push');
    expect(s.bankroll).toBe(START_BANKROLL);
  });

  it('even money: blackjack + insurance against an ace that is not a blackjack = +1x', () => {
    const { s } = play(stacked(['AS', 'AH', 'KD', '7C']), D, { type: 'insurance', take: true });
    expect(s.lastNet).toBe(100);
  });

  it('no insurance offered when the bankroll cannot cover it', () => {
    const s0 = stacked(['9S', 'AH', '9D', '7C'], {}, 100);
    s0.bankroll = 120; // 20 left after the bet, insurance costs 50
    const { s } = play(s0, D);
    expect(s.phase).toBe('playerTurn');
  });
});

describe('dealer rules', () => {
  it('S17: stands on soft 17', () => {
    const { s } = play(stacked(['TS', 'AH', '8D', '6C', '5S']), D, { type: 'insurance', take: false }, S);
    expect(s.dealer).toEqual(['AH', '6C']);
    expect(s.hands[0]!.result).toBe('win'); // 18 vs 17
  });
  it('H17: hits soft 17', () => {
    const { s } = play(stacked(['TS', 'AH', '8D', '6C', '2S'], { dealerHitsSoft17: true }), D, { type: 'insurance', take: false }, S);
    expect(s.dealer).toEqual(['AH', '6C', '2S']);
    expect(s.hands[0]!.result).toBe('lose'); // 18 vs 19
  });
  it('the dealer draws to 17 or more', () => {
    const { s } = play(stacked(['TS', '2H', '8D', '3C', '4S', '2D', '6H']), D, S);
    expect(handValue(s.dealer).total).toBeGreaterThanOrEqual(17);
  });
});

describe('double', () => {
  it('doubles the bet, takes exactly one card, and pays on the doubled bet', () => {
    const { s, events } = play(stacked(['6S', '9H', '5D', '7C', 'TS', '9S']), D, { type: 'double' }); // 21 vs 16 → 25
    expect(events).toContainEqual({ type: 'double', hand: 0, bet: 200 });
    expect(s.hands[0]!.cards).toHaveLength(3);
    expect(s.hands[0]!.result).toBe('win');
    expect(s.bankroll).toBe(START_BANKROLL + 200);
  });
  it('only on the first two cards, and only with enough chips', () => {
    let s = play(stacked(['2S', '9H', '3D', '7C', '2C']), D, H).s;
    expect(canDouble(s)).toBe(false);
    s = play(stacked(['6S', '9H', '5D', '7C'], {}, 500), D).s;
    s.bankroll = 499;
    expect(canDouble(s)).toBe(false);
  });
});

describe('split', () => {
  it('splits a pair into two hands that are played in turn', () => {
    // 8 8 vs 6: split; hand 0 gets 3 (11) then T (21 auto); hand 1 gets 9 (17) stand; dealer 6+T+9 = 25
    const { s, events } = play(stacked(['8S', '6H', '8D', 'TC', '3S', 'TD', '9H', '9C']), D, { type: 'split' }, H, S);
    expect(events).toContainEqual({ type: 'split', hand: 0, newHand: 1, bet: 100 });
    expect(s.hands.map((h) => h.cards)).toEqual([
      ['8S', '3S', 'TD'],
      ['8D', '9H'],
    ]);
    expect(s.hands.map((h) => h.result)).toEqual(['win', 'win']);
    expect(s.bankroll).toBe(START_BANKROLL + 200);
  });

  it('split tens of different ranks (equal value)', () => {
    expect(canSplit(play(stacked(['KS', '6H', 'QD', 'TC']), D).s)).toBe(true);
  });

  it('split aces get one card each; 21 after a split is not a blackjack (pays 1:1)', () => {
    const { s, events } = play(stacked(['AS', '9H', 'AD', '7C', 'KS', '5H']), D, { type: 'split' });
    expect(s.hands.map((h) => h.cards)).toEqual([
      ['AS', 'KS'],
      ['AD', '5H'],
    ]);
    expect(events.filter((e) => e.type === 'handDone').map((e) => (e as { reason: string }).reason)).toEqual(['splitAces', 'splitAces']);
    expect(s.hands[0]!.result).toBe('win'); // 21 vs 16+... dealer draws
    expect(s.hands[0]!.payout).toBe(200); // not 250
  });

  it('up to 4 hands', () => {
    let s = play(stacked(['8S', '6H', '8D', 'TC', '8H', '8C', '8S', '2D']), D).s;
    for (let i = 0; i < 3; i++) s = play(s, { type: 'split' }).s;
    expect(s.hands).toHaveLength(4);
    expect(canSplit(s)).toBe(false);
  });

  it('double after split is allowed', () => {
    const s = play(stacked(['8S', '6H', '8D', 'TC', '3S']), D, { type: 'split' }).s; // hand 0: 8+3
    expect(canDouble(s)).toBe(true);
  });
});

describe('bankroll, rebuy, stats, options', () => {
  it('free rebuy only when below the minimum bet, counted in stats', () => {
    const s = newGame({}, rnd);
    expect(apply(s, { type: 'rebuy' }).error).toBeDefined();
    s.bankroll = 2.5;
    s.bet = 0;
    const r = play(s, { type: 'rebuy' });
    expect(r.s.bankroll).toBe(START_BANKROLL);
    expect(r.s.stats.rebuys).toBe(1);
  });

  it('pre-fills the last bet, capped by the bankroll, in whole chips of 5', () => {
    const s0 = stacked(['TS', '9H', '7D', 'TC'], {}, 100);
    s0.bankroll = 112.5;
    const { s } = play(s0, D, S); // loses 100 → 12.5 left
    expect(s.bet).toBe(10);
  });

  it('resetStats clears the stats only', () => {
    const { s } = play(stacked(['AS', '9H', 'KD', '7C']), D, { type: 'resetStats' });
    expect(s.stats.handsPlayed).toBe(0);
    expect(s.bankroll).toBe(START_BANKROLL + 150);
  });

  it('changing the deck count makes a new shoe; options only between rounds', () => {
    const s = newGame({}, rnd);
    const r = play(s, { type: 'setOptions', options: { decks: 2 } });
    expect(r.s.shoe.cards).toHaveLength(104);
    expect(types(r.events)).toEqual(['shuffle', 'options']);
    const mid = play(stacked(['9S', '7H', '5D', 'KC']), D).s;
    expect(apply(mid, { type: 'setOptions', options: { decks: 8 } }).error).toBeDefined();
  });

  it('reshuffles before a round once the cut card is reached', () => {
    const s = newGame({ decks: 1 }, rnd);
    s.shoe.pos = s.shoe.cut;
    const r = play(s, D);
    expect(r.events[0]).toEqual({ type: 'shuffle', decks: 1, midRound: false });
    expect(r.s.shoe.pos).toBe(4);
  });
});

describe('save and resume', () => {
  it('a JSON round trip mid-hand continues exactly the same', () => {
    const mid = play(stacked(['8S', '6H', '8D', 'TC', '3S', 'TD', '9H', '9C']), D, { type: 'split' }).s;
    const resumed = JSON.parse(JSON.stringify(mid)) as GameState;
    const a = play(mid, H, S).s;
    const b = play(resumed, H, S).s;
    expect(b).toEqual(a);
  });
});

describe('property: random play never creates or loses chips', () => {
  it('3,000 rounds of random legal actions', () => {
    const r = seeded(7);
    let s = newGame({ decks: 2 }, r);
    for (let round = 0; round < 3000; round++) {
      if (s.bankroll < 5) s = play(s, { type: 'rebuy' }).s;
      const before = s.bankroll;
      s = apply(s, { type: 'clearBet' }, r).state;
      const chips = [5, 25, 100] as const;
      s = apply(s, { type: 'chip', value: chips[r(3)]! }, r).state;
      if (s.bet === 0) s = apply(s, { type: 'chip', value: 5 }, r).state;
      let res = apply(s, D, r);
      expect(res.error).toBeUndefined();
      s = res.state;
      let guard = 0;
      while (s.phase !== 'betting') {
        const legal = [...legalActions(s)].filter((a) => a !== 'setOptions' && a !== 'resetStats');
        const pick = legal[r(legal.length)]!;
        const action: Action = pick === 'insurance' ? { type: 'insurance', take: r(2) === 1 } : ({ type: pick } as Action);
        res = apply(s, action, r);
        expect(res.error).toBeUndefined();
        s = res.state;
        expect(s.bankroll).toBeGreaterThanOrEqual(0);
        if (++guard > 50) throw new Error('round did not end');
      }
      expect(s.bankroll - before).toBe(s.lastNet);
      // No card appears more often than there are decks.
      const seen = new Map<string, number>();
      for (const c of [...s.dealer, ...s.hands.flatMap((h) => h.cards)]) seen.set(c, (seen.get(c) ?? 0) + 1);
      expect(Math.max(...seen.values())).toBeLessThanOrEqual(2);
      expect(s.hands.length).toBeLessThanOrEqual(4);
    }
    expect(s.stats.handsPlayed).toBeGreaterThanOrEqual(3000);
  });
});
