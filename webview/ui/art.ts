/**
 * Original SVG art, generated in code (plan §7.2): suits, card faces with corner indices and classic pip
 * layouts, geometric face cards, a DevJack monogram back, and chips with edge stripes.
 * No external resources and no inline style attributes (the webview CSP forbids them).
 */
import { rankOf, suitOf, type Card, type Rank, type Suit } from '../engine/cards';

/** Suit shapes in a 100×100 box. */
const SUIT_PATHS: Record<Suit, string> = {
  H: 'M50 90C22 68 5 51 5 31 5 15 17 5 30 5c9 0 16 5 20 13 4-8 11-13 20-13 13 0 25 10 25 26 0 20-17 37-45 59z',
  D: 'M50 3 87 50 50 97 13 50z',
  S: 'M50 4c13 19 44 34 44 57 0 14-10 22-22 22-8 0-15-4-18-11 1 10 5 17 13 24H33c8-7 12-14 13-24-3 7-10 11-18 11C16 83 6 75 6 61 6 38 37 23 50 4z',
  C: 'M50 6a19 19 0 0 1 16 29 19 19 0 1 1 4 37c-8 0-14-4-17-10 1 11 5 21 13 31H34c8-10 12-20 13-31-3 6-9 10-17 10a19 19 0 1 1 4-37A19 19 0 0 1 50 6z',
};

export const SUIT_COLORS = {
  twoColor: { S: '#1d1d22', C: '#1d1d22', H: '#c3262e', D: '#c3262e' } as Record<Suit, string>,
  fourColor: { S: '#1d1d22', C: '#1d7a3e', H: '#c3262e', D: '#1f5fbf' } as Record<Suit, string>,
};

/** One hidden <svg> with shared symbols and patterns; inserted once into the document. */
export function spriteSvg(): string {
  const suits = (Object.keys(SUIT_PATHS) as Suit[]).map((s) => `<symbol id="dj-suit-${s}" viewBox="0 0 100 100"><path d="${SUIT_PATHS[s]}"/></symbol>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false" class="dj-sprite"><defs>
${suits}
<pattern id="dj-back-lattice" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
  <rect width="22" height="22" fill="#20304f"/>
  <path d="M0 11h22M11 0v22" stroke="#33497a" stroke-width="3"/>
  <circle cx="11" cy="11" r="3" fill="#c9a24a" opacity=".55"/>
</pattern>
<linearGradient id="dj-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9cf86"/><stop offset=".5" stop-color="#c49a3c"/><stop offset="1" stop-color="#8c6a22"/></linearGradient>
<linearGradient id="dj-face-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf8"/><stop offset="1" stop-color="#f3eee2"/></linearGradient>
</defs></svg>`;
}

const W = 250;
const H = 350;
const use = (s: Suit, x: number, y: number, size: number, color: string, flip = false) =>
  `<use href="#dj-suit-${s}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" fill="${color}"${flip ? ` transform="rotate(180 ${x} ${y})"` : ''}/>`;

/** Pip centers for 2–10 (x, y, upside-down), classic layout. */
const L = 72;
const C = 125;
const R = 178;
const PIPS: Record<string, [number, number, boolean][]> = {
  '2': [[C, 78, false], [C, 272, true]],
  '3': [[C, 78, false], [C, 175, false], [C, 272, true]],
  '4': [[L, 78, false], [R, 78, false], [L, 272, true], [R, 272, true]],
  '5': [[L, 78, false], [R, 78, false], [C, 175, false], [L, 272, true], [R, 272, true]],
  '6': [[L, 78, false], [R, 78, false], [L, 175, false], [R, 175, false], [L, 272, true], [R, 272, true]],
  '7': [[L, 78, false], [R, 78, false], [C, 126, false], [L, 175, false], [R, 175, false], [L, 272, true], [R, 272, true]],
  '8': [[L, 78, false], [R, 78, false], [C, 126, false], [L, 175, false], [R, 175, false], [C, 224, true], [L, 272, true], [R, 272, true]],
  '9': [[L, 78, false], [R, 78, false], [L, 143, false], [R, 143, false], [C, 175, false], [L, 207, true], [R, 207, true], [L, 272, true], [R, 272, true]],
  T: [[L, 78, false], [R, 78, false], [C, 110, false], [L, 143, false], [R, 143, false], [L, 207, true], [R, 207, true], [C, 240, true], [L, 272, true], [R, 272, true]],
};

const LABEL: Record<Rank, string> = { A: 'A', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', T: '10', J: 'J', Q: 'Q', K: 'K' };

function corner(rank: Rank, suit: Suit, color: string, flip: boolean) {
  const g = `<text x="27" y="52" text-anchor="middle" font-family="'Segoe UI', system-ui, -apple-system, sans-serif" font-weight="700" font-size="${rank === 'T' ? 40 : 46}" letter-spacing="${rank === 'T' ? -3 : 0}" fill="${color}">${LABEL[rank]}</text>${use(suit, 27, 78, 30, color)}`;
  return flip ? `<g transform="rotate(180 ${W / 2} ${H / 2})">${g}</g>` : `<g>${g}</g>`;
}

/** Geometric, original court art: a framed panel with a crown (K), tiara (Q) or plume (J). */
function court(rank: 'J' | 'Q' | 'K', suit: Suit, color: string): string {
  const frame = `<rect x="52" y="44" width="146" height="262" rx="10" fill="none" stroke="url(#dj-gold)" stroke-width="5"/>
<rect x="60" y="52" width="130" height="246" rx="6" fill="${color}" opacity=".07"/>`;
  const headwear: Record<'J' | 'Q' | 'K', string> = {
    K: `<path d="M88 128 96 92l17 22 12-32 12 32 17-22 8 36z" fill="url(#dj-gold)" stroke="#8c6a22" stroke-width="2"/><rect x="88" y="128" width="74" height="10" rx="3" fill="${color}"/>`,
    Q: `<path d="M92 132c4-22 18-34 33-34s29 12 33 34" fill="none" stroke="url(#dj-gold)" stroke-width="7" stroke-linecap="round"/><circle cx="125" cy="96" r="7" fill="${color}"/><circle cx="103" cy="110" r="4.5" fill="${color}"/><circle cx="147" cy="110" r="4.5" fill="${color}"/>`,
    J: `<path d="M94 132h62l-8-20H102z" fill="${color}"/><path d="M150 112c10-18 6-38-8-48 2 16-4 30-16 38z" fill="url(#dj-gold)" stroke="#8c6a22" stroke-width="2"/>`,
  };
  // Upper half, mirrored below (like a real court card).
  const half = `${headwear[rank]}
<circle cx="125" cy="158" r="18" fill="#f6e7cf" stroke="${color}" stroke-width="3"/>
<path d="M95 200c6-16 18-22 30-22s24 6 30 22" fill="${color}" opacity=".85"/>`;
  return `${frame}
<g>${half}</g>
<g transform="rotate(180 125 175)">${half}</g>
<line x1="64" y1="175" x2="186" y2="175" stroke="url(#dj-gold)" stroke-width="2" opacity=".8"/>
<text x="125" y="186" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="34" fill="${color}" opacity=".18">${rank}</text>
${use(suit, 76, 72, 22, color)}${use(suit, 174, 278, 22, color, true)}`;
}

const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="card-svg" aria-hidden="true" focusable="false">`;
const cache = new Map<string, string>();

export function cardFaceSvg(card: Card, fourColor: boolean): string {
  const key = `${card}${fourColor ? 4 : 2}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rank = rankOf(card);
  const suit = suitOf(card);
  const color = (fourColor ? SUIT_COLORS.fourColor : SUIT_COLORS.twoColor)[suit];
  let center: string;
  if (rank === 'A') center = use(suit, C, 175, suit === 'S' ? 118 : 92, color);
  else if (rank === 'J' || rank === 'Q' || rank === 'K') center = court(rank, suit, color);
  else center = PIPS[rank]!.map(([x, y, f]) => use(suit, x, y, 52, color, f)).join('');
  const svg = `${svgOpen}<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="18" fill="url(#dj-face-bg)" stroke="#cfc6b3" stroke-width="2"/>${center}${corner(rank, suit, color, false)}${corner(rank, suit, color, true)}</svg>`;
  cache.set(key, svg);
  return svg;
}

export function cardBackSvg(): string {
  return `${svgOpen}<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="18" fill="#f7f3ea" stroke="#cfc6b3" stroke-width="2"/>
<rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="11" fill="url(#dj-back-lattice)"/>
<rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="11" fill="none" stroke="url(#dj-gold)" stroke-width="3"/>
<g transform="translate(125 175)">
  <circle r="46" fill="#1a2742" stroke="url(#dj-gold)" stroke-width="4"/>
  <text y="14" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-weight="700" font-size="42" fill="url(#dj-gold)">DJ</text>
</g></svg>`;
}

/** Chip colors per denomination: distinct hues and always labeled with the value. */
export const CHIP_STYLE: Record<number, { base: string; edge: string; ink: string }> = {
  5: { base: '#b8322d', edge: '#f4e9d8', ink: '#fff7ea' },
  25: { base: '#1f7a46', edge: '#f4e9d8', ink: '#fff7ea' },
  100: { base: '#202024', edge: '#e2c46e', ink: '#f4e9d8' },
  500: { base: '#5b2a86', edge: '#f4e9d8', ink: '#fff7ea' },
};

export function chipSvg(value: number): string {
  const st = CHIP_STYLE[value] ?? CHIP_STYLE[5]!;
  // 8 edge stripes: a dashed ring (circumference of r=41 ≈ 257.6; 8 × (16 + 16.2)).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="chip-svg" aria-hidden="true" focusable="false">
<circle cx="50" cy="50" r="48" fill="${st.base}"/>
<circle cx="50" cy="50" r="41" fill="none" stroke="${st.edge}" stroke-width="12" stroke-dasharray="16 16.2" transform="rotate(-11 50 50)"/>
<circle cx="50" cy="50" r="30" fill="${st.base}" stroke="${st.edge}" stroke-width="2" stroke-dasharray="3 3"/>
<circle cx="50" cy="50" r="48" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="2"/>
<text x="50" y="${value >= 100 ? 59 : 61}" text-anchor="middle" font-family="'Segoe UI', system-ui, sans-serif" font-weight="800" font-size="${value >= 100 ? 24 : 28}" fill="${st.ink}">${value}</text>
</svg>`;
}

/** Break an amount into chips, largest first (for stacks). Halves (3:2 on 5) show as a small "½" marker. */
export function chipBreakdown(amount: number): number[] {
  const out: number[] = [];
  let left = Math.floor(amount);
  for (const v of [500, 100, 25, 5]) {
    while (left >= v && out.length < 12) {
      out.push(v);
      left -= v;
    }
  }
  return out;
}
