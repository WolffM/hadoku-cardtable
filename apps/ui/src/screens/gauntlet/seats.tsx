/* The Gauntlet's two players as its screens draw them: P1 (the coin flip's) first. */
import type { GauntletSeatIndex, GauntletView } from '@hadoku/shared';

import type { RoomMember } from '../../rooms/api.ts';

/** The table seats in P1, P2 order. */
export function seatOrder(view: GauntletView): readonly [GauntletSeatIndex, GauntletSeatIndex] {
  return view.first === 1 ? [1, 0] : [0, 1];
}

/** Each table seat's avatar, from the room member who holds it; the AI's seat, and a member with none, draw the silhouette. */
export function seatAvatars(view: GauntletView, members: readonly RoomMember[]): readonly [string | undefined, string | undefined] {
  const of = (seat: GauntletSeatIndex): string | undefined => {
    const id = view.players?.[seat].memberId;
    return id == null ? undefined : members.find((m) => m.id === id)?.avatarId;
  };
  return [of(0), of(1)];
}

/** `unknown`: the coin has not landed yet, so which side is whose is not drawn. */
export function PlayerName({ view, seat, player, unknown = false }: { view: GauntletView; seat: GauntletSeatIndex; player: 'p1' | 'p2'; unknown?: boolean }) {
  return (
    <p className="gauntlet__player" data-seat={seat} data-player={player} data-you={view.you === seat || undefined} data-unknown={unknown || undefined}>
      <span className="gauntlet__badge">{player === 'p1' ? 'P1' : 'P2'}</span>
      <span className="gauntlet__name">{view.players?.[seat].name}</span>
    </p>
  );
}
