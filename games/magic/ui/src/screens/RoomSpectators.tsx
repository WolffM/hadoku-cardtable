/*
 * A room's spectators: every member who holds no seat, drawn the way the seats are (`pod-seats`),
 * beside or under them — the 1v1 table's two seats (`ConstructedScreen.tsx`) and a pod's
 * (`pod/PodLobby.tsx`) alike. Everyone in the room is on one side or the other, whatever the room
 * plays, and moving is a click on the side you want: an open seat sits you, the open slot here
 * gives your seat back (the operator, 2026-11-02: "show a separate section for spectators and you
 * can just click back and forth between player and spectator … we dont need a stand button at
 * all", and "please unify all rooms. it's irrelevant what type of room it is").
 *
 * Wave 119 §U: the rendering itself is now `@hadoku/game-ui/seats/SpectatorRow.tsx` — this file
 * is kept as Magic's own import path (every caller still imports `RoomSpectators` from here, no
 * caller changed) with every prop and every class name/`data-testid` unchanged.
 */

import { SpectatorRow, type SpectatorRowProps } from '@hadoku/game-ui/seats/SpectatorRow.tsx';

export type RoomSpectatorsProps = SpectatorRowProps;

export function RoomSpectators(props: RoomSpectatorsProps) {
  return <SpectatorRow {...props} />;
}
