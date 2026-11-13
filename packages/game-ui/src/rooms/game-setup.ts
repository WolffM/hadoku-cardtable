/*
 * The seam between the platform room screen and a game type's own UI.
 *
 * The room screen owns join, password, leader, members, spectators, seats, ready and start —
 * every room, whatever it plays. What a game type draws INSIDE that room is registered here, by
 * its `gameType` string, so the screen never imports a game's own file to find out what to
 * render.
 *
 * `view` is nullable because the room record and the room's table are two separate reads: a
 * table can answer before the room record does, or the room record can fail while the table
 * still holds a seat list. A game's `setup`/`game` must handle `view === null` exactly as the
 * room screen already does elsewhere (optional chaining, never a crash) rather than assume the
 * two reads land together.
 *
 * This file is `platform`: it imports no game's own code, Magic's included. A game registers
 * itself by calling `registerGameRoomUi` from ITS OWN module, once, at import — Magic's `draft`
 * and `constructed-1v1` do this from `screens/magic-room-ui.tsx`, the same way bomberman's own
 * module does, reading the room's injected clients from `rooms/game-clients.tsx` rather than
 * closing over `RoomTableScreen`'s props.
 */

import type { ReactNode } from 'react';

/**
 * The room's own fields a game type reads: the platform half of the room view. `@hadoku/shared`'s
 * `RoomBody`, which is Magic's composition and what the screen already holds, satisfies it as it is.
 */
export interface RoomViewBase {
  id: string;
  name: string;
  gameType: string;
  members: readonly { id: string; name: string; avatarId?: string }[];
  /** Who holds each of the room's game seats, by seat number (a member id, or null when open); a member not in it watches. */
  seats: readonly (string | null)[];
  you: { id: string; leader: boolean };
}

export interface GameSetupProps {
  /** The parsed public view, or null while it has not resolved. */
  view: RoomViewBase | null;
  me: {
    /** The caller's own member id (`view.you.id`), or `''` while `view` is null. */
    userId: string;
    /**
     * The caller's seat NUMBER at the table (`table.players[].seat`, 2-max, Magic's), or null
     * while unseated or for a game type with no 2-seat table at all. A non-Magic game type reads
     * its own seat list off `view`'s generic member data instead of this field.
     */
    seat: number | null;
    isLeader: boolean;
  };
  /** The room's game has started: a match is running, or (for a pod game type) the deal happened. */
  underway: boolean;
}

/**
 * What a game type renders inside the platform room screen: its setup before the start, its game
 * after.
 *
 * `setup` is what a player sees ABOVE the seats before the room is underway — Magic's format,
 * mode and deck chooser. A game type that offers no pre-start configuration (today, none) leaves
 * it absent, and the room screen draws nothing in its place.
 *
 * `game` is the game type's own placeholder for "the game" once the room is playing it — Magic's
 * board/pod card inside the room (the actual match is a screen of its own, reached by
 * navigation); Bomberman's `<BundleSlot>`. Required: every registered game type draws SOMETHING
 * once underway, even if it is nothing more than a status line.
 */
export interface GameRoomUi {
  setup?: (p: GameSetupProps) => ReactNode;
  game: (p: GameSetupProps) => ReactNode;
}

const registry = new Map<string, GameRoomUi>();

/**
 * Registers (or replaces) the UI a `gameType` renders inside the room screen. Called once, at
 * module scope, from the game type's own module — every registrant, Magic's `draft` and
 * `constructed-1v1` included.
 */
export function registerGameRoomUi(gameType: string, ui: GameRoomUi): void {
  registry.set(gameType, ui);
}

/** The UI registered for a `gameType`, or null for one nothing has registered. */
export function gameRoomUiFor(gameType: string): GameRoomUi | null {
  return registry.get(gameType) ?? null;
}
