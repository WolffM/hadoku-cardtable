/*
 * The board: one game state, drawn.
 *
 * Renders a `BoardView` and nothing else. It has no idea whether the view came
 * from a committed fixture or a live stream — the same split that let the
 * draft's transport be swapped without touching `DraftScreen`. No socket, no
 * protocol, no fold: see `fixtures.ts` → `fold.ts` → `adapter.ts` for how a
 * view is made.
 *
 * ## The canvas is static, and that is absolute
 *
 * The operator, 2026-09-24: *"the location for the stack causes the field to
 * change in size. this can never happen. the entire canvas must be fully
 * static at all times."* So the board is a grid of FIXED tracks (`board.css`)
 * and every zone renders its slot whether or not it holds anything:
 *
 *   - a zone's card list is always in the markup, empty or not, so an empty
 *     zone is the same box as a full one;
 *   - a battlefield always draws all four of its rows (below), so a player's
 *     first artifact does not add a row to the table;
 *   - an opponent's hidden hand is always its backs strip, zero backs or ten;
 *   - the stack's band is a fixed height, holding nothing or five items —
 *     items overflow by scrolling INSIDE the band;
 *   - the missing-card alert and the overlay root are positioned out of flow,
 *     so neither can push a track when it appears.
 *
 * Nothing here is sized by its content. `Board.test.ts` renders the same view
 * with an empty, a one-item and a five-item stack and holds the structure
 * identical; `e2e/table-fit.spec.ts` measures the real boxes in a browser.
 *
 * ## The battlefield reads like a table: four labelled groups
 *
 * The operator, 2026-09-25: the battlefield's *"ordering random"*, and they
 * want lands, artifacts and creatures apart. So a battlefield is four groups
 * inside its one fixed slot — lands, artifacts, creatures, and everything else
 * — each with its label and its count, all four always drawn. A card's group is
 * read off its OWN type line (`BoardCard.card.typeLine`, which the adapter
 * already carries); nothing is asked of the engine and no rule is implemented
 * here. `rowFor` resolves an overlap by what the card is used as: an artifact
 * land is a land, an artifact creature is a creature.
 *
 * They are drawn as LANES ACROSS the slot rather than bands down it, and that
 * was measured, not chosen: the slot is 840 × 130 at 1280×800, where four
 * bands are a 21px card and four lanes are a 100px one. `board.css` has the
 * arithmetic. The attribute stays `data-board-row` — a row of the table, which
 * is what it is — and which axis the stylesheet draws it on is the
 * stylesheet's business.
 *
 * ## The arrangement is the player's, and it never leaves the browser
 *
 * Grouping is the DEFAULT order, not a cage. The viewer drags a permanent
 * within a row or into another row and it stays where they put it; `Regroup`
 * throws the arrangement away and the default grouping comes back. Two things
 * about this are load-bearing:
 *
 *   - **It sends nothing to Forge.** There is no wire message, no reply, no
 *     ask. It reorders what the VIEW draws, which is why a player may tidy a
 *     board in the middle of someone else's turn.
 *   - **It survives a resync.** A resync replaces the whole view (a new `seq`,
 *     every object again) and may remount this component; the arrangement
 *     lives in `ARRANGED`, a module-level store keyed by the match and the
 *     seat, holding card ids — so a new view, a new mount, or both, redraw the
 *     same arrangement. `forgetArrangements()` empties it, for a test that
 *     wants the default grouping back.
 *
 * A card the arrangement names that is no longer on the battlefield is
 * ignored, and a permanent that arrives while an arrangement stands joins the
 * end of its own row. Only the viewer's own battlefield is draggable: the
 * arrangement is theirs, and the opponent arranges their own side on their own
 * screen.
 *
 * ## Stacking: deliberate as well as free
 *
 * The operator, 2026-09-27: *"i dont want these snapping zones… put cards
 * wherever they want… snap above/below each other in any order"*. So a row is a
 * list of PILES rather than a list of cards, and which third of a card's box a
 * drop lands in says which of three things the player meant — stack on top of
 * it, stack under it, or reorder in front of it (`dropOnCard`). A drop on the
 * row's own box is still "at the end of this row, on its own", which is the
 * gesture `e2e/table-fit.spec.ts` drives.
 *
 * Forge's own client has this as two preferences — `UI_STACK_CREATURES` and
 * `UI_MAX_STACK_DEPTH` (default `4`, `ForgePreferences.java:93,96`, consumed by
 * `VField.java:33` and `VCardDisplayArea.java:380`). We took the idea and not
 * the implementation: stacking here is per pile rather than per player, it is
 * never automatic, and the depth is not refused — a pile of nine is drawn, with
 * the FAN capped at Forge's four so the offsets stay legible (`card.css`).
 * Refusing a drop the player made is worse than a tight fan.
 *
 * ## Forge's attachments are not the player's arrangement (#11)
 *
 * An equipped creature and its gear are one pile because `AttachedCards` says
 * so, and `withAttachments` applies that AFTER the player's arrangement — so
 * rearranging the board cannot separate them, and `Regroup` cannot either. The
 * player decides where the stack sits; Forge decides what is in it.
 *
 * ## A seat's furniture is a vertical bar at its side
 *
 * The operator, 2026-09-26: *"use a vertical bar for showing the players
 * health, avatar, name, hand, library. horizontal space is precious"*. So a
 * seat is no longer a wide header strip over its zones: the avatar, the life
 * on it, the name, the hand count and the library count stack in ONE narrow
 * column at the seat's left edge (`board.css`, `--who-w`), spanning both of
 * the seat's rows. The width that header used to spend on empty strip goes to
 * the battlefield, and the 2.5rem of HEIGHT it cost every seat pays for the
 * horizontal zone and lane labels below.
 *
 * **It supersedes the layout of wave 20's face anchoring, not its point.** The
 * operator, 2026-09-25: *"avatar and number looks slick, but confusing which
 * is which"* — so ours still reads as ours. Two things carry that, and both
 * are load-bearing:
 *
 *   - the bar is a grid of two tracks and the AVATAR BLOCK sits in the outer
 *     one: the first row for the opponent (the top of the board) and the last
 *     for the viewer (the bottom). The two faces are still as far apart as the
 *     canvas allows, with the stack's band between them, which is what
 *     `e2e/table-fit.spec.ts` measures;
 *   - the viewer's seat says so in words — `(you)` beside their name — and in
 *     `data-viewer`, on the seat and on the face.
 *
 * The counts are the other track, so a flag arriving mid-game ("their turn",
 * "priority") grows the track that has room rather than moving the face.
 *
 * ## Every label is horizontal
 *
 * The operator, 2026-09-26: *"vertical words are impossible to read, lets try
 * it differently"*. Nothing on this board is set rotated. A zone's label and a
 * battlefield lane's label are horizontal strips across the top of their own
 * slot, each a FIXED track (`board.css`), so they read straight and still
 * cannot be pushed by what the zone holds. `Board.test.ts` greps the
 * stylesheet for `writing-mode` and `rotate` to keep it that way; the one
 * rotation left on the board is a TAPPED CARD, which is a card turned
 * sideways and not a word (`card.css`).
 *
 * ## No prose
 *
 * The operator, 2026-09-24: *"this text is completely unnecessary: 'Stack 0
 * / empty'"*. There is no empty-state text, no hint and no explanation
 * anywhere on this board. A zone shows its label and its count; when it holds
 * nothing it shows its slot and nothing else. Do not reintroduce a sentence
 * here.
 *
 * ## Cards are `CardTile`
 *
 * Every card on the board is the draft's own `CardTile`, unchanged — our
 * layout, our pips, and art through the art resolver (`draft/cardImage.ts` →
 * `@hadoku/carddata/art`) from the Scryfall id the adapter looked up. No host
 * is named here. A card with no id is the text tile, which is a whole card on
 * its own. The board adds only the state a printed card doesn't have (damage,
 * counters, attacking), as chips beside the tile, in our own words. A stack
 * item draws its source card the same way, from `StackEntry.sourceCard`.
 *
 * ## P/T on the board is the board's badge, not the tile's stat
 *
 * A creature on a battlefield wears `3 / 1` — the current power and what is
 * LEFT of the toughness — in a badge this file draws (`PowerToughness`), because
 * the art covers `CardTile`'s printed `.card__stat` and `CardTile` is not this
 * lane's file. `adapter.ts`'s `boardPT` decides what the numbers mean; this
 * decides what they look like. Buffed is blue, hurt is red, and — settled at
 * dispatch — **colour is never the only signal**: each state also carries a
 * marker glyph, a heavier weight, and the whole thing in words in the badge's
 * accessible name. A card whose printed base our data does not know draws
 * plain, which is the honest answer and never a guessed buff.
 *
 * ## Tapped is turned sideways
 *
 * A tapped card is rotated a quarter turn inside a landscape box of the same
 * width (`card.css`), so it reads as tapped at a glance and still takes no
 * more room than its column. It keeps the word "tapped" as a chip as well.
 *
 * ## What is clickable is Forge's answer, not ours
 *
 * `interaction` carries the ids Forge last sent in `setSelectables`. A card
 * whose id is in that set is a real `<button>` — focusable, Enter/Space work —
 * and calls `onSelectCard`; any other card is inert markup with no handler at
 * all, so there is nothing to call. Players are the same, from
 * `selectablePlayers`: a selectable seat's name and its face are both buttons,
 * and an unselectable one is neither. This file never decides what may be
 * selected: we implement no rules. With no `interaction` every card is inert.
 *
 * The one control on this board that is ours rather than Forge's is `Regroup`,
 * which answers no question and sends nothing.
 *
 * ## The DOM is the seam with the interaction and inspector lanes
 *
 * Other lanes draw a targeter arrow and enlarge a card under the pointer; they
 * find things without owning this markup. What is guaranteed here, and pinned
 * by a test:
 *
 *   - every card in a zone carries `data-card-id="<id>"`, and `<id>` is unique
 *     across the board (it also keeps `data-board-card`, the older name, with
 *     the same value — other suites query it). A stack item does NOT carry
 *     `data-card-id`: the card an ability came from is still on its
 *     battlefield, so the id would be there twice and uniqueness is the
 *     property the arrow needs. The item names its card in `data-source-card`.
 *
 *     **`CardTile` draws its own `data-card-id` too, and it is a different
 *     namespace**: the draft's card id, `w<forge id>` (`adapter.ts:317`). So
 *     `[data-card-id="107"]` is this board's card 107 and nothing else, but a
 *     bare `[data-card-id]` or a `closest()` also matches the tile inside it.
 *     Match on the value, not the attribute.
 *
 *   - every player's face carries `data-player-face` and `data-player-id`, and
 *     lives in that seat's `[data-player-bar]` — the vertical bar, which is
 *     NOT a zone and carries no `data-zone`, because the set of zones on this
 *     board is itself asserted;
 *   - every zone carries `data-zone` and `data-owner` (`you`, `them`, or
 *     `table` for the stack, which belongs to no seat);
 *   - a battlefield's rows each carry `data-board-row` (`lands`, `artifacts`,
 *     `creatures`, `other`), in that order, and `data-empty` when the row
 *     holds nothing. A draggable card carries `draggable` and the viewer's
 *     battlefield carries one `[data-arrange-reset]` control;
 *
 *     **A row's `:scope > ul.zone__cards > li.board-card` children are its
 *     PILES, one per visual column** — the bottom card of each. The cards above
 *     it are `li.board-card` inside that element's own `ul.board-card__pile`,
 *     each with its own `data-card-id` and its `data-pile-depth`. A lone card is
 *     a pile of one and carries neither attribute. So a descendant query for
 *     `[data-card-id="<id>"]` still finds exactly one element anywhere on the
 *     board, and a `:scope >` query still measures one card's box;
 *
 *   - this lane's gesture is HTML5 DRAG-AND-DROP and nothing else:
 *     `dragstart` / `dragend` on a battlefield card's `<li>`, `dragover` /
 *     `drop` on that `<li>` and on the row's `<li>`. **No pointer event is bound
 *     anywhere in this file**, so the interaction lane's delegated pointer
 *     handling has the pointer to itself. Nothing here reads, writes or styles
 *     `data-attack-intent`; this lane's own attributes are `data-arrange-reset`,
 *     `data-pile-size`, `data-pile-depth`, `data-attached` and `data-pt*`;
 *
 *     **`draggable` and `data-selectable` are mutually exclusive, and that is
 *     the seam, not a detail.** A `draggable="true"` element starts the
 *     browser's native drag from the same press the interaction lane starts a
 *     targeter drag on, and that lane starts one over any card Forge is
 *     offering — so an offered card that was also draggable would fire both
 *     gestures at once. A card Forge offers is never draggable here
 *     (`CardOnBoard`), which means a natively-draggable element is by
 *     construction never one Forge offered;
 *   - `data-board-overlay` is a positioned root covering the canvas exactly,
 *     at the board's top level, for those lanes to render into. This file adds
 *     no pointer handler to it and draws nothing in it.
 *
 * The inspector (`inspect/index.ts`) is BOOTED here — one mount effect on the
 * board's root element, disposed on unmount — and that is the whole of this
 * file's involvement with it: it attaches its own listeners, by delegation,
 * and renders into the overlay root. No handler, prop or markup here is for
 * it.
 *
 * ## Hidden information
 *
 * An opponent's hand arrives as `hand: null` and a count (`adapter.ts`), and is
 * drawn as that many card backs — our own pattern, not Magic's back. There is
 * no card object to render, so no face can leak through here.
 *
 * ## Layout
 *
 * The opponent on top with their bar's face at its head, a centre band holding
 * the stack, the viewer at the bottom with their hand and their bar's face at
 * its foot. Page layout is `board.css`; how a single card looks is `card.css`,
 * sized from `--card-w` so the layout can shrink cards per zone.
 */

import { useEffect, useReducer, useRef, type DragEvent, type ReactNode } from 'react';

import { CardTile } from '../components/CardTile.tsx';
import { boardPT, type BoardCard, type BoardPlayer, type BoardView, type PTState, type StackEntry } from './adapter.ts';
import { mountInspector } from './inspect/index.ts';
import './board.css';
import './card.css';

/** What Forge currently lets the viewer click, and where a click goes. */
export interface BoardInteraction {
  /** Card ids Forge currently says are selectable (from setSelectables). */
  selectable: ReadonlySet<number>;
  /** Player ids Forge currently says are selectable. */
  selectablePlayers: ReadonlySet<number>;
  /** A card was clicked. Only ever called for an id in `selectable`. */
  onSelectCard(cardId: number): void;
  onSelectPlayer(playerId: number): void;
}

/** Which side of the table a zone is on. The stack belongs to neither. */
type ZoneOwner = 'you' | 'them' | 'table';

/* ── the battlefield's rows ───────────────────────────────────────────── */

/** The battlefield's rows, top to bottom. Every battlefield draws all four. */
const BOARD_ROWS = ['lands', 'artifacts', 'creatures', 'other'] as const;
type BoardRow = (typeof BOARD_ROWS)[number];

const ROW_LABEL: Readonly<Record<BoardRow, string>> = {
  lands: 'Lands',
  artifacts: 'Artifacts',
  creatures: 'Creatures',
  other: 'Other',
};

/**
 * Which row a permanent belongs in, from its own type line.
 *
 * Read off the types, never the subtypes — `Artifact — Equipment` is an
 * artifact and nothing here should care that "Equipment" is a word. An overlap
 * resolves to what the card is USED as, which is why the order below is land,
 * then creature, then artifact: an artifact land is tapped for mana and an
 * artifact creature attacks.
 */
function rowFor(card: BoardCard): BoardRow {
  const types = card.card.typeLine.split('—')[0] ?? '';
  if (/\bLand\b/i.test(types)) return 'lands';
  if (/\bCreature\b/i.test(types)) return 'creatures';
  if (/\bArtifact\b/i.test(types)) return 'artifacts';
  return 'other';
}

/**
 * A pile: cards drawn as one, BOTTOM FIRST. A lone card is a pile of one, and
 * that is the overwhelming case — a battlefield with nothing stacked and nothing
 * attached draws exactly the markup it drew before piles existed.
 */
type Pile = readonly BoardCard[];

/** One battlefield, in rows of piles. Always all four keys, in `BOARD_ROWS` order. */
type Grouped = Readonly<Record<BoardRow, readonly Pile[]>>;

/**
 * The player's own arrangement, as PILES of card ids per `<playerId>:<row>`. A
 * row the store does not name is drawn in the view's order, each card on its
 * own; a row it names is drawn in the player's piles, and then anything the
 * store has never heard of, in the view's order.
 */
type Arrangement = Readonly<Record<string, readonly (readonly number[])[]>>;

const NO_ARRANGEMENT: Arrangement = {};
const slotKey = (playerId: number, row: BoardRow): string => `${playerId}:${row}`;

/** How many cards a row holds, across all its piles. */
const cardsIn = (piles: readonly Pile[]): number => piles.reduce((n, p) => n + p.length, 0);

/**
 * Every match's arrangement, in the browser and nowhere else — not on the
 * wire, not in the view, not in React state, because a resync may remount the
 * board and React state would go with it. Keyed by the match so two matches in
 * one session do not inherit each other's tidying.
 */
const ARRANGED = new Map<string, Arrangement>();

/** Which match a view is: its title and its seats. */
function matchKey(view: BoardView): string {
  return `${view.title}|${view.players.map((p) => p.id).join(',')}`;
}

/** Forget every match's arrangement. For a test that wants the default grouping. */
export function forgetArrangements(): void {
  ARRANGED.clear();
}

/**
 * A battlefield's rows: what the player arranged first, then everything else in
 * the row its type puts it in — and Forge's attachments folded in on top of
 * both.
 *
 * Every card appears exactly once whatever the store says — an id the store
 * lists twice, or lists for a card that has left the battlefield, cannot
 * duplicate a card or lose one. `data-card-id` is unique across the board and
 * three other lanes depend on that.
 */
function group(cards: readonly BoardCard[], playerId: number, arranged: Arrangement): Grouped {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows: Record<BoardRow, BoardCard[][]> = { lands: [], artifacts: [], creatures: [], other: [] };
  const placed = new Set<number>();
  for (const row of BOARD_ROWS) {
    for (const pile of arranged[slotKey(playerId, row)] ?? []) {
      const members: BoardCard[] = [];
      for (const id of pile) {
        const card = byId.get(id);
        if (card === undefined || placed.has(id)) continue;
        placed.add(id);
        members.push(card);
      }
      if (members.length > 0) rows[row].push(members);
    }
  }
  for (const card of cards) {
    if (!placed.has(card.id)) rows[rowFor(card)].push([card]);
  }
  return withAttachments(rows, cards);
}

/**
 * Forge's attachments, drawn as one stack with what they are attached to — and
 * drawn that way whatever the player arranged, because this is the engine's
 * truth about the board rather than the player's opinion about it (#11).
 *
 * The relation is read from the HOST's `AttachedCards`, never from the
 * attachment's `EntityAttachedTo`: that one is a bare int that may name a card
 * or a player and the two id spaces overlap (`adapter.ts`'s header).
 *
 * An attachment joins its host's pile wherever the player has put that host, so
 * rearranging cannot separate an equipped creature from its gear; only cards on
 * THIS battlefield are folded in, so an aura you control on their creature stays
 * a card on your own side, which is where Forge lists it.
 *
 * With nothing attached this returns the rows it was given, unchanged — the
 * common case costs one map and no allocation.
 */
function withAttachments(rows: Record<BoardRow, BoardCard[][]>, cards: readonly BoardCard[]): Grouped {
  const byId = new Map(cards.map((c) => [c.id, c]));
  /** attachment id → the host that claims it. First claim wins. */
  const hostOf = new Map<number, number>();
  for (const card of cards) {
    for (const attached of card.attachedCardIds ?? []) {
      if (attached === card.id || !byId.has(attached) || hostOf.has(attached)) continue;
      hostOf.set(attached, card.id);
    }
  }
  if (hostOf.size === 0) return rows;

  /** The bottom of a chain (equipment on a creature, an aura on that equipment). */
  const rootHost = (id: number): number => {
    const seen = new Set<number>([id]);
    let at = id;
    for (;;) {
      const next = hostOf.get(at);
      if (next === undefined || seen.has(next)) return at;
      seen.add(next);
      at = next;
    }
  };

  const out: Record<BoardRow, BoardCard[][]> = { lands: [], artifacts: [], creatures: [], other: [] };
  /** Which pile array a host ended up in, so its attachments can be spliced into it. */
  const home = new Map<number, BoardCard[]>();
  for (const row of BOARD_ROWS) {
    for (const pile of rows[row]) {
      const kept = pile.filter((c) => rootHost(c.id) === c.id);
      if (kept.length === 0) continue;
      out[row].push(kept);
      for (const c of kept) home.set(c.id, kept);
    }
  }
  for (const card of cards) {
    if (rootHost(card.id) === card.id) continue;
    const pile = home.get(rootHost(card.id));
    // A host that is itself an attachment of an attachment in a cycle has no
    // home; its gear is still drawn, on its own, rather than lost.
    if (pile === undefined) {
      out[rowFor(card)].push([card]);
      continue;
    }
    const at = pile.findIndex((c) => c.id === hostOf.get(card.id));
    pile.splice(at === -1 ? pile.length : at + 1, 0, card);
  }
  return out;
}

/**
 * Where a drop landed, and so what the player meant by it.
 *
 * A row's own box is "at the end of this row, on its own". A CARD is three
 * targets, because the operator asked for two different things at once — *"put
 * cards wherever they want"* and *"snap above/below each other in any order"*:
 *
 *   - its top third: stack ON TOP of that card;
 *   - its bottom third: stack UNDERNEATH it;
 *   - its middle: the old behaviour, in front of that card's pile.
 */
type DropTarget =
  | { kind: 'row' }
  | { kind: 'before'; id: number }
  | { kind: 'stack'; id: number; onTop: boolean };

/**
 * A drop on a card, read off the pointer's height in that card's box.
 *
 * With no geometry to read it is a reorder, which is what a drop on a card has
 * always meant. Both halves of "no geometry" happen for real: an element with no
 * layout has a zero-height rect, and `clientY` is absent whenever the drop was
 * not a real `DragEvent` — jsdom has no `DragEvent` at all, so a suite that
 * wants the stacking thirds has to give the element a box AND put `clientY` on
 * the event it dispatches, exactly as a browser does.
 */
function dropOnCard(rect: { top: number; height: number }, clientY: number | undefined, id: number): DropTarget {
  const at = clientY === undefined || !(rect.height > 0) ? NaN : (clientY - rect.top) / rect.height;
  if (at < 1 / 3) return { kind: 'stack', id, onTop: true };
  if (at > 2 / 3) return { kind: 'stack', id, onTop: false };
  return { kind: 'before', id };
}

/**
 * The arrangement after a drag: `cardId` lands in `row`, at `target`.
 *
 * All four rows are written out, not just the two the card moved between: what
 * the player is looking at becomes what is stored, so the next permanent to
 * arrive joins the end of its row instead of landing in the middle of an order
 * they arranged. Forge's attachments are written out with it and re-applied on
 * the next render, so an equip stack survives every one of these moves.
 */
function withMove(
  rows: Grouped,
  playerId: number,
  arranged: Arrangement,
  cardId: number,
  row: BoardRow,
  target: DropTarget,
): Arrangement {
  const piles: Record<BoardRow, number[][]> = { lands: [], artifacts: [], creatures: [], other: [] };
  for (const r of BOARD_ROWS) {
    piles[r] = rows[r].map((p) => p.map((c) => c.id).filter((id) => id !== cardId)).filter((p) => p.length > 0);
  }
  const into = piles[row];
  if (target.kind === 'row') {
    into.push([cardId]);
  } else {
    const index = into.findIndex((p) => p.includes(target.id));
    if (index === -1) into.push([cardId]);
    else if (target.kind === 'before') into.splice(index, 0, [cardId]);
    else {
      const pile = into[index]!;
      const at = pile.indexOf(target.id);
      pile.splice(target.onTop ? at + 1 : at, 0, cardId);
    }
  }
  const next: Record<string, readonly (readonly number[])[]> = { ...arranged };
  for (const r of BOARD_ROWS) next[slotKey(playerId, r)] = piles[r];
  return next;
}

/** The arrangement with one seat's rows thrown away: the default grouping is back. */
function withoutSeat(playerId: number, arranged: Arrangement): Arrangement {
  const next: Record<string, readonly (readonly number[])[]> = { ...arranged };
  for (const row of BOARD_ROWS) delete next[slotKey(playerId, row)];
  return next;
}

/**
 * The drag, as the markup sees it. Present only on the viewer's own
 * battlefield; every other zone gets `undefined` and renders no drag
 * affordance at all.
 */
interface Arranging {
  start(event: DragEvent, cardId: number): void;
  over(event: DragEvent): void;
  /** Dropped on a card: which third of its box decides stack-above, stack-below or reorder. */
  dropOn(event: DragEvent<HTMLElement>, row: BoardRow, cardId: number): void;
  /** Dropped on the row's own box: the row's end, on its own. */
  dropInRow(event: DragEvent, row: BoardRow): void;
  /** A drag that ended anywhere — including outside the board — carries nothing now. */
  end(): void;
  regroup(): void;
}

/** `{T}` is a WotC mark; on our chrome it is the word. */
function inOurWords(text: string): string {
  return text.replace(/\{T\}/g, 'TAP');
}

/**
 * What a buffed or a hurt number wears BESIDES its colour.
 *
 * Settled at dispatch: *colour may never be the only signal*. So each state
 * carries a marker glyph and a weight of its own as well as an ink, and the
 * badge says the whole thing in words in its accessible name. The glyphs are
 * geometry, not typography that might not render: `▲` and `▼`.
 */
const PT_MARK: Readonly<Record<'buffed' | 'hurt', string>> = { buffed: '▲', hurt: '▼' };

/**
 * A creature's power and toughness, as the operator asked for them (#12, #18):
 * *"3 (blue) / 1 (red)"* — the current power, and what is LEFT of the toughness.
 *
 * `adapter.ts`'s `boardPT` decides what the numbers mean; this draws them. It
 * is the board's own badge rather than the tile's `.card__stat`, because the art
 * covers the tile and the printed stat with it, and because `CardTile` is not
 * this lane's file.
 *
 * A card whose printed base our data does not know draws PLAIN — no ink, no
 * marker — and never claims a buff it cannot know about.
 */
function PowerToughness({ entry }: { entry: BoardCard }) {
  const pt = boardPT(entry);
  if (pt === null) return null;
  const say = (what: string, value: number, state: PTState): string =>
    state === 'buffed'
      ? `${what} ${value}, up from ${what === 'power' ? pt.printed?.power : pt.printed?.toughness}`
      : state === 'hurt'
        ? `${what} ${value}, ${pt.damage > 0 && what === 'toughness' ? `${pt.damage} damage marked` : 'down'}`
        : `${what} ${value}`;
  const number = (value: number, state: PTState, which: string) => (
    <span className="board-card__pt-n" data-pt-state={state === 'plain' ? undefined : state} data-pt-of={which}>
      {state === 'plain' ? null : <span aria-hidden="true">{PT_MARK[state]}</span>}
      {value}
    </span>
  );
  return (
    <span
      className="board-card__pt"
      data-pt=""
      aria-label={`${say('power', pt.power, pt.powerState)}, ${say('toughness', pt.toughness, pt.toughnessState)}`}
    >
      {number(pt.power, pt.powerState, 'power')}
      <span aria-hidden="true">/</span>
      {number(pt.toughness, pt.toughnessState, 'toughness')}
    </span>
  );
}

/**
 * One card, and — when it is the bottom of a pile — everything stacked on it.
 *
 * The pile's own `<li>` IS the bottom card, and the cards above it are a nested
 * list inside it. That shape is load-bearing in two directions:
 *
 *   - a battlefield row still answers `:scope > ul.zone__cards > li.board-card`
 *     with one element per VISUAL column, which is what `e2e/table-fit.spec.ts`
 *     measures a card's width from and what `e2e/play.spec.ts` walks;
 *   - every card keeps its own `data-card-id` at its own depth, unique across
 *     the board, which is what the other three lanes read.
 *
 * A lone card renders exactly the markup it rendered before piles existed: no
 * wrapper, no nested list, no extra attribute. Only a pile of two or more is
 * different, and only inside its own box (`card.css` fans it within one card's
 * width — nothing about a pile changes the slot it is in).
 */
function CardOnBoard({
  entry,
  interaction,
  arranging,
  row,
  pile,
  depth = 0,
}: {
  entry: BoardCard;
  interaction: BoardInteraction | undefined;
  arranging?: Arranging;
  /** Set on a battlefield, and only there. A hand or a pile has no row. */
  row?: BoardRow;
  /** The whole pile, on its bottom card. Absent for a lone card and for members. */
  pile?: Pile;
  /** 0 for the bottom of a pile, 1 for the card on it, and so on. */
  depth?: number;
}) {
  const chips: string[] = [];
  if (entry.tapped) chips.push('tapped');
  if (entry.summoningSick) chips.push('summoning sick');
  if (entry.attacking) chips.push('attacking');
  if (entry.blocking) chips.push('blocking');
  // Damage is the red half of the P/T badge when there is one; saying it twice
  // on a 70px card is noise, and the badge carries the number and the words.
  if (entry.damage > 0 && boardPT(entry) === null) chips.push(`${entry.damage} damage`);
  if (entry.token) chips.push('token');
  for (const c of entry.counters) chips.push(`${c.count} ${c.name}`);

  const selectable = interaction !== undefined && interaction.selectable.has(entry.id);
  /*
   * A card Forge is OFFERING belongs to Forge, and `!selectable` is what says so
   * to the pointer.
   *
   * Without it the two gestures on this board are not exclusive and both fire on
   * one press. The interaction lane starts its targeter drag on `pointerdown`
   * over any card in `interaction.selectable` (`live/gestures/install.ts`), and a
   * `draggable="true"` element ALSO starts the browser's own HTML5 drag from the
   * same press — so a press-and-move on an offered card on your own battlefield
   * would both rearrange the board and send a `selectCard` on release. That is
   * worst on exactly the cards that matter most: your own lands during a payment,
   * your own creatures while something is targeting.
   *
   * So arranging is what you do with a card Forge is not asking about, which is
   * the wave's "Forge decides, we render its answer" rule applied to a gesture
   * rather than to a rule. Both gestures keep working, and neither has to guess
   * what the other is doing: the attribute the browser reads is the same fact the
   * pointer lane tests.
   */
  const draggable = arranging !== undefined && row !== undefined && !selectable;
  const above = pile === undefined ? [] : pile.slice(1);

  return (
    <li
      className="board-card"
      data-tapped={entry.tapped || undefined}
      data-board-card={entry.id}
      data-card-id={entry.id}
      data-selectable={selectable || undefined}
      /* Forge says this card is attached to something: not the player's doing. */
      data-attached={(entry.attachedToId ?? null) !== null || undefined}
      data-pile-size={above.length > 0 ? pile!.length : undefined}
      data-pile-depth={depth > 0 ? depth : undefined}
      draggable={draggable || undefined}
      onDragStart={draggable ? (e) => arranging.start(e, entry.id) : undefined}
      onDragEnd={draggable ? () => arranging.end() : undefined}
      onDragOver={draggable ? (e) => arranging.over(e) : undefined}
      onDrop={draggable ? (e) => arranging.dropOn(e, row, entry.id) : undefined}
    >
      {selectable ? (
        <button
          type="button"
          className="board-card__face"
          aria-label={`Select ${entry.card.name}${entry.tapped ? ', tapped' : ''}`}
          onClick={() => interaction.onSelectCard(entry.id)}
        >
          <CardTile card={entry.card} />
        </button>
      ) : (
        <div className="board-card__face">
          <CardTile card={entry.card} />
        </div>
      )}
      {row !== undefined && <PowerToughness entry={entry} />}
      {chips.length > 0 && (
        <ul className="board-card__chips" aria-label={`${entry.card.name} status`}>
          {chips.map((chip) => (
            <li key={chip} className="board-card__chip">
              {chip}
            </li>
          ))}
        </ul>
      )}
      {above.length > 0 && (
        <ul className="board-card__pile" aria-label={`Stacked on ${entry.card.name}`}>
          {above.map((c, i) => (
            <CardOnBoard
              key={c.id}
              entry={c}
              interaction={interaction}
              arranging={arranging}
              row={row}
              depth={i + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One zone's slot. The list is always rendered, empty or not: its box is the
 * zone's box, and an empty zone that drew something else instead (a word, a
 * shorter element, nothing at all) would be a different size from a full one.
 */
function Zone({
  owner,
  ownerSide,
  zone,
  label,
  cards,
  interaction,
}: {
  owner: string;
  ownerSide: ZoneOwner;
  zone: string;
  label: string;
  cards: readonly BoardCard[];
  interaction: BoardInteraction | undefined;
}) {
  return (
    <ZoneShell owner={owner} ownerSide={ownerSide} zone={zone} label={label} count={cards.length}>
      <ul className="zone__cards">
        {cards.map((c) => (
          <CardOnBoard key={c.id} entry={c} interaction={interaction} />
        ))}
      </ul>
    </ZoneShell>
  );
}

/** A zone's box, its label and its count. What goes inside is the caller's. */
function ZoneShell({
  owner,
  ownerSide,
  zone,
  label,
  count,
  gutter,
  children,
}: {
  owner: string;
  ownerSide: ZoneOwner;
  zone: string;
  label: string;
  count: number;
  gutter?: ReactNode;
  children: ReactNode;
}) {
  const head = (
    <h4 className="zone__head">
      {label} <span className="zone__count">{count}</span>
    </h4>
  );
  return (
    <section
      className={`zone zone--${zone}`}
      aria-label={`${owner} ${label}`}
      data-zone={zone}
      data-owner={ownerSide}
      data-count={count}
    >
      {gutter === undefined ? (
        head
      ) : (
        <div className="zone__gutter">
          {head}
          {gutter}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A battlefield: four labelled rows in one fixed slot, all four always drawn.
 * The rows are the default ordering and the player's own arrangement on top of
 * it; `arranging` is present only on the viewer's own side.
 */
function Battlefield({
  player,
  ownerSide,
  interaction,
  arranging,
  arranged,
}: {
  player: BoardPlayer;
  ownerSide: ZoneOwner;
  interaction: BoardInteraction | undefined;
  arranging: Arranging | undefined;
  arranged: Arrangement;
}) {
  const rows = group(player.battlefield, player.id, arranged);
  return (
    <ZoneShell
      owner={player.name}
      ownerSide={ownerSide}
      zone="battlefield"
      label="Battlefield"
      count={player.battlefield.length}
      gutter={
        arranging === undefined ? undefined : (
          <button
            type="button"
            className="zone__regroup"
            data-arrange-reset=""
            aria-label="Regroup your battlefield"
            onClick={arranging.regroup}
          >
            Regroup
          </button>
        )
      }
    >
      <ul className="zone__rows">
        {BOARD_ROWS.map((row) => (
          <li
            key={row}
            className="zone__row"
            data-board-row={row}
            data-empty={rows[row].length === 0 || undefined}
            /*
             * A lane's share of the battlefield's width is how many COLUMNS it
             * draws — its piles, not its cards — so every card on the board comes
             * out the same width whatever the split is (`board.css`). A stack
             * takes one card's width, which is the whole point of stacking, and
             * the lane it is in asks for one card's worth of room. A lane holding
             * nothing takes its label's width and the stylesheet decides that,
             * not this number.
             */
            style={{ flexGrow: rows[row].length }}
            onDragOver={arranging === undefined ? undefined : (e) => arranging.over(e)}
            onDrop={arranging === undefined ? undefined : (e) => arranging.dropInRow(e, row)}
          >
            <h5 className="zone__row-head">
              {ROW_LABEL[row]} <span className="zone__count">{cardsIn(rows[row])}</span>
            </h5>
            <ul className="zone__cards">
              {rows[row].map((pile) => (
                <CardOnBoard
                  key={pile[0]!.id}
                  entry={pile[0]!}
                  interaction={interaction}
                  arranging={arranging}
                  row={row}
                  pile={pile}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </ZoneShell>
  );
}

/**
 * Someone else's hand: a count, drawn as that many backs. There is no card
 * here to draw a face from — the adapter never maps these cards. The strip is
 * always in the markup so the slot is one height at nought backs and at ten.
 */
function HiddenHand({ player }: { player: BoardPlayer }) {
  return (
    <section
      className="zone zone--hand"
      aria-label={`${player.name} Hand`}
      data-zone="hand"
      data-owner="them"
      data-count={player.handCount}
    >
      <h4 className="zone__head">
        Hand <span className="zone__count">{player.handCount}</span>
      </h4>
      <ul className="card-backs" aria-hidden="true">
        {Array.from({ length: player.handCount }, (_, i) => (
          <li key={i} className="card-back" data-card-back="" />
        ))}
      </ul>
    </section>
  );
}

/**
 * A player, as a thing you can point at: our own drawn mark with their life on
 * it. Arena's affordance, none of its art — shapes in an inline `<svg>`, no
 * image, no asset, and no WotC mark anywhere near it.
 *
 * It is a `<button>` exactly when Forge says the player may be selected, the
 * same rule the cards follow, and it carries `data-player-face` so the
 * interaction lane can anchor an arrow on it without reading this file.
 *
 * It sits at the OUTER end of its seat's vertical bar — the top of the board
 * for the opponent, the bottom for the viewer (`board.css`) — because the
 * operator could not tell the two apart when both were in the centre band.
 *
 * The badge on the mark is the seat's one life total: `data-testid="life"` is
 * here and nowhere else, so the number a seat shows is the number the avatar
 * shows. `e2e/play.spec.ts` reads it inside `[data-testid="player"]` and
 * compares it to the view, so its text is the number and nothing else.
 */
function PlayerFace({ player, interaction }: { player: BoardPlayer; interaction: BoardInteraction | undefined }) {
  const selectable = interaction !== undefined && interaction.selectablePlayers.has(player.id);
  const mark = (
    <>
      <svg className="face__art" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <circle className="face__plate" cx="24" cy="24" r="22.5" />
        <circle className="face__brow" cx="24" cy="18" r="7.5" />
        <path className="face__bust" d="M10.5 40.5a13.5 13.5 0 0 1 27 0Z" />
      </svg>
      <span className="face__life" data-testid="life">
        {player.life}
      </span>
    </>
  );
  return (
    <div
      className="face"
      data-player-face=""
      data-player-id={player.id}
      data-viewer={player.isViewer || undefined}
      data-active={player.isActive || undefined}
      data-lost={player.hasLost || undefined}
      data-selectable={selectable || undefined}
    >
      {selectable ? (
        <button
          type="button"
          className="face__hit"
          aria-label={`Select ${player.name}`}
          onClick={() => interaction.onSelectPlayer(player.id)}
        >
          {mark}
        </button>
      ) : (
        <div className="face__hit">{mark}</div>
      )}
      <span className="face__name">{player.name}</span>
    </div>
  );
}

function PlayerArea({
  player,
  interaction,
  arranging,
  arranged,
}: {
  player: BoardPlayer;
  interaction: BoardInteraction | undefined;
  arranging: Arranging | undefined;
  arranged: Arrangement;
}) {
  const selectable = interaction !== undefined && interaction.selectablePlayers.has(player.id);
  const side: ZoneOwner = player.isViewer ? 'you' : 'them';
  const name = (
    <>
      {player.name}
      {player.isViewer && <span className="seat__you"> (you)</span>}
    </>
  );
  return (
    <section
      className="seat"
      data-testid="player"
      data-player-id={player.id}
      data-viewer={player.isViewer || undefined}
      data-selectable={selectable || undefined}
      aria-label={player.isViewer ? `${player.name} (you)` : player.name}
    >
      {/*
       * The seat's furniture, in one narrow column at its side: the avatar
       * with its life, the name, then the counts. Two blocks and two fixed
       * grid tracks (`board.css`) — the avatar block in the seat's OUTER track
       * so the two faces stay at opposite ends of the canvas, the counts in the
       * one that has the slack, so a flag arriving mid-game cannot move a face.
       */}
      <div className="seat__who" data-player-bar="">
        <div className="seat__ident">
          <PlayerFace player={player} interaction={interaction} />
          <h3 className="seat__name">
            {selectable ? (
              <button
                type="button"
                className="seat__select"
                aria-label={`Select ${player.name}`}
                onClick={() => interaction.onSelectPlayer(player.id)}
              >
                {name}
              </button>
            ) : (
              name
            )}
          </h3>
        </div>
        <div className="seat__counts">
          <span data-testid="hand-count">hand {player.handCount}</span>
          <span data-testid="library-count">library {player.libraryCount}</span>
          {player.isActive && <span className="seat__flag">their turn</span>}
          {player.hasPriority && <span className="seat__flag">priority</span>}
          {player.hasLost && <span className="seat__flag seat__flag--lost">lost</span>}
        </div>
      </div>

      <Battlefield
        player={player}
        ownerSide={side}
        interaction={interaction}
        arranging={arranging}
        arranged={arranged}
      />
      <div className="seat__piles">
        <Zone
          owner={player.name}
          ownerSide={side}
          zone="graveyard"
          label="Graveyard"
          cards={player.graveyard}
          interaction={interaction}
        />
        <Zone owner={player.name} ownerSide={side} zone="exile" label="Exile" cards={player.exile} interaction={interaction} />
      </div>
      {player.hand !== null ? (
        <Zone owner={player.name} ownerSide={side} zone="hand" label="Hand" cards={player.hand} interaction={interaction} />
      ) : (
        <HiddenHand player={player} />
      )}
    </section>
  );
}

/**
 * One item on the stack: its source card, drawn, beside what it is doing.
 * `sourceCard` is the adapter's own resolved face, so the art here goes
 * through the same resolver as every other card — nothing builds a URL.
 */
function StackItem({ item, interaction }: { item: StackEntry; interaction: BoardInteraction | undefined }) {
  const sourceId = item.sourceCardId;
  const selectable = interaction !== undefined && sourceId !== null && interaction.selectable.has(sourceId);
  const body = (
    <>
      {item.sourceCard !== null && (
        <span className="stack__art">
          <CardTile card={item.sourceCard} />
        </span>
      )}
      <span className="stack__what">
        <span className="stack__source">
          {item.sourceName ?? 'unknown source'}
          {item.isAbility && <span className="stack__kind"> · ability</span>}
        </span>
        {item.controllerName !== null && <span className="stack__controller">{item.controllerName}</span>}
        <span className="stack__text">{inOurWords(item.description)}</span>
      </span>
    </>
  );
  return (
    <li
      className="stack__item"
      data-stack-id={item.id}
      data-source-card={sourceId ?? undefined}
      data-selectable={selectable || undefined}
    >
      {selectable ? (
        <button
          type="button"
          className="stack__body stack__select"
          aria-label={`Select ${item.sourceName ?? 'stack item'}`}
          onClick={() => interaction.onSelectCard(sourceId)}
        >
          {body}
        </button>
      ) : (
        <span className="stack__body">{body}</span>
      )}
    </li>
  );
}

/**
 * The stack's band. Fixed height, always: the list is in the markup at zero
 * items, and items past the band's width scroll inside it. Nothing about this
 * zone's box depends on what is on the stack — that is item #2 of the
 * operator's list and it is the whole point of this component's shape.
 */
function StackView({ stack, interaction }: { stack: readonly StackEntry[]; interaction: BoardInteraction | undefined }) {
  return (
    <section className="stack" aria-label="Stack" data-zone="stack" data-owner="table" data-count={stack.length}>
      <h3 className="zone__head">
        Stack <span className="zone__count">{stack.length}</span>
      </h3>
      <ol className="stack__items">
        {stack.map((item) => (
          <StackItem key={item.id} item={item} interaction={interaction} />
        ))}
      </ol>
    </section>
  );
}

export function Board({ view, interaction }: { view: BoardView; interaction?: BoardInteraction }) {
  const viewer = view.players.find((p) => p.isViewer);
  const others = view.players.filter((p) => !p.isViewer);
  const active = view.players.find((p) => p.id === view.activePlayerId);

  /*
   * The inspector, booted and nothing more: it attaches its own listeners by
   * delegation and draws into the overlay root. One mount, one dispose.
   */
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = root.current;
    if (el === null) return undefined;
    return mountInspector(el);
  }, []);

  /*
   * The player's arrangement, out of the module store rather than React state
   * — a resync may remount this component and the arrangement must outlive
   * that. `redraw` is what a drag does: the store is the truth, so all a
   * handler has to do is change it and ask for a frame.
   */
  const key = matchKey(view);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const arranged = ARRANGED.get(key) ?? NO_ARRANGEMENT;
  /** The card a drag is carrying. A ref: it changes nothing that is drawn. */
  const carried = useRef<number | null>(null);

  /**
   * One drop, applied. Everything a drop does is here: it stops the browser's
   * default, keeps the row from also seeing a drop that landed on a card, and
   * writes the store. It sends NOTHING — there is no sender in this scope, no
   * ask, no reply; a rearrange is invisible to Forge by construction.
   */
  const place = (event: DragEvent, row: BoardRow, target: DropTarget): void => {
    const cardId = carried.current;
    carried.current = null;
    if (viewer === undefined || cardId === null) return;
    event.preventDefault();
    // A card dropped on a card is not also dropped on the row under it.
    event.stopPropagation();
    if (target.kind !== 'row' && target.id === cardId) return;
    if (!viewer.battlefield.some((c) => c.id === cardId)) return;
    ARRANGED.set(
      key,
      withMove(group(viewer.battlefield, viewer.id, arranged), viewer.id, arranged, cardId, row, target),
    );
    redraw();
  };

  const arranging: Arranging | undefined =
    viewer === undefined
      ? undefined
      : {
          start(event, cardId) {
            carried.current = cardId;
            /*
             * A card INSIDE a pile is inside the `<li>` of the card it is
             * stacked on, and `dragstart` bubbles — so without this the base
             * card's own handler runs next and overwrites which card is being
             * carried. Dragging the equipment off a creature dragged the
             * creature instead. Every one of this lane's handlers is on a card
             * or a row and none of them wants its ancestor's copy.
             */
            event.stopPropagation();
            const data = event.dataTransfer as DataTransfer | undefined;
            if (data !== undefined) {
              data.effectAllowed = 'move';
              data.setData('text/plain', String(cardId));
            }
          },
          over(event) {
            if (carried.current === null) return;
            // Without this the browser refuses the drop.
            event.preventDefault();
            const data = event.dataTransfer as DataTransfer | undefined;
            if (data !== undefined) data.dropEffect = 'move';
          },
          dropOn(event, row, cardId) {
            const box = event.currentTarget as HTMLElement | null;
            const rect = box?.getBoundingClientRect?.() ?? { top: 0, height: 0 };
            place(event, row, dropOnCard(rect, event.clientY, cardId));
          },
          dropInRow(event, row) {
            place(event, row, { kind: 'row' });
          },
          end() {
            carried.current = null;
          },
          regroup() {
            ARRANGED.set(key, withoutSeat(viewer.id, arranged));
            redraw();
          },
        };

  return (
    <section className="board" aria-label="Game board" ref={root}>
      <header className="board__bar" data-testid="turn-bar">
        <span data-testid="turn">Turn {view.turn}</span>
        <span data-testid="phase" data-phase={view.phase ?? ''}>
          {view.phaseLabel}
        </span>
        {active !== undefined && <span data-testid="active-player">{active.name}&rsquo;s turn</span>}
        {view.gameOver && <span className="board__over">game over</span>}
      </header>

      <div className="board__opponents">
        {others.map((p) => (
          <PlayerArea key={p.id} player={p} interaction={interaction} arranging={undefined} arranged={arranged} />
        ))}
      </div>

      <div className="board__mid" data-testid="board-mid">
        <StackView stack={view.stack} interaction={interaction} />
      </div>

      {viewer !== undefined && (
        <PlayerArea player={viewer} interaction={interaction} arranging={arranging} arranged={arranged} />
      )}

      {/* Out of flow, both of them: neither may move a track when it appears. */}
      {view.missingCardIds.length > 0 && (
        <p className="board__warn" role="alert">
          {view.missingCardIds.length} card(s) named by a zone never arrived: {view.missingCardIds.join(', ')}
        </p>
      )}
      <div className="board__overlay" data-board-overlay="" />
    </section>
  );
}
