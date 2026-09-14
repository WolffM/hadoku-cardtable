/**
 * The pod: every seat in seat order, who holds it, and who still owes a pick.
 *
 * ## Seat order is the content, not the styling
 *
 * `SeatId` is an index and the pack passes along it, so the bar renders
 * `view.seats` in array order with no sort. It also draws the pass direction as
 * an arrow between the seats, because "pack 2 passes right" is a fact about the
 * table that a player otherwise has to remember.
 *
 * ## What a seat may show
 *
 * A name, whether it is a bot, and how many cards it has taken. Never *which*
 * cards — the payload does not carry them, and this component could not leak
 * them if it tried. See `draft/types.ts`.
 */

import type { DraftSeatView, DraftView } from '../draft/types.ts';
import { isWaiting } from '../draft/types.ts';

function occupantKind(seat: DraftSeatView): string {
  if (seat.occupant === null) return 'empty';
  return seat.occupant.kind;
}

export function SeatBar({ view }: { view: DraftView }) {
  const viewerSeatId = view.viewer.kind === 'seat' ? view.viewer.seatId : null;

  return (
    <section className="seats" data-testid="seat-bar" aria-label="Seats">
      <header className="seats__head">
        <h2 className="seats__title">
          Pod <span className="seats__capacity">{view.seats.length}/{view.capacity ?? '∞'}</span>
        </h2>
        <p className="seats__pass" data-testid="pass-direction">
          Pack {view.packNumber} passes {view.passDirection}
          <span aria-hidden="true"> {view.passDirection === 'left' ? '←' : '→'}</span>
        </p>
      </header>

      <ol className="seats__list">
        {view.seats.map((seat) => {
          const waiting = isWaiting(view, seat.id);
          const isYou = seat.id === viewerSeatId;
          return (
            <li
              key={seat.id}
              className={[
                'seat',
                waiting ? 'seat--waiting' : 'seat--done',
                isYou ? 'seat--you' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-testid={`seat-${seat.id}`}
              data-waiting={waiting ? 'true' : 'false'}
              data-occupant={occupantKind(seat)}
            >
              <span className="seat__id">{seat.id}</span>
              <span className="seat__name">
                {seat.occupant === null ? <em>empty</em> : seat.displayName}
                {isYou && <span className="seat__you"> (you)</span>}
              </span>
              <span className="seat__meta">
                {occupantKind(seat) === 'bot' && <span className="seat__bot">bot</span>}
                <span className="seat__picked" data-testid={`seat-${seat.id}-picked`}>
                  {seat.pickedCount}
                </span>
              </span>
              <span className="seat__clock">{waiting ? 'picking…' : 'picked'}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
