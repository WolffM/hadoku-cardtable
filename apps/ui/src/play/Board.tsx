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
 * ## No prose
 *
 * The operator, same session: *"this text is completely unnecessary: 'Stack 0
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
 * ## The DOM is the seam with the interaction lane
 *
 * Another lane draws a targeter arrow and drags cards; it finds things without
 * owning this markup. What is guaranteed here, and pinned by a test:
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
 *   - `data-board-overlay` is a positioned root covering the canvas exactly,
 *     at the board's top level, for that lane to render into. This file adds
 *     no pointer handler to it and draws no arrow.
 *
 * ## Hidden information
 *
 * An opponent's hand arrives as `hand: null` and a count (`adapter.ts`), and is
 * drawn as that many card backs — our own pattern, not Magic's back. There is
 * no card object to render, so no face can leak through here.
 *
 * ## Layout
 *
 * Opponents on top, a centre band in the middle holding the two faces and the
 * stack between them, the viewer at the bottom with their hand. Page layout is
 * `board.css`; how a single card looks is `card.css`, sized from `--card-w` so
 * the layout can shrink cards per zone.
 */

import { CardTile } from '../components/CardTile.tsx';
import type { BoardCard, BoardPlayer, BoardView, StackEntry } from './adapter.ts';
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

/** `{T}` is a WotC mark; on our chrome it is the word. */
function inOurWords(text: string): string {
  return text.replace(/\{T\}/g, 'TAP');
}

function CardOnBoard({ entry, interaction }: { entry: BoardCard; interaction: BoardInteraction | undefined }) {
  const chips: string[] = [];
  if (entry.tapped) chips.push('tapped');
  if (entry.summoningSick) chips.push('summoning sick');
  if (entry.attacking) chips.push('attacking');
  if (entry.blocking) chips.push('blocking');
  if (entry.damage > 0) chips.push(`${entry.damage} damage`);
  if (entry.token) chips.push('token');
  for (const c of entry.counters) chips.push(`${c.count} ${c.name}`);

  const selectable = interaction !== undefined && interaction.selectable.has(entry.id);

  return (
    <li
      className="board-card"
      data-tapped={entry.tapped || undefined}
      data-board-card={entry.id}
      data-card-id={entry.id}
      data-selectable={selectable || undefined}
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
    <section
      className={`zone zone--${zone}`}
      aria-label={`${owner} ${label}`}
      data-zone={zone}
      data-owner={ownerSide}
      data-count={cards.length}
    >
      <h4 className="zone__head">
        {label} <span className="zone__count">{cards.length}</span>
      </h4>
      <ul className="zone__cards">
        {cards.map((c) => (
          <CardOnBoard key={c.id} entry={c} interaction={interaction} />
        ))}
      </ul>
    </section>
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

function PlayerArea({ player, interaction }: { player: BoardPlayer; interaction: BoardInteraction | undefined }) {
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

      <Zone
        owner={player.name}
        ownerSide={side}
        zone="battlefield"
        label="Battlefield"
        cards={player.battlefield}
        interaction={interaction}
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

  return (
    <section className="board" aria-label="Game board">
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
          <PlayerArea key={p.id} player={p} interaction={interaction} />
        ))}
      </div>

      <div className="board__mid" data-testid="board-mid">
        <div className="board__faces board__faces--them">
          {others.map((p) => (
            <PlayerFace key={p.id} player={p} interaction={interaction} />
          ))}
        </div>
        <StackView stack={view.stack} interaction={interaction} />
        <div className="board__faces board__faces--you">
          {viewer !== undefined && <PlayerFace player={viewer} interaction={interaction} />}
        </div>
      </div>

      {viewer !== undefined && <PlayerArea player={viewer} interaction={interaction} />}

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
