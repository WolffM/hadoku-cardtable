/* What a connection is doing, as `./ConnectionBanner.tsx` shows it; a game computes it from its socket (`../draft/connection.ts`). */

export type ConnectionPhase =
  /** No connection has ever been established. */
  | 'connecting'
  /** Connected, in sync, nothing to say. */
  | 'live'
  /** Connected, but we asked for a full snapshot and it has not arrived. */
  | 'resyncing'
  /** We were connected and are not now. The seat is held for the TTL. */
  | 'offline'
  /** Connected again; nothing has arrived since the re-join. */
  | 'reconnecting'
  /** Connected again and the first payload has landed. */
  | 'recovered';

export interface ConnectionState {
  phase: ConnectionPhase;
  /**
   * Whether the server is holding THIS client's seat right now.
   *
   * True only while offline with a seat: `releaseSeat` and the reconnect guard
   * in `games/magic/server/src/room/draftRooms.ts` hold a seat against everyone else
   * for the reservation TTL, and a spectator has no seat to hold.
   */
  seatHeld: boolean;
  /** Whether the draft is frozen from the player's point of view. */
  stalled: boolean;
  /** One short line for the banner. */
  label: string;
  /** The sentence under it. Says what is happening, never "something failed". */
  detail: string;
}

/** Whether the banner has anything worth showing. `live` is silence. */
export function isWorthShowing(state: ConnectionState): boolean {
  return state.phase !== 'live';
}
