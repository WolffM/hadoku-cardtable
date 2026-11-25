/*
 * Leaving a room: the one way out of the room page, whichever control asks for it.
 *
 * The operator, 2026-11-24: *"leave buttons seem good … And make sure clicking the top bar works as
 * well. I'd expect both to work."* Until then the top bar's title only navigated home: the player
 * stayed a member of the room they walked out of, and the only thing that left was a match's
 * result screen ("Main menu").
 *
 * Two halves, because the room and the way home belong to different owners:
 *
 * - **How to leave this room** is the game's: its own client's `/leave` (membership ends only by
 *   `/leave`, a close or the idle sweep; the leader's hand-over is the kit's). The room shell
 *   registers it while it is drawn (`useRoomLeave`), so a control outside the room's tree — the
 *   page's top bar — reaches it through `leaveRoomThen`.
 *   `RoomHomeLink` is that top bar's link, for any host that draws one.
 * - **Where home is** is the host's (`RoomHomeProvider`). Standalone, the app's front page; inside
 *   another site's page, whatever that site says. A host that supplies none (a slot whose room is
 *   the host's own, like a watchparty room's game) gets no Leave button: the shell never assumes it
 *   owns the page or the URL.
 */
import { createContext, useContext, useEffect, useRef, type AnchorHTMLAttributes } from 'react';

/** Where the viewer goes once they have left. `null`: this host has no "home" to leave to. */
export type RoomHome = (() => void) | null;

const RoomHomeContext = createContext<RoomHome>(null);

/** The host's own way home, for every room shell below it. */
export const RoomHomeProvider = RoomHomeContext.Provider;

export function useRoomHome(): RoomHome {
  return useContext(RoomHomeContext);
}

/** The game's `/leave` for the room on screen; whatever it answers, the viewer goes home after. */
export type LeaveRoom = () => Promise<unknown>;

let current: LeaveRoom | null = null;

/**
 * Registers how to leave the room drawn now, for as long as it is drawn. The latest `leave` is the
 * one called, so a caller may pass a fresh closure every render.
 */
export function useRoomLeave(leave: LeaveRoom | null): void {
  const latest = useRef(leave);
  latest.current = leave;
  const present = leave !== null;
  useEffect(() => {
    if (!present) return;
    const registered: LeaveRoom = () => (latest.current ?? (() => Promise.resolve()))();
    current = registered;
    return () => {
      if (current === registered) current = null;
    };
  }, [present]);
}

/**
 * Leave the room on screen, if there is one, then `home`. With no room drawn (the front page, a
 * match, an embedded slot), `home` alone. `home` runs whatever the leave answered: a refusal (the
 * room was closed under you, say) still leaves you where you asked to go, and a throw still goes
 * home before it reaches the caller.
 */
export function leaveRoomThen(home: () => void): Promise<void> {
  const leave = current;
  current = null;
  if (leave === null) {
    home();
    return Promise.resolve();
  }
  return leave().finally(home).then(() => undefined);
}

/**
 * The page's way home (a top bar's title, say), which leaves the room on screen on its way. A real
 * anchor, so it is keyboard-reachable, announces itself as a link and middle-clicks to `href`;
 * a plain press leaves, then goes where the host's `RoomHomeProvider` says. Under no provider it is
 * an ordinary link to `href`.
 */
export function RoomHomeLink({ href, ...anchor }: { href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const home = useRoomHome();
  return (
    <a
      {...anchor}
      href={href}
      onClick={
        home === null
          ? undefined
          : (e) => {
              e.preventDefault();
              void leaveRoomThen(home);
            }
      }
    />
  );
}
