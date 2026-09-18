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
 * layout, our pips, art through the art resolver. The board adds only the
 * state a printed card doesn't have (tapped, damage, counters, attacking), as
 * chips beside the tile, in our own words. **"Tapped" is a word here, not the
 * tap symbol**, and a tapped card is dimmed rather than turned sideways: a
 * rotated tile on a 360px screen is a tile you cannot read.
 *
 * ## Layout
 *
 * Opponents on top, the stack in the middle, the viewer at the bottom with
 * their hand. Zones are grids that wrap, so a wide battlefield grows downward
 * and the page never scrolls sideways; see `board.css`.
 */

import { CardTile } from '../components/CardTile.tsx';
import type { BoardCard, BoardPlayer, BoardView, StackEntry } from './adapter.ts';
import './board.css';

function CardOnBoard({ entry }: { entry: BoardCard }) {
  const chips: string[] = [];
  if (entry.tapped) chips.push('tapped');
  if (entry.summoningSick) chips.push('summoning sick');
  if (entry.attacking) chips.push('attacking');
  if (entry.blocking) chips.push('blocking');
  if (entry.damage > 0) chips.push(`${entry.damage} damage`);
  if (entry.token) chips.push('token');
  for (const c of entry.counters) chips.push(`${c.count} ${c.name}`);

  return (
    <li className="board-card" data-tapped={entry.tapped || undefined} data-board-card={entry.id}>
      <CardTile card={entry.card} />
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
}: {
  owner: string;
  zone: string;
  label: string;
  cards: readonly BoardCard[];
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
            <CardOnBoard key={c.id} entry={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PlayerArea({ player }: { player: BoardPlayer }) {
  return (
    <section
      className="seat"
      data-testid="player"
      data-player-id={player.id}
      data-viewer={player.isViewer || undefined}
      aria-label={player.isViewer ? `${player.name} (you)` : player.name}
    >
      <header className="seat__head">
        <h3 className="seat__name">
          {player.name}
          {player.isViewer && <span className="seat__you"> (you)</span>}
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

      <Zone owner={player.name} zone="battlefield" label="Battlefield" cards={player.battlefield} />
      <div className="seat__piles">
        <Zone owner={player.name} zone="graveyard" label="Graveyard" cards={player.graveyard} />
        <Zone owner={player.name} zone="exile" label="Exile" cards={player.exile} />
      </div>
      {player.hand !== null ? (
        <Zone owner={player.name} zone="hand" label="Hand" cards={player.hand} />
      ) : (
        <section className="zone zone--hand" aria-label={`${player.name} Hand`} data-zone="hand" data-count={player.handCount}>
          <h4 className="zone__head">
            Hand <span className="zone__count">{player.handCount}</span>
          </h4>
          <p className="zone__hidden">
            {player.handCount} {player.handCount === 1 ? 'card' : 'cards'}, hidden
          </p>
        </section>
      )}
    </section>
  );
}

function StackView({ stack }: { stack: readonly StackEntry[] }) {
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
            <li key={item.id} className="stack__item" data-stack-id={item.id}>
              <span className="stack__source">
                {item.sourceName ?? 'unknown source'}
                {item.isAbility && <span className="stack__kind"> · ability</span>}
              </span>
              {item.controllerName !== null && <span className="stack__controller">{item.controllerName}</span>}
              <span className="stack__text">{item.description}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function Board({ view }: { view: BoardView }) {
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
          <PlayerArea key={p.id} player={p} />
        ))}
      </div>
      <StackView stack={view.stack} />
      {viewer !== undefined && <PlayerArea player={viewer} />}
    </section>
  );
}
