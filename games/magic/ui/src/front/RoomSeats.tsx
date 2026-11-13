/*
 * A room's seats, on the banner's "Open seats now" page (`./WildcardCard.tsx`).
 *
 * A 1v1 room ports its link preview's card (`games/magic/server/src/http/preview.ts`, the operator's
 * approved design): the host's face, VS, the other seat's face — or a dashed "?" over "You?". A pod
 * draws its seats four to a row, an open one dashed with a plus, as the room's own seats do
 * (`../screens/pod/PodSeats.tsx`). An open seat that is a way in is a button, the same press as the
 * page's Join. What is drawn is derived by `./roomCard.ts` (`seats`, `seatsMore`, `seatJoinable`).
 */
import { magicGame } from '@hadoku/shared';
import type { RoomView } from '../rooms/api.ts';
import { Avatar } from '@hadoku/game-ui/components/Avatar.tsx';
import type { RoomCardSeat, RoomCardView } from './roomCard.ts';
import './RoomSeats.css';

const PLUS = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

interface SeatProps {
  seat: RoomCardSeat;
  /** A 1v1 room: its open seat is a "?" over "You?". */
  duel: boolean;
  joinable: boolean;
  roomName: string;
  onTake: () => void;
}

function Seat({ seat, duel, joinable, roomName, onTake }: SeatProps) {
  if (seat.kind === 'taken') {
    return (
      <span className="room-seats__seat" data-testid="room-seat-taken">
        <span className="room-seats__face">
          <Avatar id={seat.avatarId} look={seat.look} fallback="initial" name={seat.name} className="room-seats__face-img" fallbackClassName="room-seats__face-initial" />
        </span>
        <span className="room-seats__name">{seat.name}</span>
      </span>
    );
  }
  const face = duel ? (
    <span className="room-seats__ask" aria-hidden="true">
      ?
    </span>
  ) : (
    PLUS
  );
  return (
    <span className="room-seats__seat" data-open="">
      {joinable ? (
        <button type="button" className="room-seats__face room-seats__face--open" data-testid="room-seat-open" aria-label={`Take a seat in ${roomName}`} onClick={onTake}>
          {face}
        </button>
      ) : (
        <span className="room-seats__face room-seats__face--open">{face}</span>
      )}
      {/* A pod's open seat has no word under it, the plus says it; the empty line keeps the grid's rows even. */}
      <span className="room-seats__name room-seats__name--open">{duel ? 'You?' : ''}</span>
    </span>
  );
}

export function RoomSeats({ room, view, onTake }: { room: RoomView; view: RoomCardView; onTake: () => void }) {
  const duel = magicGame(room).pod === null;
  const seat = (s: RoomCardSeat, i: number) => <Seat key={i} seat={s} duel={duel} joinable={view.seatJoinable} roomName={room.name} onTake={onTake} />;
  if (duel) {
    return (
      <div className="room-seats room-seats--duel" data-testid="room-seats">
        {view.seats[0] !== undefined && seat(view.seats[0], 0)}
        <span className="room-seats__vs" aria-label="versus">
          VS
        </span>
        {view.seats[1] !== undefined && seat(view.seats[1], 1)}
      </div>
    );
  }
  return (
    <div className="room-seats room-seats--pod" data-testid="room-seats">
      <span className="room-seats__grid">{view.seats.map(seat)}</span>
      {view.seatsMore > 0 && <span className="room-seats__more">+{view.seatsMore}</span>}
    </div>
  );
}
