/** Preset table situations for the harness (and for screenshots), built with the real engine. */
import type { Card } from '../engine/cards';
import { apply, newGame, type Action, type GameState } from '../engine/game';
import type { SavedGame } from '../app';

function stacked(cards: Card[], bet = 25): GameState {
  const s = newGame();
  s.shoe = { ...s.shoe, cards: [...cards, ...s.shoe.cards], pos: 0, cut: 10_000 };
  s.bet = bet;
  return s;
}
function run(s: GameState, ...actions: Action[]): GameState {
  for (const a of actions) {
    const r = apply(s, a);
    if (r.error) throw new Error(`${a.type}: ${r.error}`);
    s = r.state;
  }
  return s;
}

const SCENARIOS: Record<string, () => GameState> = {
  betting: () => newGame(),
  midhand: () => run(stacked(['9S', 'KH', '7D', '6C']), { type: 'deal' }),
  soft: () => run(stacked(['AS', '8H', '5D', '9C']), { type: 'deal' }),
  insurance: () => run(stacked(['TS', 'AH', '8D', '7C']), { type: 'deal' }),
  split: () => run(stacked(['8S', '6H', '8D', 'TC', '3S', 'QD']), { type: 'deal' }, { type: 'split' }),
  win: () => run(stacked(['TS', '9H', 'QD', '8C']), { type: 'deal' }, { type: 'stand' }),
  blackjack: () => run(stacked(['AS', '9H', 'KD', '7C'], 100), { type: 'deal' }),
  bust: () => run(stacked(['TS', '6H', '6D', 'TC', 'KS']), { type: 'deal' }, { type: 'hit' }),
  doubled: () => run(stacked(['6S', '9H', '5D', '7C', 'TS', '9S']), { type: 'deal' }, { type: 'double' }),
  broke: () => ({ ...newGame(), bankroll: 2.5, bet: 0 }),
  fourHands: () => run(stacked(['8S', '6H', '8D', 'TC', '8H', '8C', '8S', '2D', '3S', '9C', 'QH']), { type: 'deal' }, { type: 'split' }, { type: 'split' }, { type: 'split' }),
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

export function scenario(name: string): SavedGame | undefined {
  const make = SCENARIOS[name];
  if (!make) return undefined;
  const params = new URLSearchParams(location.search);
  return { v: 1, game: make(), ui: { felt: (params.get('felt') as 'green') || 'green', fourColor: params.has('four'), muted: true } };
}
