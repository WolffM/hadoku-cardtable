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
 * ref so a re-read cannot ask twice.
 *
 * **A draft room does not touch the tables API.** `http/routes.ts` answers 409
 * to `PUT …/deck`, `POST …/ready` and the room start for anything that is not
 * `constructed-1v1`, so none of them is called and the formats, decks and
 * legality sweep are not loaded either. The table READ still runs, because its
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
 * The table — your own deck and verdict, and whether each player is ready —
 * is read from the room again whenever the server says it changed
 * (`../rooms/feed.ts`): no timer reads it.
 * When both are ready either browser asks the server to start; the
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
 * The mode comes from `GET /api/rooms/:id`, read beside the table, and is
 * latched the first time it is read: a later answer cannot turn a room someone
 * is sitting in into the other kind. A read that fails leaves the mode unknown
 * and this renders the builtin table — the same direction `parseRoomView`
 * defaults in, and the same outage the table read is already reporting in
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
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import {
  artIdIndexFromTable,
  backFaceNames,
  scryfallIdFor,
  type ArtIdIndex,
  type ArtIdTableFile,
} from '@hadoku/carddata/art';
import {
  deckColorsByName,
  LIMITED_MIN_MAIN_DECK_SIZE,
  mainDeckSize,
  manaTokensOf,
  moveToMain,
  type Deck,
  type DeckColor,
} from '@hadoku/deck';
import { LIBRARY_CARD_COSTS, LIBRARY_DECK_STYLES, type DeckStyle } from '@hadoku/deck/library';
/**
 * Aliased on import: `./tables.ts` separately exports its own, unrelated
 * `RoomTable` (a seat's whole state at one table), and the two would clash by
 * name if both were imported bare into this file.
 */
import { FREE_PICK, type ConstructedMode, type GauntletOptions as GauntletModeOptions, type GauntletView, type PodView, type RandomOptions, type RoomTable as SharedRoomTable, type TournamentDecks } from '@hadoku/shared';

import { navigate, routeHash } from './route.ts';
import { myDecksClient, type MyDeck, type MyDecksClient } from '../deck/myDecks.ts';
import { followMatchOnce, openNewMatch } from '../play/live/matchStart.ts';
import { PodScreen } from './PodScreen.tsx';
import { TableSideboard } from './TableSideboard.tsx';
import { DraftLobby, podDealable } from './DraftLobby.tsx';
import { ActionButton } from '../components/ActionButton.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { mainDeckColors } from '../components/DeckView.tsx';
import artIdsData from '../draft/art-ids.json' with { type: 'json' };
import deckArtTraits from '../draft/deck-art-traits.json' with { type: 'json' };
import { assignDeckArt, rankDeckArt, traitsOfDraftCard, type DeckArtChoice } from './deckArt.ts';
import { artCredit, useArtist } from '../draft/artists.ts';
import { cardImageUrl, prefetchCardImages } from '../draft/cardImage.ts';
import { cardIndex, withSuggestedBasics } from '../deck/build.ts';
import { dckTextOf, deckFromPool, draftBuild, savedBuild } from '../draft/deckFromPool.ts';
import type { DraftTransport } from '../draft/socket.ts';
import type { DraftCard } from '../draft/types.ts';
import {
  roomsClient,
  streamPath,
  streamReachable,
  type ClientMode,
  type Fetch,
  type GameType,
  type RoomMember,
  type RoomOutcome,
  type RoomView,
  type RoomsClient,
} from '../rooms/api.ts';
import { GameTypeRow } from '../rooms/GameTypeRow.tsx';
import { ClassicOptions, type Browse } from './constructed-mode/ClassicOptions.tsx';
import { GauntletOptions } from './constructed-mode/GauntletOptions.tsx';
import { AllRandomOptions } from './random/AllRandomOptions.tsx';
import { GauntletScreen } from './gauntlet/GauntletScreen.tsx';
import { seatAvatars } from './gauntlet/seats.tsx';
import './pod/PodSeats.css';
import { freshRoomMode, ModeRow } from './constructed-mode/ModeRow.tsx';
import { TournamentOptions } from './constructed-mode/TournamentOptions.tsx';
import { TournamentPodLobby } from './constructed-mode/TournamentPodLobby.tsx';
import { TournamentRounds } from './constructed-mode/TournamentRounds.tsx';
import { sitPod, aiPod, closePod, standPod, startMyTable } from './pod/client.ts';
import { isPodAi } from './pod/wire.ts';
import {
  RANDOM_DECK,
  isEra,
  legalDecksIn,
  newestFormat,
  pickRandom,
  secureRandom,
  tablesClient,
  type DeckRef,
  type LegalSweep,
  type RoomPlayer,
  type SeatDeck,
  type RoomTable,
  type DeckLine,
  type TableDeck,
  type GauntletEraOption,
  type GauntletOutcome,
  type TableFormat,
  type TablesClient,
} from './tables.ts';
import { SettingsGear } from '../settings/Settings.tsx';
import { DeckPeek, namedFace, usePeekHover, type PeekLine, type PeekList } from './DeckPeek.tsx';
import { DeckTile } from './DeckTile.tsx';
import { DeckFilterBar } from './DeckFilterBar.tsx';
import { NO_DECK_FILTER, deckPasses, type DeckFilter } from './deckFilter.ts';
import { byWinRate, type DeckRecords } from '../stats/deckOrder.ts';
import { fetchDeckRecords } from '../stats/StatsPopout.tsx';
import { takeWarmRoom } from '../rooms/warm.ts';
import { CloseRoom } from '../rooms/CloseRoom.tsx';
import { roomFeed, type RoomFeed } from '../rooms/feed.ts';
import { latestReads } from '../rooms/latest.ts';

export interface ConstructedScreenProps {
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
  /** The room whose table this is. `App` threads it from `#/room/<id>`. */
  roomId?: string;
  /** What says the room changed. Tests pass their own; production passes nothing. */
  feed?: RoomFeed;
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
  /** Everyone's record per deck, for the picker's order. Tests pass a stub; production passes nothing and asks the stats service. */
  deckRecords?: () => Promise<DeckRecords>;
  /** Free pick's "My decks" (`deck/myDecks.ts`). Tests pass a stub; production passes nothing. */
  myDecks?: MyDecksClient;
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
export interface DeckOption {
  value: string;
  /** The whole name, which the tile's title and every accessible name carry. */
  label: string;
  /**
   * A library deck's two halves, from its file's own `Archetype` and `Pilot`:
   * the tile draws the deck on its first line and who played it on the second.
   * Absent for any other deck, which draws `label` alone.
   */
  name?: string;
  pilot?: string;
  colors: readonly DeckColor[];
  /** The deck's cards that could stand for it, best first (`deckArt.ts`). */
  art?: readonly DeckArtChoice[];
  /**
   * The Scryfall id of the card whose art represents this deck on the page it is
   * shown on — {@link assignDeckArt} over `art`, so no two tiles repeat a card —
   * or undefined when nothing in the list could be resolved.
   */
  artId?: string | undefined;
  /** The list a hover shows beside the tile (`DeckPeek.tsx`). */
  list?: PeekList;
  /** The selection's play style for a library deck; none for anything else. */
  deckStyle?: DeckStyle;
}

/**
 * A line known by its name: costed from the same committed slice the colours
 * fold, its face's art from the play board's own table (`LIBRARY_ART_IDS`).
 */
function namedPeekLine({ name, count }: DeckLine): PeekLine {
  const printed = LIBRARY_CARD_COSTS[name] ?? '';
  const cost = manaTokensOf(printed);
  const manaValue = manaValueOf(printed);
  const id = scryfallIdFor(LIBRARY_ART_IDS, name, '');
  return { name, count, cost, manaValue, face: namedFace(name, cost, manaValue, id, backFaceNames(LIBRARY_ART_IDS, id)) };
}

/** A library deck's lines: the wire sends names. */
export function libraryPeekList(main: readonly DeckLine[], sideboard: readonly DeckLine[]): PeekList {
  return { main: main.map(namedPeekLine), sideboard: sideboard.map(namedPeekLine) };
}

/**
 * A library deck's art, ranked by the room's rule (`rankDeckArt`). The wire
 * sends a library deck by NAME, so both halves of the rule are lookups against
 * committed data: the cost from the slice the colours come from, the id from
 * the play board's own table (each line's face, `namedPeekLine`).
 */
export function libraryDeckArt(list: PeekList): DeckArtChoice[] {
  return rankDeckArt(
    list.main.flatMap((line) => {
      const cost = LIBRARY_CARD_COSTS[line.name];
      if (cost === undefined) return [];
      return [{ name: line.name, count: line.count, manaValue: manaValueOf(cost), traits: LIBRARY_ART_TRAITS[line.name] ?? 'c', scryfallId: line.face.scryfallId }];
    }),
  );
}

/** What a deck's peek draws. */
export type PeekedDeck = Pick<DeckOption, 'label' | 'name' | 'pilot' | 'colors' | 'deckStyle'> & { list: PeekList };

/** A library deck as its tile and its peek draw it: the wire sends its lines by name. */
export function libraryDeckPeek(d: TableDeck): PeekedDeck {
  return {
    label: d.name,
    name: d.archetype,
    pilot: d.pilot,
    list: libraryPeekList(d.main, d.sideboard),
    deckStyle: LIBRARY_DECK_STYLES[d.id],
    colors: deckColorsByName(
      d.main.map((line) => line.name),
      LIBRARY_CARD_COSTS,
    ),
  };
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

/** Rarity and card type of each library card, for the art rule (`scripts/art/build-deck-art-traits.ts`). */
const LIBRARY_ART_TRAITS: Readonly<Record<string, string>> = deckArtTraits.traits;

/** A "My decks" option's value: the pod it was drafted in, never a library id. */
const MY_DECK = 'mine:';

/* ── a drafted deck ───────────────────────────────────────────────────── */

/** Basics in an auto-built limited deck: the limited convention, one number. */
export const DRAFTED_BASICS = 17;

/**
 * A playable deck out of a drafted pool, with no choices asked: what a finished
 * draft with no saved build (or an unreadable one) is shown as.
 *
 * `#/deck/<podId>` is where a pool is refined into forty cards; this is only the
 * stand-in, and it has to be a deck Forge could actually play — which means
 * lands, because a maindeck of 45 spells and no lands is legal by every rule we
 * check and unplayable at the table.
 *
 * Everything drafted goes in the maindeck (45 ≥ `LIMITED_MIN_MAIN_DECK_SIZE`, and
 * a card you did not draft has no way in — `newDeck` opens with the pool
 * sideboarded and only `moveToMain` moves anything), and `DRAFTED_BASICS` basics
 * are split by the maindeck's own coloured pips, through the editor's Auto
 * (`withSuggestedBasics`) aimed at the maindeck plus seventeen. The basics come
 * from the table rather than the pool, which is what `setBasicLand` is and what
 * the gate's `splitBasicLands` exempts from the pool check.
 */
export function draftedDeckOf(draftId: string, pool: readonly DraftCard[]): Deck {
  let deck = deckFromPool(draftId, pool);
  for (const entry of [...deck.sideboard]) deck = moveToMain(deck, entry.card, entry.count);
  return withSuggestedBasics(deck, cardIndex(pool), mainDeckSize(deck) + DRAFTED_BASICS);
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
 * copying anybody's image metadata — but it is art shown without its frame all
 * the same, so it is credited like one.
 *
 * Decorative, and deliberately: `alt=""` plus `aria-hidden`. The row's accessible
 * name is the DECK's name, and announcing "Primeval Titan" for a deck called
 * Kessig Titan would be telling a screen-reader user about our art rule.
 *
 * A URL that 404s (a CDN key never uploaded) only shows up at fetch time, so
 * `onError` falls back to the same empty band an unresolved id gets.
 *
 * The slice drops the illustrator and copyright line printed at the card's
 * foot, so the band carries them itself (Scryfall's image guidelines for art
 * shown cropped), and shows no art it cannot credit.
 */
export function DeckArt({ artId }: { artId: string | undefined }) {
  const [broken, setBroken] = useState(false);
  const artist = useArtist(artId ?? null);
  const url = artId === undefined ? null : cardImageUrl(artId);
  if (url === null || typeof artist !== 'string' || broken) {
    return <span className="deckpick__art deckpick__art--none" aria-hidden="true" />;
  }
  return (
    <span className="deckpick__art" aria-hidden="true">
      <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
      <span className="deckpick__credit">{artCredit(artist)}</span>
    </span>
  );
}

/**
 * A drafted deck as a chooser tile: its list, its colours and its art, all
 * from the pool it was drafted from — Free pick's "My decks" and the Decks
 * page draw drafted decks with this one fold.
 */
export function draftedDeckOption(value: string, label: string, deck: Deck, pool: readonly DraftCard[]): DeckOption {
  // A drafted card carries its own id and its own mana value, so the art rule
  // needs no lookup table here — the pool IS the table.
  const byName = new Map(pool.map((card) => [card.name, card]));
  // A drafted card is its own face; a basic is not in the pool and is looked up by name.
  const draftedLine = (entry: { card: { name: string }; count: number }): PeekLine => {
    const card = byName.get(entry.card.name);
    return card === undefined
      ? namedPeekLine({ name: entry.card.name, count: entry.count })
      : { name: card.name, count: entry.count, cost: card.manaCost, manaValue: card.manaValue, face: card };
  };
  return {
    value,
    label,
    list: {
      main: [...deck.main, ...deck.basics].map(draftedLine),
      sideboard: deck.sideboard.map(draftedLine),
    },
    colors: mainDeckColors(deck, cardIndex(pool)),
    art: rankDeckArt(
      deck.main.flatMap((entry) => {
        const card = byName.get(entry.card.name);
        if (card === undefined || card.manaCost.length === 0) return [];
        return [
          {
            name: card.name,
            count: entry.count,
            manaValue: card.manaValue,
            traits: traitsOfDraftCard(card.rarity, card.typeLine),
            scryfallId: card.scryfallId,
          },
        ];
      }),
    ),
  };
}

/** A drafter's saved build as the deck builder opens it (`draftBuild`), or the auto-built one (`draftedDeckOf`) when there is none or it cannot be read. */
export function openDraftedDeck(saved: string | null | undefined, draftId: string, pool: readonly DraftCard[]): Deck {
  const build = savedBuild(saved, true);
  return build === null ? draftedDeckOf(draftId, pool) : draftBuild(draftId, pool, build);
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
export function DeckChooser({
  options,
  value,
  disabled,
  onChoose,
  empty,
  pending = false,
  pendingTiles = 8,
  tileAction,
}: {
  options: readonly DeckOption[];
  value: string;
  disabled: boolean;
  onChoose: (value: string) => void;
  /** The pool has not said which decks it offers: tiles' outlines where they will be. */
  pending?: boolean;
  /** How many outlines `pending` draws. */
  pendingTiles?: number;
  /** Drawn in place of the tiles when there are none, if given. */
  empty?: string | undefined;
  /** A control drawn over a tile's corner, beside the tile's button rather than inside it. */
  tileAction?: (option: DeckOption) => ReactNode;
}) {
  /** Where Tab lands. Null until the reader moves it, so it follows the choice. */
  const [focus, setFocus] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  /** The tile whose list is open, by index (`usePeekHover`). */
  const hover = usePeekHover<number>();
  const peek = hover.peek;
  const openPeekSoon = (index: number): void =>
    hover.openSoon(index, () => {
      const tile = refs.current[index];
      if (tile === null || tile === undefined) return null;
      const screen = tile.closest('[data-testid="constructed"]') ?? document.documentElement;
      return { anchor: tile.getBoundingClientRect(), bounds: screen.getBoundingClientRect() };
    });
  const peeked = peek === null ? undefined : options[peek.key];
  /** Where the pointer last was over the grid, so a scroll can find the tile now under it. */
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const onScrolled = (): void => {
    hover.close();
    const at = pointerAt.current;
    if (at === null) return;
    const tile = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>('[data-deck-id]');
    const index = tile === null || tile === undefined ? -1 : refs.current.indexOf(tile as HTMLButtonElement);
    if (index >= 0 && options[index]?.list !== undefined) openPeekSoon(index);
  };
  // The grid is never its own scroller: the room's screen, or the page, scrolls it.
  // A scroll does not bubble, so the listener is on the document in the capture
  // phase, and answers only a scroll of a box the grid is inside.
  const latestOnScrolled = useRef(onScrolled);
  latestOnScrolled.current = onScrolled;
  useEffect(() => {
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && grid.current !== null && event.target.contains(grid.current)) latestOnScrolled.current();
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  /**
   * Which decks are offered, and in what order — content, not the array's own
   * identity. `byWinRate` (`stats/deckOrder.ts`) returns a FRESH array on every
   * records update even when nothing reordered (every deck still unplayed
   * sorts back to its own index), so keying this effect on `options` itself
   * closed an open or opening peek the instant the win-rate fetch resolved,
   * for a list that had not actually changed — `constructed.test.ts`'s "a
   * peeked list the pointer can reach" caught it as a race, timing-dependent
   * on which settled first (the server run that found it: CI job 117402002655
   * on `a4a4a7c3`, red once locally in 50 runs the same shape).
   */
  const optionKey = options.map((o) => o.value).join('\u0000');
  // A filter changes which tiles there are, so an index into the old list means
  // nothing: Tab goes back to following the choice, and an open list closes.
  const closeHover = hover.close;
  useEffect(() => {
    setFocus(null);
    closeHover();
  }, [optionKey, closeHover]);

  const chosen = options.findIndex((o) => o.value === value);
  const stop = focus !== null && focus < options.length ? focus : chosen >= 0 ? chosen : 0;

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
      ref={grid}
      onKeyDown={disabled ? undefined : onKeyDown}
      onPointerMove={(event) => {
        if (event.pointerType !== 'touch') pointerAt.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerLeave={() => {
        pointerAt.current = null;
      }}
    >
      {options.map((option, index) => {
        const tile = (
          <DeckTile
            key={option.value}
            option={option}
            checked={option.value === value}
            role="radio"
            data-testid="deck-option"
            tabIndex={stop === index ? 0 : -1}
            disabled={disabled}
            ref={(el) => {
              refs.current[index] = el;
            }}
            onFocus={() => setFocus(index)}
            onClick={() => onChoose(option.value)}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch' && option.list !== undefined) openPeekSoon(index);
            }}
            onPointerLeave={hover.closeSoon}
            // A press is a choice made: the list it was read from goes, and comes back on the next hover.
            onPointerDown={hover.close}
            aria-describedby={peek?.key === index ? 'deck-peek' : undefined}
          />
        );
        return tileAction === undefined ? (
          tile
        ) : (
          <div key={option.value} className="deckpick__cell">
            {tile}
            {tileAction(option)}
          </div>
        );
      })}
      {pending && options.length === 0 && <SkeletonTiles count={pendingTiles} />}
      {options.length === 0 && empty !== undefined && (
        <p className="deckpick__empty" data-testid="deck-none">
          {empty}
        </p>
      )}
      {peek !== null && peeked?.list !== undefined && (
        <DeckPeek
          id="deck-peek"
          label={peeked.label}
          name={peeked.name}
          pilot={peeked.pilot}
          colors={peeked.colors}
          deckStyle={peeked.deckStyle}
          list={peeked.list}
          anchor={peek.anchor}
          bounds={peek.bounds}
          onPointerEnter={hover.hold}
          onPointerLeave={hover.closeSoon}
        />
      )}
    </div>
  );
}

export function ConstructedScreen({
  client: given,
  roomId,
  feed = roomFeed(),
  rooms,
  streamFetch,
  rand = secureRandom,
  makeTransport,
  deckRecords = fetchDeckRecords,
  myDecks,
}: ConstructedScreenProps) {
  const client = useMemo(() => given ?? tablesClient(), [given]);
  return roomId === undefined ? (
    <NoRoom />
  ) : (
    <RoomTableScreen
      client={client}
      roomId={roomId}
      feed={feed}
      rooms={rooms}
      streamFetch={streamFetch}
      rand={rand}
      makeTransport={makeTransport}
      deckRecords={deckRecords}
      myDecks={myDecks}
    />
  );
}

function RoomTableScreen({
  client,
  roomId,
  feed,
  rooms: givenRooms,
  streamFetch,
  rand,
  makeTransport,
  deckRecords: readDeckRecords,
  myDecks: givenMyDecks,
}: {
  client: TablesClient;
  roomId: string;
  feed: RoomFeed;
  rooms?: RoomsClient;
  streamFetch?: Fetch;
  rand: () => number;
  makeTransport?: () => DraftTransport;
  deckRecords: () => Promise<DeckRecords>;
  myDecks?: MyDecksClient;
}) {
  const rooms = useMemo(() => givenRooms ?? roomsClient(), [givenRooms]);
  const myDecksStore = useMemo(() => givenMyDecks ?? myDecksClient(), [givenMyDecks]);
  // What the room list read before navigating here (`rooms/warm.ts`): the first
  // render is then the finished page. Every read below still runs as before.
  const [warm] = useState(() => takeWarmRoom(roomId));
  const [loaded, setLoaded] = useState<Loaded | null>(warm?.catalogue ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [table, setTable] = useState<RoomTable | null>(warm?.table ?? null);
  /** The table's reads and this screen's own writes of it, latest-wins (`../rooms/latest.ts`). */
  const [tableReads] = useState(latestReads);
  const [tableError, setTableError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deckId, setDeckId] = useState('');
  /**
   * One write at a time, held here and never drawn: greying every control for
   * the round trip made the room blink on each press (the operator, 2026-10-19:
   * *"whenever i click sit here or ai, i notice all the buttons flash"*). A press
   * while one is in flight waits its turn and goes out once it has answered.
   */
  const busyRef = useRef(false);
  const later = useRef<(() => void)[]>([]);
  const setBusy = (b: boolean): void => {
    busyRef.current = b;
    while (!busyRef.current && later.current.length > 0) later.current.shift()!();
  };
  /** True when a write is in flight: `run` is queued behind it. */
  const queued = (run: () => void): boolean => {
    if (!busyRef.current) return false;
    later.current.push(run);
    return true;
  };
  const [starting, setStarting] = useState(false);
  /** The pool's answer to "which decks are legal here", and one per pool kept. */
  const [legal, setLegal] = useState<LegalSweep | null>(warm?.sweep ?? null);
  const sweeps = useRef(new Map<string, LegalSweep>(warm?.sweep === undefined ? [] : [[warm.sweep.formatId, warm.sweep]]));
  /**
   * The room's pool as this screen last saw it, so a CHANGE can be told from a
   * first sighting. Null until the room has answered once: arriving in a room
   * whose pool is already set must not re-send a deck the server is holding
   * against that same pool, because a `PUT …/deck` stands you down
   * (`routes.ts`: a new deck un-readies you).
   */
  const seenPool = useRef<string | null>(null);
  const [startRefusal, setStartRefusal] = useState<string | null>(null);
  /** A start is in flight, or has been refused: not asked again on every read. */
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
   * `resolved` flips on the first answer the screen keeps, success or failure, and
   * gates the body below so a streamed room never flashes the builtin table on
   * the way in. It is one extra concurrent request alongside the table read,
   * not a second round trip after it.
   */
  const [view, setView] = useState<RoomView | null>(warm?.view ?? null);
  /** The room record's reads and this screen's own writes of it, latest-wins (`../rooms/latest.ts`). */
  const [roomReads] = useState(latestReads);
  const [resolved, setResolved] = useState(warm !== undefined);
  /** Latched on the first read. A room does not change mode under its players. */
  const modeRef = useRef<ClientMode | null>(warm?.view.clientMode ?? null);
  /** A refusal from `ready` or `start`, in the server's own words. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const [dealing, setDealing] = useState(false);
  /** A deal is in flight or was refused: not asked again on every read. */
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
  const allReady = podDealable(view?.pod?.seats, members);
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
  /** The pool's own catalogue row: its name, and for an era its set list. */
  const poolFormat = loaded?.formats.find((f) => f.id === poolId) ?? null;
  /** Free pick: every library deck, whatever its era. No tab is the table's while it is on. */
  const freePick = poolId === FREE_PICK;
  const handSmoothing = view?.settings.handSmoothing ?? true;
  /**
   * Tournament mode (`docs/planning/tournament-mode-plan.md`): a Constructed
   * room plays a Swiss pod of its own mode, the same `RoomView.pod` a draft
   * room's does. `tournamentDecks` only matters once `tournament` is on.
   */
  const tournament = view?.settings.tournament === true;
  const tournamentDecks = view?.settings.tournamentDecks ?? 'locked';
  const pod: PodView | null = view?.pod ?? null;
  /** The pod's seats are still open — Tournament/Decks are the leader's, and seats, AI and Lock all act. */
  const tournamentLobby = tournament && pod !== null && pod.phase === 'lobby';
  /** Seats are locked: the bracket, standings and "your table" replace the lobby's seats entirely. */
  const tournamentRounds = tournament && pod !== null && (pod.phase === 'rounds' || pod.phase === 'done');
  /*
   * The tournament's rounds: my own table (if any) among `view.tables` —
   * possibly several at once, unlike the 1v1 room's single `myTable` —
   * found the same way `PodScreen.tsx`'s own `myCurrentTable` does, from
   * the CURRENT round's pairings, since an earlier round's table is still
   * mine and finished. Computed here (ahead of the deck/table reads below)
   * so a Gauntlet tournament's own state effect, further down, can scope
   * its reads to it.
   */
  const myTournamentTable: SharedRoomTable | undefined = (() => {
    if (pod === null || view === null) return undefined;
    const current = new Set(pod.pairings.map((p) => p.tableId));
    return view.tables.find((t) => current.has(t.id) && t.players.some((p) => p.memberId === view.you.id));
  })();
  const tSideboarding = myTournamentTable !== undefined && myTournamentTable.matchId === null && myTournamentTable.series.phase === 'sideboarding';
  /** A tournament Gauntlet table is scoped by this id; a non-tournament one reads `undefined` (the room's first table), same as before. */
  const gauntletTableId = tournament ? myTournamentTable?.id : undefined;

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

  // The room's table: read now, and again whenever the feed says the room
  // changed (`../rooms/feed.ts` — never on a fast timer).
  //
  // ## Entering a room joins it
  //
  // Reaching a room by any route other than the list's Join button — an invite
  // link, a refresh, a bookmark, a second browser — used to leave you a
  // non-member. The server answers a non-member exactly as it answers a
  // missing room (`routes.ts` `tableFor`, deliberately: a different answer
  // would tell an outsider which rooms exist), so the screen said "this room
  // is not there" about a room that was, and read that 404 forever.
  //
  // Observed live 2026-09-19 on `r-8eb2a7cd614c`: the leader read it fine, the
  // second person got 404 on every read, and the room file on disk held
  // exactly one member. So a read that is refused tries to JOIN once, then
  // reads again.
  //
  // Only once, and only for a refusal. A locked room refuses the join too, and
  // retrying that on every read is a rate-limit trip and a password guessing
  // loop nobody asked for.
  //
  // **A draft room runs this too**, and that is the whole reason the read is not
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
      const landed = tableReads.read();
      void client.table(roomId).then(async (outcome) => {
        if (!live) return;
        const verdict = landed();
        if (verdict === 'drop') return;
        if (verdict === 'reread') {
          read();
          return;
        }
        if (outcome.ok) {
          setTable(outcome.table);
          setTableError(null);
          return;
        }
        if (joined) {
          // The join went through, so this refusal is something else — a room
          // that has since gone, or a read that raced the write. Keep following:
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
    const stopFollowing = feed.follow({ room: roomId }, read);
    return () => {
      live = false;
      stopFollowing();
    };
  }, [client, rooms, roomId, feed, attempt, tableReads]);

  // The room record, read beside the table on the same feed. The mode is
  // latched on the first read; the membership keeps moving, because a streamed
  // room's seats appear as people arrive.
  useEffect(() => {
    let live = true;
    const read = (): void => {
      // Latest-wins (`../rooms/latest.ts`): a dropped read decides nothing, opening the body included.
      const landed = roomReads.read();
      rooms.get(roomId).then(
        (room) => {
          if (!live) return;
          const verdict = landed();
          if (verdict === 'drop') return;
          if (room === null) {
            setResolved(true);
            // The room was here and is not any more: its owner closed it.
            if (modeRef.current !== null) navigate({ kind: 'lobby' }, { replace: true });
            return;
          }
          if (verdict === 'reread') {
            read();
            return;
          }
          modeRef.current ??= room.clientMode;
          setView(room);
          setResolved(true);
        },
        () => {
          // The room could not be read. That is the same server the table read
          // is asking, and `tableError` below already says so in words; adding
          // a second sentence about it would say it twice. What this must not
          // do is stay silent AND keep the body hidden, so the gate opens.
          if (live && landed() !== 'drop') setResolved(true);
        },
      );
    };
    const stopFollowing = feed.follow({ room: roomId }, read);
    return () => {
      live = false;
      stopFollowing();
    };
  }, [rooms, roomId, feed, roomReads]);

  const players = table?.players ?? [];
  const mine = players.find((p) => p.you) ?? null;
  /** Your own deck's verdict: the only deck this screen is ever told about. */
  const myLegal = mine?.deck?.legal === true;
  const matchId = table?.room.matchId ?? null;
  const full = players.length >= (table?.room.seats ?? 2);
  /** I hold a seat (with or without a deck): sitting is its own act (2026-10-12). */
  const seated = table?.you.player === true;
  const spectating = table !== null && !seated && full;
  /** Nobody stands up: a match is live, or both players are ready (the operator's ruling, 2026-10-12). */
  const tableLocked = table?.room.locked === true || (table?.room.matchId ?? null) !== null;
  // Ready already means a legal deck: the server refuses it without one.
  const bothReady = players.length === 2 && players.every((p) => p.ready);
  /** A start asked for or a match running: the table is no longer anyone's to change. */
  const underway = starting || matchId !== null;
  /**
   * The room's Constructed mode, or null until the leader picks one. A room
   * record that could not be read leaves the mode unknown, and the table then
   * draws as Classic — the table it has always drawn without that record.
   */
  const mode = view === null ? 'classic' : view.mode;
  /** A Gauntlet room's state as I may see it; null in any other mode. */
  const [gauntlet, setGauntlet] = useState<GauntletView | null>(null);
  /** The Gauntlet's reads and this screen's own moves, latest-wins (`../rooms/latest.ts`). */
  const [gauntletReads] = useState(latestReads);
  /** The Gauntlet's seats have stopped being the table's to arrange: readied, or drawn and not yet done. */
  const gauntletUnderway = gauntlet !== null && gauntlet.phase !== 'done' && (gauntlet.phase !== 'options' || gauntlet.ready.some(Boolean));
  /** Whether a seat is ready: the Gauntlet keeps its own readiness, every other mode the table's. */
  const readyAt = (seat: number): boolean => (mode === 'gauntlet' ? gauntlet?.ready[seat] === true : players[seat]?.ready === true);
  /**
   * The mode is the leader's to change until somebody readies or the game is
   * under way (ruling 8); the server's `mode-locked` is the same rule, and the
   * refusal it answers a late press with is shown like any other. Tournament
   * and Decks lock the same moment: "both are locked once the seats lock"
   * (the plan's Design section) — once the pod has left `lobby`.
   */
  const modeLocked = underway || players.some((p) => p.ready) || gauntletUnderway || (pod !== null && pod.phase !== 'lobby');
  /** What the room plays: Constructed or Draft, as the create form named it. */
  const gameType: GameType = draftRoom ? 'draft' : 'constructed-1v1';
  /**
   * The type is the leader's when the mode is (the server's `mode-locked` again);
   * a draft room's until its deal is asked for, after which it is the pod's.
   */
  const typeLocked = draftRoom ? dealing : modeLocked;
  /**
   * What stands between my seat and Ready: in Classic, a legal deck of my
   * own; in Gauntlet and All Random the room deals the decks, so only the seat
   * (and a Gauntlet only before its draw, or once it is decided, to begin the next).
   */
  const canReady =
    mode === 'classic' ? deckId !== '' && myLegal : mode === 'gauntlet' ? seated && ['options', 'done'].includes(gauntlet?.phase ?? 'options') : seated;
  /**
   * The room's own table record (wave 71 §D's wire shape, via `@hadoku/shared`),
   * for the SERIES it carries — `wins`, `games`, `phase` — none of which
   * `./tables.ts`'s own `RoomTable` (`table`, above) has. A plain constructed
   * 1v1 room is the one-table case, so this is `tables[0]`; a TOURNAMENT room
   * never plays on `tables[0]` once it locks (`room/lobby.ts`'s
   * `#lockTournament` unseats it — a real run, 2026-10-22, is exactly what
   * reading it here regardless of mode cost), so this reads the player's own
   * CURRENT tournament table (`myTournamentTable`) instead.
   */
  const myTable: SharedRoomTable | null = tournament ? (myTournamentTable ?? null) : (view?.tables[0] ?? null);
  /** Between games of my series: the room is where the sideboard step is, whichever page I came back by (`TableSideboard`). */
  const mySideboarding = myTable !== null && myTable.matchId === null && myTable.series.phase === 'sideboarding';
  const streamed = modeRef.current === 'streamed';
  /** The room's name as soon as either read has it; the id is never a title. */
  const roomTitle = streamed ? view?.name : (table?.room.name ?? view?.name);
  /** The room answered with a refusal rather than a table: there is nothing more to wait for. */
  const settled = locked !== null || tableError !== null;
  /** The empty seat Forge's AI is offered on, if any: the last one, while nobody but me is seated. */
  const botSeat = players.every((p) => p.you) ? [0, 1].findLast((seat) => players[seat] === undefined) : undefined;
  /** Nothing of the room's own to draw yet: its skeleton instead. */
  const pending = !streamed && !settled && (!resolved || (!draftRoom && table === null));
  /** Whether the deck card is on the screen at all: nothing below asks for it otherwise. */
  const picking =
    !streamed && !draftRoom && mode === 'classic' && resolved && locked === null && table !== null && !spectating && loaded !== null;

  // Which decks the ROOM's pool offers. One sweep per pool, remembered — see
  // `legalDecksIn`. Gated on the card being drawn, so a streamed room, a
  // locked room and a spectator ask nothing. The leader moving the pool re-runs
  // it, which is what narrows the dropdown for everybody in the room.
  useEffect(() => {
    if (!picking || loaded === null || poolId === '') return;
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
  }, [picking, loaded, poolId, client]);

  /**
   * Everyone's record per library deck, so the picker lists the winners first
   * (`stats/deckOrder.ts`). Empty until it answers, and empty if it cannot: the
   * library's own order is a fine picker, so a failed read is logged, not shown.
   */
  const [deckRecords, setDeckRecords] = useState<DeckRecords>(() => new Map());
  useEffect(() => {
    let live = true;
    readDeckRecords()
      .then((records) => {
        if (live) setDeckRecords(records);
      })
      .catch((err: unknown) => {
        console.warn('[cardtable] deck win rates are unavailable; the picker keeps the library order', err);
      });
    return () => {
      live = false;
    };
  }, [readDeckRecords]);

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
   * An era offers the library decks legal in it; Free pick offers the whole
   * library plus your own drafted decks ("My decks"), and all of them are
   * {@link DeckOption} rows the same chooser renders. Null keeps the chooser
   * disabled — an option list assembled before the answer would offer decks the
   * pool does not have.
   *
   * ## The colours, and the ONE fold they come from
   *
   * Operator, wave 26: *"decks should have their corresponding mana symbols."*
   * Wave 26 §D drew them in `DeckView` and the deck screen's own builder and
   * exported the fold so a third screen could not invent a second one — which
   * is what this is.
   * Both arms call into `DeckView.tsx`:
   *
   *   - a LIBRARY deck is a list of names (`TableDeck.main`), so it folds
   *     through `deckColorsByName` against `LIBRARY_CARD_COSTS` — the cost of
   *     every card the library plays, sliced out of the same
   *     `decks/pools/*.generated.json` the fixtures are and shipped as 10 KB of
   *     data because a browser has no filesystem and `GET /api/tables/decks`
   *     sends names without costs.
   *   - a DRAFTED deck is a `Deck` of real cards, so it folds through
   *     `mainDeckColors`, which is the same fold plus the basics.
   *
   * The MAINDECK only, both times, and `DeckView`'s head does the same: a
   * sideboard is not what you are playing. Get this wrong and two screens
   * disagree about what colour a deck is, which is the failure wave 26's single
   * export exists to prevent.
   */
  /**
   * Free pick's "My decks": every draft you finished whose build is a deck —
   * the operator, 2026-10-19: *"the only other time this deck can be selected
   * to be played is if 'Free-Pick' is enabled"*. Asked for when Free pick is
   * on and the deck card is drawn; null until it answers.
   */
  const [myDecks, setMyDecks] = useState<MyDeck[] | null>(null);
  useEffect(() => {
    if (!picking || !freePick) return;
    let live = true;
    myDecksStore
      .list()
      .then((decks) => {
        if (live) setMyDecks(decks);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setMyDecks([]);
        setActionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [picking, freePick, myDecksStore]);
  const myDeckOptions = useMemo(
    () =>
      myDecks?.flatMap((d) => {
        if (d.deck === null) return [];
        const deck = openDraftedDeck(d.deck, d.id, d.pool);
        return mainDeckSize(deck) < LIMITED_MIN_MAIN_DECK_SIZE ? [] : [{ option: draftedDeckOption(`${MY_DECK}${d.id}`, d.name, deck, d.pool), dck: dckTextOf(deck) }];
      }) ?? null,
    [myDecks],
  );

  const deckOptions = useMemo<DeckOption[] | null>(() => {
    if (offered === null) return null;
    const mine = freePick ? (myDeckOptions ?? []).map((m) => m.option) : [];
    return [
      ...byWinRate(
        offered.map((d) => {
          const peek = libraryDeckPeek(d);
          return { value: d.id, ...peek, art: libraryDeckArt(peek.list) };
        }),
        deckRecords,
      ),
      ...mine,
    ];
  }, [offered, deckRecords, freePick, myDeckOptions]);

  /**
   * On Free pick the whole library is on offer, and each player browses it by
   * format for themselves — the operator, 2026-10-10: *"when free-pick is
   * enabled, instead of showing all decks in one list can we expose the
   * Standard/Modern/Legacy to the other player?"* This moves nothing in the
   * room: it filters what THIS screen shows. `deckOptions` stays the whole
   * offer, so a deck you hold is still yours while you look at another tab.
   */
  const [browse, setBrowse] = useState<Browse>({ family: 'standard', era: '' });
  /** A library deck's era, by the era id the server gives each deck. */
  const eraOfDeck = useMemo(() => {
    const out = new Map<string, TableFormat>();
    if (loaded === null) return out;
    const eras = new Map(loaded.formats.filter(isEra).map((f) => [f.id, f]));
    for (const d of loaded.decks) {
      const era = eras.get(d.era);
      if (era !== undefined) out.set(d.id, era);
    }
    return out;
  }, [loaded]);
  // The art is assigned here, on the list as shown, so a card one tile uses is
  // not repeated further down — the operator, 2026-10-11.
  const shownOptions = useMemo(() => {
    if (deckOptions === null) return null;
    // "My decks" draws nothing until they have answered, not an empty tab that then fills.
    if (freePick && browse.family === 'mine' && myDeckOptions === null) return null;
    const shown = !freePick
      ? deckOptions
      : browse.family === 'mine'
        ? deckOptions.filter((o) => o.value.startsWith(MY_DECK))
        : deckOptions.filter((o) => {
            const era = eraOfDeck.get(o.value);
            return era !== undefined && era.family === browse.family && (browse.era === '' || era.id === browse.era);
          });
    const artIds = assignDeckArt(shown.map((o) => o.art ?? []));
    return shown.map((o, i) => ({ ...o, artId: artIds[i] }));
  }, [deckOptions, freePick, eraOfDeck, browse, myDeckOptions]);

  /**
   * The filter row's narrowing of the library on show (`deckFilter.ts`). It is
   * this screen's own view and moves nothing in the room: a chosen deck the
   * filter hides stays chosen. Kept across an era change, so a search follows
   * the reader from one year to the next.
   */
  const [deckFilter, setDeckFilter] = useState<DeckFilter>(NO_DECK_FILTER);
  const visibleOptions = useMemo(
    () => (shownOptions === null ? shownOptions : shownOptions.filter((o) => deckPasses(o, deckFilter))),
    [shownOptions, deckFilter],
  );

  /**
   * Every art URL this room has already asked the browser to warm, and the
   * `Image` object doing it — kept for as long as this screen stays mounted,
   * so the warm cannot be garbage-collected mid-load. A ref rather than
   * state: it drives no render, and a map the size of the library is not
   * something to copy on every write the way `setState` would.
   */
  const prefetchedArt = useRef(new Map<string, HTMLImageElement>());

  // The moment an era's options are known, ask the browser to
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
    if (shownOptions === null) return;
    const urls = shownOptions.flatMap((o) => {
      if (o.artId === undefined) return [];
      const url = cardImageUrl(o.artId);
      return url === null ? [] : [url];
    });
    prefetchCardImages(urls, prefetchedArt.current);
  }, [shownOptions]);

  // A deck the new pool does not offer is no longer chosen. The `PUT` under the
  // new rules has already gone (the re-send below), so its verdict is on the
  // screen saying which card is the problem; what this does is stop Ready
  // coming back to life over a deck the list no longer contains.
  useEffect(() => {
    if (deckOptions === null || deckId === '') return;
    if (!deckOptions.some((o) => o.value === deckId)) setDeckId('');
  }, [deckOptions, deckId]);

  // The match the server started — for whoever pressed nothing, too. Only one
  // this screen saw begin is new: a table that already had a match when it
  // first loaded is a match under way, and opens without the start sound.
  //
  // Never for a tournament: `table`/`matchId` read `tables[0]`, which a
  // tournament room never plays on once it locks (`room/lobby.ts`'s
  // `#lockTournament` unseats it) — a tournament's own match-follow is
  // `myTournamentTable`'s effect, further down.
  const sawNoMatch = useRef(false);
  if (table !== null && matchId === null) sawNoMatch.current = true;
  useEffect(() => {
    if (!tournament && matchId !== null) followMatchOnce(matchId, sawNoMatch.current);
  }, [tournament, matchId]);

  const startVsBot = (): void => {
    setStartRefusal(null);
    setStarting(true);
    client
      .startVsBot(roomId)
      .then((outcome) => {
        if (outcome.ok) {
          openNewMatch(outcome.matchId);
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
  //
  // A Gauntlet game starts the same way once both of its decks are chosen and
  // dealt ('playing'); against the AI through the AI's start. Each game of the
  // series asks once: the ask is cleared when a match ends.
  const startAs: 'room' | 'ai' | null =
    mode === 'gauntlet'
      ? gauntlet?.phase === 'playing'
        ? gauntlet.players?.some((p) => p.memberId === null) === true
          ? 'ai'
          : 'room'
        : null
      : bothReady
        ? 'room'
        : null;
  const lastMatch = useRef<string | null>(null);
  useEffect(() => {
    if (lastMatch.current !== null && matchId === null) asked.current = false;
    lastMatch.current = matchId;
  }, [matchId]);
  useEffect(() => {
    // Never for a tournament: `startRoom`/`startVsBot` with no table id act on
    // `tables[0]`, which a tournament room never plays — its own start is
    // `startTournamentTable`'s effect, scoped to `myTournamentTable`, further down.
    if (tournament || draftRoom || startAs === null || matchId !== null || mine === null || asked.current) return;
    asked.current = true;
    setStarting(true);
    (startAs === 'ai' ? client.startVsBot(roomId) : client.startRoom(roomId))
      .then((outcome) => {
        if (outcome.ok) {
          openNewMatch(outcome.matchId);
          return;
        }
        setStartRefusal(outcome.error);
        setStarting(false);
      })
      .catch((err: unknown) => {
        setStartRefusal(err instanceof Error ? err.message : String(err));
        setStarting(false);
      });
  }, [tournament, draftRoom, startAs, matchId, mine, client, roomId]);

  /*
   * Every member ready: deal the draft.
   *
   * Either browser may ask and the server deals once — `startDraft` is
   * idempotent, so a room whose draft has already started answers with its view
   * rather than an error. The ref is what stops every re-read asking again
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
          roomReads.wrote();
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
    const choice = mine?.deck?.choice ?? null;
    if (restored.current || choice === null) return;
    const { deck } = choice;
    if ('library' in deck) {
      restored.current = true;
      setDeckId(deck.library);
      return;
    }
    // A `{ dck }` hold is one of Free pick's "My decks" — the only thing on this
    // screen that sends one — so the picker opens on the deck with those bytes.
    if (myDeckOptions === null) return;
    restored.current = true;
    const held = myDeckOptions.find((m) => m.dck === deck.dck);
    if (held !== undefined) setDeckId(held.option.value);
  }, [mine, myDeckOptions]);

  const apply = (outcome: Awaited<ReturnType<TablesClient['table']>>): void => {
    if (outcome.ok) {
      tableReads.wrote();
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
    if (queued(() => loadDeckRef(deck))) return;
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
   * A "My decks" value is the `.dck` text of that draft's build as the builder
   * opens it (`openDraftedDeck`); every other value is a library id. Null for a "My
   * decks" value whose list has not answered.
   */
  const deckRefOf = (value: string): DeckRef | null => {
    if (value.startsWith(MY_DECK)) {
      const mine = myDeckOptions?.find((m) => m.option.value === value);
      return mine === undefined ? null : { dck: mine.dck };
    }
    return { library: value };
  };

  /**
   * The deck dropdown moved. `Random` is one of the decks ON OFFER — the room's
   * pool has already narrowed them, so it cannot roll an illegal deck — and it
   * resolves to that deck's id rather than staying a mystery: what you got is
   * what the dropdown then reads.
   */
  const chooseDeck = (value: string): void => {
    const chosen = value === RANDOM_DECK ? pickRandom(visibleOptions ?? [], rand)?.value : value;
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
   * browser reads the change when the feed says the room moved. A refusal — a non-leader, a room
   * that is drafting — is shown in the server's own words, and nothing local
   * has moved, so the screen still reads what the table is actually on.
   */
  /**
   * One LEADER write to the room (its pool, its mode, a setting), answered
   * with the room as it now is or the server's own refusal.
   */
  const writeRoom = (write: () => Promise<RoomOutcome>): void => {
    if (queued(() => writeRoom(write))) return;
    setBusy(true);
    setActionError(null);
    write()
      .then((outcome) => {
        if (!outcome.ok) {
          setActionError(outcome.message);
          return;
        }
        roomReads.wrote();
        setView(outcome.room);
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const choosePool = (value: string): void => {
    if (value !== poolId) writeRoom(() => rooms.setFormat(roomId, value));
  };

  /** The LEADER flipped hand smoothing. */
  const toggleHandSmoothing = (): void => writeRoom(() => rooms.setSettings(roomId, { handSmoothing: !handSmoothing }));

  /**
   * The LEADER flipped Tournament, or moved Decks between Locked and Each
   * round — both `PATCH /api/rooms/:id` with `{ settings }`, same as hand
   * smoothing. Any of the three modes may run a tournament
   * (`docs/planning/tournament-mode-plan.md`).
   */
  const toggleTournament = (on: boolean): void => writeRoom(() => rooms.setSettings(roomId, { tournament: on }));
  const chooseTournamentDecks = (decks: TournamentDecks): void => writeRoom(() => rooms.setSettings(roomId, { tournamentDecks: decks }));

  /*
   * The tournament pod's own seat actions — `screens/pod/client.ts`'s
   * sit/ai/close/stand, the same calls `DraftLobby.tsx` already drives for a
   * draft pod's lobby — queued the same way every OTHER write on this screen
   * is (`queued`/`setBusy`, above) rather than `DraftLobby`'s own separate
   * in-flight ref, since this screen already has one.
   */
  const [podSeatError, setPodSeatError] = useState<string | null>(null);
  const podAct = (call: () => Promise<{ ok: boolean; message: string | null }>): void => {
    if (queued(() => podAct(call))) return;
    setBusy(true);
    setPodSeatError(null);
    call()
      .then((r) => {
        if (!r.ok) setPodSeatError(r.message);
      })
      .finally(() => setBusy(false));
  };
  const doSitPod = (seat: number): void => podAct(() => sitPod(roomId, seat));
  const doAiPod = (seat: number, on: boolean): void => podAct(() => aiPod(roomId, seat, on));
  const doClosePod = (seat: number, closed: boolean): void => podAct(() => closePod(roomId, seat, closed));
  const doStandPod = (): void => podAct(() => standPod(roomId));

  /**
   * Lock seats: the SAME route a draft room's own deal already uses
   * (`rooms.start`, `POST /api/rooms/:id/start`) — `room/lobby.ts`'s
   * `startDraft` dispatches to the tournament lock whenever the room is one,
   * so there is no separate route to call. The leader's "not ready" refusal
   * (too few entrants, a human without a legal Classic deck) lands here in
   * the server's own words, same as every other write on this screen.
   */
  const [podLockError, setPodLockError] = useState<string | null>(null);
  const doLockSeats = (): void => {
    if (queued(() => doLockSeats())) return;
    setBusy(true);
    setPodLockError(null);
    rooms
      .start(roomId)
      .then((r) => {
        if (!r.ok) {
          setPodLockError(r.message);
          return;
        }
        roomReads.wrote();
        setView(r.room);
      })
      .catch((err: unknown) => setPodLockError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /** The eras a Gauntlet is offered in, read once the room is on Gauntlet. */
  const [gauntletEras, setGauntletEras] = useState<GauntletEraOption[] | null>(null);
  const wantsGauntletEras = mode === 'gauntlet' && gauntletEras === null;
  useEffect(() => {
    if (!wantsGauntletEras) return;
    let live = true;
    client
      .gauntletEras()
      .then((eras) => {
        if (live) setGauntletEras(eras);
      })
      .catch((err: unknown) => {
        if (live) setActionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [client, wantsGauntletEras]);

  // A Gauntlet room's state, read on the room's own feed: every move the server
  // stores pings it, so both screens and every watcher follow the board. A
  // tournament scopes the read to MY OWN table (`gauntletTableId`); between
  // rounds, before I have one, there is nothing of mine to show.
  useEffect(() => {
    if (mode !== 'gauntlet' || (tournament && gauntletTableId === undefined)) {
      setGauntlet(null);
      return;
    }
    let live = true;
    const read = (): void => {
      const landed = gauntletReads.read();
      client.gauntlet(roomId, gauntletTableId).then(
        (next) => {
          if (!live) return;
          const verdict = landed();
          if (verdict === 'keep') setGauntlet(next);
          else if (verdict === 'reread') read();
        },
        (err: unknown) => {
          if (live && landed() !== 'drop') setActionError(err instanceof Error ? err.message : String(err));
        },
      );
    };
    const stopFollowing = feed.follow({ room: roomId }, read);
    return () => {
      live = false;
      stopFollowing();
    };
  }, [client, feed, roomId, mode, gauntletReads, tournament, gauntletTableId]);

  /** One Gauntlet move (ready, ban, pick, choose): the board as it now stands, or the server's words. */
  const gauntletMove = (move: () => Promise<GauntletOutcome>): void => {
    setActionError(null);
    move()
      .then((outcome) => {
        if (!outcome.ok) {
          setActionError(outcome.error);
          return;
        }
        gauntletReads.wrote();
        setGauntlet(outcome.view);
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  };

  /** The LEADER picked the room's other type: it becomes that room, its mode unchosen and nobody ready. */
  const chooseGameType = (next: GameType): void => {
    if (next !== gameType) writeRoom(() => rooms.setGameType(roomId, next));
  };

  /** The LEADER picked a mode: the room moves to it with that mode's first options. */
  const chooseMode = (next: ConstructedMode): void => {
    if (next !== mode) writeRoom(() => rooms.setRoomMode(roomId, freshRoomMode(next)));
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
  }, [picking, poolId, deckId]);

  const setReady = (ready: boolean): void => {
    if (queued(() => setReady(ready))) return;
    setBusy(true);
    setActionError(null);
    client
      .ready(roomId, ready)
      .then(apply)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /**
   * Taking a seat, and giving it back (2026-10-12). Sitting is its own act
   * now: Sit here holds a seat before any deck is chosen, and Stand up gives
   * it back. Choosing a deck while unseated still seats you when a seat is
   * free (the server's `PUT …/deck` auto-sits), so the one-click Random → Ready
   * path every spec and the watchparty production run drive is unchanged; the
   * picker is withheld only from someone the table has no seat for. The
   * server refuses a stand-up once both players are ready or the match is
   * live (`room.locked`), and the refusal is shown in its own words where a
   * deck or ready refusal is.
   */
  const sitDown = (): void => {
    if (queued(() => sitDown())) return;
    setBusy(true);
    setActionError(null);
    client
      .sit(roomId)
      .then(apply)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const standUp = (): void => {
    if (queued(() => standUp())) return;
    setBusy(true);
    setActionError(null);
    client
      .stand(roomId)
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
    if (queued(() => setDraftReady(ready))) return;
    setBusy(true);
    setDraftError(null);
    rooms
      .ready(roomId, ready)
      .then((outcome) => {
        if (!outcome.ok) {
          setDraftError(outcome.message);
          return;
        }
        roomReads.wrote();
          setView(outcome.room);
      })
      .catch((err: unknown) => setDraftError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /**
   * Every entrant's display name and avatar — human members, plus whatever
   * `pod.seats` named for an AI entrant (`ai:<seat>` or the draft pod's
   * shared `ai`) while the pod was still in `lobby` (seats clear once rounds
   * start, so this is captured once and kept for the rest of the pod's life).
   */
  const [podEntrantNames, setPodEntrantNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (pod === null || pod.phase !== 'lobby') return;
    setPodEntrantNames((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const s of pod.seats) {
        if (s !== null && next[s.memberId] !== s.name) {
          next[s.memberId] = s.name;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [pod]);
  const tNameOf = (id: string): string => podEntrantNames[id] ?? members.find((m) => m.id === id)?.name ?? (isPodAi(id) ? 'AI' : id);
  const tAvatarOf = (id: string): string | null => members.find((m) => m.id === id)?.avatarId ?? null;

  /**
   * A player whose table starts a game is taken to it; everyone else stays
   * on the pod — `PodScreen.tsx`'s own effect for a draft pod's rounds,
   * mirrored here because a tournament pod lives inside `ConstructedScreen`
   * rather than `PodScreen`.
   */
  useEffect(() => {
    if (!tournamentRounds || myTournamentTable?.matchId == null) return;
    followMatchOnce(myTournamentTable.matchId, false);
  }, [tournamentRounds, myTournamentTable]);

  /**
   * Classic's "Each round": my CURRENT round's own table, read fresh
   * whenever a new round's table replaces the last one — `client.table`/
   * `loadDeck`'s own `tableId`, the SAME per-table read and write the 1v1
   * flow already uses, just named at a tournament table instead of
   * `tables[0]`. A fresh round's table has played no game of its series yet
   * (`matchId === null`, no games), which is when the picker is shown; once
   * a game exists, the deck already held is the one being played.
   */
  const [tTable, setTTable] = useState<Awaited<ReturnType<TablesClient['table']>> | null>(null);
  const tTableId = myTournamentTable?.id;
  useEffect(() => {
    if (tTableId === undefined) {
      setTTable(null);
      return;
    }
    let live = true;
    client.table(roomId, tTableId).then((outcome) => {
      if (live) setTTable(outcome);
    });
    return () => {
      live = false;
    };
  }, [client, roomId, tTableId]);
  const tFreshRound = myTournamentTable !== undefined && myTournamentTable.matchId === null && myTournamentTable.series.games.length === 0;
  const tDeckPicking = mode === 'classic' && tournamentDecks === 'per-round' && tFreshRound;
  const tMine = tTable?.ok === true ? tTable.table.players.find((p) => p.you) : undefined;
  /** Whether THIS round still needs a deck chosen before its table may start — "Each round" Classic only. */
  const tNeedsDeck = tDeckPicking && tMine?.deck?.legal !== true;
  const [tDeckId, setTDeckId] = useState('');
  const chooseTournamentTableDeck = (value: string): void => {
    if (tTableId === undefined) return;
    const chosen = value === RANDOM_DECK ? pickRandom(visibleOptions ?? [], rand)?.value : value;
    if (chosen === undefined || chosen === '') return;
    const ref = deckRefOf(chosen);
    if (ref === null) return;
    setTDeckId(chosen);
    client.loadDeck(roomId, ref, tTableId).then((outcome) => {
      setTTable(outcome);
    });
  };

  /**
   * My table's next game starts with nobody pressing anything — same gate as
   * `PodScreen.tsx`'s, plus Classic's "Each round": a fresh round withholds
   * the start until THIS entrant's own re-pick is legal (`tNeedsDeck`); the
   * OTHER seat's own table-read answers the same way once they pick theirs,
   * so the first of the two to finish never starts the game alone.
   */
  const [tStartError, setTStartError] = useState<string | null>(null);
  const tAsked = useRef<string | null>(null);
  const startTournamentTable = (t: SharedRoomTable, ask: string = t.id): void => {
    tAsked.current = ask;
    setTStartError(null);
    startMyTable(roomId, t).then((r) => {
      if (!r.ok) setTStartError(r.message);
    });
  };
  const retryTournamentTable = (tableId: string): void => {
    const t = view?.tables.find((x) => x.id === tableId);
    if (t !== undefined) startTournamentTable(t);
  };
  useEffect(() => {
    if (!tournamentRounds || myTournamentTable === undefined || tNeedsDeck) return;
    // Gauntlet's own flow decides when a game may start (its `playing` phase,
    // once both decks are dealt) — the table's bare `seating` is true from the
    // pairing itself, long before anyone has readied, banned or picked.
    if (mode === 'gauntlet' && gauntlet?.phase !== 'playing') return;
    if (myTournamentTable.matchId !== null || (myTournamentTable.series.phase !== 'seating' && myTournamentTable.series.phase !== 'playing')) return;
    const ask = `${myTournamentTable.id}:${myTournamentTable.series.games.length}:${myTournamentTable.series.phase}`;
    if (tAsked.current === ask) return;
    startTournamentTable(myTournamentTable, ask);
  }, [tournamentRounds, myTournamentTable, tNeedsDeck, mode, gauntlet]);

  const startState = startStateText(starting, matchId);
  /** Back in the room by choice while the game goes on: the way into it again. */
  const matchLink = matchId !== null && (
    <a className="lobby__go" data-testid="room-match-link" href={routeHash({ kind: 'match', matchId })}>
      {players.some((p) => p.you) ? 'Play' : 'Watch'}
    </a>
  );
  const startRefused = startRefusal !== null && (
    <div className="ct-error" role="alert" data-testid="start-refused">
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
  );

  /**
   * A Gauntlet tournament table's own board — `TournamentRounds`'s
   * `gauntlet` slot. Nobody sits or stands here (the pod's pairing already
   * fixed the two seats, ruling 5): before the draw, just the two entrants'
   * names and MY OWN Ready; from the reveal on, `GauntletScreen`, exactly as
   * a non-tournament Gauntlet table already draws it, just scoped to
   * `gauntletTableId`.
   */
  const tGauntletBoard =
    mode === 'gauntlet' && myTournamentTable !== undefined && gauntlet !== null ? (
      <section className="lobby__card" data-testid="tournament-gauntlet">
        {gauntlet.phase === 'options' ? (
          <ul className="pod-seats pod-seats--table" data-testid="tournament-gauntlet-seats">
            {[0, 1].map((seat) => (
              <li key={seat} className="pod-seats__seat">
                <span className="pod-seats__label">{myTournamentTable.players[seat]?.name ?? 'AI'}</span>
                {gauntlet.you === seat && (
                  <ActionButton
                    action="ready"
                    data-testid="tournament-gauntlet-ready"
                    onPress={() => gauntletMove(() => client.gauntletReady(roomId, !gauntlet.ready[seat], undefined, gauntletTableId))}
                  >
                    {gauntlet.ready[seat] ? 'Waiting…' : 'Ready'}
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <GauntletScreen
            view={gauntlet}
            avatars={seatAvatars(gauntlet, members)}
            onBan={(deck) => gauntletMove(() => client.gauntletAct(roomId, 'ban', deck, gauntletTableId))}
            onPick={(deck) => gauntletMove(() => client.gauntletAct(roomId, 'pick', deck, gauntletTableId))}
            onChoose={(deck) => gauntletMove(() => client.gauntletChoose(roomId, deck, gauntletTableId))}
          />
        )}
      </section>
    ) : undefined;

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
    <div className="shell shell--fit" data-testid="constructed" data-members={view?.members.length ?? undefined}>
      <header className="shell__head">
        {/* The room's own name, never its id: until the room has answered, a
            skeleton line where the name will be. */}
        {roomTitle !== undefined ? (
          <h1 className="shell__title" data-testid="room-name">
            {roomTitle}
          </h1>
        ) : settled ? (
          <h1 className="shell__title">Room</h1>
        ) : (
          <span className="skeleton skeleton--title" />
        )}
        <div className="shell__tools">
          {!streamed && iAmLeader && <CloseRoom roomId={roomId} rooms={rooms} />}
          <SettingsGear />
        </div>
        {/* A streamed room says so under its name: it is not our table. Ours
            needs no line (the operator, 2026-10-21: "i don't need the
            'Constructed 1v1' title inside the room"). */}
        {resolved && streamed && (
          <p className="shell__sub" data-testid="room-client-mode">
            Forge’s full client
          </p>
        )}
      </header>

      <main className="lobby lobby--room" aria-busy={pending ? 'true' : undefined}>
        {pending && <RoomSkeleton />}
        {streamed && <StreamedSeats roomId={roomId} members={view?.members ?? []} streamFetch={streamFetch} />}
        {/* Everything below is the builtin room, unchanged. It waits for the
            room record as well as the table so a streamed room never flashes
            a deck picker on its way in; both reads are in flight together, so
            this is not a second round trip. */}
        {!streamed && resolved && (
          <>
        {locked !== null && (
          <form
            className="lobby__locked ct-panel"
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
          <p className="ct-error" role="alert" data-testid="room-missing">
            {tableError}
          </p>
        )}
        {/* The draft room's first phase. Nothing below this is drawn for it:
            there is no deck to hold, no seat at a constructed table, and every
            table write it could make is a 409. */}
        {locked === null && draftRoom && (
          <>
          <section className="lobby__card">
            <GameTypeRow testId="room-game-type" value={gameType} disabled={!iAmLeader || typeLocked} onChange={chooseGameType} />
            {actionError !== null && (
              <p className="ct-error" role="alert" data-testid="table-error">
                {actionError}
              </p>
            )}
          </section>
          <DraftLobby
            roomId={roomId}
            pod={view?.pod ?? null}
            members={members}
            leaderId={view?.leader ?? ''}
            myId={view?.you.id ?? ''}
            iAmReady={iAmReady}
            allReady={allReady}
            dealing={dealing}
            error={draftError}
            onReady={setDraftReady}
            onRetry={() => {
              askedDeal.current = false;
              setDraftError(null);
              setDealAttempt((n) => n + 1);
            }}
          />
          </>
        )}

        {!draftRoom && loadError !== null && (
          <p className="ct-error" role="alert" data-testid="tables-load-error">
            Could not load the formats and decks: {loadError}
          </p>
        )}

        {!draftRoom && table !== null && (
          <>
            {/* The mode, and the chosen mode's options beside it. With no mode
                chosen this row is the whole room (the operator, 2026-10-21). */}
            <section className="lobby__card">
              {/* The room's type above its mode (the operator, 2026-10-21), so the
                  mode and its options keep their one line. */}
              <GameTypeRow testId="room-game-type" value={gameType} disabled={!iAmLeader || typeLocked} onChange={chooseGameType} />
              <div className="lobby__modeline">
                <ModeRow mode={mode} disabled={!iAmLeader || modeLocked} onChoose={chooseMode} />
                {mode === 'classic' && loaded !== null && (
                  <ClassicOptions
                    formats={loaded.formats}
                    poolId={poolId}
                    leader={iAmLeader}
                    disabled={underway}
                    onPool={choosePool}
                    browse={browse}
                    onBrowse={setBrowse}
                    handSmoothing={handSmoothing}
                    onHandSmoothing={toggleHandSmoothing}
                  />
                )}
                {mode === 'gauntlet' && gauntletEras !== null && (
                  <GauntletOptions
                    eras={gauntletEras}
                    // The pair parsed together (`parseRoomView`), so a Gauntlet's options are Gauntlet's.
                    options={(view?.modeOptions ?? {}) as GauntletModeOptions}
                    leader={iAmLeader}
                    disabled={modeLocked}
                    onChange={(options) => writeRoom(() => rooms.setRoomMode(roomId, { mode: 'gauntlet', modeOptions: options }))}
                  />
                )}
                {mode === 'random' && (
                  <AllRandomOptions
                    // The pair parsed together (`parseRoomView`), so an All Random room's options carry its pool.
                    value={(view?.modeOptions as RandomOptions | null)?.pool ?? null}
                    disabled={!iAmLeader || modeLocked}
                    onChange={(pool) => writeRoom(() => rooms.setRoomMode(roomId, { mode: 'random', modeOptions: { pool } }))}
                  />
                )}
                {/* Tournament applies across every mode (ruling 2), so it sits
                    beside the mode row rather than inside any one mode's own
                    options — shown once a mode is chosen, same as the others. */}
                {mode !== null && (
                  <TournamentOptions
                    tournament={tournament}
                    tournamentDecks={tournamentDecks}
                    leader={iAmLeader}
                    disabled={modeLocked}
                    onTournament={toggleTournament}
                    onDecks={chooseTournamentDecks}
                  />
                )}
              </div>
              {actionError !== null && (
                <p className="ct-error" role="alert" data-testid="table-error">
                  {actionError}
                </p>
              )}
            </section>

            {mode !== null && tournamentLobby ? (
              <TournamentPodLobby
                pod={pod!}
                members={members}
                leaderId={view?.leader ?? ''}
                myMemberId={view?.you.id ?? ''}
                iAmReady={iAmReady}
                canReady={canReady}
                // Classic's own lock-readiness (a legal deck) is caller-scoped on
                // the wire — observable for ME (`canReady`), not for anyone else,
                // so every OTHER human reads optimistically true and the real
                // gate is the server's refusal. Random's `ready` flag is NOT
                // caller-scoped, so every human's own is read straight.
                lockReadyOf={mode === 'classic' ? (id) => id !== view?.you.id || canReady : (id) => members.find((m) => m.id === id)?.ready === true}
                onSit={doSitPod}
                onStand={doStandPod}
                onAi={doAiPod}
                onClose={doClosePod}
                onReady={setDraftReady}
                onLock={doLockSeats}
                seatError={podSeatError}
                lockError={podLockError}
              >
                {mode === 'classic' && loaded !== null && (
                  <DeckChooser
                    options={visibleOptions ?? []}
                    empty={shownOptions !== null && shownOptions.length > 0 ? 'No decks' : undefined}
                    value={deckId}
                    disabled={deckOptions === null || underway}
                    pending={shownOptions === null}
                    pendingTiles={ROOM_SKELETON_TILES}
                    onChoose={chooseDeck}
                  />
                )}
              </TournamentPodLobby>
            ) : mode !== null && tournamentRounds ? (
              <TournamentRounds
                pod={pod!}
                tables={view?.tables ?? []}
                myMemberId={view?.you.id ?? null}
                nameOf={tNameOf}
                avatarOf={tAvatarOf}
                onPlay={tStartError === null ? undefined : retryTournamentTable}
                startTableError={tStartError}
                deckPicker={
                  tDeckPicking && loaded !== null ? (
                    <DeckChooser
                      options={visibleOptions ?? []}
                      empty={shownOptions !== null && shownOptions.length > 0 ? 'No decks' : undefined}
                      value={tDeckId}
                      disabled={deckOptions === null}
                      pending={shownOptions === null}
                      pendingTiles={ROOM_SKELETON_TILES}
                      onChoose={chooseTournamentTableDeck}
                    />
                  ) : undefined
                }
                sideboard={
                  tSideboarding && myTournamentTable !== undefined ? (
                    <TableSideboard key={`${myTournamentTable.id}:${myTournamentTable.series.games.length}`} roomId={roomId} tableId={myTournamentTable.id} refresh={view} tables={client} />
                  ) : undefined
                }
                gauntlet={tGauntletBoard}
              />
            ) : (
              mode !== null && (
              <>
            <section className="lobby__card">
              {/* Where the table stands sits on its heading's line, which has the
                  width to spare: a line added under the seats comes off the room's height. */}
              <div className="lobby__deckhead">
                <h2>At the table</h2>
                {startState !== null && (
                  <p className="lobby__note" data-testid="start-state">
                    {startState}
                  </p>
                )}
                {matchLink}
              </div>
              {/* Drawn as the draft room draws its seats (the operator, 2026-10-22: "can we also show seats the same way we show seats then in draft?"). */}
              <ul className="pod-seats pod-seats--table" data-testid="room-players">
                {[0, 1].map((seat) => {
                  const player = players[seat];
                  return player === undefined ? (
                    <li key={seat} className="pod-seats__seat" data-testid={`room-seat-${seat}-empty`}>
                      {/* Sitting is its own act (2026-10-12): dead once I hold a seat, once the table is locked, or once a match is under way. */}
                      <ActionButton
                        action="sit"
                        className="pod-seats__avatar pod-seats__avatar--open"
                        data-testid="seat-sit"
                        data-seat={seat}
                        aria-label={`Sit in seat ${seat + 1}`}
                        disabled={seated || tableLocked || underway}
                        onPress={sitDown}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      </ActionButton>
                      <span className="pod-seats__label">Open</span>
                      {/*
                       * Forge's AI takes this seat (the operator, 2026-10-02 and
                       * 2026-10-16): offered while nobody ELSE is seated, on the one
                       * empty seat that will not be mine — loading a deck seats me at
                       * the first free one. Live once I am seated with a legal deck;
                       * the server plays a random library deck legal in this room's
                       * pool, and holds the same gate.
                       */}
                      {botSeat === seat && (
                        <span className="pod-seats__actions">
                          <ActionButton
                            action="vs-bot"
                            className="pod-seats__action"
                            data-testid="play-vs-bot"
                            aria-label="Play the AI"
                            disabled={!canReady || underway}
                            onPress={mode === 'gauntlet' ? () => gauntletMove(() => client.gauntletReady(roomId, true, true)) : startVsBot}
                          >
                            AI
                          </ActionButton>
                        </span>
                      )}
                    </li>
                  ) : (
                    <PlayerRow
                      key={seat}
                      seat={seat}
                      player={{ ...player, ready: readyAt(seat) }}
                      avatarId={members.find((m) => m.name === player.name)?.avatarId}
                      leader={player.you ? iAmLeader : !iAmLeader && player.name === leaderMember?.name}
                      {...(player.you
                        ? {
                            onReady: () =>
                              mode === 'gauntlet' ? gauntletMove(() => client.gauntletReady(roomId, !readyAt(seat))) : setReady(!player.ready),
                            readyDisabled: !canReady || underway,
                          }
                        : {})}
                      {...(player.you ? { onStand: standUp, standDisabled: tableLocked || underway } : {})}
                    />
                  );
                })}
              </ul>
              {startRefused}
            </section>

            {mode === 'gauntlet' ? (
              // The board between games too, from the choice onward. From the choice to the board the
              // room stays the screen the choice was made on (the operator, 2026-10-21: *"let's go
              // stragiht from deck selection into the next game"*, and *"theres still an extra screen …
              // we need to get rid of this"*): the start, its refusal and the way back into a live game
              // are the table's, above it, as in every mode.
              gauntlet !== null && (
                <GauntletScreen
                  view={gauntlet}
                  avatars={seatAvatars(gauntlet, members)}
                  onBan={(deck) => gauntletMove(() => client.gauntletAct(roomId, 'ban', deck))}
                  onPick={(deck) => gauntletMove(() => client.gauntletAct(roomId, 'pick', deck))}
                  onChoose={(deck) => gauntletMove(() => client.gauntletChoose(roomId, deck))}
                />
              )
            ) : spectating ? (
              <section className="lobby__card">
                <p className="lobby__note" data-testid="room-spectator">
                  Table full &mdash; watching.
                </p>
              </section>
            ) : mySideboarding && players.some((p) => p.you) ? (
              <section className="lobby__card">
                <TableSideboard key={`${myTable.id}:${myTable.series.games.length}`} roomId={roomId} tableId={myTable.id} refresh={view} tables={client} />
              </section>
            ) : mode !== 'classic' ? null : loaded === null ? (
              loadError === null && <DeckCardSkeleton />
            ) : (
                <section className="lobby__card lobby__decks">
                  {/* The sets the chosen era is made of, as symbols — the operator's
                      own ask, for a Standard era. An
                      eternal format's forty-odd sets drew a strip the operator called
                      ridiculous (2026-10-07), so those draw none either. */}
                  {/* Beside them, the deck grid's filters. */}
                  <div className="lobby__setsrow">
                    {poolFormat !== null && isEra(poolFormat) && poolFormat.family === 'standard' && <PoolSets format={poolFormat} />}
                    <DeckFilterBar filter={deckFilter} onChange={setDeckFilter} />
                    {/* Random is a button and not one of the tiles because it is not a
                        state a deck can be in: it resolves to one of the decks on offer,
                        and the chooser then reads that deck (`chooseDeck`). */}
                    <button
                      type="button"
                      className="deckpick__random"
                      data-testid="deck-random"
                      data-deck-id={RANDOM_DECK}
                      disabled={deckOptions === null || underway}
                      onClick={() => chooseDeck(RANDOM_DECK)}
                    >
                      Random
                    </button>
                  </div>

                  {/* Only the decks the room's pool offers, and the pool's
                      answer is the gate's. Disabled until it has answered: an
                      option list assembled before the answer would offer decks
                      the pool does not have. */}
                  <span className="lobby__field lobby__field--hidden" id="deck-mine-label">
                    You play
                  </span>
                  <DeckChooser
                    options={visibleOptions ?? []}
                    empty={shownOptions !== null && shownOptions.length > 0 ? 'No decks' : undefined}
                    value={deckId}
                    disabled={deckOptions === null || underway}
                    pending={shownOptions === null}
                    pendingTiles={ROOM_SKELETON_TILES}
                    onChoose={chooseDeck}
                  />
                </section>
            )}
              </>
              )
            )}
          </>
        )}
          </>
        )}
      </main>
    </div>
  );
}

/* ── a draft room, before the cards exist ─────────────────────────────── */

/**
 * The draft room's lobby: who is here, who is ready, and the rule a person
 * would otherwise have to guess — *"every member ready, then bots take the
 * rest of the eight seats"*, the operator's own design and the difference
 * between this and the pod button it replaced, which auto-started against
 * seven bots.
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

/**
 * The line beside the table's heading, only while something is happening: who is waited on is the
 * seats' own ready rings and pills (the operator, 2026-10-22: "lets get rid of the 'Waiting for
 * Hadoku.' this is unecessary").
 */
function startStateText(starting: boolean, matchId: string | null): string | null {
  if (matchId !== null) return 'Match running — joining.';
  if (starting) return 'Starting Forge…';
  return null;
}

/** The leader's mark, our own five-point outline, on a 12-unit square. */
export const CROWN = 'M2 9V3.5l2.2 2L6 2.6l1.8 2.9L10 3.5V9Z';
/** A pass: the ready pill's tick. */
const TICK = 'M2.6 6.3 4.9 8.8 9.4 3.3';

/**
 * A status, drawn: a shape, a colour and a word.
 *
 * Colour alone is not a status — a third of the operator's friends could not
 * read it — so each state has its OWN SHAPE (`data-mark`, drawn in an inline
 * `<svg>` we own) and its own border style as well. `screens.css` colours it;
 * remove every colour from that file and this still reads.
 */
export function StatusPill({ testId, state, mark, label }: { testId: string; state: 'yes' | 'no'; mark: 'tick' | 'ring'; label: string }) {
  return (
    <span className="pill pill--ready" data-testid={testId} data-state={state} data-mark={mark}>
      <svg className="pill__mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {mark === 'tick' ? <path d={TICK} /> : <circle cx="6" cy="6" r="3.4" />}
      </svg>
      {label}
    </span>
  );
}

/**
 * One seat at the table, drawn as a draft seat is (`pod/PodSeats.tsx`, the operator, 2026-10-22: "can
 * we also show seats the same way we show seats then in draft?"): the member's avatar, ringed once
 * ready and crowned for the room's owner, their name under it, then the ready state as a
 * `StatusPill` (a button on my own seat), and Stand on mine.
 *
 * My own seat says so by `data-mine`, never in words beside my name (the operator, 2026-10-22:
 * "remove the (you) from the constructed table too").
 *
 * Only your own seat has deck lines, because only your own seat has a deck: the server sends
 * another seat as its name and its ready state (the operator, 2026-10-21: "don't reveal the deck
 * that someone has picked").
 */
function PlayerRow({
  seat,
  player,
  avatarId,
  onStand,
  standDisabled = false,
  leader = false,
  onReady,
  readyDisabled = false,
}: {
  seat: number;
  player: RoomPlayer;
  /** The seated member's watchparty avatar, the one `Avatar` draws everywhere else; `undefined` for none. */
  avatarId?: string;
  /** My own row only: the ready state is a button that sets it. */
  onReady?: () => void;
  readyDisabled?: boolean;
  /** This seat's player sets the table: a crown on their avatar. */
  leader?: boolean;
  /** My own row only: give the seat back (2026-10-12). */
  onStand?: () => void;
  standDisabled?: boolean;
}) {
  return (
    <li className="pod-seats__seat" data-testid={`room-seat-${seat}`} data-mine={player.you ? '' : undefined}>
      <span className="pod-seats__avatar-wrap">
        <span className="pod-seats__avatar" data-ready={player.ready ? 'true' : 'false'}>
          <Avatar id={avatarId} fallback="initial" name={player.name} className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
        </span>
        {leader && (
          <svg className="pod-seats__crown" data-testid="room-leader" viewBox="0 0 12 12" role="img" aria-label="Room owner">
            <title>Room owner</title>
            <path d={CROWN} />
          </svg>
        )}
      </span>
      <span className="pod-seats__label">{player.name}</span>
      {player.deck !== undefined && <OwnDeckCells seat={seat} deck={player.deck} />}
      {onReady === undefined ? (
        <StatusPill
          testId={`room-seat-${seat}-ready`}
          state={player.ready ? 'yes' : 'no'}
          mark={player.ready ? 'tick' : 'ring'}
          label={player.ready ? 'ready' : 'not ready'}
        />
      ) : (
        <ActionButton
          action={player.ready ? 'unready' : 'ready'}
          className="pill pill--ready pill--button"
          data-testid="ready-toggle"
          data-state={player.ready ? 'yes' : 'no'}
          data-mark={player.ready ? 'tick' : 'ring'}
          aria-pressed={player.ready}
          disabled={readyDisabled}
          onPress={onReady}
        >
          <svg className="pill__mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            {player.ready ? <path d={TICK} /> : <circle cx="6" cy="6" r="3.4" />}
          </svg>
          Ready
        </ActionButton>
      )}
      {onStand !== undefined && (
        <span className="pod-seats__actions">
          <ActionButton action="stand" className="pod-seats__action" data-testid="seat-stand" aria-label="Stand up" disabled={standDisabled} onPress={onStand}>
            Stand
          </ActionButton>
        </span>
      )}
    </li>
  );
}

/**
 * Your own seat's deck: its name and the pool's words for it. Not whether it is
 * legal: the picker offers only decks legal in the room's pool, and Ready is
 * what an unplayable deck holds back (the operator, 2026-10-21, of the pill that
 * said it: "ugly and unecessary").
 */
function OwnDeckCells({ seat, deck }: { seat: number; deck: SeatDeck | null }) {
  return (
    <>
      <span className="pod-seats__deck" data-testid={`room-seat-${seat}-deck`}>
        {deck?.name ?? '—'}
      </span>
      <span className="pod-seats__rules" data-testid={`room-seat-${seat}-rules`}>
        {deck?.rulesName ?? '—'}
      </span>
    </>
  );
}

/*
 * The room before it has answered: its own layout in outline, the same cards at
 * the same sizes, so the loaded room replaces it without anything moving (the
 * operator, 2026-10-16: *"can we show a loading skeleton before the room is
 * loaded? that would look better than an incremental rename of the page"*).
 * No words: `aria-busy` on the room says it is still coming.
 */
function RoomSkeleton() {
  return (
    <>
      <section className="lobby__card" data-testid="room-skeleton">
        <div className="lobby__deckhead">
          <span className="skeleton skeleton--heading" />
        </div>
        <ul className="pod-seats pod-seats--table">
          <li className="skeleton skeleton--seat" />
          <li className="skeleton skeleton--seat" />
        </ul>
      </section>
      <DeckCardSkeleton />
    </>
  );
}

/** The deck card before the catalogue has answered: its heading's row, the sets and filters, and tiles. */
function DeckCardSkeleton() {
  return (
    <section className="lobby__card lobby__decks" data-testid="deck-skeleton">
      <span className="skeleton skeleton--row" />
      <span className="skeleton skeleton--sets" />
      <div className="deckpick">
        <SkeletonTiles count={ROOM_SKELETON_TILES} />
      </div>
    </section>
  );
}

/** A room's deck card while it loads: twelve outlines (the operator, 2026-10-20). */
const ROOM_SKELETON_TILES = 12;

/** `count` deck tiles' outlines, each the size a tile is. */
function SkeletonTiles({ count }: { count: number }) {
  return Array.from({ length: count }, (_, i) => <span key={i} className="skeleton skeleton--tile" />);
}

/** `#/play` with no room: the room list is where a match starts now. */
function NoRoom() {
  return (
    <div className="shell" data-testid="constructed">
      <header className="shell__head">
        <h1 className="shell__title">Constructed</h1>
        <div className="shell__tools">
          <SettingsGear />
        </div>
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

