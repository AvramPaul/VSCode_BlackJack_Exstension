/**
 * The Blackjack table UI (plan §7.2–7.5). No framework.
 * The engine is applied first (state saved at once: "never lose a bet"); its events are then played as an
 * animation timeline on a view model, and the view is reconciled with the final state at the end.
 */
import { cardName, handValue, type Card } from './engine/cards';
import {
  apply,
  canRebuy,
  CHIPS,
  DECK_OPTIONS,
  emptyStats,
  handInProgress,
  legalActions,
  maxBet,
  newGame,
  type Action,
  type GameEvent,
  type GameState,
  type HandResult,
} from './engine/game';
import { cardBackSvg, cardFaceSvg, chipBreakdown, chipSvg, spriteSvg } from './ui/art';
import { animate, endFastForward, fastForward, flyFrom, pop, reducedMotion, shake, wait } from './ui/motion';
import { Sound } from './ui/sound';
import type { ClaudeStatus, DoneMode, FromWebview, Prefs, StatusInfo, ToWebview } from '../shared/protocol';

export interface Host {
  post(m: FromWebview): void;
  getState(): unknown;
  setState(s: unknown): void;
}

export type Felt = 'green' | 'blue' | 'burgundy';
export interface UiPrefs {
  felt: Felt;
  fourColor: boolean;
  muted: boolean;
}
export interface SavedGame {
  v: 1;
  game: GameState;
  ui: UiPrefs;
}

interface HandView {
  cards: Card[];
  bet: number;
  doubled: boolean;
  result?: HandResult;
  payout?: number;
}
interface View {
  dealer: (Card | null)[];
  hands: HandView[];
  active: number | null;
  bankroll: number;
  bet: number;
  insurance: number;
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0');

function viewOf(s: GameState): View {
  return {
    dealer: s.dealer.map((c, i) => (i === 1 && !s.holeRevealed ? null : c)),
    hands: s.hands.map((h) => ({ cards: [...h.cards], bet: h.bet, doubled: h.doubled, result: s.phase === 'betting' ? h.result : undefined, payout: h.payout })),
    active: s.phase === 'playerTurn' ? s.active : null,
    bankroll: s.bankroll,
    bet: s.bet,
    insurance: s.insurance,
  };
}

function totalLabel(cards: readonly (Card | null)[]): string {
  const known = cards.filter((c): c is Card => !!c);
  if (!known.length) return '';
  const v = handValue(known);
  return v.soft && v.total < 21 ? `${v.total - 10}/${v.total}` : String(v.total);
}

export function validSaved(x: unknown): SavedGame | undefined {
  const o = x as SavedGame | undefined;
  const g = o?.game;
  if (!o || o.v !== 1 || !g || g.v !== 1 || typeof g.bankroll !== 'number' || !['betting', 'insurance', 'playerTurn'].includes(g.phase) || !Array.isArray(g.shoe?.cards) || !Array.isArray(g.hands)) return undefined;
  const ui = (o.ui ?? {}) as Partial<UiPrefs>; // older saves may lack fields
  return { v: 1, game: { ...g, stats: { ...emptyStats(), ...g.stats } }, ui: { felt: ui.felt ?? 'green', fourColor: !!ui.fourColor, muted: !!ui.muted } };
}

const KEYS: Record<string, string> = { deal: 'Space', hit: 'H', stand: 'S', double: 'D', split: 'P', insYes: 'I', insNo: 'N', clear: '⌫', mute: 'M', rebuy: 'Space', go: 'G' };

export class App {
  private state: GameState;
  private ui: UiPrefs;
  private view: View;
  private busy = false;
  private claude: StatusInfo = { state: 'idle', sessions: 0 };
  private done: DoneMode | null = null;
  private mode: 'auto' | 'free' = 'free';
  private readonly sound = new Sound();
  private timer: ReturnType<typeof setInterval> | undefined;
  private handTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHandState: boolean | undefined;
  private readonly $: Record<string, HTMLElement> = {};

  constructor(private readonly root: HTMLElement, private readonly host: Host, saved?: unknown) {
    const s = validSaved(saved) ?? validSaved(host.getState());
    this.state = s?.game ?? newGame();
    this.ui = s?.ui ?? { felt: 'green', fourColor: false, muted: false };
    this.view = viewOf(this.state);
    this.sound.muted = this.ui.muted;
    this.build();
    this.renderAll();
    if (s && handInProgress(s.game)) this.announce('Your round was saved and is restored. ' + this.situation());
    this.bindInput();
    this.reportHand(true);
  }

  // ---------------------------------------------------------------- messages from the extension

  receive(m: ToWebview) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      this.mode = m.mode;
      this.applyPrefs(m.prefs);
      this.setClaude(m.status);
    } else if (m.type === 'status') {
      if (m.status.state !== 'idle') this.done = null;
      this.setClaude(m.status);
    } else if (m.type === 'claudeDone') {
      this.done = m.mode;
      this.renderStrip();
      if (m.mode === 'afterHand') this.announce('Claude finished. Finish your hand.');
      else if (m.mode === 'soon') this.announce('Claude is done.');
    } else if (m.type === 'prefs') this.applyPrefs(m.prefs);
  }

  private applyPrefs(p: Prefs) {
    this.sound.allowed = p.sound;
  }

  private setClaude(s: StatusInfo) {
    const was = this.claude.state;
    this.claude = s;
    if (s.state === 'waiting' && was !== 'waiting') this.sound.play('needsYou');
    this.renderStrip();
  }

  // ---------------------------------------------------------------- DOM

  private build() {
    this.root.className = 'dj-root';
    this.root.innerHTML = `${spriteSvg()}
<header class="strip" id="strip">
  <span class="dot" aria-hidden="true"></span>
  <span class="label" id="strip-label">DevJack</span>
  <span class="time" id="strip-time"></span>
  <span class="spacer"></span>
  <button class="btn go" id="go" hidden aria-keyshortcuts="G">Go to Claude<kbd>${KEYS.go}</kbd></button>
</header>
<div class="banner" id="banner" hidden></div>
<main class="table" id="table" aria-label="Blackjack table">
  <div class="felt-print" aria-hidden="true">
    <svg viewBox="0 0 1000 200" preserveAspectRatio="xMidYMid meet">
      <path id="dj-arc1" d="M20 30 Q500 190 980 30" fill="none"/>
      <path id="dj-arc2" d="M260 100 Q500 170 740 100" fill="none"/>
      <text class="print-main"><textPath href="#dj-arc1" startOffset="50%" text-anchor="middle" id="print-rules">BLACKJACK PAYS 3 TO 2 · DEALER STANDS ON SOFT 17</textPath></text>
      <text class="print-ins"><textPath href="#dj-arc2" startOffset="50%" text-anchor="middle">INSURANCE PAYS 2 TO 1</textPath></text>
    </svg>
  </div>
  <div class="discard" id="discard" aria-hidden="true"></div>
  <div class="shoe" id="shoe" aria-hidden="true"><div class="shoe-card">${cardBackSvg()}</div><div class="shoe-card">${cardBackSvg()}</div><div class="shoe-box"></div></div>
  <section class="dealer-zone" aria-label="Dealer">
    <div class="cards" id="dealer-cards"></div>
    <div class="total" id="dealer-total" aria-hidden="true"></div>
  </section>
  <div class="message" id="message" aria-hidden="true"></div>
  <section class="player-zone" aria-label="Your hands">
    <div class="hands" id="hands"></div>
    <div class="bet-circle" id="bet-circle"><div class="stack" id="bet-stack"></div><span class="amount" id="bet-amount"></span></div>
  </section>
  <div class="rail" aria-hidden="true"></div>
</main>
<footer class="controls" id="controls">
  <div class="hud"><span>Bankroll <b id="bankroll"></b></span><span>Bet <b id="bet"></b></span><span class="spacer"></span>
    <button class="btn icon" id="mute" aria-keyshortcuts="M" aria-pressed="false">Sound<kbd>${KEYS.mute}</kbd></button>
    <button class="btn icon" id="menu-btn" aria-haspopup="dialog">Menu</button>
  </div>
  <div class="row" id="row-bet">
    ${CHIPS.map((c, i) => `<button class="chip-btn" data-chip="${c}" aria-keyshortcuts="${i + 1}" aria-label="Add ${c}">${chipSvg(c)}<kbd>${i + 1}</kbd></button>`).join('')}
    <button class="btn" id="clear" aria-keyshortcuts="Backspace">Clear<kbd>${KEYS.clear}</kbd></button>
    <button class="btn primary" id="deal" aria-keyshortcuts="Space">Deal<kbd>${KEYS.deal}</kbd></button>
    <button class="btn primary" id="rebuy" aria-keyshortcuts="Space" hidden>Free rebuy: 1,000<kbd>${KEYS.rebuy}</kbd></button>
  </div>
  <div class="row" id="row-ins" hidden>
    <span class="prompt">Insurance?</span>
    <button class="btn primary" id="ins-yes" aria-keyshortcuts="I">Take insurance<kbd>${KEYS.insYes}</kbd></button>
    <button class="btn" id="ins-no" aria-keyshortcuts="N">No thanks<kbd>${KEYS.insNo}</kbd></button>
  </div>
  <div class="row" id="row-play" hidden>
    <button class="btn primary" id="hit" aria-keyshortcuts="H">Hit<kbd>${KEYS.hit}</kbd></button>
    <button class="btn primary" id="stand" aria-keyshortcuts="S">Stand<kbd>${KEYS.stand}</kbd></button>
    <button class="btn" id="double" aria-keyshortcuts="D">Double<kbd>${KEYS.double}</kbd></button>
    <button class="btn" id="split" aria-keyshortcuts="P">Split<kbd>${KEYS.split}</kbd></button>
  </div>
</footer>
<dialog class="menu" id="menu" aria-label="DevJack menu">
  <form method="dialog">
    <h2>Table</h2>
    <label>Decks <select id="opt-decks">${DECK_OPTIONS.map((d) => `<option value="${d}">${d}</option>`).join('')}</select></label>
    <label>Dealer <select id="opt-h17"><option value="s17">Stands on soft 17</option><option value="h17">Hits soft 17</option></select></label>
    <p class="note" id="opt-note" hidden>Rule changes apply between rounds.</p>
    <fieldset><legend>Felt</legend>
      ${(['green', 'blue', 'burgundy'] as Felt[]).map((f) => `<label class="inline"><input type="radio" name="felt" value="${f}"> ${f[0]!.toUpperCase() + f.slice(1)}</label>`).join('')}
    </fieldset>
    <label class="inline"><input type="checkbox" id="opt-four"> Four-color deck</label>
    <h2>Stats</h2>
    <dl class="stats" id="stats"></dl>
    <div class="menu-actions"><button class="btn" id="reset-stats" type="button">Reset stats</button><button class="btn primary" value="close">Close</button></div>
  </form>
</dialog>
<div class="sr-only" aria-live="polite" id="live"></div>`;
    for (const el of this.root.querySelectorAll<HTMLElement>('[id]')) this.$[el.id] = el;
    this.$['dealer-cards'] = this.root.querySelector('#dealer-cards')!;
  }

  private renderAll() {
    this.root.dataset.felt = this.ui.felt;
    this.root.dataset.fourColor = String(this.ui.fourColor);
    this.syncCards(this.$['dealer-cards']!, this.view.dealer, false);
    this.$['dealer-total']!.textContent = totalLabel(this.view.dealer);
    this.renderHands(false);
    this.renderBetCircle();
    this.renderHud();
    this.renderControls();
    this.renderStrip();
    this.$['print-rules']!.textContent = `BLACKJACK PAYS 3 TO 2 · DEALER ${this.state.options.dealerHitsSoft17 ? 'HITS' : 'STANDS ON'} SOFT 17`;
    this.$['discard']!.classList.toggle('has-cards', this.state.shoe.pos > 4);
  }

  private cardEl(card: Card | null): HTMLElement {
    const el = document.createElement('div');
    el.className = 'card';
    el.setAttribute('role', 'img');
    el.dataset.card = card ?? 'down';
    el.setAttribute('aria-label', card ? cardName(card) : 'Face-down card');
    el.innerHTML = `<div class="card-inner${card ? '' : ' down'}"><div class="face front">${card ? cardFaceSvg(card, this.ui.fourColor) : ''}</div><div class="face back">${cardBackSvg()}</div></div>`;
    return el;
  }

  /** Keyed reconcile of a card row; new cards fly in from the shoe when `animateNew`. */
  private syncCards(container: HTMLElement, cards: readonly (Card | null)[], animateNew: boolean): HTMLElement[] {
    const existing = [...container.children] as HTMLElement[];
    const added: HTMLElement[] = [];
    cards.forEach((c, i) => {
      const key = c ?? 'down';
      const cur = existing[i];
      if (cur && cur.dataset.card === key) return;
      const el = this.cardEl(c);
      if (cur) container.replaceChild(el, cur);
      else container.appendChild(el);
      added.push(el);
    });
    for (let i = cards.length; i < existing.length; i++) existing[i]!.remove();
    if (animateNew) {
      const from = this.$['shoe']!.getBoundingClientRect();
      for (const el of added) void flyFrom(el, from, 300);
    }
    return added;
  }

  private handEls(): HTMLElement[] {
    return [...this.$['hands']!.children] as HTMLElement[];
  }

  private renderHands(animateNew: boolean) {
    const container = this.$['hands']!;
    const hands = this.view.hands;
    while (container.children.length > hands.length) container.lastElementChild!.remove();
    hands.forEach((h, i) => {
      let el = container.children[i] as HTMLElement | undefined;
      if (!el) {
        el = document.createElement('div');
        el.className = 'hand';
        el.innerHTML = `<div class="glow" aria-hidden="true"></div><div class="cards"></div><div class="total" aria-hidden="true"></div><div class="hand-bet"><div class="stack"></div><span class="amount"></span></div><div class="result" aria-hidden="true"></div>`;
        container.appendChild(el);
      }
      el.classList.toggle('active', this.view.active === i && hands.length > 1);
      el.setAttribute('aria-label', `Hand ${i + 1}${hands.length > 1 ? ` of ${hands.length}` : ''}`);
      this.syncCards(el.querySelector('.cards')!, h.cards, animateNew);
      el.querySelector('.cards')!.lastElementChild?.classList.toggle('sideways', h.doubled && h.cards.length === 3);
      el.querySelector('.total')!.textContent = totalLabel(h.cards);
      this.renderStack(el.querySelector('.hand-bet .stack')!, h.bet);
      el.querySelector('.hand-bet .amount')!.textContent = h.bet ? fmt(h.bet) : '';
      // Once settled, the result badge carries the outcome; the bet circle takes the next bet.
      (el.querySelector('.hand-bet') as HTMLElement).hidden = !!h.result && this.state.phase === 'betting' && !this.busy;
      const r = el.querySelector<HTMLElement>('.result')!;
      r.className = `result${h.result ? ` show ${h.result}` : ''}`;
      r.textContent = h.result ? resultLabel(h.result, (h.payout ?? 0) - h.bet) : '';
    });
    this.$['player-zone'] = this.root.querySelector('.player-zone')!;
    this.root.querySelector('.player-zone')!.classList.toggle('has-hands', hands.length > 0 && hands.some((h) => h.cards.length > 0));
  }

  private renderStack(stack: Element, amount: number) {
    const chips = chipBreakdown(amount);
    const key = chips.join(',');
    if ((stack as HTMLElement).dataset.key === key) return;
    (stack as HTMLElement).dataset.key = key;
    stack.innerHTML = chips.map((v, i) => `<div class="stack-chip" data-i="${i}">${chipSvg(v)}</div>`).join('');
    stack.querySelectorAll<HTMLElement>('.stack-chip').forEach((c, i) => c.style.setProperty('--i', String(i)));
  }

  private renderBetCircle() {
    const betting = this.state.phase === 'betting' && !this.view.hands.some((h) => h.cards.length && !h.result);
    const showCircle = this.state.phase === 'betting';
    this.$['bet-circle']!.hidden = !showCircle;
    if (showCircle) {
      this.renderStack(this.$['bet-stack']!, betting ? this.view.bet : 0);
      this.$['bet-amount']!.textContent = this.view.bet ? fmt(this.view.bet) : 'Place a bet';
    }
  }

  private renderHud() {
    this.$['bankroll']!.textContent = fmt(this.view.bankroll);
    this.$['bet']!.textContent = fmt(this.state.phase === 'betting' ? this.view.bet : this.view.hands.reduce((a, h) => a + h.bet, 0) + this.view.insurance);
    const mute = this.$['mute']!;
    mute.setAttribute('aria-pressed', String(this.ui.muted));
    mute.firstChild!.textContent = this.ui.muted ? 'Muted' : 'Sound';
  }

  private renderControls() {
    const s = this.state;
    const legal = this.busy ? new Set<string>() : legalActions(s);
    const phase = s.phase;
    this.$['row-bet']!.hidden = phase !== 'betting';
    this.$['row-ins']!.hidden = phase !== 'insurance';
    this.$['row-play']!.hidden = phase !== 'playerTurn';
    const rebuy = canRebuy(s);
    this.$['rebuy']!.hidden = !rebuy;
    this.$['deal']!.hidden = rebuy;
    this.$['clear']!.hidden = rebuy;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.chip-btn')) {
      b.hidden = rebuy;
      b.disabled = this.busy || s.bet + Number(b.dataset.chip) > maxBet(s);
    }
    const set = (id: string, on: boolean) => ((this.$[id] as HTMLButtonElement).disabled = !on);
    set('deal', legal.has('deal'));
    set('clear', legal.has('clearBet'));
    set('rebuy', legal.has('rebuy'));
    set('ins-yes', legal.has('insurance') && s.bankroll >= (s.hands[0]?.bet ?? 0) / 2);
    set('ins-no', legal.has('insurance'));
    set('hit', legal.has('hit'));
    set('stand', legal.has('stand'));
    set('double', legal.has('double'));
    set('split', legal.has('split'));
  }

  private renderStrip() {
    const state: ClaudeStatus | 'done' = this.done && this.claude.state === 'idle' ? 'done' : this.claude.state;
    const strip = this.$['strip']!;
    strip.className = `strip ${state}`;
    strip.hidden = this.mode === 'free' && state === 'idle';
    this.$['strip-label']!.textContent = { idle: 'Claude is idle', working: 'Claude is working', waiting: 'Claude needs you', done: 'Done ✓' }[state];
    const ticking = state === 'working' || state === 'waiting';
    const tick = () => {
      if (!this.claude.since) return void (this.$['strip-time']!.textContent = '');
      const sec = Math.max(0, Math.floor((Date.now() - this.claude.since) / 1000));
      this.$['strip-time']!.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}${this.claude.sessions > 1 ? ` · ${this.claude.sessions} sessions` : ''}`;
    };
    if (ticking) tick();
    else this.$['strip-time']!.textContent = '';
    // Tick only while Claude works: no CPU use when idle.
    if (ticking && !this.timer) this.timer = setInterval(tick, 1000);
    if (!ticking && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.$['go']!.hidden = state !== 'waiting';
    const banner = this.$['banner']!;
    const text = this.done === 'afterHand' && state === 'done' ? 'Claude finished, finish your hand.' : this.done === 'keepOpen' && state === 'done' ? 'Claude is done.' : '';
    banner.textContent = text;
    banner.hidden = !text;
  }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const click = (id: string, fn: () => void) => this.$[id]!.addEventListener('click', () => {
      this.sound.unlock();
      fn();
    });
    click('deal', () => this.act({ type: 'deal' }));
    click('rebuy', () => this.act({ type: 'rebuy' }));
    click('clear', () => this.act({ type: 'clearBet' }));
    click('hit', () => this.act({ type: 'hit' }));
    click('stand', () => this.act({ type: 'stand' }));
    click('double', () => this.act({ type: 'double' }));
    click('split', () => this.act({ type: 'split' }));
    click('ins-yes', () => this.act({ type: 'insurance', take: true }));
    click('ins-no', () => this.act({ type: 'insurance', take: false }));
    click('mute', () => this.toggleMute());
    click('go', () => this.host.post({ type: 'goToClaude' }));
    click('menu-btn', () => this.openMenu());
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.chip-btn')) {
      b.addEventListener('click', () => {
        this.sound.unlock();
        this.act({ type: 'chip', value: Number(b.dataset.chip) as (typeof CHIPS)[number] });
      });
    }
    this.bindMenu();

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const menu = this.$['menu'] as HTMLDialogElement;
      if (menu.open) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.sound.unlock();
      if (k === 'm') return this.toggleMute();
      if (k === 'g' && this.claude.state === 'waiting') return this.host.post({ type: 'goToClaude' });
      const s = this.state;
      let action: Action | undefined;
      if (k === ' ' || k === 'Enter') {
        if (e.target instanceof HTMLButtonElement && k === 'Enter') return; // let Enter press the focused button
        action = canRebuy(s) ? { type: 'rebuy' } : s.phase === 'betting' ? { type: 'deal' } : undefined;
      } else if (k === 'h') action = { type: 'hit' };
      else if (k === 's') action = { type: 'stand' };
      else if (k === 'd') action = { type: 'double' };
      else if (k === 'p') action = { type: 'split' };
      else if (k === 'i') action = { type: 'insurance', take: true };
      else if (k === 'n') action = { type: 'insurance', take: false };
      else if (k === 'Backspace') action = { type: 'clearBet' };
      else if (/^[1-4]$/.test(k)) action = { type: 'chip', value: CHIPS[Number(k) - 1]! };
      if (!action) return;
      e.preventDefault();
      this.act(action);
    });
  }

  private toggleMute() {
    this.ui.muted = !this.ui.muted;
    this.sound.muted = this.ui.muted;
    this.renderHud();
    this.save();
    this.announce(this.ui.muted ? 'Sound off.' : 'Sound on.');
  }

  private bindMenu() {
    const menu = this.$['menu'] as HTMLDialogElement;
    const decks = this.$['opt-decks'] as HTMLSelectElement;
    const h17 = this.$['opt-h17'] as HTMLSelectElement;
    decks.addEventListener('change', () => this.act({ type: 'setOptions', options: { decks: Number(decks.value) as (typeof DECK_OPTIONS)[number] } }));
    h17.addEventListener('change', () => this.act({ type: 'setOptions', options: { dealerHitsSoft17: h17.value === 'h17' } }));
    for (const r of menu.querySelectorAll<HTMLInputElement>('input[name=felt]')) {
      r.addEventListener('change', () => {
        this.ui.felt = r.value as Felt;
        this.renderAll();
        this.save();
      });
    }
    (this.$['opt-four'] as HTMLInputElement).addEventListener('change', (e) => {
      this.ui.fourColor = (e.target as HTMLInputElement).checked;
      for (const el of this.root.querySelectorAll<HTMLElement>('.card')) el.dataset.card = '';
      this.renderAll();
      this.save();
    });
    this.$['reset-stats']!.addEventListener('click', () => {
      this.act({ type: 'resetStats' });
      this.renderStats();
    });
  }

  private openMenu() {
    const s = this.state;
    (this.$['opt-decks'] as HTMLSelectElement).value = String(s.options.decks);
    (this.$['opt-h17'] as HTMLSelectElement).value = s.options.dealerHitsSoft17 ? 'h17' : 's17';
    const locked = s.phase !== 'betting';
    (this.$['opt-decks'] as HTMLSelectElement).disabled = locked;
    (this.$['opt-h17'] as HTMLSelectElement).disabled = locked;
    this.$['opt-note']!.hidden = !locked;
    for (const r of this.root.querySelectorAll<HTMLInputElement>('input[name=felt]')) r.checked = r.value === this.ui.felt;
    (this.$['opt-four'] as HTMLInputElement).checked = this.ui.fourColor;
    this.renderStats();
    (this.$['menu'] as HTMLDialogElement).showModal();
  }

  private renderStats() {
    const st = this.state.stats;
    const rows: [string, string][] = [
      ['Hands played', fmt(st.handsPlayed)],
      ['Wins / losses / pushes', `${fmt(st.wins)} / ${fmt(st.losses)} / ${fmt(st.pushes)}`],
      ['Blackjacks', fmt(st.blackjacks)],
      ['Biggest win', fmt(st.biggestWin)],
      ['Best streak', fmt(st.bestStreak)],
      ['Net result', signed(st.net)],
      ['Rebuys', fmt(st.rebuys)],
    ];
    this.$['stats']!.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  // ---------------------------------------------------------------- actions and the timeline

  private act(action: Action) {
    if (this.busy) {
      fastForward(); // impatient: finish the current animation; press again to act
      return;
    }
    const r = apply(this.state, action);
    if (r.error) {
      if (action.type === 'chip') void shake(this.$['bet-circle']!);
      return;
    }
    const before = this.state;
    this.state = r.state;
    this.save();
    void this.play(r.events, before);
  }

  private save() {
    const data: SavedGame = { v: 1, game: this.state, ui: this.ui };
    this.host.setState(data);
    this.host.post({ type: 'save', data });
  }

  private async play(events: GameEvent[], before: GameState) {
    this.busy = true;
    endFastForward();
    this.renderControls();
    this.view = viewOf(before);
    try {
      for (const e of events) await this.step(e);
    } finally {
      this.busy = false;
      endFastForward();
      this.view = viewOf(this.state);
      this.renderAll();
      this.reportHand(false);
    }
    this.announce(this.situation(events));
  }

  /** One engine event → view-model change + animation + sound. */
  private async step(e: GameEvent) {
    const v = this.view;
    switch (e.type) {
      case 'shuffle':
        this.sound.play('shuffle');
        this.flash(e.midRound ? 'Reshuffling' : 'Shuffling');
        await animate(this.$['shoe']!, [{ transform: 'rotate(0)' }, { transform: 'rotate(-4deg)' }, { transform: 'rotate(3deg)' }, { transform: 'rotate(0)' }], 420);
        this.$['discard']!.classList.remove('has-cards');
        break;
      case 'bet':
        v.bet = e.amount;
        this.renderBetCircle();
        this.renderHud();
        if (e.amount) {
          this.sound.play('chip');
          const top = this.$['bet-stack']!.lastElementChild;
          if (top) void pop(top);
        }
        break;
      case 'betPlaced': {
        await this.clearTable();
        v.hands = [{ cards: [], bet: e.amount, doubled: false }];
        v.bankroll -= e.amount;
        v.bet = e.amount;
        this.renderHands(false);
        this.renderBetCircle();
        this.renderHud();
        this.sound.play('chip');
        break;
      }
      case 'card': {
        const card = e.card ?? null;
        if (e.to === 'dealer') {
          v.dealer.push(card);
          this.syncCards(this.$['dealer-cards']!, v.dealer, true);
          this.$['dealer-total']!.textContent = totalLabel(v.dealer);
        } else {
          v.hands[e.to]!.cards.push(card!);
          this.renderHands(true);
        }
        this.sound.play('card');
        await wait(230);
        break;
      }
      case 'reveal': {
        v.dealer[1] = e.card;
        const el = this.$['dealer-cards']!.children[1] as HTMLElement | undefined;
        if (el) {
          el.dataset.card = e.card;
          el.setAttribute('aria-label', cardName(e.card));
          el.querySelector('.front')!.innerHTML = cardFaceSvg(e.card, this.ui.fourColor);
          const inner = el.querySelector<HTMLElement>('.card-inner')!;
          inner.classList.remove('down');
          this.sound.play('card');
          await animate(inner, [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], 420, 'cubic-bezier(.3,.6,.2,1)');
        }
        this.$['dealer-total']!.textContent = totalLabel(v.dealer);
        await wait(150);
        break;
      }
      case 'insuranceOffered':
        this.flash('Insurance?', 1400);
        break;
      case 'insurance':
        v.insurance = e.amount;
        v.bankroll -= e.amount;
        this.renderHud();
        if (e.taken) this.sound.play('chip');
        break;
      case 'peek':
        this.flash('Dealer checks for blackjack', 700);
        await wait(500);
        break;
      case 'insuranceResult':
        v.bankroll += e.payout;
        this.renderHud();
        this.flash(e.won ? `Insurance pays ${fmt(e.payout)}` : 'Insurance lost', 900);
        await wait(400);
        break;
      case 'split': {
        const hands = this.handEls();
        const fromCard = hands[e.hand]?.querySelector('.cards')?.lastElementChild?.getBoundingClientRect();
        const h = v.hands[e.hand]!;
        const moved = h.cards.pop()!;
        v.hands.splice(e.newHand, 0, { cards: [moved], bet: e.bet, doubled: false });
        v.bankroll -= e.bet;
        this.renderHands(false);
        const movedEl = this.handEls()[e.newHand]?.querySelector('.cards')?.firstElementChild as HTMLElement | null;
        if (movedEl && fromCard) void flyFrom(movedEl, fromCard, 280, { rotate: 0, scale: 1 });
        this.renderHud();
        this.sound.play('chip');
        await wait(280);
        break;
      }
      case 'double':
        v.bankroll -= v.hands[e.hand]!.bet;
        v.hands[e.hand]!.bet = e.bet;
        v.hands[e.hand]!.doubled = true;
        this.renderHands(false);
        this.renderHud();
        this.sound.play('chip');
        break;
      case 'turn':
        v.active = e.hand;
        this.renderHands(false);
        break;
      case 'handDone': {
        const el = this.handEls()[e.hand];
        if (!el) break;
        if (e.reason === 'bust') {
          this.sound.play('lose');
          await shake(el);
        } else if (e.reason === 'blackjack') {
          this.shimmer(el);
          this.sound.play('blackjack');
          await wait(350);
        } else if (e.reason === 'twentyOne') void pop(el.querySelector('.total')!);
        break;
      }
      case 'dealerDone':
        this.flash(e.blackjack ? 'Dealer has blackjack' : e.bust ? 'Dealer busts' : `Dealer has ${e.total}`, 900);
        await wait(300);
        break;
      case 'settled': {
        const h = v.hands[e.hand]!;
        h.result = e.result;
        h.payout = e.payout;
        v.bankroll += e.payout;
        this.renderHands(false);
        this.renderHud();
        const el = this.handEls()[e.hand];
        if (el) {
          const badge = el.querySelector('.result')!;
          void pop(badge);
          if (e.result === 'win' || e.result === 'blackjack') {
            this.payoutChips(el);
            void animate(el.querySelector('.glow')!, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], 900, 'ease-out');
            this.sound.play(e.result === 'blackjack' ? 'blackjack' : 'win');
          } else if (e.result === 'lose') {
            void animate(el.querySelector('.hand-bet')!, [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-60px) scale(.8)', opacity: 0 }], 420, 'ease-in');
          }
        }
        await wait(260);
        break;
      }
      case 'roundOver':
        v.bankroll = e.bankroll;
        this.renderHud();
        this.flash(e.net > 0 ? `You win ${fmt(e.net)}` : e.net < 0 ? `You lose ${fmt(-e.net)}` : 'Push', 1300);
        break;
      case 'rebuy':
        v.bankroll = e.bankroll;
        this.renderHud();
        this.flash('Free rebuy: 1,000 chips', 1200);
        this.sound.play('chip');
        break;
      case 'options':
      case 'statsReset':
        break;
    }
  }

  /** Last round's cards slide to the discard tray. */
  private async clearTable() {
    const cards = [...this.root.querySelectorAll<HTMLElement>('.dealer-zone .card, .hand .card')];
    if (cards.length && !reducedMotion()) {
      const tray = this.$['discard']!.getBoundingClientRect();
      await Promise.all(
        cards.map((c) => {
          const r = c.getBoundingClientRect();
          const dx = tray.left + tray.width / 2 - (r.left + r.width / 2);
          const dy = tray.top + tray.height / 2 - (r.top + r.height / 2);
          return animate(c, [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) rotate(-20deg) scale(.6)`, opacity: 0 }], 300, 'ease-in');
        }),
      );
    }
    this.view.dealer = [];
    this.view.hands = [];
    this.syncCards(this.$['dealer-cards']!, [], false);
    this.$['dealer-total']!.textContent = '';
    this.renderHands(false);
    if (cards.length) this.$['discard']!.classList.add('has-cards');
  }

  private payoutChips(handEl: HTMLElement) {
    const stack = handEl.querySelector('.hand-bet .stack');
    if (!stack || reducedMotion()) return;
    const from = this.$['dealer-cards']!.getBoundingClientRect();
    for (const chip of [...stack.children].slice(-3) as HTMLElement[]) void flyFrom(chip, from, 420, { rotate: 0, scale: 0.9 });
  }

  private shimmer(el: HTMLElement) {
    const s = document.createElement('div');
    s.className = 'shimmer';
    el.appendChild(s);
    void animate(s, [{ transform: 'translateX(-120%)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: 'translateX(120%)', opacity: 0 }], 900, 'ease-in-out').then(() => s.remove());
    if (reducedMotion()) setTimeout(() => s.remove(), 0);
  }

  private flash(text: string, ms = 800) {
    const m = this.$['message']!;
    m.textContent = text;
    m.classList.add('show');
    clearTimeout((m as unknown as { _t?: ReturnType<typeof setTimeout> })._t);
    (m as unknown as { _t?: ReturnType<typeof setTimeout> })._t = setTimeout(() => m.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------- announcements and hand state

  private announce(text: string) {
    const live = this.$['live']!;
    live.textContent = '';
    setTimeout(() => (live.textContent = text), 30);
  }

  private situation(events: GameEvent[] = []): string {
    const s = this.state;
    const up = s.dealer[0];
    const parts: string[] = [];
    const dealtToMe = events.filter((e): e is Extract<GameEvent, { type: 'card' }> => e.type === 'card' && e.to !== 'dealer' && !!e.card);
    if (dealtToMe.length === 1) parts.push(`You drew the ${cardName(dealtToMe[0]!.card!)}.`);
    if (s.phase === 'insurance' && up) parts.push(`Dealer shows an ace. Insurance costs ${fmt(s.hands[0]!.bet / 2)}. Press I to take it or N to decline.`);
    else if (s.phase === 'playerTurn' && up) {
      const h = s.hands[s.active]!;
      const v = handValue(h.cards);
      parts.push(`${s.hands.length > 1 ? `Hand ${s.active + 1}: you` : 'You'} have ${v.soft && v.total < 21 ? 'soft ' : ''}${v.total}. Dealer shows ${cardName(up)}.`);
    } else if (s.phase === 'betting' && s.hands.length && s.hands[0]!.result) {
      const dv = handValue(s.dealer);
      parts.push(`Dealer has ${dv.total > 21 ? `${dv.total}, bust` : dv.total}.`);
      s.hands.forEach((h, i) => parts.push(`${s.hands.length > 1 ? `Hand ${i + 1}: ` : ''}${resultLabel(h.result!, (h.payout ?? 0) - h.bet)}.`));
      parts.push(`Bankroll ${fmt(s.bankroll)}. Press Space to deal again.`);
    } else if (s.phase === 'betting') parts.push(canRebuy(s) ? 'Out of chips. Press Space for a free rebuy.' : `Bet ${fmt(s.bet)}. Press Space to deal.`);
    return parts.join(' ');
  }

  /** Tell the extension whether a hand is in progress (it closes the table only between hands). */
  private reportHand(immediate: boolean) {
    const now = handInProgress(this.state);
    if (now === this.lastHandState) return;
    clearTimeout(this.handTimer);
    const send = () => {
      this.lastHandState = now;
      this.host.post({ type: 'handState', handInProgress: now });
    };
    // Let the player see the result before an "after the hand" close.
    if (now || immediate) send();
    else this.handTimer = setTimeout(send, 1200);
  }
}

function resultLabel(r: HandResult, net: number): string {
  if (r === 'blackjack') return `Blackjack ${signed(net)}`;
  if (r === 'win') return `Win ${signed(net)}`;
  if (r === 'push') return 'Push';
  return 'Lose';
}
