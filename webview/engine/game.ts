/**
 * Blackjack rules engine (plan §7.1). Pure and synchronous: `apply(state, action)` returns a new state and
 * the list of events that happened, which the UI plays as an animation timeline (so logic and animation
 * can't get out of sync). The state is plain JSON: it is saved after every action, so a round survives
 * the panel closing ("never lose a bet").
 *
 * Money is counted in chips; 3:2 and insurance can produce halves (a 5 blackjack pays 7.5).
 */
import { handValue, isAce, isTenValue, isTwoCard21, rankOf, type Card } from './cards';
import { cryptoRandomInt, drawCard, newShoe, pastCut, type RandomInt, type ShoeState } from './shoe';

export const CHIPS = [5, 25, 100, 500] as const;
export type Chip = (typeof CHIPS)[number];
export const MIN_BET = 5;
export const MAX_BET = 500;
export const START_BANKROLL = 1000;
export const MAX_HANDS = 4;
export const DECK_OPTIONS = [1, 2, 6, 8] as const;

export interface GameOptions {
  decks: (typeof DECK_OPTIONS)[number];
  /** H17 instead of S17. */
  dealerHitsSoft17: boolean;
}
export const DEFAULT_OPTIONS: GameOptions = { decks: 6, dealerHitsSoft17: false };

export type Phase = 'betting' | 'insurance' | 'playerTurn';
export type HandResult = 'blackjack' | 'win' | 'push' | 'lose';

export interface Hand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  fromSplit: boolean;
  /** Split aces: one card each, no further action. */
  splitAces: boolean;
  done: boolean;
  result?: HandResult;
  payout?: number;
}

export interface Stats {
  handsPlayed: number;
  wins: number;
  losses: number;
  pushes: number;
  blackjacks: number;
  /** Best round result (net). */
  biggestWin: number;
  /** Longest run of winning hands (pushes neither extend nor break it). */
  bestStreak: number;
  currentStreak: number;
  /** Sum of all round results (rebuys not included). */
  net: number;
  rebuys: number;
}
export const emptyStats = (): Stats => ({ handsPlayed: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0, biggestWin: 0, bestStreak: 0, currentStreak: 0, net: 0, rebuys: 0 });

export interface GameState {
  v: 1;
  phase: Phase;
  bankroll: number;
  /** Betting phase: the bet being built (pre-filled with the last bet). */
  bet: number;
  lastBet: number;
  shoe: ShoeState;
  /** dealer[1] is the hole card: hidden until `holeRevealed`. */
  dealer: Card[];
  holeRevealed: boolean;
  hands: Hand[];
  active: number;
  insurance: number;
  round: number;
  /** Result of the last finished round (shown until the next deal). */
  lastNet?: number;
  stats: Stats;
  options: GameOptions;
}

export type Action =
  | { type: 'chip'; value: Chip }
  | { type: 'clearBet' }
  | { type: 'deal' }
  | { type: 'insurance'; take: boolean }
  | { type: 'hit' }
  | { type: 'stand' }
  | { type: 'double' }
  | { type: 'split' }
  | { type: 'rebuy' }
  | { type: 'setOptions'; options: Partial<GameOptions> }
  | { type: 'resetStats' };

export type Target = 'dealer' | number;
export type HandDoneReason = 'stand' | 'bust' | 'twentyOne' | 'blackjack' | 'double' | 'splitAces';

export type GameEvent =
  | { type: 'shuffle'; decks: number; midRound: boolean }
  | { type: 'bet'; amount: number }
  | { type: 'betPlaced'; hand: number; amount: number }
  | { type: 'card'; to: Target; card?: Card; faceDown?: boolean }
  | { type: 'insuranceOffered'; cost: number }
  | { type: 'insurance'; taken: boolean; amount: number }
  | { type: 'peek'; blackjack: boolean }
  | { type: 'insuranceResult'; won: boolean; payout: number }
  | { type: 'split'; hand: number; newHand: number; bet: number }
  | { type: 'double'; hand: number; bet: number }
  | { type: 'handDone'; hand: number; reason: HandDoneReason }
  | { type: 'turn'; hand: number }
  | { type: 'reveal'; card: Card }
  | { type: 'dealerDone'; total: number; bust: boolean; blackjack: boolean }
  | { type: 'settled'; hand: number; result: HandResult; payout: number; net: number }
  | { type: 'roundOver'; net: number; bankroll: number }
  | { type: 'rebuy'; bankroll: number }
  | { type: 'options'; options: GameOptions }
  | { type: 'statsReset' };

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
  error?: string;
}

// ---------------------------------------------------------------- creation and queries

export function newGame(options: Partial<GameOptions> = {}, rnd: RandomInt = cryptoRandomInt): GameState {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return { v: 1, phase: 'betting', bankroll: START_BANKROLL, bet: 25, lastBet: 25, shoe: newShoe(opts.decks, rnd), dealer: [], holeRevealed: false, hands: [], active: 0, insurance: 0, round: 0, stats: emptyStats(), options: opts };
}

export const maxBet = (s: GameState) => Math.min(MAX_BET, s.bankroll);
/** The last bet, capped by what the bankroll allows, in whole chips of 5. */
const prefillBet = (s: GameState) => Math.floor(Math.min(Math.max(s.lastBet, MIN_BET), maxBet(s)) / MIN_BET) * MIN_BET;
export const handInProgress = (s: GameState) => s.phase !== 'betting';
export const canRebuy = (s: GameState) => s.phase === 'betting' && s.bankroll < MIN_BET;
export const activeHand = (s: GameState): Hand | undefined => (s.phase === 'playerTurn' ? s.hands[s.active] : undefined);
/** Cards the player can see: the hole card stays hidden until revealed. */
export const visibleDealer = (s: GameState): (Card | null)[] => s.dealer.map((c, i) => (i === 1 && !s.holeRevealed ? null : c));
export const isBlackjackHand = (h: Hand) => !h.fromSplit && isTwoCard21(h.cards);

const sameValue = (a: Card, b: Card) => rankOf(a) === rankOf(b) || (isTenValue(a) && isTenValue(b));

export function canHit(s: GameState): boolean {
  const h = activeHand(s);
  return !!h && !h.done && handValue(h.cards).total < 21;
}
export function canDouble(s: GameState): boolean {
  const h = activeHand(s);
  return !!h && !h.done && !h.splitAces && h.cards.length === 2 && s.bankroll >= h.bet;
}
export function canSplit(s: GameState): boolean {
  const h = activeHand(s);
  return !!h && !h.done && h.cards.length === 2 && sameValue(h.cards[0]!, h.cards[1]!) && s.hands.length < MAX_HANDS && s.bankroll >= h.bet;
}

export type ActionType = Action['type'];
/** What the UI may offer right now. */
export function legalActions(s: GameState): Set<ActionType> {
  const out = new Set<ActionType>(['setOptions', 'resetStats']);
  if (s.phase === 'betting') {
    if (canRebuy(s)) out.add('rebuy');
    else {
      if (CHIPS.some((c) => s.bet + c <= maxBet(s))) out.add('chip');
      if (s.bet > 0) out.add('clearBet');
      if (s.bet >= MIN_BET && s.bet <= s.bankroll) out.add('deal');
    }
  } else if (s.phase === 'insurance') out.add('insurance');
  else {
    out.add('stand');
    if (canHit(s)) out.add('hit');
    if (canDouble(s)) out.add('double');
    if (canSplit(s)) out.add('split');
  }
  return out;
}

// ---------------------------------------------------------------- apply

export function apply(state: GameState, action: Action, rnd: RandomInt = cryptoRandomInt): ApplyResult {
  const s = structuredClone(state);
  const ev: GameEvent[] = [];
  const fail = (error: string): ApplyResult => ({ state, events: [], error });
  const ctx: Ctx = { s, ev, rnd };

  switch (action.type) {
    case 'chip': {
      if (s.phase !== 'betting') return fail('not betting');
      if (!(CHIPS as readonly number[]).includes(action.value)) return fail('unknown chip');
      if (s.bet + action.value > maxBet(s)) return fail('over the maximum bet');
      s.bet += action.value;
      ev.push({ type: 'bet', amount: s.bet });
      break;
    }
    case 'clearBet':
      if (s.phase !== 'betting') return fail('not betting');
      s.bet = 0;
      ev.push({ type: 'bet', amount: 0 });
      break;
    case 'deal':
      if (s.phase !== 'betting') return fail('not betting');
      if (s.bet < MIN_BET) return fail('bet below the minimum');
      if (s.bet > maxBet(s)) return fail('bet above the maximum');
      startRound(ctx);
      break;
    case 'insurance': {
      if (s.phase !== 'insurance') return fail('no insurance offered');
      const cost = s.hands[0]!.bet / 2;
      if (action.take) {
        if (s.bankroll < cost) return fail('not enough chips');
        s.bankroll -= cost;
        s.insurance = cost;
      }
      ev.push({ type: 'insurance', taken: action.take, amount: action.take ? cost : 0 });
      peek(ctx);
      break;
    }
    case 'hit': {
      if (!canHit(s)) return fail('cannot hit');
      deal(ctx, s.active);
      afterCard(ctx);
      break;
    }
    case 'stand':
      if (s.phase !== 'playerTurn') return fail('not your turn');
      finishHand(ctx, 'stand');
      break;
    case 'double': {
      if (!canDouble(s)) return fail('cannot double');
      const h = s.hands[s.active]!;
      s.bankroll -= h.bet;
      h.bet *= 2;
      h.doubled = true;
      ev.push({ type: 'double', hand: s.active, bet: h.bet });
      deal(ctx, s.active);
      finishHand(ctx, handValue(h.cards).total > 21 ? 'bust' : 'double');
      break;
    }
    case 'split': {
      if (!canSplit(s)) return fail('cannot split');
      const h = s.hands[s.active]!;
      const aces = isAce(h.cards[0]!);
      const moved = h.cards.pop()!;
      const newHand: Hand = { cards: [moved], bet: h.bet, doubled: false, fromSplit: true, splitAces: aces, done: false };
      h.fromSplit = true;
      h.splitAces = aces;
      s.bankroll -= h.bet;
      s.hands.splice(s.active + 1, 0, newHand);
      ev.push({ type: 'split', hand: s.active, newHand: s.active + 1, bet: h.bet });
      if (aces) {
        // One card each, then both hands are done.
        deal(ctx, s.active);
        deal(ctx, s.active + 1);
        h.done = true;
        ev.push({ type: 'handDone', hand: s.active, reason: 'splitAces' });
        newHand.done = true;
        ev.push({ type: 'handDone', hand: s.active + 1, reason: 'splitAces' });
        advance(ctx);
      } else {
        deal(ctx, s.active);
        afterCard(ctx);
      }
      break;
    }
    case 'rebuy':
      if (!canRebuy(s)) return fail('rebuy only when out of chips');
      s.bankroll = START_BANKROLL;
      s.stats.rebuys++;
      s.bet = prefillBet(s);
      ev.push({ type: 'rebuy', bankroll: s.bankroll }, { type: 'bet', amount: s.bet });
      break;
    case 'setOptions': {
      if (s.phase !== 'betting') return fail('options change between rounds');
      const next: GameOptions = { ...s.options, ...action.options };
      if (!(DECK_OPTIONS as readonly number[]).includes(next.decks)) return fail('unknown deck count');
      const decksChanged = next.decks !== s.options.decks;
      s.options = next;
      if (decksChanged) {
        s.shoe = newShoe(next.decks, rnd);
        ev.push({ type: 'shuffle', decks: next.decks, midRound: false });
      }
      ev.push({ type: 'options', options: next });
      break;
    }
    case 'resetStats':
      s.stats = emptyStats();
      ev.push({ type: 'statsReset' });
      break;
  }
  return { state: s, events: ev };
}

// ---------------------------------------------------------------- round flow

interface Ctx {
  s: GameState;
  ev: GameEvent[];
  rnd: RandomInt;
}

function onTable(s: GameState): Card[] {
  return [...s.dealer, ...s.hands.flatMap((h) => h.cards)];
}

function deal(ctx: Ctx, to: Target, faceDown = false) {
  const { s, ev, rnd } = ctx;
  const { card, reshuffled } = drawCard(s.shoe, rnd, onTable(s));
  if (reshuffled) ev.push({ type: 'shuffle', decks: s.shoe.decks, midRound: true });
  if (to === 'dealer') s.dealer.push(card);
  else s.hands[to]!.cards.push(card);
  ev.push(faceDown ? { type: 'card', to, faceDown: true } : { type: 'card', to, card });
}

function startRound(ctx: Ctx) {
  const { s, ev, rnd } = ctx;
  if (pastCut(s.shoe)) {
    s.shoe = newShoe(s.options.decks, rnd);
    ev.push({ type: 'shuffle', decks: s.options.decks, midRound: false });
  }
  s.round++;
  s.dealer = [];
  s.holeRevealed = false;
  s.insurance = 0;
  s.active = 0;
  s.lastNet = undefined;
  s.hands = [{ cards: [], bet: s.bet, doubled: false, fromSplit: false, splitAces: false, done: false }];
  s.bankroll -= s.bet;
  s.lastBet = s.bet;
  ev.push({ type: 'betPlaced', hand: 0, amount: s.bet });
  deal(ctx, 0);
  deal(ctx, 'dealer');
  deal(ctx, 0);
  deal(ctx, 'dealer', true);

  const up = s.dealer[0]!;
  if (isAce(up)) {
    const cost = s.bet / 2;
    if (s.bankroll >= cost) {
      s.phase = 'insurance';
      ev.push({ type: 'insuranceOffered', cost });
      return;
    }
    return peek(ctx); // can't afford insurance: straight to the peek
  }
  if (isTenValue(up)) return peek(ctx);
  // The dealer can't have blackjack.
  if (isBlackjackHand(s.hands[0]!)) {
    s.hands[0]!.done = true;
    ev.push({ type: 'handDone', hand: 0, reason: 'blackjack' });
    return dealerPlay(ctx);
  }
  s.phase = 'playerTurn';
  ev.push({ type: 'turn', hand: 0 });
}

/** Dealer shows an Ace or a ten: check the hole card for blackjack. */
function peek(ctx: Ctx) {
  const { s, ev } = ctx;
  const dealerBJ = isTwoCard21(s.dealer);
  ev.push({ type: 'peek', blackjack: dealerBJ });
  if (s.insurance > 0) {
    const payout = dealerBJ ? s.insurance * 3 : 0;
    s.bankroll += payout;
    ev.push({ type: 'insuranceResult', won: dealerBJ, payout });
  }
  const h = s.hands[0]!;
  if (dealerBJ || isBlackjackHand(h)) {
    h.done = true;
    if (isBlackjackHand(h)) ev.push({ type: 'handDone', hand: 0, reason: 'blackjack' });
    return dealerPlay(ctx);
  }
  s.phase = 'playerTurn';
  ev.push({ type: 'turn', hand: 0 });
}

/** After a card to the active hand: bust or 21 ends the hand. */
function afterCard(ctx: Ctx) {
  const { s } = ctx;
  const total = handValue(s.hands[s.active]!.cards).total;
  if (total > 21) finishHand(ctx, 'bust');
  else if (total === 21) finishHand(ctx, 'twentyOne');
}

function finishHand(ctx: Ctx, reason: HandDoneReason) {
  const { s, ev } = ctx;
  s.hands[s.active]!.done = true;
  ev.push({ type: 'handDone', hand: s.active, reason });
  advance(ctx);
}

/** Move to the next unfinished hand (a split hand gets its second card now), or to the dealer. */
function advance(ctx: Ctx) {
  const { s, ev } = ctx;
  const next = s.hands.findIndex((h) => !h.done);
  if (next < 0) return dealerPlay(ctx);
  s.active = next;
  s.phase = 'playerTurn';
  const h = s.hands[next]!;
  ev.push({ type: 'turn', hand: next });
  if (h.cards.length === 1) {
    deal(ctx, next);
    if (handValue(h.cards).total === 21) finishHand(ctx, 'twentyOne');
  }
}

function dealerPlay(ctx: Ctx) {
  const { s, ev } = ctx;
  s.holeRevealed = true;
  ev.push({ type: 'reveal', card: s.dealer[1]! });
  const anyLive = s.hands.some((h) => handValue(h.cards).total <= 21 && !isBlackjackHand(h));
  const dealerBJ = isTwoCard21(s.dealer);
  if (anyLive && !dealerBJ) {
    for (;;) {
      const v = handValue(s.dealer);
      if (v.total < 17 || (v.total === 17 && v.soft && s.options.dealerHitsSoft17)) deal(ctx, 'dealer');
      else break;
    }
  }
  const dv = handValue(s.dealer);
  ev.push({ type: 'dealerDone', total: dv.total, bust: dv.total > 21, blackjack: dealerBJ });
  settle(ctx);
}

function settle(ctx: Ctx) {
  const { s, ev } = ctx;
  const dealerBJ = isTwoCard21(s.dealer);
  const dealerTotal = handValue(s.dealer).total;
  let net = s.insurance > 0 ? (dealerBJ ? s.insurance * 2 : -s.insurance) : 0;
  s.hands.forEach((h, i) => {
    const total = handValue(h.cards).total;
    let result: HandResult;
    if (total > 21) result = 'lose';
    else if (isBlackjackHand(h)) result = dealerBJ ? 'push' : 'blackjack';
    else if (dealerBJ) result = 'lose';
    else if (dealerTotal > 21 || total > dealerTotal) result = 'win';
    else if (total === dealerTotal) result = 'push';
    else result = 'lose';
    const payout = result === 'blackjack' ? h.bet * 2.5 : result === 'win' ? h.bet * 2 : result === 'push' ? h.bet : 0;
    h.result = result;
    h.payout = payout;
    s.bankroll += payout;
    net += payout - h.bet;
    ev.push({ type: 'settled', hand: i, result, payout, net: payout - h.bet });

    const st = s.stats;
    st.handsPlayed++;
    if (result === 'win' || result === 'blackjack') {
      st.wins++;
      if (result === 'blackjack') st.blackjacks++;
      st.currentStreak++;
      st.bestStreak = Math.max(st.bestStreak, st.currentStreak);
    } else if (result === 'lose') {
      st.losses++;
      st.currentStreak = 0;
    } else st.pushes++;
  });
  s.stats.net += net;
  s.stats.biggestWin = Math.max(s.stats.biggestWin, net);
  s.lastNet = net;
  s.phase = 'betting';
  s.bet = s.bankroll < MIN_BET ? 0 : prefillBet(s);
  ev.push({ type: 'roundOver', net, bankroll: s.bankroll });
}
