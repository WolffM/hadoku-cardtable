/*
 * What the table should sound like between two board views.
 *
 * `deriveSoundEvents(prev, next)` compares two consecutive `BoardView`s and
 * names the roles (`@hadoku/shared`'s `SOUND_ROLES`) that moment plays. It is
 * called once per view `LiveBoard` renders, and the pacer (`./pace.ts`) is what
 * releases those views, so a sound starts with the change it belongs to.
 *
 * Pure, and read off the board only: the same view the player sees. Nothing
 * here reads Forge's prose (`showPromptMessage`), for the reason `./pace.ts`
 * gives. Where the board cannot tell two moments apart, the closer one wins
 * and the comment says so.
 *
 * ## Whose seat an event is
 *
 * The opponent's sounds play quieter (`docs/planning/audio.md`). An event
 * belongs to the seat that ACTED: the caster for the stack, the controller for
 * a tap, an attack or a land, the active player for what combat and removal do
 * to the board (a creature dying on your turn is your doing).
 *
 * ## The creature stack
 *
 * The operator's three sounds for a creature spell: the quiet cast when it
 * goes on the stack, then its voice (the colour × creature cell) as it
 * resolves, then the thud of it landing. The last two arrive in the same view,
 * so they carry `delayMs` to stay in that order.
 */

import { COLOUR_IDS, type ColourId, type ParadigmId } from '@hadoku/shared';

import type { BoardCard, BoardPlayer, BoardView } from '../adapter.ts';
import type { DelayedSoundEvent } from '../../sound/index.ts';
import type { Seat } from '../../sound/mix.ts';

/** Between one untap and the next in the untap step: past the mixer's 80 ms collapse window. */
export const UNTAP_REPEAT_GAP_MS = 90;
/** The most untaps one view sounds. */
export const UNTAP_REPEAT_MAX = 8;
/** Between the creature's voice and the thud of it landing. */
export const LAND_THUD_DELAY_MS = 380;
/** A view that changes this much at once is a snapshot (a join, a resync), not a moment. */
const SNAPSHOT_EVENT_LIMIT = 24;

type Zone = 'hand' | 'battlefield' | 'graveyard' | 'exile';

interface Placed {
  zone: Zone;
  owner: BoardPlayer;
  entry: BoardCard;
}

const BASIC_LAND: Readonly<Record<string, string>> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

/**
 * Whether a library was shuffled between two views. Forge re-sends the whole
 * id list on a shuffle, so the order of the cards that are in both lists is
 * what tells: a draw, a mill or a card put on top or bottom keeps the rest in
 * order, and a scry moves a few. A shuffle keeps almost no neighbours. Under
 * four shared cards a shuffle cannot be told from those, so it stays quiet.
 */
export function wasShuffled(before: readonly number[] | undefined, after: readonly number[] | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  const at = new Map(before.map((id, i) => [id, i] as const));
  const ranks = after.flatMap((id) => {
    const i = at.get(id);
    return i === undefined ? [] : [i];
  });
  if (ranks.length < 4) return false;
  const order = [...ranks].sort((a, b) => a - b);
  const rank = new Map(order.map((v, i) => [v, i] as const));
  let kept = 0;
  for (let i = 1; i < ranks.length; i++) if (rank.get(ranks[i]!)! === rank.get(ranks[i - 1]!)! + 1) kept++;
  return kept / (ranks.length - 1) < 0.5;
}

/** The colour-identity row for a set of colours, in `COLOUR_IDS`' own spelling. */
export function colourRow(colours: readonly string[]): ColourId {
  const set = new Set(colours);
  if (set.size === 0) return 'C';
  if (set.size >= 4) return 'WUBRG';
  const match = COLOUR_IDS.find((id) => id !== 'C' && id.length === set.size && [...id].every((c) => set.has(c)));
  return match ?? 'C';
}

function types(entry: BoardCard): string {
  return entry.card.typeLine.split('—')[0] ?? '';
}

const isType = (entry: BoardCard, t: string): boolean => types(entry).includes(t);

const ALL_COLOURS = ['W', 'U', 'B', 'R', 'G'];
const BASIC_TYPE = /\b(Plains|Island|Swamp|Mountain|Forest)\b/g;
const basicTypeColours = (text: string): string[] => [...text.matchAll(BASIC_TYPE)].map((m) => BASIC_LAND[m[1]!]!);

/**
 * A land's colours, which it has none of as a card. All read off the face in
 * play (a modal double-faced card played as its land is that face), from:
 * - its basic land types (a Plains, a Steam Vents);
 * - the mana its text adds (`Add {W}`, `Add {B} or {R}`); "any color" is all five;
 * - the basic land types it fetches (`Search your library for an Island or
 *   Mountain card`); "a basic land card" is any basic, so all five. Another
 *   player's search ("their library") is not this land's;
 * - the basic land types it grants (`Each land is a Swamp`);
 * - the basic land type it chose (Multiversal Passage's `ChosenType`).
 * A type it only checks for ("unless you control a Mountain") is no colour.
 */
function landColours(entry: BoardCard): string[] {
  const { typeLine, oracleText: text } = entry.card;
  if (/\bany (?:one )?colou?r\b/i.test(text)) return ALL_COLOURS;
  const found = new Set(basicTypeColours(typeLine));
  for (const clause of text.matchAll(/\bAdd\b[^.]*/g)) for (const m of clause[0].matchAll(/\{([WUBRG])\}/g)) found.add(m[1]!);
  for (const clause of text.matchAll(/\bsearch your library for\b[^.]*?\bcard\b/gi)) {
    const fetched = basicTypeColours(clause[0]);
    if (fetched.length === 0 && /\bbasic land card\b/i.test(clause[0])) return ALL_COLOURS;
    for (const c of fetched) found.add(c);
  }
  for (const clause of text.matchAll(/\bis an? (?:Plains|Island|Swamp|Mountain|Forest)\b/g)) for (const c of basicTypeColours(clause[0])) found.add(c);
  for (const choice of entry.choices ?? []) if (choice.kind === 'type') for (const v of choice.values) for (const c of basicTypeColours(v)) found.add(c);
  return [...found];
}

/** The colour cell a card's arrival is layered with, or null for a card that has none. */
export function colourCell(entry: BoardCard): string | null {
  const paradigm = paradigmOf(entry);
  if (paradigm === null) return null;
  if (paradigm === 'land') {
    const colours = landColours(entry);
    const row = colourRow(colours);
    // A basic land of one colour has its own cell on the mono rows (2026-10-10); every
    // other land — a mono-coloured nonbasic, a dual, Wastes — is its colour's `land`.
    const basic = /\bBasic\b/.test(entry.card.typeLine) && colours.length === 1;
    return `${row}|${basic ? 'basic' : 'land'}`;
  }
  // An artifact sounds the same whatever its colours: only the colourless row has the column.
  if (paradigm === 'artifact' || paradigm === 'artifact-creature') return `C|${paradigm}`;
  return `${colourRow(entry.card.colors)}|${paradigm}`;
}

function paradigmOf(entry: BoardCard): ParadigmId | null {
  if (isType(entry, 'Land')) return 'land';
  const creature = isType(entry, 'Creature');
  const artifact = isType(entry, 'Artifact');
  if (creature && artifact) return 'artifact-creature';
  if (creature) return 'creature';
  if (artifact) return 'artifact';
  if (isType(entry, 'Instant') || isType(entry, 'Sorcery')) return 'spell';
  return null;
}

/** `g.cast.<type>` for a spell's type line: the most specific permanent type first. */
export function castRole(typeLine: string): string {
  const t = typeLine.split('—')[0] ?? '';
  for (const [word, role] of [
    ['Creature', 'g.cast.creature'],
    ['Planeswalker', 'g.cast.planeswalker'],
    ['Battle', 'g.cast.battle'],
    ['Artifact', 'g.cast.artifact'],
    ['Enchantment', 'g.cast.enchantment'],
    ['Instant', 'g.cast.instant'],
  ] as const) {
    if (t.includes(word)) return role;
  }
  return 'g.cast.sorcery';
}

function placements(view: BoardView): Map<number, Placed> {
  const out = new Map<number, Placed>();
  for (const owner of view.players) {
    for (const entry of owner.hand ?? []) out.set(entry.id, { zone: 'hand', owner, entry });
    for (const entry of owner.battlefield) out.set(entry.id, { zone: 'battlefield', owner, entry });
    for (const entry of owner.graveyard) out.set(entry.id, { zone: 'graveyard', owner, entry });
    for (const entry of owner.exile) out.set(entry.id, { zone: 'exile', owner, entry });
  }
  return out;
}

const seatOf = (player: BoardPlayer | undefined): Seat => (player === undefined || player.isViewer ? 'me' : 'opp');

const counterTotal = (entry: BoardCard): number => entry.counters.reduce((n, c) => n + c.count, 0);
const poolTotal = (p: BoardPlayer): number => (p.manaPool ?? []).reduce((n, m) => n + m.count, 0);

export function deriveSoundEvents(prev: BoardView | null, next: BoardView): DelayedSoundEvent[] {
  if (prev === null || next.seq <= prev.seq) return [];
  const events: DelayedSoundEvent[] = [];
  const push = (role: string, seat: Seat, extra: Partial<DelayedSoundEvent> = {}): void => {
    events.push({ role, seat, ...extra });
  };

  const active = seatOf(next.players.find((p) => p.id === next.activePlayerId));
  const seatByName = new Map(next.players.map((p) => [p.name, seatOf(p)] as const));

  // ── the game and the turn ─────────────────────────────────────────────
  if (!prev.gameOver && next.gameOver) {
    const viewer = next.players.find((p) => p.isViewer);
    push(viewer?.hasLost === true ? 'g.lose' : 'g.win', 'me');
    return events;
  }
  if (next.turn > prev.turn && next.activePlayerId !== null) {
    push(active === 'me' ? 'g.turn-mine' : 'g.turn-theirs', 'me');
  } else if (next.phase !== prev.phase && next.phase !== null) {
    push('g.phase', active);
  }

  // ── the stack ─────────────────────────────────────────────────────────
  const before = placements(prev);
  const after = placements(next);
  const prevStack = new Map(prev.stack.map((s) => [s.id, s] as const));
  const nextStackIds = new Set(next.stack.map((s) => s.id));
  for (const item of next.stack) {
    if (prevStack.has(item.id)) continue;
    const seat = seatByName.get(item.controllerName ?? '') ?? active;
    if (item.isAbility || item.sourceCard === null) push('g.ability', seat);
    else push(castRole(item.sourceCard.typeLine), seat);
  }
  /** Cards whose spell left the stack in this view: their arrival is a resolution, not a cheat. */
  const resolvedCards = new Set<number>();
  for (const item of prev.stack) {
    if (nextStackIds.has(item.id)) continue;
    const seat = seatByName.get(item.controllerName ?? '') ?? active;
    const landed = item.sourceCardId !== null ? after.get(item.sourceCardId) : undefined;
    const permanentSpell =
      !item.isAbility && item.sourceCard !== null && /Creature|Artifact|Enchantment|Planeswalker|Battle/.test(item.sourceCard.typeLine);
    if (item.sourceCardId !== null) resolvedCards.add(item.sourceCardId);
    if (permanentSpell && landed !== undefined && landed.zone !== 'battlefield') {
      push('g.counter', seat);
    } else if (!permanentSpell && !item.isAbility && item.sourceCard !== null) {
      // An instant or sorcery: its colour's spell cell is the resolve flavour.
      const cell = `${colourRow(item.sourceCard.colors)}|spell`;
      push('g.resolve', seat, { colourCell: cell });
    } else {
      push('g.resolve', seat);
    }
  }

  // ── cards changing zones ──────────────────────────────────────────────
  for (const [id, now] of after) {
    const was = before.get(id);
    if (was !== undefined && was.zone === now.zone) continue;
    const entry = now.entry;
    const owner = seatOf(now.owner);
    if (now.zone === 'battlefield') {
      if (isType(entry, 'Land') && (was === undefined || was.zone === 'hand') && !resolvedCards.has(id)) {
        push('g.land', owner, { colourCell: colourCell(entry) });
        continue;
      }
      if (entry.token && was === undefined) {
        push('g.token', owner);
        continue;
      }
      if (was?.zone === 'graveyard') push('g.reanimate', active);
      if (isType(entry, 'Creature')) {
        push('g.creature', owner, { colourCell: colourCell(entry), delayMs: 60 });
        push('g.enter', owner, { delayMs: 60 + LAND_THUD_DELAY_MS });
      } else {
        push('g.enter', owner, { colourCell: isType(entry, 'Artifact') ? colourCell(entry) : null });
      }
    } else if (was?.zone === 'battlefield') {
      if (now.zone === 'graveyard') push(isType(was.entry, 'Creature') ? 'g.dies' : 'g.destroy', active);
      else if (now.zone === 'exile') push('g.exile', active);
      else if (now.zone === 'hand') push('g.bounce', active);
    } else if (now.zone === 'exile') {
      push('g.exile', active);
    } else if (now.zone === 'graveyard' && !resolvedCards.has(id)) {
      if (was?.zone === 'hand') push('g.discard', owner);
      else if (was === undefined) {
        const p = prev.players.find((x) => x.id === now.owner.id);
        if (p !== undefined && now.owner.libraryCount < p.libraryCount) push('g.mill', active);
        else if (p !== undefined && now.owner.handCount < p.handCount) push('g.discard', owner);
      }
    }
  }
  // A permanent that left play to nowhere visible: a token dying, mostly.
  for (const [id, was] of before) {
    if (was.zone !== 'battlefield' || after.has(id)) continue;
    push(isType(was.entry, 'Creature') ? 'g.dies' : 'g.destroy', active);
  }

  // ── per-card state ────────────────────────────────────────────────────
  for (const p of next.players) {
    const prevP = prev.players.find((x) => x.id === p.id);
    if (prevP === undefined) continue;
    const seat = seatOf(p);
    const prevCards = new Map(prevP.battlefield.map((c) => [c.id, c] as const));
    let untappedHere = 0;
    for (const c of p.battlefield) {
      const was = prevCards.get(c.id);
      if (was === undefined) continue;
      if (!was.tapped && c.tapped) push('g.tap', seat);
      if (was.tapped && !c.tapped) untappedHere += 1;
      if (!was.attacking && c.attacking) push('g.attack', seat);
      if (!was.blocking && c.blocking) push('g.block', seat);
      if (c.damage > was.damage) push('g.damage', active);
      const dc = counterTotal(c) - counterTotal(was);
      if (dc > 0) push('g.counter-on', seat);
      if (dc < 0) push('g.counter-off', seat);
      if ((c.attachedToId ?? null) !== null && c.attachedToId !== was.attachedToId) push('g.attach', seat);
      if ((c.changedFrom?.name ?? null) !== (was.changedFrom?.name ?? null)) push('g.transform', seat);
    }
    // The untap step is the untap once per card (the operator, 2026-10-10), spaced past the mixer's
    // collapse window so each is heard, and capped so a full board is a flourish, not a drumroll.
    for (let i = 0; i < Math.min(untappedHere, UNTAP_REPEAT_MAX); i++) push('g.untap', seat, i === 0 ? {} : { delayMs: i * UNTAP_REPEAT_GAP_MS });

    // ── the player ───────────────────────────────────────────────────────
    const drew = Math.min(p.handCount - prevP.handCount, prevP.libraryCount - p.libraryCount);
    // A London mulligan arrives as one delta: the hand goes back, the library is
    // shuffled and a new hand drawn, so both counts come out where they were and
    // the library holds cards it did not before.
    const shuffled = wasShuffled(prevP.libraryIds, p.libraryIds);
    const returned = new Set(prevP.libraryIds);
    const redrawn =
      shuffled &&
      p.handCount > 0 &&
      p.handCount === prevP.handCount &&
      p.libraryCount === prevP.libraryCount &&
      (p.libraryIds ?? []).some((id) => !returned.has(id));
    const mulligan = redrawn || (prevP.handCount - p.handCount >= 2 && p.libraryCount > prevP.libraryCount);
    if (mulligan) push('g.mulligan', seat);
    else if (drew > 0) push('g.draw', seat);
    if (shuffled) push('g.shuffle', seat, mulligan ? { delayMs: 250 } : {});
    if (p.life < prevP.life) push('g.damage-player', active);
    if (p.life > prevP.life) push('g.lifegain', seat);
    if (poolTotal(p) > poolTotal(prevP)) push('g.mana', seat);
  }

  return events.length > SNAPSHOT_EVENT_LIMIT ? [] : events;
}
