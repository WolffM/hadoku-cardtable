/**
 * The pod: every seat around one table, who holds it, who still owes a pick,
 * and which way the packs go.
 *
 * ## A circle, because the pass is a circle
 *
 * The operator, 2026-10-21: *"rather than showing a vertical table can we show a
 * visual circle instead? … display all the avatars and then show arrows between
 * them for who is passing to who."* So the seats sit around a ring in `SeatId`
 * order — the order the pack passes along, which is the content, not the
 * styling — and an arc between each pair of neighbours points the way this
 * pack goes (`packages/draft/src/engine.ts`: left is seat s to s + 1). The
 * table is turned so the viewer's own seat (a spectator's watched one, else
 * seat 0) is at the bottom, and the arc that ends there — where their next pack
 * comes from — is the one drawn lit. The pack and pick counters are its centre.
 *
 * ## What a seat may show
 *
 * A face, a name, and how many cards it has taken. Never *which* cards — the
 * payload does not carry them, and this component could not leak them if it
 * tried. See `draft/types.ts`. The face is the seat's watchparty character
 * (`avatarId`: a member's own, an AI seat's persona), or our own mark for a seat
 * with none.
 *
 * ## A spectator's seats are whose draft to watch
 *
 * A person holding no seat watches one drafter's pack and picks (the
 * operator, 2026-10-20). Their circle marks the seat they watch, and pressing
 * another seat watches that one instead.
 *
 * ## HELD, which is the fourth thing a seat can be
 *
 * A seat whose player dropped is released with `{ hold: true }` and reserved
 * against everyone else for a TTL, so they come back to the same chair
 * (`apps/server/src/room/draftRooms.ts`). `draft/seatStatus.ts` derives the
 * difference from an empty chair and says plainly what it is derived FROM,
 * because the envelope carries no reservation field.
 */

import { seatStatus, SEAT_HELD_NOTE } from '../draft/seatStatus.ts';
import type { DraftView } from '../draft/types.ts';
import { isWaiting } from '../draft/types.ts';
import { Avatar } from './Avatar.tsx';
import { DraftCounters } from './DraftCounters.tsx';
import './spectate.css';

/** The ring the seats sit on and the arcs run along, in the circle's own 0–100 box. */
const RING = 36;
/**
 * The ring's centre sits above the box's: a seat's label hangs under its face, so
 * the bottom seat needs more room below it than the top one needs above.
 */
const CENTRE_Y = 47;
/** How far either side of a seat's centre its arc stops, in degrees: clear of its face. */
const CLEAR = 16;

const point = (deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [50 + RING * Math.cos(a), CENTRE_Y + RING * Math.sin(a)];
};

const fixed = (n: number): string => n.toFixed(2);

export function SeatBar({ view, onWatch }: { view: DraftView; onWatch?: (seatId: number) => void }) {
  const viewerSeatId = view.viewer.kind === 'seat' ? view.viewer.seatId : null;
  const watchedId = view.viewer.kind === 'watcher' ? view.viewer.seatId : null;
  const watchable = watchedId !== null && onWatch !== undefined;
  const seats = view.seats;
  const n = seats.length;
  const bottom = Math.max(0, seats.findIndex((s) => s.id === (viewerSeatId ?? watchedId ?? 0)));
  // Clockwise from the bottom, in seat order: screen angles grow clockwise.
  const angleOf = (at: number): number => 90 + (((at - bottom + n) % n) * 360) / n;
  const left = view.passDirection === 'left';

  const arcs = seats.map((_, at) => {
    const next = (at + 1) % n;
    const [x0, y0] = point(angleOf(at) + CLEAR);
    const [x1, y1] = point(angleOf(next) - CLEAR);
    // Left runs clockwise (sweep 1) from a seat to the next; right, the reverse.
    const d = left
      ? `M ${fixed(x0)} ${fixed(y0)} A ${RING} ${RING} 0 0 1 ${fixed(x1)} ${fixed(y1)}`
      : `M ${fixed(x1)} ${fixed(y1)} A ${RING} ${RING} 0 0 0 ${fixed(x0)} ${fixed(y0)}`;
    const intoBottom = left ? next === bottom : at === bottom;
    return { d, intoBottom };
  });

  return (
    <section className="seats" data-testid="seat-bar" aria-label="Seats">
      <div className="podcircle">
        <svg
          className="podcircle__ring"
          viewBox="0 0 100 100"
          role="img"
          aria-label={`passing ${view.passDirection}`}
          data-testid="pass-direction"
          data-direction={view.passDirection}
        >
          <defs>
            <marker id="podcircle-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path className="podcircle__head" d="M1 1 L8 5 L1 9" />
            </marker>
            <marker id="podcircle-head-in" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path className="podcircle__head podcircle__head--in" d="M1 1 L8 5 L1 9" />
            </marker>
          </defs>
          {n > 1 && arcs.map((arc, at) => <path key={at} className={arc.intoBottom ? 'podcircle__arc podcircle__arc--in' : 'podcircle__arc'} d={arc.d} />)}
        </svg>

        <div className="podcircle__centre">
          <DraftCounters view={view} />
        </div>

        <ol className="podcircle__seats">
          {seats.map((seat, at) => {
            const waiting = isWaiting(view, seat.id);
            const isYou = seat.id === viewerSeatId;
            const watched = seat.id === watchedId;
            const status = seatStatus(seat);
            const held = status === 'held';
            const [x, y] = point(angleOf(at));
            return (
              <li
                key={seat.id}
                className={[
                  'seatbar__seat',
                  waiting ? 'seatbar__seat--waiting' : 'seatbar__seat--done',
                  isYou ? 'seatbar__seat--you' : '',
                  watched ? 'seatbar__seat--watched' : '',
                  held ? 'seatbar__seat--held' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: `${fixed(x)}%`, top: `${fixed(y)}%` }}
                data-testid={`seat-${seat.id}`}
                data-waiting={waiting ? 'true' : 'false'}
                data-occupant={status}
                data-watched={watched ? '' : undefined}
              >
                {watchable && !watched && (
                  <button
                    type="button"
                    className="seatbar__watch"
                    data-testid={`seat-${seat.id}-watch`}
                    aria-label={`Watch ${seat.displayName}`}
                    onClick={() => onWatch(seat.id)}
                  />
                )}
                <span className="seatbar__face">
                  <Avatar id={seat.avatarId} fallback="mark" />
                </span>
                <span className="seatbar__label">
                  {/* Your own seat is named like every other; the lit ring at the bottom marks it as yours. */}
                  <span className="seatbar__name" title={seat.displayName}>
                    {status === 'empty' ? <em>empty</em> : seat.displayName}
                  </span>
                  {held && (
                    <span className="seatbar__held" data-testid={`seat-${seat.id}-held`} title={SEAT_HELD_NOTE}>
                      held
                    </span>
                  )}
                  <span className="seatbar__picked" data-testid={`seat-${seat.id}-picked`}>
                    {seat.pickedCount}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
