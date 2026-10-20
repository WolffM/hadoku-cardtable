/**
 * The pod: every seat in seat order, who holds it, and who still owes a pick.
 *
 * ## Seat order is the content, not the styling
 *
 * `SeatId` is an index and the pack passes along it, so the bar renders
 * `view.seats` in array order with no sort. It also draws the pass direction as
 * an arrow, and only an arrow.
 *
 * ## What a seat may show
 *
 * A name, whether it is a bot, and how many cards it has taken. Never *which*
 * cards — the payload does not carry them, and this component could not leak
 * them if it tried. See `draft/types.ts`.
 *
 * ## A spectator's seats are whose draft to watch
 *
 * A person holding no seat watches one drafter's pack and picks (the
 * operator, 2026-10-20). Their bar marks the seat they watch, and pressing
 * another seat watches that one instead.
 *
 * ## HELD, which is the fourth thing a seat can be
 *
 * A seat whose player dropped is released with `{ hold: true }` and reserved
 * against everyone else for a TTL, so they come back to the same chair
 * (`apps/server/src/room/draftRooms.ts`). Until this wave the bar drew that
 * seat as `empty` — identical to a chair nobody had ever sat in — and the other
 * seven drafters had no way to tell "Sam dropped, the table is waiting" from
 * "this pod was never full". `draft/seatStatus.ts` derives the difference and
 * says plainly what it is derived FROM, because the envelope carries no
 * reservation field.
 */

import { seatStatus, SEAT_HELD_NOTE } from '../draft/seatStatus.ts';
import type { DraftSeatView, DraftView } from '../draft/types.ts';
import { isWaiting } from '../draft/types.ts';
import './spectate.css';

function occupantKind(seat: DraftSeatView): string {
  return seatStatus(seat);
}

export function SeatBar({ view, onWatch }: { view: DraftView; onWatch?: (seatId: number) => void }) {
  const viewerSeatId = view.viewer.kind === 'seat' ? view.viewer.seatId : null;
  const watchedId = view.viewer.kind === 'watcher' ? view.viewer.seatId : null;
  const watchable = watchedId !== null && onWatch !== undefined;

  return (
    <section className="seats" data-testid="seat-bar" aria-label="Seats">
      <header className="seats__head">
        <h2 className="seats__title">
          Pod <span className="seats__capacity">{view.seats.length}/{view.capacity ?? '∞'}</span>
        </h2>
        {/* The arrow alone: the operator, 2026-10-19, of "Pack 2 passes right →": "more useless ai prose". */}
        <span className="seats__pass" data-testid="pass-direction" data-direction={view.passDirection} role="img" aria-label={`passing ${view.passDirection}`}>
          {view.passDirection === 'left' ? '←' : '→'}
        </span>
      </header>

      <ol className="seats__list">
        {view.seats.map((seat) => {
          const waiting = isWaiting(view, seat.id);
          const isYou = seat.id === viewerSeatId;
          const watched = seat.id === watchedId;
          const status = seatStatus(seat);
          const held = status === 'held';
          return (
            <li
              key={seat.id}
              className={[
                'seat',
                waiting ? 'seat--waiting' : 'seat--done',
                isYou ? 'seat--you' : '',
                watched ? 'seat--watched' : '',
                held ? 'seat--held' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-testid={`seat-${seat.id}`}
              data-waiting={waiting ? 'true' : 'false'}
              data-occupant={occupantKind(seat)}
              data-watched={watched ? '' : undefined}
            >
              {watchable && !watched && (
                <button
                  type="button"
                  className="seat__watch"
                  data-testid={`seat-${seat.id}-watch`}
                  aria-label={`Watch ${seat.displayName}`}
                  onClick={() => onWatch(seat.id)}
                />
              )}
              <span className="seat__id">{seat.id}</span>
              <span className="seat__name">
                {status === 'empty' ? <em>empty</em> : seat.displayName}
                {isYou && <span className="seat__you"> (you)</span>}
              </span>
              <span className="seat__meta">
                {status === 'bot' && <span className="seat__bot">bot</span>}
                {held && (
                  <span className="seat__held" data-testid={`seat-${seat.id}-held`} title={SEAT_HELD_NOTE}>
                    held
                  </span>
                )}
                <span className="seat__picked" data-testid={`seat-${seat.id}-picked`}>
                  {seat.pickedCount}
                </span>
              </span>
              <span className="seat__clock">
                {held ? 'away — seat held' : waiting ? 'picking…' : 'picked'}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
