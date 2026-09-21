/*
 * The board: one game state, drawn.
 *
 * Renders a `BoardView` and nothing else. It has no idea whether the view came
 * from a committed fixture or a live stream — the same split that let the
 * draft's transport be swapped without touching `DraftScreen`. No socket, no
 * protocol, no fold: see `fixtures.ts` → `fold.ts` → `adapter.ts` for how a
 * view is made.
 *
 * ## Cards are `CardTile`
 *
 * Every card on the board is the draft's own `CardTile`, unchanged — our
 * layout, our pips, and art through the art resolver (`draft/cardImage.ts` →
 * `@hadoku/carddata/art`) from the Scryfall id the adapter looked up. No host
 * is named here. A card with no id is the text tile, which is a whole card on
 * its own. The board adds only the state a printed card doesn't have (damage,
 * counters, attacking), as chips beside the tile, in our own words.
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
 * `selectablePlayers`. This file never decides what may be selected: we
 * implement no rules. With no `interaction` every card is inert.
 *
 * ## Hidden information
 *
 * An opponent's hand arrives as `hand: null` and a count (`adapter.ts`), and is
 * drawn as that many card backs — our own pattern, not Magic's back. There is
 * no card object to render, so no face can leak through here.
 *
 * ## Layout
 *
 * Opponents on top, the stack in the middle, the viewer at the bottom with
 * their hand. Page layout is `board.css`; how a single card looks is
 * `card.css`, sized from `--card-w` so the layout can shrink cards per zone.
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

function Zone({
  owner,
  zone,
  label,
  cards,
  interaction,
}: {
  owner: string;
  zone: string;
  label: string;
  cards: readonly BoardCard[];
  interaction: BoardInteraction | undefined;
}) {
  return (
    <section className={`zone zone--${zone}`} aria-label={`${owner} ${label}`} data-zone={zone} data-count={cards.length}>
      <h4 className="zone__head">
        {label} <span className="zone__count">{cards.length}</span>
      </h4>
      {cards.length === 0 ? (
        <p className="zone__empty">empty</p>
      ) : (
        <ul className="zone__cards">
          {cards.map((c) => (
            <CardOnBoard key={c.id} entry={c} interaction={interaction} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Someone else's hand: a count, drawn as that many backs. There is no card
 * here to draw a face from — the adapter never maps these cards.
 */
function HiddenHand({ player }: { player: BoardPlayer }) {
  return (
    <section className="zone zone--hand" aria-label={`${player.name} Hand`} data-zone="hand" data-count={player.handCount}>
      <h4 className="zone__head">
        Hand <span className="zone__count">{player.handCount}</span>
      </h4>
      {player.handCount > 0 && (
        <ul className="card-backs" aria-hidden="true">
          {Array.from({ length: player.handCount }, (_, i) => (
            <li key={i} className="card-back" data-card-back="" />
          ))}
        </ul>
      )}
      <p className="zone__hidden">
        {player.handCount} {player.handCount === 1 ? 'card' : 'cards'}, hidden
      </p>
    </section>
  );
}

function PlayerArea({ player, interaction }: { player: BoardPlayer; interaction: BoardInteraction | undefined }) {
  const selectable = interaction !== undefined && interaction.selectablePlayers.has(player.id);
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

      <Zone owner={player.name} zone="battlefield" label="Battlefield" cards={player.battlefield} interaction={interaction} />
      <div className="seat__piles">
        <Zone owner={player.name} zone="graveyard" label="Graveyard" cards={player.graveyard} interaction={interaction} />
        <Zone owner={player.name} zone="exile" label="Exile" cards={player.exile} interaction={interaction} />
      </div>
      {player.hand !== null ? (
        <Zone owner={player.name} zone="hand" label="Hand" cards={player.hand} interaction={interaction} />
      ) : (
        <HiddenHand player={player} />
      )}
    </section>
  );
}

function StackItem({ item, interaction }: { item: StackEntry; interaction: BoardInteraction | undefined }) {
  const sourceId = item.sourceCardId;
  const selectable = interaction !== undefined && sourceId !== null && interaction.selectable.has(sourceId);
  const body = (
    <>
      <span className="stack__source">
        {item.sourceName ?? 'unknown source'}
        {item.isAbility && <span className="stack__kind"> · ability</span>}
      </span>
      {item.controllerName !== null && <span className="stack__controller">{item.controllerName}</span>}
      <span className="stack__text">{inOurWords(item.description)}</span>
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
          className="stack__select"
          aria-label={`Select ${item.sourceName ?? 'stack item'}`}
          onClick={() => interaction.onSelectCard(sourceId)}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}

function StackView({ stack, interaction }: { stack: readonly StackEntry[]; interaction: BoardInteraction | undefined }) {
  return (
    <section className="stack" aria-label="Stack" data-zone="stack" data-count={stack.length}>
      <h3 className="zone__head">
        Stack <span className="zone__count">{stack.length}</span>
        {stack.length > 0 && <span className="stack__hint">top first</span>}
      </h3>
      {stack.length === 0 ? (
        <p className="zone__empty">empty</p>
      ) : (
        <ol className="stack__items">
          {stack.map((item) => (
            <StackItem key={item.id} item={item} interaction={interaction} />
          ))}
        </ol>
      )}
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

      {view.missingCardIds.length > 0 && (
        <p className="board__warn" role="alert">
          {view.missingCardIds.length} card(s) named by a zone never arrived: {view.missingCardIds.join(', ')}
        </p>
      )}

      <div className="board__opponents">
        {others.map((p) => (
          <PlayerArea key={p.id} player={p} interaction={interaction} />
        ))}
      </div>
      <StackView stack={view.stack} interaction={interaction} />
      {viewer !== undefined && <PlayerArea player={viewer} interaction={interaction} />}
    </section>
  );
}
