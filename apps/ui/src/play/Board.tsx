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
 * ## The faces anchor the table: ours at the bottom, theirs at the top
 *
 * The operator, 2026-09-25: *"avatar and number looks slick, but confusing
 * which is which"*. So each face sits at its own end of the canvas — the
 * opponent's in their seat's head, which is the top of the board, and ours in
 * our seat's head, which `board.css` puts at the BOTTOM of ours. The stack
 * keeps the centre band to itself. The faces themselves are unchanged.
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
 *   - every player's face carries `data-player-face` and `data-player-id`;
 *   - every zone carries `data-zone` and `data-owner` (`you`, `them`, or
 *     `table` for the stack, which belongs to no seat);
 *   - a battlefield's rows each carry `data-board-row` (`lands`, `artifacts`,
 *     `creatures`, `other`), in that order, and `data-empty` when the row
 *     holds nothing. A draggable card carries `draggable` and the viewer's
 *     battlefield carries one `[data-arrange-reset]` control;
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
 * The opponent on top with their face in their head, a centre band holding the
 * stack, the viewer at the bottom with their hand and their face under it.
 * Page layout is `board.css`; how a single card looks is `card.css`, sized from
 * `--card-w` so the layout can shrink cards per zone.
 */

import { useEffect, useReducer, useRef, type DragEvent, type ReactNode } from 'react';

import { CardTile } from '../components/CardTile.tsx';
import type { BoardCard, BoardPlayer, BoardView, StackEntry } from './adapter.ts';
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

/** One battlefield, in rows. Always all four keys, in `BOARD_ROWS` order. */
type Grouped = Readonly<Record<BoardRow, readonly BoardCard[]>>;

/**
 * The player's own order, as card ids per `<playerId>:<row>`. A row the store
 * does not name is drawn in the view's order; a row it names is drawn in
 * theirs, and then anything the store has never heard of, in the view's order.
 */
type Arrangement = Readonly<Record<string, readonly number[]>>;

const NO_ARRANGEMENT: Arrangement = {};
const slotKey = (playerId: number, row: BoardRow): string => `${playerId}:${row}`;

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
 * the row its type puts it in.
 *
 * Every card appears exactly once whatever the store says — an id the store
 * lists twice, or lists for a card that has left the battlefield, cannot
 * duplicate a card or lose one. `data-card-id` is unique across the board and
 * three other lanes depend on that.
 */
function group(cards: readonly BoardCard[], playerId: number, arranged: Arrangement): Grouped {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows: Record<BoardRow, BoardCard[]> = { lands: [], artifacts: [], creatures: [], other: [] };
  const placed = new Set<number>();
  for (const row of BOARD_ROWS) {
    for (const id of arranged[slotKey(playerId, row)] ?? []) {
      const card = byId.get(id);
      if (card === undefined || placed.has(id)) continue;
      placed.add(id);
      rows[row].push(card);
    }
  }
  for (const card of cards) {
    if (!placed.has(card.id)) rows[rowFor(card)].push(card);
  }
  return rows;
}

/**
 * The arrangement after a drag: `cardId` lands in `row`, before `beforeId` or
 * at the row's end.
 *
 * All four rows are written out, not just the two the card moved between: what
 * the player is looking at becomes what is stored, so the next permanent to
 * arrive joins the end of its row instead of landing in the middle of an order
 * they arranged.
 */
function withMove(
  rows: Grouped,
  playerId: number,
  arranged: Arrangement,
  cardId: number,
  row: BoardRow,
  beforeId: number | null,
): Arrangement {
  const next: Record<string, readonly number[]> = { ...arranged };
  for (const r of BOARD_ROWS) next[slotKey(playerId, r)] = rows[r].map((c) => c.id).filter((id) => id !== cardId);
  const target = [...(next[slotKey(playerId, row)] ?? [])];
  const before = beforeId === null ? -1 : target.indexOf(beforeId);
  target.splice(before === -1 ? target.length : before, 0, cardId);
  next[slotKey(playerId, row)] = target;
  return next;
}

/** The arrangement with one seat's rows thrown away: the default grouping is back. */
function withoutSeat(playerId: number, arranged: Arrangement): Arrangement {
  const next: Record<string, readonly number[]> = { ...arranged };
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
  /** `beforeId` is the card dropped ON, or null for the row itself. */
  drop(event: DragEvent, row: BoardRow, beforeId: number | null): void;
  /** A drag that ended anywhere — including outside the board — carries nothing now. */
  end(): void;
  regroup(): void;
}

/** `{T}` is a WotC mark; on our chrome it is the word. */
function inOurWords(text: string): string {
  return text.replace(/\{T\}/g, 'TAP');
}

function CardOnBoard({
  entry,
  interaction,
  arranging,
  row,
}: {
  entry: BoardCard;
  interaction: BoardInteraction | undefined;
  arranging?: Arranging;
  row?: BoardRow;
}) {
  const chips: string[] = [];
  if (entry.tapped) chips.push('tapped');
  if (entry.summoningSick) chips.push('summoning sick');
  if (entry.attacking) chips.push('attacking');
  if (entry.blocking) chips.push('blocking');
  if (entry.damage > 0) chips.push(`${entry.damage} damage`);
  if (entry.token) chips.push('token');
  for (const c of entry.counters) chips.push(`${c.count} ${c.name}`);

  const selectable = interaction !== undefined && interaction.selectable.has(entry.id);
  const draggable = arranging !== undefined && row !== undefined;

  return (
    <li
      className="board-card"
      data-tapped={entry.tapped || undefined}
      data-board-card={entry.id}
      data-card-id={entry.id}
      data-selectable={selectable || undefined}
      draggable={draggable || undefined}
      onDragStart={draggable ? (e) => arranging.start(e, entry.id) : undefined}
      onDragEnd={draggable ? () => arranging.end() : undefined}
      onDragOver={draggable ? (e) => arranging.over(e) : undefined}
      onDrop={draggable ? (e) => arranging.drop(e, row, entry.id) : undefined}
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
      {chips.length > 0 && (
        <ul className="board-card__chips" aria-label={`${entry.card.name} status`}>
          {chips.map((chip) => (
            <li key={chip} className="board-card__chip">
              {chip}
            </li>
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
             * A lane's share of the battlefield's width is its card count, so
             * every card on the board comes out the same width whatever the
             * split is (`board.css`). A lane holding nothing takes its label's
             * width and the stylesheet decides that, not this number.
             */
            style={{ flexGrow: rows[row].length }}
            onDragOver={arranging === undefined ? undefined : (e) => arranging.over(e)}
            onDrop={arranging === undefined ? undefined : (e) => arranging.drop(e, row, null)}
          >
            <h5 className="zone__row-head">
              {ROW_LABEL[row]} <span className="zone__count">{rows[row].length}</span>
            </h5>
            <ul className="zone__cards">
              {rows[row].map((c) => (
                <CardOnBoard key={c.id} entry={c} interaction={interaction} arranging={arranging} row={row} />
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
 * It sits in its seat's head, which is the top of the board for the opponent
 * and the bottom for the viewer (`board.css`) — the operator could not tell
 * the two apart when both were in the centre band.
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
      <span className="face__life" data-testid="face-life">
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
      <header className="seat__head">
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
        <span className="seat__life" data-testid="life" aria-label={`${player.name} life`}>
          {player.life}
        </span>
        <span className="seat__meta">
          <span data-testid="hand-count">hand {player.handCount}</span>
          <span data-testid="library-count">library {player.libraryCount}</span>
          {player.isActive && <span className="seat__flag">their turn</span>}
          {player.hasPriority && <span className="seat__flag">priority</span>}
          {player.hasLost && <span className="seat__flag seat__flag--lost">lost</span>}
        </span>
      </header>

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

  const arranging: Arranging | undefined =
    viewer === undefined
      ? undefined
      : {
          start(event, cardId) {
            carried.current = cardId;
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
          drop(event, row, beforeId) {
            const cardId = carried.current;
            carried.current = null;
            if (cardId === null) return;
            event.preventDefault();
            // A card dropped on a row is also dropped on nothing above it.
            event.stopPropagation();
            if (cardId === beforeId || !viewer.battlefield.some((c) => c.id === cardId)) return;
            ARRANGED.set(key, withMove(group(viewer.battlefield, viewer.id, arranged), viewer.id, arranged, cardId, row, beforeId));
            redraw();
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
