/*
 * Where everything in a Swiss bracket sits (`PodBracket.tsx` draws it) — the operator, 2026-10-23, of
 * the standings: *"can we show them as more of a bracket instead of this? like properly seperating
 * winners from losers? i'm thinking of more of a staggered visual"*; the answer was the canvas
 * "Tournament over" artboard, re-sent 2026-11-02.
 *
 * One column per round, then a FINAL column once the pod is done. Inside a column each match sits on
 * the row of its players' record going into that round (wins minus losses: the higher, the higher up),
 * so a column's groups stagger against the next one's. From each group two lines step on to the next
 * column: its winners up a row, its losers down one. The final column has everyone by place, on the row
 * of the record they finished with.
 *
 * Pure: the pod's results, its pairings, its bot games and its tables in, positions out. A round not yet
 * paired is a column with a head and nothing under it.
 */

import type { PodMatchResult, RoomTable, SeriesPhase } from '@hadoku/shared';

import { isPodAi, type PodView } from './wire.ts';

/** The bracket's sizes, in px: one place for them, read by the CSS too (`PodBracket.tsx` sets them as custom properties). */
export const SWISS = {
  /** A match card's width, wide enough for two names beside their faces and games (never squished). */
  cardW: 200,
  /** One player's row on a card. */
  rowH: 34,
  /** A live card's title bar, over its players: the game in play, the way in, the ⋯. */
  barH: 28,
  /** Between two cards of one group. */
  gap: 10,
  /** Between two columns, where the step lines run. */
  gutter: 64,
  /** Clear space over each group, under the heads or the group above. */
  lead: 12,
  /** The round heads across the top. */
  headH: 30,
  /** The final column's width and its rows. */
  finalW: 232,
  finalRowH: 40,
  finalGap: 6,
  /** Space kept clear between two groups of one column. */
  clear: 18,
} as const;

export interface Record3 {
  w: number;
  l: number;
  d: number;
}

export interface SwissMatch {
  /** Seat order on a live table; `[playerA, playerB]` for a result. */
  players: readonly [string, string];
  wins: readonly [number, number];
  table: RoomTable | null;
  /** The table's series phase, or `done` for a recorded result. */
  phase: SeriesPhase;
  /** Being played now: the way into its table. */
  live: boolean;
}

export interface SwissCard {
  kind: 'match';
  match: SwissMatch;
  x: number;
  y: number;
  h: number;
}

export interface SwissBye {
  kind: 'bye';
  player: string;
  x: number;
  y: number;
  h: number;
}

export interface SwissGroup {
  column: number;
  /** Wins minus losses going into the round (in the final column: the record finished with). */
  net: number;
  record: Record3;
  /** Everyone in it. */
  players: readonly string[];
  x: number;
  /** The group's vertical middle: where its step lines leave from and arrive at. */
  cy: number;
  top: number;
  h: number;
}

export interface SwissEdge {
  /** The group the line leaves. */
  from: SwissGroup;
  /** Up a row (its winners) or down one (its losers). */
  step: 'win' | 'loss';
  /** An SVG path: across, up or down, across. */
  d: string;
}

export interface SwissFinal {
  player: string;
  place: number;
  record: Record3;
  x: number;
  y: number;
}

export interface SwissColumn {
  round: number | 'final';
  state: 'past' | 'now' | 'next' | 'final';
  x: number;
  w: number;
}

export interface SwissLayout {
  columns: SwissColumn[];
  groups: SwissGroup[];
  cards: (SwissCard | SwissBye)[];
  edges: SwissEdge[];
  finals: SwissFinal[];
  width: number;
  height: number;
  /** Each player's step out of each round, by `${player}:${round}`: what a path highlight follows. */
  steps: ReadonlyMap<string, 'win' | 'loss' | 'draw'>;
}

const blank = (): Record3 => ({ w: 0, l: 0, d: 0 });
const bump = (r: Record3, o: 'win' | 'loss' | 'draw'): Record3 => ({ w: r.w + (o === 'win' ? 1 : 0), l: r.l + (o === 'loss' ? 1 : 0), d: r.d + (o === 'draw' ? 1 : 0) });
const net = (r: Record3): number => r.w - r.l;

/** `2–1`, or `2–1–1` with a draw. */
export function recordText(r: Record3): string {
  return r.d > 0 ? `${r.w}–${r.l}–${r.d}` : `${r.w}–${r.l}`;
}

/** A recorded result's outcome for each side. A bye (`playerB: null`) is a win. */
function outcome(r: PodMatchResult): ['win' | 'loss' | 'draw', 'win' | 'loss' | 'draw'] {
  if (r.playerB === null || r.gamesA > r.gamesB) return ['win', 'loss'];
  if (r.gamesA < r.gamesB) return ['loss', 'win'];
  return ['draw', 'draw'];
}

/** Every entrant's record after all recorded results, by id: what the standings show beside the points. */
export function records(pod: Pick<PodView, 'results'>): Map<string, Record3> {
  const out = new Map<string, Record3>();
  const add = (id: string, o: 'win' | 'loss' | 'draw'): void => void out.set(id, bump(out.get(id) ?? blank(), o));
  for (const r of pod.results) {
    const [a, b] = outcome(r);
    add(r.playerA, a);
    if (r.playerB !== null) add(r.playerB, b);
  }
  return out;
}

function sameSeats(table: RoomTable, players: readonly [string, string]): boolean {
  const seated = table.players.map((p) => p.memberId);
  // A table against an AI (either shape, `isPodAi`) seats one player; the AI holds no seat at it. Two AIs
  // play a bot game, which has no table at all.
  const want = players.filter((id) => !isPodAi(id));
  return want.length > 0 && seated.length === want.length && want.every((id) => seated.includes(id));
}

const sameMatch = (r: PodMatchResult, players: readonly [string, string]): boolean =>
  (r.playerA === players[0] && r.playerB === players[1]) || (r.playerA === players[1] && r.playerB === players[0]);

/** One round's entries: its matches (a live round's pairings, as they stand) and its bye. */
function roundEntries(pod: PodView, tables: readonly RoomTable[], round: number, claimed: Set<string>): { matches: SwissMatch[]; bye: string | null } {
  const results = pod.results.filter((r) => r.round === round);
  const live = pod.phase === 'rounds' && round === pod.round;
  const matches: SwissMatch[] = [];
  const recorded = results.filter((r) => r.playerB !== null);
  // The round in play names its own tables; a pairing already decided is drawn from its result, at that table.
  const paired = live ? pod.pairings : [];
  for (const p of paired) {
    const table = tables.find((t) => t.id === p.tableId) ?? null;
    if (table !== null) claimed.add(table.id);
    if (recorded.some((r) => sameMatch(r, p.players))) continue;
    matches.push({ players: p.players, wins: table?.series.wins ?? [0, 0], table, phase: table?.series.phase ?? 'seating', live: true });
  }
  // Two AIs playing their bot game out: under way, at no table.
  for (const g of live ? (pod.botGames ?? []) : []) {
    if (!recorded.some((r) => sameMatch(r, g.players))) matches.push({ players: g.players, wins: [0, 0], table: null, phase: 'playing', live: true });
  }
  for (const r of recorded) {
    const players: [string, string] = [r.playerA, r.playerB!];
    const pairing = paired.find((p) => sameMatch(r, p.players));
    const table = (pairing === undefined ? tables.find((t) => !claimed.has(t.id) && sameSeats(t, players)) : tables.find((t) => t.id === pairing.tableId)) ?? null;
    if (table !== null) claimed.add(table.id);
    matches.push({ players, wins: [r.gamesA, r.gamesB], table, phase: 'done', live: false });
  }
  const bye = results.find((r) => r.playerB === null)?.playerA ?? (live ? pod.bye : null);
  return { matches, bye };
}

const cardH = (m: SwissMatch): number => SWISS.rowH * 2 + 2 + (m.live && m.table !== null ? SWISS.barH : 0);
const BYE_H = SWISS.rowH + 2;

interface Pending {
  column: number;
  net: number;
  record: Record3;
  items: ({ kind: 'match'; match: SwissMatch; h: number } | { kind: 'bye'; player: string; h: number } | { kind: 'final'; player: string; place: number; h: number })[];
  h: number;
}

/**
 * The whole bracket. `standings` order the final column (already ranked by the server); every other
 * place comes from the results, the pairings and the tables.
 */
export function swissLayout(pod: PodView, tables: readonly RoomTable[]): SwissLayout {
  const rounds = Math.max(1, pod.rounds);
  const done = pod.phase === 'done';
  const shown = done ? rounds : pod.phase === 'rounds' ? Math.min(pod.round, rounds) : 0;
  const claimed = new Set<string>();
  const rec = new Map<string, Record3>();
  const recOf = (id: string): Record3 => rec.get(id) ?? blank();
  const steps = new Map<string, 'win' | 'loss' | 'draw'>();
  const pending: Pending[] = [];
  const columns: SwissColumn[] = [];
  let x = 0;
  const stride = SWISS.cardW + SWISS.gutter;

  for (let round = 1; round <= rounds; round++) {
    const column = round - 1;
    const state = round > shown ? 'next' : !done && round === pod.round ? 'now' : 'past';
    columns.push({ round, state, x, w: SWISS.cardW });
    if (round <= shown) {
      const { matches, bye } = roundEntries(pod, tables, round, claimed);
      const byNet = new Map<number, Pending>();
      const into = (record: Record3): Pending => {
        const n = net(record);
        let g = byNet.get(n);
        if (g === undefined) {
          g = { column, net: n, record, items: [], h: 0 };
          byNet.set(n, g);
        }
        return g;
      };
      for (const m of matches) into(recOf(m.players[0])).items.push({ kind: 'match', match: m, h: cardH(m) });
      if (bye !== null) into(recOf(bye)).items.push({ kind: 'bye', player: bye, h: BYE_H });
      for (const g of byNet.values()) {
        g.h = g.items.reduce((s, it) => s + it.h, 0) + SWISS.gap * (g.items.length - 1);
        pending.push(g);
      }
      // The records the next column groups by: only a finished round moves anyone.
      for (const r of pod.results.filter((x) => x.round === round)) {
        const [a, b] = outcome(r);
        steps.set(`${r.playerA}:${round}`, a);
        rec.set(r.playerA, bump(recOf(r.playerA), a));
        if (r.playerB !== null) {
          steps.set(`${r.playerB}:${round}`, b);
          rec.set(r.playerB, bump(recOf(r.playerB), b));
        }
      }
    }
    x += stride;
  }

  const finals: SwissFinal[] = [];
  if (done) {
    const column = rounds;
    columns.push({ round: 'final', state: 'final', x, w: SWISS.finalW });
    const byNet = new Map<number, Pending>();
    for (const row of pod.standings) {
      const record = recOf(row.id);
      const n = net(record);
      let g = byNet.get(n);
      if (g === undefined) {
        g = { column, net: n, record, items: [], h: 0 };
        byNet.set(n, g);
      }
      g.items.push({ kind: 'final', player: row.id, place: row.rank, h: SWISS.finalRowH });
    }
    for (const g of byNet.values()) {
      g.h = g.items.length * SWISS.finalRowH + (g.items.length - 1) * SWISS.finalGap;
      pending.push(g);
    }
    x += SWISS.finalW;
  } else {
    x -= SWISS.gutter;
  }

  // One row height for the whole bracket: the smallest that keeps every column's groups clear of each other.
  let unit = SWISS.rowH * 2;
  for (let c = 0; c < columns.length; c++) {
    const col = pending.filter((g) => g.column === c).sort((a, b) => b.net - a.net);
    for (let i = 1; i < col.length; i++) {
      const [hi, lo] = [col[i - 1]!, col[i]!];
      unit = Math.max(unit, (hi.h / 2 + lo.h / 2 + SWISS.lead + SWISS.clear) / (hi.net - lo.net));
    }
  }
  unit = Math.ceil(unit);
  const topNet = Math.max(0, ...pending.map((g) => g.net));
  // The top-most group's top sits just under the heads.
  const y0 = Math.max(
    SWISS.headH + SWISS.lead,
    ...pending.map((g) => SWISS.headH + SWISS.lead + g.h / 2 - (topNet - g.net) * unit),
  );
  const yOf = (n: number): number => y0 + (topNet - n) * unit;

  const groups: SwissGroup[] = [];
  const cards: (SwissCard | SwissBye)[] = [];
  for (const g of pending) {
    const cx = columns[g.column]!.x;
    const cy = yOf(g.net);
    const top = cy - g.h / 2;
    const players = g.items.flatMap((it) => (it.kind === 'match' ? [...it.match.players] : [it.player]));
    groups.push({ column: g.column, net: g.net, record: g.record, players, x: cx, cy, top, h: g.h });
    let y = top;
    for (const it of g.items) {
      if (it.kind === 'match') cards.push({ kind: 'match', match: it.match, x: cx, y, h: it.h });
      else if (it.kind === 'bye') cards.push({ kind: 'bye', player: it.player, x: cx, y, h: it.h });
      else finals.push({ player: it.player, place: it.place, record: recOf(it.player), x: cx, y });
      y += it.h + (it.kind === 'final' ? SWISS.finalGap : SWISS.gap);
    }
  }

  // Winners step up a row, losers down one, into the next column — only where that column has a group to land on.
  const edges: SwissEdge[] = [];
  for (const g of groups) {
    const next = groups.filter((n) => n.column === g.column + 1);
    if (next.length === 0) continue;
    const x1 = g.x + SWISS.cardW;
    const x2 = columns[g.column + 1]!.x;
    const xm = x1 + Math.round(SWISS.gutter / 2);
    for (const [step, dn, dy] of [['win', 1, -8], ['loss', -1, 8]] as const) {
      const to = next.find((n) => n.net === g.net + dn);
      if (to === undefined) continue;
      const y1 = g.cy + dy;
      edges.push({ from: g, step, d: `M${x1} ${y1}H${xm}V${to.cy}H${x2}` });
    }
  }

  const bottom = Math.max(0, ...groups.map((g) => g.top + g.h));
  return { columns, groups, cards, edges, finals, width: Math.max(x, SWISS.cardW), height: Math.ceil(bottom) + 4, steps };
}

/** Whether `player`'s path runs along `edge`: they were in its group and took its step. */
export function onPath(layout: SwissLayout, edge: SwissEdge, player: string): boolean {
  return edge.from.players.includes(player) && layout.steps.get(`${player}:${edge.from.column + 1}`) === edge.step;
}
