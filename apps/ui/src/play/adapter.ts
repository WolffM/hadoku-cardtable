/*
 * Wire state → the board's view model.
 *
 * `fold.ts` produces Forge's object graph as the client holds it: id-keyed
 * property bags. This module is the only place that knows which of those
 * properties mean "battlefield" or "life", and it is the seam the fixture
 * discipline buys: the components under `./Board.tsx` render a `BoardView` and
 * cannot tell whether it came from a committed fixture (`./fixtures.ts`) or a
 * live match over a socket (`./live/match.ts`). Both call `toBoardView` the
 * same way, and `./live/parity.test.ts` holds them to identical markup.
 *
 * ## Where each zone comes from
 *
 * | board              | wire                                                    |
 * | ------------------ | ------------------------------------------------------- |
 * | turn, phase        | GameView `Turn`, `Phase` (`PhaseType` enum name)        |
 * | active player      | GameView `PlayerTurn` (player id)                       |
 * | stack              | GameView `Stack` — StackItemView ids, **top first**     |
 * | life               | PlayerView `Life`                                       |
 * | hand / library     | PlayerView `Hand` / `Library` — card ids                |
 * | battlefield, etc.  | PlayerView `Battlefield` / `Graveyard` / `Exile`        |
 * | a card's face      | the CardStateView at `cardId*16 + CurrentState`         |
 *
 * **Zone membership is the PlayerView's list, never the card's own `Zone`.**
 * Forge's client does the same — it re-stamps each card's `Zone` from the list
 * that holds it (`NetworkGuiGame.applyPropertyMap`), because the per-card field
 * can lag the lists.
 *
 * "Stack is top first" is read from the data, not assumed: in the committed
 * game the stack is `[49, 48]`, where 48 is the spell and 49 the trigger it
 * caused, so the newer item leads.
 *
 * ## Hidden information
 *
 * An opponent's hand is a **count**. The adapter does not map those cards at
 * all, so no component can render one by accident. That matters more than it
 * sounds: in the captured stream the opponent's hand cards arrive WITH their
 * names — the wire does not hide them in this harness — so the renderer is the
 * last line, and it holds.
 *
 * ## What the wire does not carry
 *
 * - **No Scryfall id.** A card's print is Forge's `ImageKey`
 *   (`c:Mountain|MRD|1` — name, set, art index), not a Scryfall id. The
 *   adapter looks the id up by `Name` + `SetCode` in an `ArtIdIndex` (below)
 *   and puts it on the `DraftCard`; `CardTile` then resolves the art through
 *   `@hadoku/carddata/art` exactly as the draft screen does. The default
 *   index is the cube's own `pool.json` — the only name → id table the
 *   browser has — so a card outside the cube (a basic land, most of a
 *   constructed list) has no id and `CardTile` draws the text tile. Nothing
 *   here builds an image URL: the adapter moves an id, the resolver owns the
 *   host.
 * - **No collector number.** Left empty.
 * - **Which player is "me".** That is `openView(myPlayers)`, not a delta, so
 *   the caller passes `viewerPlayerId`. The fixture records it beside the
 *   capture; a live match takes it from the server's `MatchSnapshot.playerId`
 *   and never infers it from the state.
 *
 * An id that names no player in the game makes NO seat the viewer, so every
 * hand is a count. That is the safe failure: a wrong or missing viewer hides a
 * hand rather than showing one.
 */

import type { DraftCard, ManaColor, Rarity } from '@hadoku/shared';

import poolData from '../draft/pool.json' with { type: 'json' };
import type { WireState } from './fold.ts';
import { cardStateKey, deltaKey, WireType, type Tagged, type WireObject } from './wire.ts';

export interface BoardCard {
  id: number;
  /** What `CardTile` draws. */
  card: DraftCard;
  tapped: boolean;
  summoningSick: boolean;
  damage: number;
  counters: { name: string; count: number }[];
  attacking: boolean;
  blocking: boolean;
  token: boolean;
}

export interface BoardPlayer {
  id: number;
  name: string;
  life: number;
  isViewer: boolean;
  isActive: boolean;
  hasPriority: boolean;
  hasLost: boolean;
  /** `null` for anyone but the viewer: an opponent's hand is a count. */
  hand: BoardCard[] | null;
  handCount: number;
  libraryCount: number;
  battlefield: BoardCard[];
  graveyard: BoardCard[];
  exile: BoardCard[];
}

export interface StackEntry {
  id: number;
  description: string;
  /**
   * The CardView the item came from. Forge names a spell on the stack by its
   * card, so this is the id `setSelectables` uses when the item is a target.
   */
  sourceCardId: number | null;
  sourceName: string | null;
  controllerName: string | null;
  isAbility: boolean;
}

export interface BoardView {
  seq: number;
  title: string;
  turn: number;
  /** `PhaseType` constant name, e.g. `MAIN1`. `null` before the first turn. */
  phase: string | null;
  phaseLabel: string;
  activePlayerId: number | null;
  /** Viewer first, then the others in the game's own order. */
  players: BoardPlayer[];
  /** Top of the stack first. */
  stack: StackEntry[];
  gameOver: boolean;
  /** Ids a zone named whose object never arrived. A non-empty list is a bug upstream. */
  missingCardIds: number[];
}

export interface AdaptOptions {
  viewerPlayerId: number;
  /** Where a card's Scryfall id is looked up. Defaults to the cube's pool. */
  artIds?: ArtIdIndex;
}

// ── which Scryfall id a card is ─────────────────────────────────────────────

/**
 * `Name|SET` and bare `Name` → Scryfall id. A lookup table of ids, never URLs:
 * which host the art comes from stays the resolver's decision (D15).
 */
export type ArtIdIndex = ReadonlyMap<string, string>;

export interface ArtIdSource {
  name: string;
  setCode: string;
  scryfallId?: string | undefined;
}

/**
 * Build an index from any list of known printings. The exact printing wins;
 * failing that, the first printing of the same name — another printing's art
 * is still that card. A double-faced card is also indexed by its front face,
 * since Forge names the face it is showing.
 */
export function artIdIndex(cards: Iterable<ArtIdSource>): ArtIdIndex {
  const index = new Map<string, string>();
  for (const c of cards) {
    if (c.scryfallId === undefined || c.scryfallId === '') continue;
    const names = [c.name];
    const front = c.name.split(' // ')[0];
    if (front !== undefined && front !== c.name) names.push(front);
    for (const name of names) {
      const exact = `${name}|${c.setCode.toUpperCase()}`;
      if (!index.has(exact)) index.set(exact, c.scryfallId);
      if (!index.has(name)) index.set(name, c.scryfallId);
    }
  }
  return index;
}

/** The cube's cards: the only name → id table the browser already carries. */
export const CUBE_ART_IDS: ArtIdIndex = artIdIndex((poolData as { cards: ArtIdSource[] }).cards);

export function scryfallIdFor(index: ArtIdIndex, name: string, setCode: string): string | undefined {
  return index.get(`${name}|${setCode.toUpperCase()}`) ?? index.get(name);
}

// ── reading tagged values ───────────────────────────────────────────────────

function prop(obj: WireObject | undefined, name: string): Tagged | undefined {
  const v = obj?.[name];
  return typeof v === 'object' && v !== null ? v : undefined;
}

function readInt(obj: WireObject | undefined, name: string, fallback = 0): number {
  const v = prop(obj, name);
  return v !== undefined && (v.t === 'int' || v.t === 'long' || v.t === 'byte') && typeof v.v === 'number'
    ? v.v
    : fallback;
}

function readBool(obj: WireObject | undefined, name: string): boolean {
  const v = prop(obj, name);
  return v !== undefined && v.t === 'bool' && v.v === true;
}

function readStr(obj: WireObject | undefined, name: string): string | null {
  const v = prop(obj, name);
  return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

function readEnum(obj: WireObject | undefined, name: string): string | null {
  const v = prop(obj, name);
  return v !== undefined && v.t === 'enum' && typeof v.v === 'string' ? v.v : null;
}

/** A `list` of `int` — how every collection of entities crosses the wire. */
function readIds(obj: WireObject | undefined, name: string): number[] {
  const v = prop(obj, name);
  if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
  const ids: number[] = [];
  for (const item of v.v as Tagged[]) {
    // Forge skips -1 when it resolves a collection (`resolveFromNetwork`).
    if (item.t === 'int' && typeof item.v === 'number' && item.v !== -1) ids.push(item.v);
  }
  return ids;
}

// ── card faces ──────────────────────────────────────────────────────────────

/**
 * `ManaCostShard` constant → the cost token our pips draw
 * (`forge-core/.../card/mana/ManaCostShard.java`, the second constructor arg).
 * `COLORED_X` is Forge's "X paid in coloured mana"; its own label is `1`, which
 * would draw as a generic one, so it is drawn as the X it is.
 */
const SHARD_TOKEN: Record<string, string> = {
  WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G', COLORLESS: 'C',
  WU: 'W/U', WB: 'W/B', UB: 'U/B', UR: 'U/R', BR: 'B/R', BG: 'B/G', RW: 'R/W', RG: 'R/G', GW: 'G/W', GU: 'G/U',
  W2: '2/W', U2: '2/U', B2: '2/B', R2: '2/R', G2: '2/G',
  CW: 'C/W', CU: 'C/U', CB: 'C/B', CR: 'C/R', CG: 'C/G',
  S: 'S', GENERIC: '1', X: 'X', COLORED_X: 'X',
  WP: 'W/P', UP: 'U/P', BP: 'B/P', RP: 'R/P', GP: 'G/P',
  BGP: 'B/G/P', BRP: 'B/R/P', GUP: 'G/U/P', GWP: 'G/W/P', RGP: 'R/G/P',
  RWP: 'R/W/P', UBP: 'U/B/P', URP: 'U/R/P', WBP: 'W/B/P', WUP: 'W/U/P',
};

/**
 * `ManaCost.serialize` → tokens. The format is the generic amount (`-1` for
 * "no cost", e.g. a land), then shard names, joined by U+0006
 * (`ManaCost.java:261`). An unknown shard name is kept verbatim — our pip
 * renders an unknown token rather than dropping it.
 */
export function manaCostTokens(serialized: string): { tokens: string[]; manaValue: number } {
  const [genericText = '-1', ...shards] = serialized.split('\u0006').filter((p) => p !== '');
  const generic = Number.parseInt(genericText, 10);
  const tokens: string[] = [];
  let manaValue = 0;
  if (generic > 0) {
    tokens.push(String(generic));
    manaValue += generic;
  }
  for (const shard of shards) {
    const token = SHARD_TOKEN[shard] ?? shard;
    tokens.push(token);
    manaValue += token === 'X' ? 0 : token.startsWith('2/') ? 2 : 1;
  }
  if (generic === 0 && shards.length === 0) tokens.push('0');
  return { tokens, manaValue };
}

const RARITY: Record<string, Rarity> = {
  BasicLand: 'common',
  Common: 'common',
  Uncommon: 'uncommon',
  Rare: 'rare',
  MythicRare: 'mythic',
  Special: 'special',
  Token: 'special',
};

const WUBRG: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** `ColorSet` crosses as an enum name built from its letters (`BGU`, `R`, `C`). */
function colorsOf(enumName: string | null): ManaColor[] {
  if (enumName === null) return [];
  return WUBRG.filter((c) => enumName.includes(c));
}

function typeLineOf(t: Tagged | undefined): string {
  if (t === undefined || t.t !== 'cardtype') return '';
  const ct = t as Extract<Tagged, { t: 'cardtype' }>;
  const head = [...ct.sup, ...ct.core].join(' ');
  return ct.sub.length > 0 ? `${head} — ${ct.sub.join(' ')}` : head;
}

function coreTypes(t: Tagged | undefined): string[] {
  return t !== undefined && t.t === 'cardtype' ? (t as Extract<Tagged, { t: 'cardtype' }>).core : [];
}

function countersOf(obj: WireObject | undefined): { name: string; count: number }[] {
  const v = prop(obj, 'Counters');
  if (v === undefined || v.t !== 'multiset' || !Array.isArray(v.v)) return [];
  return (v.v as [string, number][]).map(([name, count]) => ({ name, count }));
}

function toBoardCard(state: WireState, id: number, artIds: ArtIdIndex, onBattlefield = false): BoardCard | null {
  const view = state.get(deltaKey(WireType.Card, id));
  if (view === undefined) return null;
  const face = state.get(cardStateKey(id, readInt(view, 'CurrentState', 0)));

  const name = readStr(face, 'Name') ?? readStr(view, 'Name') ?? `card ${id}`;
  const cost = prop(face, 'ManaCost');
  const { tokens, manaValue } =
    cost !== undefined && cost.t === 'manacost' && typeof cost.v === 'string'
      ? manaCostTokens(cost.v)
      : { tokens: [], manaValue: 0 };
  const type = prop(face, 'Type');
  const core = coreTypes(type);
  const counters = countersOf(view);
  const loyaltyCounter = counters.find((c) => c.name === 'Loyalty');

  const card: DraftCard = {
    cardId: `w${id}`,
    name,
    manaCost: tokens,
    manaValue,
    colors: colorsOf(readEnum(face, 'Colors')),
    typeLine: typeLineOf(type),
    // Forge writes CRLF; CardTile splits on LF and drops empty lines.
    oracleText: (readStr(face, 'OracleText') ?? '').replace(/\r\n?/g, '\n'),
    setCode: readStr(face, 'SetCode') ?? '',
    collectorNumber: '',
    rarity: RARITY[readEnum(face, 'Rarity') ?? ''] ?? 'special',
  };
  const scryfallId = scryfallIdFor(artIds, name, card.setCode);
  if (scryfallId !== undefined) card.scryfallId = scryfallId;
  if (core.includes('Creature')) {
    card.power = String(readInt(face, 'Power'));
    card.toughness = String(readInt(face, 'Toughness'));
  }
  if (core.includes('Planeswalker')) {
    card.loyalty = loyaltyCounter !== undefined ? String(loyaltyCounter.count) : (readStr(face, 'Loyalty') ?? '0');
  }

  return {
    id,
    card,
    tapped: readBool(view, 'Tapped'),
    // Forge sets `Sickness` on cards in every zone; it only means something on
    // a creature on the battlefield, so it is only reported there.
    summoningSick: onBattlefield && core.includes('Creature') && readBool(view, 'Sickness'),
    damage: readInt(view, 'Damage'),
    counters: counters.filter((c) => c.name !== 'Loyalty' || !core.includes('Planeswalker')),
    attacking: readBool(view, 'Attacking'),
    blocking: readBool(view, 'Blocking'),
    token: readBool(view, 'Token'),
  };
}

// ── the board ───────────────────────────────────────────────────────────────

/** Our words for Forge's `PhaseType` constants (`PhaseType.java:16-28`). */
export const PHASE_LABEL: Readonly<Record<string, string>> = {
  UNTAP: 'Untap',
  UPKEEP: 'Upkeep',
  DRAW: 'Draw',
  MAIN1: 'Main 1',
  COMBAT_BEGIN: 'Beginning of combat',
  COMBAT_DECLARE_ATTACKERS: 'Declare attackers',
  COMBAT_DECLARE_BLOCKERS: 'Declare blockers',
  COMBAT_FIRST_STRIKE_DAMAGE: 'First-strike damage',
  COMBAT_DAMAGE: 'Combat damage',
  COMBAT_END: 'End of combat',
  MAIN2: 'Main 2',
  END_OF_TURN: 'End step',
  CLEANUP: 'Cleanup',
};

export function toBoardView(
  state: WireState,
  seq: number,
  { viewerPlayerId, artIds = CUBE_ART_IDS }: AdaptOptions,
): BoardView {
  const game = [...state.values()].find((o) => o._type === WireType.Game);
  const missing: number[] = [];

  const cardsIn = (ids: number[], onBattlefield = false): BoardCard[] => {
    const out: BoardCard[] = [];
    for (const id of ids) {
      const c = toBoardCard(state, id, artIds, onBattlefield);
      if (c === null) missing.push(id);
      else out.push(c);
    }
    return out;
  };

  const activePlayerId = prop(game, 'PlayerTurn') !== undefined ? readInt(game, 'PlayerTurn') : null;
  const playerIds = readIds(game, 'Players');
  const players: BoardPlayer[] = playerIds.map((pid) => {
    const p = state.get(deltaKey(WireType.Player, pid));
    const isViewer = pid === viewerPlayerId;
    const handIds = readIds(p, 'Hand');
    return {
      id: pid,
      name: readStr(p, 'Name') ?? `player ${pid}`,
      life: readInt(p, 'Life'),
      isViewer,
      isActive: pid === activePlayerId,
      hasPriority: readBool(p, 'HasPriority'),
      hasLost: readBool(p, 'HasLost'),
      hand: isViewer ? cardsIn(handIds) : null,
      handCount: handIds.length,
      libraryCount: readIds(p, 'Library').length,
      battlefield: cardsIn(readIds(p, 'Battlefield'), true),
      graveyard: cardsIn(readIds(p, 'Graveyard')),
      exile: cardsIn(readIds(p, 'Exile')),
    };
  });
  players.sort((a, b) => Number(b.isViewer) - Number(a.isViewer));

  const nameOfPlayer = (pid: number): string | null =>
    readStr(state.get(deltaKey(WireType.Player, pid)), 'Name');

  const stack: StackEntry[] = readIds(game, 'Stack').map((sid) => {
    const item = state.get(deltaKey(WireType.StackItem, sid));
    const sourceCardId = prop(item, 'SourceCard') !== undefined ? readInt(item, 'SourceCard') : null;
    const source = sourceCardId !== null ? toBoardCard(state, sourceCardId, artIds) : null;
    const activator = prop(item, 'ActivatingPlayer') !== undefined ? readInt(item, 'ActivatingPlayer') : null;
    return {
      id: sid,
      description: readStr(item, 'Description') ?? readStr(item, 'Key') ?? `stack item ${sid}`,
      sourceCardId,
      sourceName: source?.card.name ?? null,
      controllerName: activator === null ? null : nameOfPlayer(activator),
      isAbility: readBool(item, 'Ability'),
    };
  });

  const phase = readEnum(game, 'Phase');
  return {
    seq,
    title: readStr(game, 'Title') ?? '',
    turn: readInt(game, 'Turn'),
    phase,
    phaseLabel: phase === null ? 'Not started' : (PHASE_LABEL[phase] ?? phase),
    activePlayerId,
    players,
    stack,
    gameOver: readBool(game, 'GameOver'),
    missingCardIds: missing,
  };
}
