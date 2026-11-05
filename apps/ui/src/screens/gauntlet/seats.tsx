/* The Gauntlet's two players as its screens draw them: P1 (the coin flip's) first. */
import { createContext, useContext } from 'react';
import type { GauntletSeatIndex, GauntletView } from '@hadoku/shared';

import { faceOf, NO_FACE, type Face } from '../../components/Avatar.tsx';
import { PlayerName as Name } from '../../room/look.tsx';
import type { RoomMember } from '../../rooms/api.ts';

/** The table seats in P1, P2 order. */
export function seatOrder(view: GauntletView): readonly [GauntletSeatIndex, GauntletSeatIndex] {
  return view.first === 1 ? [1, 0] : [0, 1];
}

/** Each table seat's face: the AI's own character, else the room member who holds the seat; a member with none draws the silhouette. */
export function seatFaces(view: GauntletView, members: readonly RoomMember[]): readonly [Face, Face] {
  const of = (seat: GauntletSeatIndex): Face => {
    const player = view.players?.[seat];
    if (player?.avatarId !== undefined) return { id: player.avatarId };
    return player?.memberId == null ? NO_FACE : faceOf(members.find((m) => m.id === player.memberId));
  };
  return [of(0), of(1)];
}

/** The two seats' faces, in seat order, for every Gauntlet screen under `GauntletScreen`. */
export const SeatFaces = createContext<readonly [Face, Face]>([NO_FACE, NO_FACE]);

/** `unknown`: the coin has not landed yet, so which side is whose is not drawn. */
export function PlayerName({ view, seat, player, unknown = false }: { view: GauntletView; seat: GauntletSeatIndex; player: 'p1' | 'p2'; unknown?: boolean }) {
  const faces = useContext(SeatFaces);
  return (
    <p className="gauntlet__player" data-seat={seat} data-player={player} data-you={view.you === seat || undefined} data-unknown={unknown || undefined}>
      <span className="gauntlet__badge">{player === 'p1' ? 'P1' : 'P2'}</span>
      <Name name={view.players?.[seat].name ?? ''} face={faces[seat]} className="gauntlet__name" />
    </p>
  );
}
