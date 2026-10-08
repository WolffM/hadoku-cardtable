/*
 * A room, and what it plays: a constructed table, or a draft.
 *
 * The room screen is the only screen a room has. `constructed-1v1` is the table
 * below — YOUR deck, their state, and the match the server starts once both of
 * you are ready — and `draft` is a lobby with a readiness gate that becomes a
 * pod. Which one is drawn comes off the ROOM's own record (`rooms.get`), never
 * off the table.
 *
 * ## The draft branch, and why it is here rather than on a route of its own (w23)
 *
 * It used to be a route of its own: `#/draft/<id>`, a client-minted id, and a
 * server that dealt the draft the moment a socket connected. The operator, of
 * the button that opened it: *"old cruft that seems to auto-start with all
 * bots"*, and of what should happen instead: *"it should go to a room first and
 * only after everyone clicks ready should it actually start the draft"*. So
 * there is one door and one id. A room created with `gameType: 'draft'` shows:
 *
 *   `draftStartedAt === null`  the room's lobby — who is here, who is ready,
 *                              and a Ready toggle. No cards exist yet.
 *   `draftStartedAt !== null`  the pod (`PodScreen`), against the room's id.
 *
 * Every member ready is the gate, and either browser may ask the server to deal
 * — the same shape constructed's start already has, guarded by the same kind of
 * ref so a poll cannot ask twice.
 *
 * **A draft room does not touch the tables API.** `http/routes.ts` answers 409
 * to `PUT …/deck`, `POST …/ready` and the room start for anything that is not
 * `constructed-1v1`, so none of them is called and the formats, decks and
 * legality sweep are not loaded either. The table POLL still runs, because its
 * join-on-refusal (below) is what turns following an invite link into
 * membership, and a draft room needs that as much as a constructed one —
 * `GET /api/tables/rooms/:roomId` is the one table route that is not gated.
 *
 * ## Whose Ready toggle it is, and who the leader is — both from the server
 *
 * A member's id is a hashed participant id the browser cannot derive, and the
 * display name is not unique (an unnamed key is "friend"), so no client can work
 * out which member it is. It does not have to: the room record carries a
 * caller-scoped `you: { leader, ready }` (w25), beside the `you` the constructed
 * table has always had. The draft toggle's label is that flag rather than a
 * latch set by our own call — which is what used to make a reload mid-lobby read
 * "Ready" while the room knew otherwise (wave 23's stated cost) — and `leader`
 * is what decides who gets the table's settings.
 *
 * Both default FALSE when the field is absent (`rooms/api.ts`'s `parseYou`), so
 * a server that predates them leaves nobody in charge. That costs the leader a
 * control; it can never hand one to somebody else.
 *
 * The operator's flow (`docs/handoff/w13.md`): a room list, a room, a game
 * type, then *"once both players have a valid deck loaded the game can be
 * started"*. What this screen used to be — one person choosing BOTH decks and
 * sending a link — is the shape they rejected in exactly those words: *"this is
 * not how any of this should work"*. So there is no picker here for anybody's
 * deck but your own, and no call this file can make that names another member.
 *
 * ## The server is the authority, and it is asked once per deck
 *
 * Loading a deck is `PUT /api/tables/rooms/:roomId/deck`, which checks it with
 * the gate and stores the verdict; that stored verdict is what the match starts
 * from. The Ready toggle is disabled while your deck is illegal, and the server
 * refuses the same thing with the same sentence — the disabled button is a
 * courtesy, the refusal is the control.
 *
 * ## Choosing a deck IS loading it, and the ROOM's pool decides which decks
 *
 * The operator, of the Load button this used to have: *"just 'I'm ready' is
 * enough."* So picking a deck sends the `PUT` itself; there is no second thing
 * to press.
 *
 * The pool is the TABLE's, not the seat's (w25). Operator, 2026-09-27: *"the
 * room leader can change the set or other settings"* and *"people who join can
 * only select from the deck dropdown"*. So the pool is READ from the room
 * record, the leader alone gets a control that moves it
 * (`PATCH /api/rooms/:id` → `rooms.setFormat`), and a deck already chosen is
 * re-sent when the pool moves under it — on every browser, because it is
 * everybody's stored verdict the server clears, not only the leader's.
 *
 * `PUT …/deck` therefore names a deck and nothing else. It used to carry the
 * caller's own `rules`, which is how two players could sit at one table holding
 * decks legal in two different pools; the server now refuses a body that
 * carries `rules` at all (400), so there is no version of this screen that can
 * quietly disagree with the room about what was checked.
 *
 * The pool also NARROWS the deck list to the decks legal in it, which is one
 * `GET /api/tables/legal/:format` per era — see `legalDecksIn` for why the
 * gate answers it, and why every deck is offered when the era could not be
 * asked about. The answer is remembered per pool, so moving
 * back to one already asked about costs nothing.
 *
 * A room whose record has not been read yet, or a server that sends no
 * `format`, falls back to the NEWEST pool (`newestFormat`) — the same default
 * the server applies at create, and deliberately not `formats[0]`, which is
 * the oldest power-summer era (2008-07-25) and is where every room used to
 * open.
 *
 * Each option also says what COLOUR its deck is (wave 27 §D), folded out of the
 * deck's own card list by the one fold `DeckView.tsx` exports — see
 * {@link deckOptions} for where the costs come from and {@link optionLabel} for
 * why the option says `WU` in letters while the symbols sit beside the control.
 *
 * ## Waiting for the other person is the job
 *
 * Both players' state — chosen, legal, ready — is polled from the room
 * (`pollMs`, 1.5 s). No second socket: `RoomChrome` already holds one for the
 * room's chat and roster, and a second one would share and then tear down its
 * connection. When both are ready either browser asks the server to start; the
 * server answers one match to both, and `matchId` appearing on the table is
 * what sends each player to `#/match/<id>` — including a player who never
 * pressed anything.
 *
 * ## Two clients, and the room decides which (D19a)
 *
 * A room is created `builtin` — this table — or `streamed`, which is Forge's
 * own desktop client running in a container per seat and shown through the
 * server's `/stream/**` route. The choice is the ROOM's, made once at create
 * and never again, so this screen reads it and renders one of two bodies; it
 * offers no switch, because there is nothing to switch to mid-room.
 *
 * The mode comes from `GET /api/rooms/:id`, polled beside the table, and is
 * latched the first time it is read: a later answer cannot turn a room someone
 * is sitting in into the other kind. A read that fails leaves the mode unknown
 * and this renders the builtin table — the same direction `parseRoomView`
 * defaults in, and the same outage the table poll is already reporting in
 * words a few lines below.
 *
 * ## Without a room
 *
 * `#/play` has nothing left to do: a match against a person starts in a room.
 * It points back at the room list rather than rendering a table with no room.
 */

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  artIdIndexFromTable,
  scryfallIdFor,
  type ArtIdIndex,
  type ArtIdTableFile,
} from '@hadoku/carddata/art';
import { basicLand, mainDeckSize, moveToMain, setBasicLand, type Deck } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';

import { navigate } from './route.ts';
import { PodScreen } from './PodScreen.tsx';
import {
  DeckColors,
  deckColorsByName,
  mainDeckColors,
  manaTokensOf,
  type DeckColor,
} from '../components/DeckView.tsx';
import artIdsData from '../draft/art-ids.json' with { type: 'json' };
import { cardImageUrl, prefetchCardImages } from '../draft/cardImage.ts';
import { cardIndex, mainSummary } from '../deck/build.ts';
import { deckFromPool, dckTextOf } from '../draft/deckFromPool.ts';
import { closeDraft, startDraft, type DraftTransport, type SocketDraft } from '../draft/socket.ts';
import type { DraftCard } from '../draft/types.ts';
import {
  roomsClient,
  streamPath,
  streamReachable,
  type ClientMode,
  type Fetch,
  type RoomMember,
  type RoomView,
  type RoomsClient,
} from '../rooms/api.ts';
import {
  RANDOM_DECK,
  legalDecksIn,
  newestFormat,
  pickRandom,
  secureRandom,
  tablesClient,
  type DeckRef,
  type FormatFamily,
  type LegalSweep,
  type RoomPlayer,
  type RoomTable,
  type TableDeck,
  type TableFormat,
  type TablesClient,
  type Verdict,
} from './tables.ts';

export interface ConstructedScreenProps {
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
  /** The room whose table this is. `App` threads it from `#/room/<id>`. */
  roomId?: string;
  /** How often the room's table is re-read. Tests pass something small. */
  pollMs?: number;
  /** Tests pass a rooms client so the join-on-entry can be driven. Production passes nothing. */
  rooms?: RoomsClient;
  /** Tests pass the stream probe's `fetch`. Production passes nothing. */
  streamFetch?: Fetch;
  /** Where `Random` gets its number. Tests pin it; production passes nothing. */
  rand?: () => number;
  /**
   * The draft pod's transport, threaded to `PodScreen` once a draft room has
   * started. Tests pass a stub; production passes nothing and gets socket.io.
   */
  makeTransport?: () => DraftTransport;
}

/** How often a seat that has no stream yet asks again. */
export const STREAM_PROBE_MS = 5000;

type Loaded = { formats: TableFormat[]; decks: TableDeck[] };

/**
 * A pool, as the screen names it: the id and the pool's own name.
 *
 * The same text in the leader's `<option>` and in the fixed value everybody else
 * reads, so the two screens are not two vocabularies. A pool the catalogue does
 * not hold is shown as its bare id rather than blank — the room said it, and a
 * value the screen cannot expand is still the value.
 */
/**
 * One row of the deck chooser: what it sends, what it reads, what colour it is,
 * and which card's art stands for it.
 *
 * The colours are folded once, here, and used twice — in the row's own pips and
 * in the pips beside the control — so the two cannot disagree with each other.
 */
interface DeckOption {
  value: string;
  label: string;
  colors: readonly DeckColor[];
  /**
   * The Scryfall id of the card whose art represents this deck, or undefined
   * when nothing in the list could be resolved. See {@link deckArtId}.
   */
  artId?: string | undefined;
}

/** Converted mana cost of one Scryfall cost token — `'3'` → 3, `'2/W'` → 2, `'X'` → 0. */
function tokenValue(token: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  const generic = token.split('/').find((part) => /^\d+$/.test(part));
  if (generic !== undefined) return Number(generic);
  return token === 'X' || token === 'Y' || token === 'Z' ? 0 : 1;
}

/** Converted mana cost of a Scryfall cost string. Scryfall's own `cmc`, recomputed. */
export function manaValueOf(cost: string): number {
  return manaTokensOf(cost).reduce((total, token) => total + tokenValue(token), 0);
}

/** A maindeck card the art rule may choose between. */
interface ArtCandidate {
  name: string;
  count: number;
  manaValue: number;
  scryfallId?: string | undefined;
}

/**
 * The card whose art stands for a deck — **the most expensive card it plays**,
 * ties broken by how many copies, then by name.
 *
 * A deck has no art of its own, so a rule has to be chosen and written down.
 * This is the rule, and it is the most expensive card rather than the first
 * non-land because the expensive card is the one the deck is usually NAMED
 * after: it gives Primeval Titan for Kessig Titan, Geist of Saint Traft for UW
 * Delver, Tempered Steel for the archetype of the same name and Avenger of
 * Zendikar for Valakut Ramp. "First non-land" would give whatever the
 * transcription happened to list first, which for these files is alphabetical
 * inside the creature block.
 *
 * Copies before name because two six-drops is common and the four-of is the
 * deck's plan; name last so the answer is total and a re-render cannot flicker.
 *
 * **A card with no mana cost is not a candidate**, which is how a land is
 * excluded without a type line: the library arm learns costs from
 * `LIBRARY_CARD_COSTS`, where every land is simply absent, and the drafted arm
 * reads `DraftCard.manaCost`, which is empty for one. All 49 catalogued library
 * decks resolve under this rule — verified against
 * `apps/ui/src/draft/art-ids.json`, whose scope is *"every card in the committed
 * decks/ lists"* plus a bare-name fallback row.
 *
 * Undefined when nothing resolves; the row then draws its colours and no art,
 * which is a complete option on its own.
 */
export function deckArtId(candidates: readonly ArtCandidate[]): string | undefined {
  const best = [...candidates].sort(
    (a, b) =>
      b.manaValue - a.manaValue ||
      b.count - a.count ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )[0];
  return best?.scryfallId;
}

/**
 * `Name|SET` and bare `Name` → Scryfall id, for every card the committed
 * constructed lists play.
 *
 * The same committed table the play board resolves art through
 * (`scripts/art/build-art-ids.ts` generates it; `apps/ui/src/play/adapter.ts`
 * loads it for the same reason), read here through `@hadoku/carddata/art` rather
 * than through that file, so this screen does not depend on the play surface's
 * module layout. It is already in this bundle — the app is not code-split — so
 * importing it here costs no bytes.
 *
 * **A lookup, not a URL** (D15): nothing here names a host. The id goes to
 * `cardImageUrl`, which is the only place in the UI that builds one, and
 * repointing a card stays a one-line edit in `art-manifest.json`.
 */
const LIBRARY_ART_IDS: ArtIdIndex = artIdIndexFromTable(artIdsData as ArtIdTableFile);

function poolLabel(formats: readonly TableFormat[], id: string): string {
  const found = formats.find((f) => f.id === id);
  return found === undefined ? id : `${found.id} — ${found.name}`;
}

/* ── the format tab selector (wave 48 §U) ─────────────────────────────── */

/**
 * The three ruleset tabs, operator order (2026-10-05): *"i'll need a tab
 * selector at the top for picking the format as well obviously"*. "Drafted
 * pool" is a fourth tab, appended only when the room has one — it is not a
 * `FormatFamily` and is never grouped into one of these three.
 */
const FORMAT_TABS: ReadonlyArray<{ id: FormatFamily; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'modern', label: 'Modern' },
  { id: 'legacy', label: 'Legacy' },
];

/**
 * `formats`, narrowed to one tab's own eras, newest year first.
 *
 * Grouped on `family` — data the server sends — never on a parsed name
 * (brief item 2): a `Standard (ORI)` string tells a person which card frame
 * it was, not which of three tabs it belongs on.
 *
 * Sorted by `id` descending rather than by a parsed date: a Standard id IS its
 * bare `YYYY-MM-DD` date, and a Modern/Legacy id is `<family>-<date>` with the
 * SAME family prefix for every era in one tab's own list, so lexicographic
 * order on `id` is chronological order within the tab either way.
 */
export function erasOf(formats: readonly TableFormat[], tab: FormatFamily): TableFormat[] {
  return formats
    .filter((f) => f.source !== 'draft' && f.family === tab)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Whether `poolId` — the room's ACTUAL pool — is one of the options `tab`
 * itself offers.
 *
 * Found live (w48 §U): a native `<select>` whose `value` matches none of its
 * `<option>`s falls back to showing the FIRST option as already selected, so
 * a leader browsing a tab the room is not on would see an era highlighted
 * that was never chosen — and clicking that exact one fires no `change`
 * event (the browser already considered it selected), so the room could
 * never be moved to it. The caller uses this to render no selection at all
 * on a tab the room's own era is not part of, rather than let the DOM invent
 * one.
 */
export function poolIsOnTab(
  formats: readonly TableFormat[],
  tab: FormatFamily | 'draft',
  poolId: string,
  pod: string | null,
): boolean {
  if (tab === 'draft') return pod !== null && formats.some((f) => f.source === 'draft' && f.id === poolId);
  return erasOf(formats, tab).some((f) => f.id === poolId);
}

/* ── a room on a DRAFTED pool (wave 26 §F) ────────────────────────────── */

/** What makes a room's pool a pod rather than a frozen era. The server's own spelling. */
const DRAFT_POOL_PREFIX = 'draft:';

/** The option value for "the cards I drafted". Not a library id, like `RANDOM_DECK`. */
export const DRAFTED_DECK = '__drafted__';

/** Basics in an auto-built limited deck: the limited convention, one number. */
export const DRAFTED_BASICS = 17;

const BASIC_FOR: Record<'W' | 'U' | 'B' | 'R' | 'G', string> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
};

/**
 * The pod behind a room's drafted pool id, or null for a frozen era.
 *
 * A MIRROR of the server's `draftIdOfPool` (`apps/server/src/room/lobby.ts`),
 * including the room-id shape, and it is a mirror rather than a shared function
 * because the string lives in a server package this browser app does not import.
 * It is used only to decide what to draw and which pod to open a socket on — the
 * server re-derives it for every decision that matters, so a browser that read
 * this wrong would draw the wrong picker and could still not check a deck against
 * the wrong pool.
 */
export function draftPoolPod(poolId: string): string | null {
  if (!poolId.startsWith(DRAFT_POOL_PREFIX)) return null;
  const draftId = poolId.slice(DRAFT_POOL_PREFIX.length);
  return /^[a-z0-9-]{1,40}$/.test(draftId) ? draftId : null;
}

/**
 * A playable deck out of a drafted pool, with no choices asked.
 *
 * The room screen has a deck DROPDOWN, not a deck builder: `#/deck/<podId>`
 * is where a pool is refined into forty cards, and duplicating that here would
 * be a second builder to keep correct. So the one thing this offers is "the cards
 * I drafted", and it has to be a deck Forge can actually play — which means
 * lands, because a maindeck of 45 spells and no lands is legal by every rule we
 * check and unplayable at the table.
 *
 * Everything drafted goes in the maindeck (45 ≥ `LIMITED_MIN_MAIN_DECK_SIZE`, and
 * a card you did not draft has no way in — `newDeck` opens with the pool
 * sideboarded and only `moveToMain` moves anything), and `DRAFTED_BASICS` basics
 * are split by the maindeck's own coloured pips. The basics come from the table
 * rather than the pool, which is what `setBasicLand` is and what the gate's
 * `splitBasicLands` exempts from the pool check.
 *
 * Largest-remainder, not `round` per colour: rounding five shares independently
 * gives 16 or 18 lands as often as 17, and the deck the person plays should have
 * the number of lands it says it has.
 */
export function draftedDeckOf(draftId: string, pool: readonly DraftCard[]): Deck {
  let deck = deckFromPool(draftId, pool);
  for (const entry of [...deck.sideboard]) deck = moveToMain(deck, entry.card, entry.count);

  const { pips } = mainSummary(deck, cardIndex(pool));
  const colors = Object.keys(BASIC_FOR) as (keyof typeof BASIC_FOR)[];
  const total = colors.reduce((n, c) => n + pips[c], 0);
  if (total === 0) return deck;

  const exact = colors.map((c) => ({ color: c, want: (DRAFTED_BASICS * pips[c]) / total }));
  const counts = new Map(exact.map((e) => [e.color, Math.floor(e.want)]));
  let left = DRAFTED_BASICS - [...counts.values()].reduce((a, b) => a + b, 0);
  for (const e of [...exact].sort((a, b) => b.want - Math.floor(b.want) - (a.want - Math.floor(a.want)))) {
    if (left <= 0) break;
    counts.set(e.color, (counts.get(e.color) ?? 0) + 1);
    left -= 1;
  }
  for (const [color, count] of counts) {
    if (count > 0) deck = setBasicLand(deck, basicLand(BASIC_FOR[color]), count);
  }
  return deck;
}

/**
 * The era's sets, as symbols. Operator: *"constructed selections should show the
 * set symbols that are in that era."*
 *
 * `GET /api/tables/formats` already sends each era's `sets`, so this is C's
 * `SetSymbol` on that list and nothing more — no host, no image, no WotC file: a
 * Keyrune glyph with the raw code beside it (D20, `docs/LICENSING.md` §3.2).
 * A drafted pool has no set list and draws nothing, which is the truth about it:
 * a cube is not an era.
 */
/**
 * The label on the pool control. Two kinds of pool, two nouns.
 *
 * Was "Matched Standard" (the operator's own words) for every frozen era; wave
 * 48 §U replaced the single "Matched Standard" optgroup with the format tab
 * selector, and the label above it has to stay true for a Modern or Legacy
 * pick too — "Format" is neutral across all three and names what the tabs
 * are tabs OF. A room on a pod is still not playing any of the three, so that
 * half is unchanged.
 */
function poolFieldLabel(pod: string | null): string {
  return pod === null ? 'Format' : 'Drafted pool';
}

/* ── the era's sets, grouped by block (wave 28 §C, item 1) ─────────────── */

/**
 * Which block Scryfall files each set the eras are made of under.
 *
 * **A static map, on purpose, and here is the reason** — the alternative was to
 * put the block in the pool fixtures through their own generator
 * (`packages/deck/src/library/build-pool-fixture.ts`), and that generator
 * **cannot answer the question**. It reads `packages/carddata/data/cards.jsonl`,
 * Scryfall's `default_cards` bulk export, and a Scryfall CARD object carries
 * `set`, `set_name` and `set_type` and **no `block` field at all** (verified
 * against the committed corpus: every key of a card row is listed by
 * `head -1 cards.jsonl`, and `block` is not among them). `block` and `block_code`
 * live on the SET object, which only `api.scryfall.com/sets` serves, so the
 * fixture route would have meant a new network dependency in a generator that has
 * none — for twelve rows that cannot change, because the eras are frozen.
 *
 * So: twelve codes, four groups, each one verified against
 * `https://api.scryfall.com/sets` on 2026-09-28 rather than remembered —
 *
 *   ZEN WWK ROE → Zendikar (`zen`)
 *   SOM MBS NPH → Scars of Mirrodin (`som`)
 *   ISD DKA AVR → Innistrad (`isd`)
 *   M11 M12 M13 → Core Set (`lea`)
 *
 * The core sets really are one Scryfall block whose `block_code` is `lea`, i.e.
 * Alpha, 1993. That is why {@link groupSetsByBlock} does not order blocks by
 * their own earliest set: it would put the core block in front of everything.
 */
interface SetBlock {
  readonly block: string;
  readonly blockCode: string;
}

const ZENDIKAR: SetBlock = { block: 'Zendikar', blockCode: 'zen' };
const SCARS: SetBlock = { block: 'Scars of Mirrodin', blockCode: 'som' };
const INNISTRAD: SetBlock = { block: 'Innistrad', blockCode: 'isd' };
const CORE: SetBlock = { block: 'Core Set', blockCode: 'lea' };

/** A set this screen has no block recorded for still draws, in a group of its own. */
const UNKNOWN_BLOCK: SetBlock = { block: 'Other sets', blockCode: 'other' };

const SET_BLOCKS: Readonly<Record<string, SetBlock>> = {
  ZEN: ZENDIKAR,
  WWK: ZENDIKAR,
  ROE: ZENDIKAR,
  SOM: SCARS,
  MBS: SCARS,
  NPH: SCARS,
  ISD: INNISTRAD,
  DKA: INNISTRAD,
  AVR: INNISTRAD,
  M11: CORE,
  M12: CORE,
  M13: CORE,
};

/** One block's worth of an era: the block, and the era's sets that belong to it. */
export interface SetBlockGroup {
  readonly block: string;
  readonly blockCode: string;
  readonly codes: string[];
}

/**
 * An era's sets, gathered into their blocks.
 *
 * Order: the sets arrive in release order (`GET /api/tables/formats` sends the
 * format's own list, and `standardPoolAt` builds it oldest-first), and that order
 * is kept INSIDE each group. The groups themselves come in first-appearance
 * order, except that the core-set block goes last and an unrecognised set's group
 * after it. Core last rather than in place because a core set is not part of the
 * story its neighbours tell, and because `M12` sits between `NPH` and `ISD` in
 * release order — leaving it there would split the two expansion blocks it falls
 * between, which is exactly the cramped, ungrouped look the operator objected to.
 */
export function groupSetsByBlock(sets: readonly string[]): SetBlockGroup[] {
  const groups = new Map<string, SetBlockGroup>();
  for (const code of sets) {
    const meta = SET_BLOCKS[code.toUpperCase()] ?? UNKNOWN_BLOCK;
    const held = groups.get(meta.blockCode);
    if (held === undefined) groups.set(meta.blockCode, { ...meta, codes: [code] });
    else held.codes.push(code);
  }
  const rank = (blockCode: string): number =>
    blockCode === UNKNOWN_BLOCK.blockCode ? 2 : blockCode === CORE.blockCode ? 1 : 0;
  // Stable sort, so first-appearance order survives inside a rank.
  return [...groups.values()].sort((a, b) => rank(a.blockCode) - rank(b.blockCode));
}

/**
 * The era's sets, as symbols and NOTHING else.
 *
 * Operator, 2026-09-28: *"this is ugly, just the symbols is okay. group them by
 * block and make them bigger."* So the raw set code that used to sit beside every
 * glyph is gone, the glyph is `2rem` (`screens.css`), and the sets are clustered
 * into their blocks with a gap between clusters.
 *
 * **The code is gone from the TEXT, not from the DOM's reach.** Hiding it in CSS
 * would have left it in `textContent`, which is a test that passes against a row
 * nobody can read — the trap the old `<option>` comment warned about. So the row
 * carries no text at all, and every set is still identifiable: `data-set` and a
 * `title` per glyph, and the block's name and its codes in the group's
 * `aria-label`, which is what a screen reader gets instead of twelve bare glyphs.
 *
 * Keyrune glyphs, from a third-party font — never a WotC file and never
 * `svgs.scryfall.io` (D20, `docs/LICENSING.md` §3.2). This deliberately does not
 * use `components/ManaPip.tsx`'s `SetSymbol`, which renders the code beside the
 * glyph by construction and is `CardTile`'s, not this screen's.
 *
 * A drafted pool has no set list and draws nothing, which is the truth about it:
 * a cube is not an era.
 */
/**
 * The most set symbols this row draws, however long a format's legal list is.
 *
 * Legacy never rotates, so its legal-set list is Forge's whole `Sets:` line up
 * to the era's date — 150+ codes by the eras this wave adds, against a dozen
 * for Standard. `groupSetsByBlock` renders fine at that size (small glyphs,
 * one block per cluster), but a row that long stops being "the era's set
 * symbols" and starts being Magic's entire set history, which answers a
 * different question than the one this row exists for. Chosen: the newest
 * {@link MAX_POOL_SETS}, which is what a player actually associates the era
 * with — Forge's `Sets:` line is oldest-first (verified against
 * `forge/forge-gui/res/formats/Archived/Legacy/*.txt`), so the newest sets are
 * the LAST entries, never a random sample.
 */
const MAX_POOL_SETS = 40;

function PoolSets({ format }: { format: TableFormat | null }) {
  if (format === null || format.sets.length === 0) return null;
  const sets = format.sets.length > MAX_POOL_SETS ? format.sets.slice(-MAX_POOL_SETS) : format.sets;
  return (
    <p className="lobby__sets" data-testid="pool-sets" data-sets={sets.join(' ')}>
      {groupSetsByBlock(sets).map((group) => (
        <span
          key={group.blockCode}
          className="lobby__block"
          data-testid="pool-block"
          data-block={group.blockCode}
          data-sets={group.codes.join(' ')}
          aria-label={`${group.block}: ${group.codes.join(' ')}`}
        >
          {group.codes.map((code) => (
            <i
              key={code}
              className={`ss ss-${code.toLowerCase()}`}
              data-set={code}
              title={code}
              aria-hidden="true"
            />
          ))}
        </span>
      ))}
    </p>
  );
}

/* ── the deck chooser, which is not a dropdown (wave 28 §C, item 2) ─────── */

/**
 * A deck's art: a slice of the card the art rule chose, or nothing.
 *
 * **A lookup, not a URL.** The id goes to `cardImageUrl`, the one function in
 * this app that builds an image URL, which resolves it through
 * `art-manifest.json` — so repointing a card is still a one-line data edit and
 * this component names no host (D15). No bytes ship in the bundle: this is an
 * `<img src>` at a remote origin, and D18 repealed the restriction on which one.
 *
 * `normal` is what `cardImageUrl` defaults to: the whole card face, unmodified.
 * The SLICE is a CSS crop of those bytes for layout — `object-fit: cover` on a
 * short box — which is what *"a partial art that represents the deck"* asks for,
 * and it is a display crop rather than an `art_crop` URL, so we are still not
 * copying anybody's image metadata.
 *
 * Decorative, and deliberately: `alt=""` plus `aria-hidden`. The row's accessible
 * name is the DECK's name, and announcing "Primeval Titan" for a deck called
 * Kessig Titan would be telling a screen-reader user about our art rule.
 *
 * A URL that 404s (a CDN key never uploaded) only shows up at fetch time, so
 * `onError` falls back to the same empty band an unresolved id gets.
 */
function DeckArt({ artId }: { artId: string | undefined }) {
  const [broken, setBroken] = useState(false);
  const url = artId === undefined ? null : cardImageUrl(artId);
  if (url === null || broken) {
    return <span className="deckpick__art deckpick__art--none" aria-hidden="true" />;
  }
  return (
    <span className="deckpick__art" aria-hidden="true">
      <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
    </span>
  );
}

/**
 * The deck chooser: one card-like row per legal deck, and not a `<select>`.
 *
 * Operator, 2026-09-28: *"the deck chooser dropdown is very ugly, needs a
 * complete redesign. it should have a partial art that represents the deck and
 * the two colored symbols. we cannot use a standard dropdown for this."*
 *
 * ## What the dropdown's own comment got right, and what dissolved with it
 *
 * The previous author argued FOR the `<select>`, and one of their two reasons
 * dissolves the moment it stops being one: `<option>` has a text-only content
 * model, so a `<span>` React puts inside one stays in the DOM while the browser
 * draws only the option's text — every symbol in this app is a `::before`-driven
 * font glyph since D20, so a pip inside an `<option>` rendered as nothing at all,
 * and *"a test that counted pip elements inside an `<option>` would pass against
 * a dropdown that shows a player nothing"*. Real elements hold real glyphs, so
 * the pips are in the rows now.
 *
 * **The lesson survives, because it was never about `<option>`:** assert on what
 * a browser would paint. `constructed.test.ts` asserts the glyph CLASSES the
 * fonts define and the text the rows carry, not that some node exists inside
 * them.
 *
 * Their second reason was real: three e2e specs drove it with Playwright's
 * `selectOption` — `e2e/play.spec.ts`, `e2e/arrow.spec.ts`, `e2e/table-fit.spec.ts`
 * (`room-mode` and `streamed-live` only ever asserted its presence, so the old
 * comment's "six specs" was already stale). None of those files is this lane's,
 * so the shape here is chosen to make each re-aim ONE line: `deck-mine` stays on
 * the ROOT, every row carries `data-deck-id="<library id>"`, and the root carries
 * `aria-disabled` so `toBeEnabled()` still means something.
 * `docs/planning/wave28-evidence/C-deck-chooser-e2e-recipe.md` has the exact
 * before/after line for each spec.
 *
 * The `Name · WU` letters the dropdown carried are gone, and colour is still not
 * the only signal: a Mana-font pip draws the colour's LETTER inside the coloured
 * disc, and `DeckColors` names the colours in an `aria-label` besides. The
 * letters were in the text only because an `<option>`'s colour cannot be styled.
 *
 * ## Keyboard, which a div cannot get for free
 *
 * A `role="radiogroup"` of `role="radio"` BUTTONS: native buttons, so Space and
 * Enter activate without a handler, and `disabled` is the real thing rather than
 * a class. One row is in the tab order at a time (a roving `tabIndex`), and until
 * somebody presses something that stop is the CHOSEN row — otherwise Tab would
 * land on one deck while another is checked. Arrow keys move focus and choose, as
 * the ARIA radio-group pattern says; choosing on arrow is also what the
 * `<select>` did, since a closed native select fires `change` on every arrow
 * press, so no extra `PUT` per keystroke has been introduced. Home and End jump
 * to the ends, and nothing wraps — a `<select>` does not wrap either, and here
 * wrapping past the end would silently re-roll onto another deck.
 *
 * `aria-checked` is what says which deck is chosen; `data-chosen` on the root is
 * the same fact for a test, and the row also paints a mark.
 */
function DeckChooser({
  options,
  value,
  disabled,
  onChoose,
}: {
  options: readonly DeckOption[];
  value: string;
  disabled: boolean;
  onChoose: (value: string) => void;
}) {
  /** Where Tab lands. Null until the reader moves it, so it follows the choice. */
  const [focus, setFocus] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const chosen = options.findIndex((o) => o.value === value);
  const stop = focus ?? (chosen >= 0 ? chosen : 0);

  const goTo = (index: number): void => {
    const next = Math.max(0, Math.min(options.length - 1, index));
    const row = options[next];
    if (row === undefined) return;
    setFocus(next);
    refs.current[next]?.focus();
    onChoose(row.value);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (step !== 0) {
      event.preventDefault();
      goTo(stop + step);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      goTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      goTo(options.length - 1);
    }
  };

  return (
    <div
      className="deckpick"
      id="deck-mine"
      data-testid="deck-mine"
      role="radiogroup"
      aria-labelledby="deck-mine-label"
      aria-disabled={disabled ? 'true' : undefined}
      data-chosen={value}
      onKeyDown={disabled ? undefined : onKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="deckpick__option"
          data-testid="deck-option"
          data-deck-id={option.value}
          data-colors={option.colors.join('')}
          aria-checked={option.value === value}
          tabIndex={stop === index ? 0 : -1}
          disabled={disabled}
          ref={(el) => {
            refs.current[index] = el;
          }}
          onFocus={() => setFocus(index)}
          onClick={() => onChoose(option.value)}
        >
          <DeckArt artId={option.artId} />
          <span className="deckpick__name" title={option.label}>
            {option.label}
          </span>
          <DeckColors
            colors={option.colors}
            label={`${option.label}: ${
              option.colors.length === 0 ? 'colourless' : option.colors.join(' ')
            }`}
          />
          {option.value === value && (
            <span className="deckpick__mark" aria-hidden="true">
              chosen
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function ConstructedScreen({
  client: given,
  roomId,
  pollMs = 1500,
  rooms,
  streamFetch,
  rand = secureRandom,
  makeTransport,
}: ConstructedScreenProps) {
  const client = useMemo(() => given ?? tablesClient(), [given]);
  return roomId === undefined ? (
    <NoRoom />
  ) : (
    <RoomTableScreen
      client={client}
      roomId={roomId}
      pollMs={pollMs}
      rooms={rooms}
      streamFetch={streamFetch}
      rand={rand}
      makeTransport={makeTransport}
    />
  );
}

function RoomTableScreen({
  client,
  roomId,
  pollMs,
  rooms: givenRooms,
  streamFetch,
  rand,
  makeTransport,
}: {
  client: TablesClient;
  roomId: string;
  pollMs: number;
  rooms?: RoomsClient;
  streamFetch?: Fetch;
  rand: () => number;
  makeTransport?: () => DraftTransport;
}) {
  const rooms = useMemo(() => givenRooms ?? roomsClient(), [givenRooms]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deckId, setDeckId] = useState('');
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  /** The pool's answer to "which decks are legal here", and one per pool kept. */
  const [legal, setLegal] = useState<LegalSweep | null>(null);
  const sweeps = useRef(new Map<string, LegalSweep>());
  /**
   * The room's pool as this screen last saw it, so a CHANGE can be told from a
   * first sighting. Null until the room has answered once: arriving in a room
   * whose pool is already set must not re-send a deck the server is holding
   * against that same pool, because a `PUT …/deck` stands you down
   * (`routes.ts`: a new deck un-readies you).
   */
  const seenPool = useRef<string | null>(null);
  const [startRefusal, setStartRefusal] = useState<string | null>(null);
  /** A start is in flight, or has been refused: not asked again on every poll. */
  const asked = useRef(false);
  /** The picker is set from the server's copy of your choice exactly once. */
  const restored = useRef(false);
  /**
   * The join was refused. `need` is the first refusal, sent without a
   * password; `wrong` is a refusal for one we sent. The two are different
   * sentences to a person and the same response from the server, which cannot
   * tell us which it was without telling an outsider that the room exists.
   */
  const [locked, setLocked] = useState<null | 'need' | 'wrong' | 'rate-limited'>(null);
  const [password, setPassword] = useState('');
  /** Bumped to re-run the join with whatever `passwordRef` now holds. */
  const [attempt, setAttempt] = useState(0);
  const passwordRef = useRef('');
  /**
   * The room's own record: which client it runs, and who is in it. Streamed
   * rooms are drawn entirely from this — there is no deck to load and no
   * `players` list to read, so `table` says nothing useful about them.
   *
   * `resolved` flips on the first answer of any kind, success or failure, and
   * gates the body below so a streamed room never flashes the builtin table on
   * the way in. It is one extra concurrent request alongside the table read,
   * not a second round trip after it.
   */
  const [view, setView] = useState<RoomView | null>(null);
  const [resolved, setResolved] = useState(false);
  /** Latched on the first read. A room does not change mode under its players. */
  const modeRef = useRef<ClientMode | null>(null);
  /** A refusal from `ready` or `start`, in the server's own words. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const [dealing, setDealing] = useState(false);
  /** A deal is in flight or was refused: not asked again on every poll. */
  const askedDeal = useRef(false);
  /** Bumped by Try again, which is the only thing that re-asks by hand. */
  const [dealAttempt, setDealAttempt] = useState(0);

  /**
   * The room's game type, live rather than latched.
   *
   * Unlike `clientMode` — fixed at create — the leader may change the game type
   * while the room is in its lobby, and the server refuses the change once a
   * draft has started (`PATCH /api/rooms/:id` → 409) and clears every ready flag
   * when it allows it. So the screen follows it; latching would leave the room
   * drawing the game it was created as.
   *
   * A room record that could not be read leaves this false, which draws the
   * constructed table — the same direction `parseRoomView` defaults in, and the
   * behaviour every room had before there was a draft branch.
   */
  const draftRoom = view?.gameType === 'draft';
  const draftStartedAt = view?.draftStartedAt ?? null;
  const members = view?.members ?? [];
  const allReady = members.length > 0 && members.every((m) => m.ready);
  /** Your own readiness in a DRAFT room, as the ROOM says it. Not a latch. */
  const iAmReady = view?.you.ready === true;
  /**
   * Whether the table's settings are yours.
   *
   * Two sources, and they are the same fact computed by the same server from the
   * same record: the room record's caller-scoped `you.leader` and the table
   * view's. Either arriving is enough — a draft room has no table, and a room
   * record that could not be read must not take the control off the leader of a
   * table that answered — and neither can be true for anybody else, because no
   * client computes it.
   */
  const iAmLeader = view?.you.leader === true || table?.you.leader === true;
  /** The member the room names as its leader, when the room said who is in it. */
  const leaderMember = members.find((m) => m.id === view?.leader) ?? null;
  /**
   * The pool the TABLE is on. The room's, or the newest one until the room has
   * said — never `formats[0]`, which is the oldest frozen pool and is where
   * every room used to open (operator, 2026-09-27: newest).
   */
  const poolId = view?.format !== undefined && view.format !== '' ? view.format : newestFormat(loaded?.formats ?? []);
  /**
   * The pod this table drafts from, or null for a frozen era (wave 26 §F).
   *
   * Everything a drafted pool changes on this screen hangs off this one value:
   * the deck dropdown offers your own drafted cards instead of the library, the
   * per-deck legality sweep does not run (the library is not in a cube pool and
   * asking would be 26 refusals), and the pod's socket is opened below.
   */
  const pod = draftPoolPod(poolId);
  /** The pool's own catalogue row: its name, and for an era its set list. */
  const poolFormat = loaded?.formats.find((f) => f.id === poolId) ?? null;
  /** Which tab the table is actually on — a pod's own tab, or its era's family. */
  const tabOfPool = pod !== null ? 'draft' : poolFormat?.family ?? 'standard';
  /**
   * The LEADER's format tab (operator, 2026-10-05: *"i'll need a tab selector
   * at the top for picking the format as well obviously"*).
   *
   * Opens on the table's own era's family and FOLLOWS it there — the effect
   * below re-syncs whenever `poolId` actually changes, which is every write
   * that moved the room's pool, mine or another browser's. Switching tabs by
   * hand only BROWSES which eras the `<select>` below offers; nothing is sent
   * until an option in it is chosen, same as the control always worked.
   */
  const [formatTab, setFormatTab] = useState<FormatFamily | 'draft'>(tabOfPool);
  const syncedPoolId = useRef(poolId);
  useEffect(() => {
    if (syncedPoolId.current === poolId) return;
    syncedPoolId.current = poolId;
    setFormatTab(tabOfPool);
    // Deliberately keyed on `poolId` alone: `tabOfPool` is read fresh each run
    // (it is a plain `const` derived every render, not a ref), and re-running
    // this effect on every render it changed WITHOUT `poolId` moving would
    // fight a hand click on a tab button before any era is chosen.
  }, [poolId]);
  /**
   * Whether the room's actual pool is one of THIS tab's own options.
   *
   * False while browsing a tab the room is not on (its own era is a different
   * family). The `<select>` below reads this to decide whether to show
   * `poolId` as chosen or nothing at all — see the comment on the select
   * itself for why "nothing at all" is the one safe answer.
   */
  const poolOnTab = poolIsOnTab(loaded?.formats ?? [], formatTab, poolId, pod);

  // The formats and the decks — for a constructed table only. A draft room has
  // no deck to hold, and `routes.ts` refuses every table write it could make.
  //
  // NOT gated on the room record having answered. The catalogue read starts at
  // mount, as it always has, because holding it back until `rooms.get` answers
  // would put the deck picker a round trip later for EVERY constructed room to
  // save a draft room two cached GETs. What the guard does instead is discard
  // the answer: `draftRoom` flipping true re-runs this, the previous run's
  // cleanup clears `live`, and `loaded` stays null — so no picker is assembled
  // and the per-deck legality sweep (`picking`, below) never runs at all.
  useEffect(() => {
    if (draftRoom) return;
    let live = true;
    Promise.all([client.formats(), client.decks()])
      .then(([formats, decks]) => {
        if (!live) return;
        setLoaded({ formats, decks });
        // No pool is chosen here either: the room's is the pool, and until the
        // room answers `poolId` falls back to the newest of these. Nothing on
        // this screen ever picks one for the table.
        //
        // No deck is chosen for you. Choosing one is what loads it, and the
        // Ready button is dead until you have, so a default here would both
        // load a deck nobody picked and make Ready live on arrival.
      })
      .catch((err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [client, draftRoom]);

  // The room's table, polled. One read now, then one every `pollMs`.
  //
  // ## Entering a room joins it
  //
  // Reaching a room by any route other than the list's Join button — an invite
  // link, a refresh, a bookmark, a second browser — used to leave you a
  // non-member. The server answers a non-member exactly as it answers a
  // missing room (`routes.ts` `tableFor`, deliberately: a different answer
  // would tell an outsider which rooms exist), so the screen said "this room
  // is not there" about a room that was, and polled that 404 forever.
  //
  // Observed live 2026-09-19 on `r-8eb2a7cd614c`: the leader read it fine, the
  // second person got 404 on every poll, and the room file on disk held
  // exactly one member. So a read that is refused tries to JOIN once, then
  // reads again.
  //
  // Only once, and only for a refusal. A locked room refuses the join too, and
  // retrying that on a 1.5 s timer is a rate-limit trip and a password
  // guessing loop nobody asked for.
  //
  // **A draft room runs this too**, and that is the whole reason the poll is not
  // switched off for one: the join-on-refusal here is what makes an invite link
  // a membership, and a draft room's invite link is the only link there is. The
  // table it reads back is empty for a draft room — nobody loads a deck — but
  // `GET /api/tables/rooms/:roomId` is not game-type gated, so the read is a
  // real answer and the join is a real join.
  useEffect(() => {
    let live = true;
    let joined = false;
    let stop = false;
    const read = (): void => {
      if (stop) return;
      void client.table(roomId).then(async (outcome) => {
        if (!live) return;
        if (outcome.ok) {
          setTable(outcome.table);
          setTableError(null);
          return;
        }
        if (joined) {
          // The join went through, so this refusal is something else — a room
          // that has since gone, or a read that raced the write. Keep polling:
          // stopping here would strand a member who is genuinely in the room.
          setTableError(outcome.error);
          return;
        }
        joined = true;
        const join = await rooms.join(roomId, passwordRef.current === '' ? undefined : passwordRef.current);
        if (!live) return;
        if (join.ok) {
          read();
          return;
        }
        stop = true;
        if (join.reason === 'refused') {
          // Locked, or genuinely not there — the server will not say which,
          // and should not. Ask for the password rather than sending someone
          // who followed a valid invite link back to the list, which was the
          // dead end the operator hit on 2026-09-19.
          setLocked(passwordRef.current === '' ? 'need' : 'wrong');
          return;
        }
        if (join.reason === 'rate-limited') {
          setLocked('rate-limited');
          return;
        }
        setTableError(join.message ?? outcome.error);
      });
    };
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, rooms, roomId, pollMs, attempt]);

  // The room record, polled on the same beat as the table. The mode is latched
  // on the first read; the membership keeps moving, because a streamed room's
  // seats appear as people arrive.
  useEffect(() => {
    let live = true;
    const read = (): void => {
      rooms.get(roomId).then(
        (room) => {
          if (!live) return;
          setResolved(true);
          if (room === null) return;
          modeRef.current ??= room.clientMode;
          setView(room);
        },
        () => {
          // The room could not be read. That is the same server the table poll
          // is reading, and `tableError` below already says so in words; adding
          // a second sentence about it would say it twice. What this must not
          // do is stay silent AND keep the body hidden, so the gate opens.
          if (live) setResolved(true);
        },
      );
    };
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [rooms, roomId, pollMs]);

  /*
   * The pod's socket, for a room on a DRAFTED pool — and it is not only how the
   * screen learns your cards.
   *
   * **Being connected is what makes your pool findable at all.** The gate resolves
   * a drafted pool through the seat you HOLD (`viewForParticipant`, over `seatOf`),
   * and a drafter who walks away from `#/deck/<podId>` or the pod screen has their
   * seat vacated after the disconnect grace — so the server would answer "you have
   * no seat in draft …" about cards you really did draft. Joining a pod you already
   * sit in reclaims your remembered seat and answers with your own pool
   * (`apps/server/src/room/socket.ts`, the `join` case), which is the same thing
   * `DeckScreen` relies on and says so in its header.
   *
   * One socket, only while it is needed: no pod, a draft room (its own screen owns
   * the pod), or a streamed room, and nothing is opened.
   */
  const [draft, setDraft] = useState<SocketDraft | null>(null);
  const [, draftTicked] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // `modeRef` rather than the `streamed` binding below: this effect sits above
    // it, and the ref is the latched answer either way.
    if (pod === null || draftRoom || modeRef.current === 'streamed') {
      setDraft(null);
      return;
    }
    const live = startDraft({ draftId: pod, transport: makeTransport?.(), onChange: () => draftTicked() });
    setDraft(live);
    return () => {
      closeDraft(live);
      setDraft(null);
    };
  }, [pod, draftRoom, resolved, makeTransport]);

  /**
   * Whether the pod has answered AT ALL — which is a different question from
   * whether it gave you a seat, and the two are different sentences to a person.
   * `SocketDraft` is mutated in place and re-renders through `draftTicked`, so
   * this is read every render rather than keyed on the object's identity.
   */
  const podAnswered = draft !== null && draft.view !== null;
  /** The cards YOU drafted, as the pod answered them. Null until it has. */
  const myPool = draft?.view?.viewer.kind === 'seat' ? draft.view.viewer.pool : null;
  /** Your drafted pool as a deck Forge can play. Rebuilt only when the pool changes. */
  const draftedDeck = useMemo(
    () => (pod === null || myPool === null || myPool.length === 0 ? null : draftedDeckOf(pod, myPool)),
    [pod, myPool],
  );

  const players = table?.players ?? [];
  const mine = players.find((p) => p.you) ?? null;
  const matchId = table?.room.matchId ?? null;
  const full = players.length >= (table?.room.seats ?? 2);
  const spectating = table !== null && !table.you.player && full;
  const bothReady = players.length === 2 && players.every((p) => p.ready && p.legal);
  const streamed = modeRef.current === 'streamed';
  /** Whether the deck card is on the screen at all: nothing below asks for it otherwise. */
  const picking =
    !streamed && !draftRoom && resolved && locked === null && table !== null && !spectating && loaded !== null;

  // Which decks the ROOM's pool offers. One sweep per pool, remembered — see
  // `legalDecksIn`. Gated on the card being drawn, so a streamed room, a
  // locked room and a spectator ask nothing. The leader moving the pool re-runs
  // it, which is what narrows the dropdown for everybody in the room.
  useEffect(() => {
    // A drafted pool asks nothing: the library is 60-card Standard and a cube pool
    // holds none of it, so the sweep would be one refusal per deck and would narrow
    // the list to nothing anyway. `deckOptions` offers your own drafted cards there.
    if (!picking || loaded === null || poolId === '' || pod !== null) return;
    const cached = sweeps.current.get(poolId);
    if (cached !== undefined) {
      setLegal(cached);
      return;
    }
    let live = true;
    void legalDecksIn(client, poolId, loaded.decks).then((sweep) => {
      // A sweep the server refused is NOT remembered: it offers every deck,
      // and caching that would leave the pool un-narrowed for as long as the
      // page is open over one dropped request. Coming back to it retries.
      if (sweep.error === null) sweeps.current.set(sweep.formatId, sweep);
      if (!live) return;
      setLegal(sweep);
      if (sweep.error !== null) setActionError(sweep.error);
    });
    return () => {
      live = false;
    };
  }, [picking, loaded, poolId, pod, client]);

  /** The decks on offer, or null while the pool's answer is still in flight. */
  const offered = useMemo(
    () =>
      legal !== null && legal.formatId === poolId && loaded !== null
        ? loaded.decks.filter((d) => legal.ids.has(d.id))
        : null,
    [legal, poolId, loaded],
  );

  /**
   * What the deck dropdown offers, or null while the answer is in flight.
   *
   * One list for two kinds of pool, because the control is one control: an era
   * offers the library decks legal in it, a pod offers the cards you drafted, and
   * both are {@link DeckOption} rows the same `<select>` renders. Null keeps the
   * select disabled — an option list assembled before the answer would offer
   * decks the pool does not have — and for a pod the answer is the pod's, which
   * arrives over the socket rather than over HTTP.
   *
   * ## The colours, and the ONE fold they come from
   *
   * Operator, wave 26: *"decks should have their corresponding mana symbols."*
   * Wave 26 §D drew them in `DeckView` and `DeckBuilder` and exported the fold
   * so a third screen could not invent a second one — which is what this is.
   * Both arms call into `DeckView.tsx`:
   *
   *   - a LIBRARY deck is a list of names (`TableDeck.main`), so it folds
   *     through `deckColorsByName` against `LIBRARY_CARD_COSTS` — the cost of
   *     every card the library plays, sliced out of the same
   *     `decks/pools/*.generated.json` the fixtures are and shipped as 10 KB of
   *     data because a browser has no filesystem and `GET /api/tables/decks`
   *     sends names without costs.
   *   - a DRAFTED pool is a `Deck` of real cards, so it folds through
   *     `mainDeckColors`, which is the same fold plus the basics.
   *
   * The MAINDECK only, both times, and `DeckView`'s head does the same: a
   * sideboard is not what you are playing. Get this wrong and two screens
   * disagree about what colour a deck is, which is the failure wave 26's single
   * export exists to prevent.
   */
  const deckOptions = useMemo<DeckOption[] | null>(() => {
    if (pod !== null) {
      if (!podAnswered) return null;
      if (draftedDeck === null) return [];
      // A drafted card carries its own id and its own mana value, so the art rule
      // needs no lookup table here — the pool IS the table.
      const byName = new Map((myPool ?? []).map((card) => [card.name, card]));
      return [
        {
          value: DRAFTED_DECK,
          label: `Your drafted pool — ${mainDeckSize(draftedDeck)} cards`,
          colors: mainDeckColors(draftedDeck, cardIndex(myPool ?? [])),
          artId: deckArtId(
            draftedDeck.main.flatMap((entry) => {
              const card = byName.get(entry.card.name);
              if (card === undefined || card.manaCost.length === 0) return [];
              return [
                {
                  name: card.name,
                  count: entry.count,
                  manaValue: card.manaValue,
                  scryfallId: card.scryfallId,
                },
              ];
            }),
          ),
        },
      ];
    }
    return offered === null
      ? null
      : offered.map((d) => ({
          value: d.id,
          label: d.name,
          colors: deckColorsByName(
            d.main.map((line) => line.name),
            LIBRARY_CARD_COSTS,
          ),
          // A library deck is a list of NAMES on the wire, so both halves of the
          // art rule are lookups against committed data: the cost from the same
          // slice the colours come from, the id from the play board's own table.
          artId: deckArtId(
            d.main.flatMap((line) => {
              const cost = LIBRARY_CARD_COSTS[line.name];
              if (cost === undefined) return [];
              return [
                {
                  name: line.name,
                  count: line.count,
                  manaValue: manaValueOf(cost),
                  scryfallId: scryfallIdFor(LIBRARY_ART_IDS, line.name, ''),
                },
              ];
            }),
          ),
        }));
  }, [pod, podAnswered, draftedDeck, myPool, offered]);

  /**
   * Every art URL this room has already asked the browser to warm, and the
   * `Image` object doing it — kept for as long as this screen stays mounted,
   * so the warm cannot be garbage-collected mid-load. A ref rather than
   * state: it drives no render, and a map the size of the library is not
   * something to copy on every write the way `setState` would.
   */
  const prefetchedArt = useRef(new Map<string, HTMLImageElement>());

  // The moment an era's (or a pod's) options are known, ask the browser to
  // warm every one of their art URLs at once — the operator: *"some loaded
  // quick, but others loaded extremely slowly… this is a static list we
  // should be able to cache these images."* One request per DISTINCT URL,
  // not per option (`deckOptions.map` can repeat an id — two decks named
  // after the same card — and `prefetchedArt` also catches a URL this room
  // already warmed under an earlier era), so the picker's own `<img>`s below
  // coalesce onto the warm rather than firing a second fetch. A failed warm
  // is silent and changes nothing: `DeckArt`'s `onError` still draws the
  // placeholder band the same as a cold 404 would.
  useEffect(() => {
    if (deckOptions === null) return;
    const urls = deckOptions.flatMap((o) => {
      if (o.artId === undefined) return [];
      const url = cardImageUrl(o.artId);
      return url === null ? [] : [url];
    });
    prefetchCardImages(urls, prefetchedArt.current);
  }, [deckOptions]);

  // A deck the new pool does not offer is no longer chosen. The `PUT` under the
  // new rules has already gone (the re-send below), so its verdict is on the
  // screen saying which card is the problem; what this does is stop Ready
  // coming back to life over a deck the list no longer contains.
  useEffect(() => {
    if (deckOptions === null || deckId === '') return;
    if (!deckOptions.some((o) => o.value === deckId)) setDeckId('');
  }, [deckOptions, deckId]);

  // The match the server started — for whoever pressed nothing, too.
  useEffect(() => {
    if (matchId !== null) navigate({ kind: 'match', matchId });
  }, [matchId]);

  const startVsBot = (): void => {
    setStartRefusal(null);
    setStarting(true);
    client
      .startVsBot(roomId)
      .then((outcome) => {
        if (outcome.ok) {
          navigate({ kind: 'match', matchId: outcome.matchId });
          return;
        }
        setStartRefusal(outcome.error);
        setStarting(false);
      })
      .catch((err: unknown) => {
        setStartRefusal(err instanceof Error ? err.message : String(err));
        setStarting(false);
      });
  };

  // Both ready: either browser may ask, and the server answers one match to both.
  // A draft room never reaches this — it seats nobody at the table — and says so
  // explicitly, because `startRoom` is one of the calls `routes.ts` 409s for it.
  useEffect(() => {
    if (draftRoom || !bothReady || matchId !== null || mine === null || asked.current) return;
    asked.current = true;
    setStarting(true);
    client
      .startRoom(roomId)
      .then((outcome) => {
        if (outcome.ok) {
          navigate({ kind: 'match', matchId: outcome.matchId });
          return;
        }
        setStartRefusal(outcome.error);
        setStarting(false);
      })
      .catch((err: unknown) => {
        setStartRefusal(err instanceof Error ? err.message : String(err));
        setStarting(false);
      });
  }, [draftRoom, bothReady, matchId, mine, client, roomId]);

  /*
   * Every member ready: deal the draft.
   *
   * Either browser may ask and the server deals once — `startDraft` is
   * idempotent, so a room whose draft has already started answers with its view
   * rather than an error. The ref is what stops the 1.5 s poll asking again
   * while one ask is in flight or has been refused; losing unanimity clears it,
   * so the next time everyone is ready the draft is asked for again rather than
   * the room sitting on a stale refusal for ever.
   */
  useEffect(() => {
    if (!draftRoom || draftStartedAt !== null || locked !== null) return;
    if (!allReady) {
      askedDeal.current = false;
      return;
    }
    if (askedDeal.current) return;
    askedDeal.current = true;
    setDealing(true);
    rooms
      .start(roomId)
      .then((outcome) => {
        if (outcome.ok) {
          setView(outcome.room);
          setDraftError(null);
        } else {
          setDraftError(outcome.message);
        }
        setDealing(false);
      })
      .catch((err: unknown) => {
        setDraftError(err instanceof Error ? err.message : String(err));
        setDealing(false);
      });
  }, [draftRoom, draftStartedAt, locked, allReady, dealAttempt, rooms, roomId]);

  // Your own choice, as the server holds it: the picker opens where you left it.
  // The deck only — the pool is the room's, and reading it back off a stored
  // choice would be this screen holding a second opinion about the table.
  useEffect(() => {
    if (restored.current || mine === null || mine.choice === null) return;
    const { deck } = mine.choice;
    restored.current = true;
    // A `{ dck }` hold at a room table is a drafted deck — the only thing on this
    // screen that sends one — so the picker opens on that option rather than blank.
    if ('library' in deck) setDeckId(deck.library);
    else setDeckId(DRAFTED_DECK);
  }, [mine]);

  const apply = (outcome: Awaited<ReturnType<TablesClient['table']>>): void => {
    if (outcome.ok) {
      setTable(outcome.table);
      setActionError(null);
      return;
    }
    setActionError(outcome.error);
  };

  /**
   * Hold a deck. There is no button: choosing is loading.
   *
   * No format goes with it. The room's pool is the rules for both seats, and the
   * server refuses a body that names one — so there is no way for this call to
   * check a deck against anything but what the table is on.
   */
  const loadDeckRef = (deck: DeckRef): void => {
    setBusy(true);
    setActionError(null);
    client
      .loadDeck(roomId, deck)
      .then(apply)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /**
   * The chosen option as a deck reference.
   *
   * `DRAFTED_DECK` is the only value that is not a library id, and it becomes the
   * `.dck` text of your own drafted pool — the same writer `#/deck/<podId>` uses
   * (`dckTextOf`), so the server checks and Forge plays the same bytes either
   * route. Null when the choice cannot be turned into a deck yet, which is a
   * drafted option before the pod has answered.
   */
  const deckRefOf = (value: string): DeckRef | null => {
    if (value !== DRAFTED_DECK) return { library: value };
    return draftedDeck === null ? null : { dck: dckTextOf(draftedDeck) };
  };

  /**
   * The deck dropdown moved. `Random` is one of the decks ON OFFER — the room's
   * pool has already narrowed them, so it cannot roll an illegal deck — and it
   * resolves to that deck's id rather than staying a mystery: what you got is
   * what the dropdown then reads.
   */
  const chooseDeck = (value: string): void => {
    const chosen = value === RANDOM_DECK ? pickRandom(deckOptions ?? [], rand)?.value : value;
    if (chosen === undefined || chosen === '') return;
    const ref = deckRefOf(chosen);
    if (ref === null) return;
    setDeckId(chosen);
    loadDeckRef(ref);
  };

  /**
   * The LEADER moved the table's pool.
   *
   * A write to the room, not to this screen's state: the room is the authority
   * on its own pool, so the answer replaces the room record and every other
   * browser picks the change up on its poll. A refusal — a non-leader, a room
   * that is drafting — is shown in the server's own words, and nothing local
   * has moved, so the screen still reads what the table is actually on.
   */
  const choosePool = (value: string): void => {
    if (value === poolId) return;
    setBusy(true);
    setActionError(null);
    rooms
      .setFormat(roomId, value)
      .then((outcome) => {
        if (!outcome.ok) {
          setActionError(outcome.message);
          return;
        }
        setView(outcome.room);
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /*
   * The pool moved under a deck we are holding, so the hold is re-sent.
   *
   * On EVERY browser, not only the leader's: the server clears both players'
   * readiness and stored verdict when the pool changes, because what they
   * readied with is not what the table is now. Re-sending is what puts a verdict
   * back on the screen — the one that names the offending card when the deck
   * does not survive the move — and the sweep above is what takes the deck off
   * the list when it does not.
   *
   * `seenPool` distinguishes a CHANGE from the first sighting. Arriving in a
   * room must not re-send: a `PUT …/deck` stands you down, so a reload would
   * silently un-ready a player who was ready.
   */
  useEffect(() => {
    if (!picking || poolId === '') return;
    const before = seenPool.current;
    seenPool.current = poolId;
    if (before === null || before === poolId) return;
    // `loadDeckRef` closes over `client` and `roomId`, which are this screen's own
    // props and do not change under it, so it is not a dependency.
    if (deckId === '') return;
    const ref = deckRefOf(deckId);
    if (ref !== null) loadDeckRef(ref);
  }, [picking, poolId, deckId, draftedDeck]);

  const setReady = (ready: boolean): void => {
    setBusy(true);
    setActionError(null);
    client
      .ready(roomId, ready)
      .then(apply)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /**
   * Readiness in a DRAFT room, which is the room's own and not the table's.
   *
   * `POST /api/rooms/:id/ready`, not `POST /api/tables/rooms/:id/ready` — the
   * second answers 409 for anything that is not a constructed room, and it is
   * about a deck this room has nobody holding.
   *
   * The answer is the whole room, including its caller-scoped `you`, so the
   * toggle's own label comes off the room rather than off a latch. Nothing here
   * remembers what it asked for.
   */
  const setDraftReady = (ready: boolean): void => {
    setBusy(true);
    setDraftError(null);
    rooms
      .ready(roomId, ready)
      .then((outcome) => {
        if (!outcome.ok) {
          setDraftError(outcome.message);
          return;
        }
        setView(outcome.room);
      })
      .catch((err: unknown) => setDraftError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /*
   * The pod: the draft room's second phase, and the whole screen while it lasts.
   *
   * Not nested inside the room chrome below. The pod has a status bar of its own
   * carrying the room's id, the cube, the seats and the invite link, so putting
   * it inside `.lobby` — a grid of 300px cards — would squeeze the table it
   * draws and say the room's name twice. A locked room is asked for its password
   * first: the form for that is in the body below.
   */
  if (!streamed && draftRoom && draftStartedAt !== null && locked === null) {
    return <PodScreen draftId={roomId} makeTransport={makeTransport} />;
  }

  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title" data-testid="room-name">
          {streamed ? (view?.name ?? roomId) : (table?.room.name ?? roomId)}
        </h1>
        {/* The header states what this room is, so nobody who followed a link
            has to work it out from what is drawn below. A builtin constructed
            room says exactly what it has always said — that sentence already
            names our table. */}
        <p className="shell__sub" data-testid="room-client-mode">
          {streamed
            ? 'Forge’s full client'
            : draftRoom
              ? 'Draft'
              : 'Constructed 1v1'}
        </p>
      </header>

      <main className="lobby">
        {streamed && <StreamedSeats roomId={roomId} members={view?.members ?? []} streamFetch={streamFetch} />}
        {/* Everything below is the builtin room, unchanged. It waits for the
            room record as well as the table so a streamed room never flashes
            a deck picker on its way in; both reads are in flight together, so
            this is not a second round trip. */}
        {!streamed && resolved && (
          <>
        {locked !== null && (
          <form
            className="lobby__locked"
            data-testid="room-locked"
            onSubmit={(e) => {
              e.preventDefault();
              passwordRef.current = password;
              setLocked(null);
              setTableError(null);
              setAttempt((n) => n + 1);
            }}
          >
            <p role="alert">
              {locked === 'need'
                ? 'This room needs a password.'
                : locked === 'wrong'
                  ? 'Wrong password.'
                  : 'Too many attempts.'}
            </p>
            <label htmlFor="room-password">Password</label>
            <input
              id="room-password"
              data-testid="room-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="submit" data-testid="room-password-submit" disabled={locked === 'rate-limited'}>
              Join
            </button>
          </form>
        )}
        {locked === null && tableError !== null && table === null && (
          <p className="lobby__error" role="alert" data-testid="room-missing">
            {tableError}
          </p>
        )}
        {/* The draft room's first phase. Nothing below this is drawn for it:
            there is no deck to hold, no seat at a constructed table, and every
            table write it could make is a 409. */}
        {locked === null && draftRoom && (
          <DraftLobby
            members={members}
            leaderId={view?.leader ?? ''}
            iAmReady={iAmReady}
            allReady={allReady}
            dealing={dealing}
            busy={busy}
            error={draftError}
            onReady={setDraftReady}
            onRetry={() => {
              askedDeal.current = false;
              setDraftError(null);
              setDealAttempt((n) => n + 1);
            }}
          />
        )}

        {!draftRoom && loadError !== null && (
          <p className="lobby__error" role="alert" data-testid="tables-load-error">
            Could not load the formats and decks: {loadError}
          </p>
        )}

        {!draftRoom && table !== null && (
          <>
            <section className="lobby__card">
              <h2>At the table</h2>
              <ul className="tables__players" data-testid="room-players">
                {[0, 1].map((seat) => {
                  const player = players[seat];
                  return player === undefined ? (
                    <li key={seat} className="tables__row tables__row--empty" data-testid={`room-seat-${seat}-empty`}>
                      Waiting for someone to load a deck.
                    </li>
                  ) : (
                    <PlayerRow key={seat} seat={seat} player={player} />
                  );
                })}
              </ul>
              <p className="lobby__note" data-testid="start-state">
                {startStateText(players, bothReady, starting, matchId)}
              </p>
              {startRefusal !== null && (
                <div className="lobby__error" role="alert" data-testid="start-refused">
                  <p>{startRefusal}</p>
                  <button
                    type="button"
                    data-testid="start-retry"
                    onClick={() => {
                      asked.current = false;
                      setStartRefusal(null);
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
            </section>

            {spectating ? (
              <section className="lobby__card">
                <p className="lobby__note" data-testid="room-spectator">
                  Table full &mdash; watching.
                </p>
              </section>
            ) : (
              loaded !== null && (
                <section className="lobby__card">
                  <h2>Your deck</h2>
                  {/* The table's pool: "Format" — one pool, both seats, checked
                      against the same list, across Standard, Modern and Legacy
                      alike (wave 48 §U). The LEADER gets a control; everybody else reads
                      the same text and cannot move it, which is the whole of
                      *"people who join can only select from the deck
                      dropdown"*. The leader is named beside it rather than
                      explained: a mark and a name, not a sentence. */}
                  {iAmLeader ? (
                    <>
                      <label className="lobby__field" htmlFor="format">
                        {poolFieldLabel(pod)}
                      </label>
                      {/* The format tab selector (wave 48 §U), replacing the single
                          "Matched Standard" optgroup: Standard, Modern, Legacy, plus
                          a "Drafted pool" tab when the room has one (the CALLER's own
                          seats — the server scopes that list, so a leader is never
                          offered a pod they did not draft in). The active tab opens
                          on the table's own era and only browses which eras the
                          select below offers; nothing moves the room until an option
                          in it is chosen. No prose: the tabs are the explanation. */}
                      <div className="lobby__format-tabs" role="tablist" data-testid="format-tabs">
                        {FORMAT_TABS.map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={formatTab === tab.id}
                            data-testid={`format-tab-${tab.id}`}
                            disabled={busy || matchId !== null}
                            onClick={() => {
                              setFormatTab(tab.id);
                              // A tab whose eras do not include the room's pool chooses its first era
                              // (newest, the list's order) at once, rather than showing nothing chosen
                              // until the leader picks (the operator, 2026-10-07: "selecting modern
                              // should default the year selection to the first available").
                              if (loaded !== null && !poolIsOnTab(loaded.formats, tab.id, poolId, pod)) {
                                const first = erasOf(loaded.formats, tab.id)[0];
                                if (first !== undefined) choosePool(first.id);
                              }
                            }}
                          >
                            {tab.label}
                          </button>
                        ))}
                        {loaded.formats.some((f) => f.source === 'draft') && (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={formatTab === 'draft'}
                            data-testid="format-tab-draft"
                            disabled={busy || matchId !== null}
                            onClick={() => setFormatTab('draft')}
                          >
                            Drafted pool
                          </button>
                        )}
                      </div>
                      {/* The era the room is ACTUALLY on is not always one this
                          tab offers (you are browsing Modern while the room
                          sits on a Standard era), and a native `<select>`
                          whose `value` matches none of its `<option>`s falls
                          back to showing the FIRST one as already selected —
                          which then fires no `change` event if that is the
                          very one you click, so the room could never be moved
                          to it (found live, w48 §U: `selectOption` on that
                          first option sent no PATCH). A disabled, hidden,
                          EMPTY placeholder option — never any text — keeps
                          the select correctly showing nothing chosen on this
                          tab, so every real era here is a genuine change. */}
                      <select
                        id="format"
                        data-testid="format"
                        value={poolOnTab ? poolId : ''}
                        disabled={busy || matchId !== null}
                        onChange={(e) => choosePool(e.target.value)}
                      >
                        {!poolOnTab && <option value="" disabled hidden />}
                        {formatTab === 'draft'
                          ? loaded.formats
                              .filter((f) => f.source === 'draft')
                              .map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.name} — {f.cardCount} cards
                                </option>
                              ))
                          : erasOf(loaded.formats, formatTab).map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.id} — {f.name}
                              </option>
                            ))}
                      </select>
                    </>
                  ) : (
                    <>
                      <span className="lobby__field">{poolFieldLabel(pod)}</span>
                      <span className="lobby__pool" data-testid="format-fixed" data-format={poolId}>
                        {poolLabel(loaded.formats, poolId)}
                      </span>
                    </>
                  )}
                  <LeaderMark name={leaderMember?.name ?? null} you={iAmLeader} />
                  {/* The sets the chosen era is made of, as symbols — the operator's
                      own ask, for a Standard era. A drafted pool has none and draws none; an
                      eternal format's forty-odd sets drew a strip the operator called
                      ridiculous (2026-10-07), so those draw none either. */}
                  {poolFormat?.family === 'standard' && <PoolSets format={poolFormat} />}

                  {/* The two actions sit ABOVE the list, not after it. Operator,
                      2026-09-30: *"the random button should be at the top, the
                      ready button should also be at the top"* — the list is a grid
                      of decks, and a Ready you have to scroll past every one of
                      them to reach is a Ready nobody finds. Random is a button and
                      not one of the radios because it is not a state a deck can be
                      in: it resolves to one of the decks on offer, and the chooser
                      then reads that deck (`chooseDeck`). */}
                  <div className="deckpick__bar" data-testid="deck-actions">
                    <button
                      type="button"
                      className="lobby__go"
                      data-testid="ready-toggle"
                      aria-pressed={mine?.ready === true}
                      disabled={busy || deckId === '' || mine === null || !mine.legal || matchId !== null}
                      onClick={() => setReady(!(mine?.ready === true))}
                    >
                      {mine?.ready === true ? 'Stand down' : 'Ready'}
                    </button>
                    <button
                      type="button"
                      className="deckpick__random"
                      data-testid="deck-random"
                      data-deck-id={RANDOM_DECK}
                      disabled={deckOptions === null || matchId !== null}
                      onClick={() => chooseDeck(RANDOM_DECK)}
                    >
                      Random
                    </button>
                    {/*
                     * Alone in the room: play Forge's AI instead of waiting for
                     * someone (the operator, 2026-10-02). The bot plays a random
                     * library deck legal in this room's pool; the server picks it.
                     */}
                    {(view?.members.length ?? 0) === 1 && (
                      <button
                        type="button"
                        className="deckpick__random"
                        data-testid="play-vs-bot"
                        disabled={busy || starting || mine === null || !mine.legal || matchId !== null}
                        onClick={startVsBot}
                      >
                        Play vs Forge AI
                      </button>
                    )}
                  </div>
                  {actionError !== null && (
                    <p className="lobby__error" role="alert" data-testid="table-error">
                      {actionError}
                    </p>
                  )}
                  {mine?.verdict != null && <VerdictView verdict={mine.verdict} testId="verdict-mine" />}

                  {/* Only the decks the room's pool offers, and the pool's
                      answer is the gate's. Disabled until it has answered: an
                      option list assembled before the answer would offer decks
                      the pool does not have. */}
                  <span className="lobby__field" id="deck-mine-label">
                    You play
                  </span>
                  <DeckChooser
                    options={deckOptions ?? []}
                    value={deckId}
                    disabled={deckOptions === null || matchId !== null}
                    onChoose={chooseDeck}
                  />
                  {/* Why the dropdown has nothing in it, when it has nothing in it.
                      A pool is hidden information until the draft is over, so the
                      server tells you about your own seat and nobody else's — and
                      "you drafted in another pod" and "you are not in this one" are
                      two different things to a person. */}
                  {pod !== null && deckOptions !== null && deckOptions.length === 0 && (
                    <p className="lobby__note" data-testid="drafted-none">
                      You have no seat in pod <strong>{pod}</strong>, so there are no drafted cards to play. Whoever
                      leads this room chose that pod as its pool.
                    </p>
                  )}
                  {pod !== null && !podAnswered && (
                    <p className="lobby__note" data-testid="drafted-waiting">
                      Asking pod <strong>{pod}</strong> for the cards you drafted.
                    </p>
                  )}

                </section>
              )
            )}
          </>
        )}
          </>
        )}
      </main>

      <footer className="shell__foot">
        <p>
          <a
            className="shell__link"
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'lobby' });
            }}
          >
            Back to the rooms
          </a>
        </p>
      </footer>
    </div>
  );
}

/* ── a draft room, before the cards exist ─────────────────────────────── */

/**
 * The draft room's lobby: who is here, who is ready, and the two rules a person
 * would otherwise have to guess.
 *
 * Both rules are written on the screen on purpose. *"Every member ready, then
 * bots take the rest of the eight seats"* is the operator's own design and the
 * difference between this and the pod button it replaced, which auto-started
 * against seven bots. *"A draft does not survive a restart"* is true of the
 * server as built — the deal is in memory and `draftStartedAt` is never restored
 * — and a room that silently came back to an empty table would look like a bug
 * rather than the honest answer.
 *
 * The toggle carries `ready-toggle`, the same id the constructed table's does:
 * one room plays one game, so exactly one of the two is ever on the screen.
 *
 * The leader is marked on their own row — `leaderId` is `RoomView.leader`, and a
 * member's id is the one thing that identifies them, since the display name is
 * not unique. A mark, not a sentence (operator: *"i dont need prose in my ui"*).
 *
 * Nothing here draws a mana symbol, a set symbol, a tap symbol or a card frame.
 */
function DraftLobby({
  members,
  leaderId,
  iAmReady,
  allReady,
  dealing,
  busy,
  error,
  onReady,
  onRetry,
}: {
  members: RoomMember[];
  leaderId: string;
  iAmReady: boolean;
  allReady: boolean;
  dealing: boolean;
  busy: boolean;
  error: string | null;
  onReady: (ready: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <section className="lobby__card" data-testid="draft-lobby">
      <h2>In the room</h2>
      <ul className="draft__members" data-testid="draft-members">
        {members.length === 0 ? (
          <li className="draft__member draft__member--empty" data-testid="draft-nobody">
            Nobody has joined yet.
          </li>
        ) : (
          members.map((member, i) => (
            <li key={member.id} className="draft__member" data-testid={`draft-member-${i}`}>
              <strong className="tables__who">{member.name}</strong>
              {member.id === leaderId && leaderId !== '' && (
                <StatusPill
                  kind="leader"
                  testId={`draft-member-${i}-leader`}
                  state="leader"
                  mark="crown"
                  label="leader"
                />
              )}
              <StatusPill
                kind="ready"
                testId={`draft-member-${i}-ready`}
                state={member.ready ? 'yes' : 'no'}
                mark={member.ready ? 'tick' : 'ring'}
                label={member.ready ? 'ready' : 'not ready'}
              />
            </li>
          ))
        )}
      </ul>

      <p className="lobby__note" data-testid="draft-state">
        {draftStateText(members, dealing)}
      </p>

      <button
        type="button"
        className="lobby__go"
        data-testid="ready-toggle"
        aria-pressed={iAmReady}
        disabled={busy || dealing || members.length === 0}
        onClick={() => onReady(!iAmReady)}
      >
        {iAmReady ? 'Stand down' : 'Ready'}
      </button>

      {error !== null && (
        <div className="lobby__error" role="alert" data-testid="draft-error">
          <p>{error}</p>
          {/* Only while everyone still is ready: a refusal because somebody
              stood down between polls fixes itself when they ready again, and
              the deal is asked for on its own then. */}
          {allReady && (
            <button type="button" data-testid="draft-retry" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

      <p className="lobby__note" data-testid="draft-rule">
        The draft deals when every member of this room is ready. Bots take whatever is left of the eight
        seats at that moment — never before, so nobody who has not readied is played for.
      </p>
      <p className="lobby__note" data-testid="draft-restart-note">
        A draft does not survive a restart of the server. The room comes back to this lobby, with its ready
        marks, rather than to an empty table.
      </p>
    </section>
  );
}

/** Who the draft is waiting on, in one line. Names, because none of them is "you". */
function draftStateText(members: RoomMember[], dealing: boolean): string {
  if (dealing) return 'Dealing the draft…';
  if (members.length === 0) return 'Waiting for someone to join.';
  const waiting = members.filter((m) => !m.ready).map((m) => m.name);
  if (waiting.length === 0) return 'Everyone is ready.';
  return `Waiting for ${listOf(waiting)}.`;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/* ── the streamed room's face ─────────────────────────────────────────── */

/**
 * A streamed room's body: one seat per member, each seat one stream.
 *
 * One container per seat is the settled shape (operator, at w18's dispatch), so
 * this is a grid of member-sized screens rather than one shared view. The seat
 * number is the member's place in the room's own member list — the same order
 * the server hands out and the same number its stream route is keyed by.
 *
 * Nothing here draws a mana symbol, a set symbol, a tap symbol or a card frame:
 * it is text, boxes and a frame. The pixels inside the frame are Forge's own.
 */
function StreamedSeats({
  roomId,
  members,
  streamFetch,
}: {
  roomId: string;
  members: RoomMember[];
  streamFetch?: Fetch;
}) {
  return (
    <section className="lobby__card streams" data-testid="room-streams">
      <h2>One screen each</h2>
      {members.length === 0 ? (
        <p className="lobby__note" data-testid="stream-nobody">
          Nobody has joined yet.
        </p>
      ) : (
        <ul className="streams__grid" data-testid="stream-seats">
          {members.map((member, seat) => (
            <StreamSeat key={member.id} roomId={roomId} seat={seat} member={member} streamFetch={streamFetch} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One seat's screen, or the honest reason there is not one.
 *
 * The frame is mounted only once the seat's page has been fetched and proved
 * to be the stream's (`streamReachable`). Anything else — no containers, a
 * container still starting, the route not there — is the stated waiting line.
 * It is never a spinner: a spinner says "nearly", and until a container exists
 * nobody knows that. Once a seat is up it stays up and the probe stops.
 */
function StreamSeat({
  roomId,
  seat,
  member,
  streamFetch,
}: {
  roomId: string;
  seat: number;
  member: RoomMember;
  streamFetch?: Fetch;
}) {
  const url = streamPath(roomId, seat);
  const [up, setUp] = useState(false);

  useEffect(() => {
    if (up) return;
    let live = true;
    const probe = (): void => {
      void streamReachable(url, streamFetch).then((ok) => {
        if (live && ok) setUp(true);
      });
    };
    probe();
    const timer = setInterval(probe, STREAM_PROBE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [url, up, streamFetch]);

  return (
    <li className="streams__seat" data-testid="stream-seat" data-seat={seat}>
      <span className="streams__who" data-testid="stream-seat-who">
        {member.name}
      </span>
      {up ? (
        <iframe
          className="streams__frame"
          data-testid="stream-frame"
          title={`${member.name}’s screen`}
          src={url}
        />
      ) : (
        <p className="streams__waiting" data-testid="stream-waiting">
          No screen yet.
        </p>
      )}
    </li>
  );
}

/** The sentence under the two players: who is being waited on, in one line. */
function startStateText(players: RoomPlayer[], bothReady: boolean, starting: boolean, matchId: string | null): string {
  if (matchId !== null) return 'Match running — joining.';
  if (starting) return 'Starting Forge…';
  if (players.length < 2) return 'Waiting for a second player.';
  if (bothReady) return 'Both ready.';
  const waiting = players.filter((p) => !p.ready).map((p) => (p.you ? 'you' : p.name));
  return `Waiting for ${waiting.join(' and ')}.`;
}

/**
 * A status, drawn: a shape, a colour and a word.
 *
 * Colour alone is not a status — a third of the operator's friends could not
 * read it — so each state has its OWN SHAPE (`data-mark`, drawn in an inline
 * `<svg>` we own) and its own border style as well. `screens.css` colours it;
 * remove every colour from that file and this still reads.
 *
 * `leader` is a third kind (w25) and it is not a yes/no: it is on the one member
 * who has it and absent everywhere else. It gets its own `data-state`, so the
 * two success/warning colourings stay exactly what they were, and its own drawn
 * mark. The crown is our own five-point outline — no WotC mark, here or
 * anywhere in this file.
 */
function StatusPill({
  kind,
  testId,
  state,
  mark,
  label,
  count,
}: {
  kind: 'legal' | 'ready' | 'leader';
  testId: string;
  state: 'yes' | 'no' | 'leader';
  mark: 'tick' | 'cross' | 'ring' | 'crown';
  label: string;
  count?: number;
}) {
  return (
    <span className={`pill pill--${kind}`} data-testid={testId} data-state={state} data-mark={mark}>
      <svg className="pill__mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {mark === 'tick' && <path d="M2.6 6.3 4.9 8.8 9.4 3.3" />}
        {mark === 'cross' && <path d="M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5" />}
        {mark === 'ring' && <circle cx="6" cy="6" r="3.4" />}
        {mark === 'crown' && <path d="M2 9V3.5l2.2 2L6 2.6l1.8 2.9L10 3.5V9Z" />}
      </svg>
      {label}
      {count !== undefined && <span className="pill__count">{count}</span>}
    </span>
  );
}

/**
 * Who sets this table, beside the control that sets it.
 *
 * A mark and a name. The operator's standing rule is *"i dont need prose in my
 * ui"*, so this is not "user-alice is the room leader and can change the pool" —
 * it is the same pill the draft lobby puts on the leader's row, carrying the
 * leader's name because on a constructed table there is no member list to put it
 * on. `(you)` is the same suffix the seat rows use, in one text node with its
 * space, for the same reason.
 *
 * Nothing is drawn when the room has not said who is in it: a mark with no name
 * would be a claim this browser cannot make.
 */
function LeaderMark({ name, you }: { name: string | null; you: boolean }) {
  if (name === null) return null;
  return (
    <StatusPill kind="leader" testId="room-leader" state="leader" mark="crown" label={you ? `${name} (you)` : name} />
  );
}

/**
 * One seat at the table, as a row of cells.
 *
 * The operator, 2026-09-25, of the shape this replaces — a sentence with
 * middots for separators and `ready` as raw text: *"looks very cheap"*. So the
 * separators are gone (the cells are the separation), the two states are
 * `StatusPill`s, and the format is a cell of its own rather than a clause in
 * "legal in Standard (MBS)".
 *
 * The cells are laid out in named areas over two lines (`screens.css`): who
 * and the two states above, the deck and the format below. One line truncated
 * "4c Reveillark Control (Shouhei Yamamoto)" to "4c…" in the column this card
 * actually gets, which is the cheap look again by another route.
 *
 * The name and `(you)` stay in ONE text node, with that space: `e2e/play.spec`
 * matches `e2e-alice (you)`, and cells in a grid put no whitespace between
 * themselves.
 */
function PlayerRow({ seat, player }: { seat: number; player: RoomPlayer }) {
  return (
    <li className="tables__row" data-testid={`room-seat-${seat}`}>
      <strong className="tables__who">{player.you ? `${player.name} (you)` : player.name}</strong>
      <span className="tables__deck" data-testid={`room-seat-${seat}-deck`}>
        {player.deckName}
      </span>
      <span className="tables__rules" data-testid={`room-seat-${seat}-rules`}>
        {player.rulesName}
      </span>
      <StatusPill
        kind="legal"
        testId={`room-seat-${seat}-legal`}
        state={player.legal ? 'yes' : 'no'}
        mark={player.legal ? 'tick' : 'cross'}
        label={player.legal ? 'legal' : 'illegal'}
        {...(player.legal ? {} : { count: player.issueCount })}
      />
      <StatusPill
        kind="ready"
        testId={`room-seat-${seat}-ready`}
        state={player.ready ? 'yes' : 'no'}
        mark={player.ready ? 'tick' : 'ring'}
        label={player.ready ? 'ready' : 'not ready'}
      />
    </li>
  );
}

/** `#/play` with no room: the room list is where a match starts now. */
function NoRoom() {
  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title">Constructed</h1>
      </header>
      <main className="lobby">
        <section className="lobby__card">
          <p data-testid="constructed-pointer">Constructed is played in a room.</p>
          <button
            type="button"
            className="lobby__go"
            data-testid="to-rooms"
            onClick={() => navigate({ kind: 'lobby' })}
          >
            See the rooms
          </button>
        </section>
      </main>
    </div>
  );
}

function VerdictView({ verdict, testId }: { verdict: Verdict; testId: string }) {
  return (
    <div className={verdict.legal ? 'tables__legal' : 'tables__illegal'} data-testid={testId}>
      <p>
        {verdict.legal
          ? `Legal in ${verdict.rulesName}.`
          : `Not legal in ${verdict.rulesName} — ${verdict.issues.length} ${verdict.issues.length === 1 ? 'problem' : 'problems'}:`}
      </p>
      {verdict.issues.length > 0 && (
        <ul className="tables__issues">
          {verdict.issues.map((issue, i) => (
            <li key={i}>
              {issue.cardName !== null && <strong className="tables__card">{issue.cardName}</strong>}
              {issue.cardName !== null && ' — '}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
