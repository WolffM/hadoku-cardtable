/*
 * BundleSlot — mounts a same-origin game bundle (a module exporting `GameBundleModule`) inside
 * the room screen, the way watchparty mounts one inside its own room: through
 * `@wolffm/rooms-client`'s `mountGameBundle`, never by importing the bundle's own code here. A
 * game type registers it as its `GameRoomUi.game` (`rooms/games/bomberman.tsx`); this file knows
 * nothing about bomberman or any other bundle, only the contract.
 *
 * `platform`: imports nothing of Magic's. `view` comes in as `RoomViewBase`
 * (`./game-setup.ts`), never `@hadoku/shared`'s `RoomBody` — that package is Magic's to import,
 * this one is not.
 *
 * ## Where `match.seats` comes from
 *
 * There is no generic seat table to read here: a non-Magic room's pod seats are Magic's own
 * stored field (`magicGame()` hides them for any other game type), so nothing server-side names
 * who holds a seat versus who is merely watching, for a game type like this one. But every room
 * auto-seats every joiner (the 2026-11-02 ruling, `seats-and-watchers-contract`), and
 * `RoomViewBase.members` carries no spectator flag of its own — so `view.members` IS the seat
 * list, in the room's own order. `match.seats[i]` is `view.members[i]`; `match.seat` is the
 * caller's own index in it (by `me.userId`, which is `view.you.id`), or null on the (should not
 * happen) case that the caller is not among its own room's members.
 *
 * ## When it mounts
 *
 * As soon as `view` and the viewer's identity have both resolved — there is no server-side
 * "start" for a pod game type outside Magic's own draft deal, and the lobby's start route refuses
 * one (`apps/server/src/room/lobby.ts`, nobody's this wave), so gating on `underway` would simply
 * never show the game. `view === null`, or identity not yet settled, both render an empty slot
 * rather than mount with a guess.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mountGameBundle, type GameBundleHandle } from '@wolffm/rooms-client';
import type { GameBundleContext, MatchInfo, SeatInfo } from '@wolffm/rooms-protocol';
import { useHadokuTheme } from '@wolffm/themes';

import { useWhoami } from '../room/whoami.ts';
import type { RoomViewBase } from './game-setup.ts';
import './BundleSlot.css';

export interface BundleSlotProps {
  /** The bundle's module URL: a same-origin path, e.g. `/bomberman/embed/bomberman-embed.js`. */
  src: string;
  view: RoomViewBase | null;
  me: { userId: string; isLeader: boolean };
  /**
   * Called when the bundle asks to close. There is no default — whether "close" means leaving
   * the room, or something lighter, is the caller's to decide; omitted, close is a no-op.
   */
  onClose?: () => void;
}

function matchOf(view: RoomViewBase, myId: string): MatchInfo {
  const seats: SeatInfo[] = view.members.map((m, i) => ({ seat: i, userId: m.name, name: m.name }));
  const seat = view.members.findIndex((m) => m.id === myId);
  return { id: view.id, seat: seat === -1 ? null : seat, seats };
}

export function BundleSlot({ src, view, me, onClose }: BundleSlotProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<GameBundleHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useHadokuTheme();
  const who = useWhoami();

  const ctx = useMemo<GameBundleContext | null>(() => {
    if (view === null || who === 'pending' || who === null) return null;
    return {
      roomKey: view.id,
      identity: { userId: who.userId, userType: who.tier, name: who.name },
      theme,
      isLeader: me.isLeader,
      close: () => onClose?.(),
      match: matchOf(view, me.userId),
    };
  }, [view, who, theme, me.isLeader, me.userId, onClose]);

  const ready = ctx !== null;

  // Mount once the context first becomes available; a later context change goes through
  // update() below, never a remount (a seat change is not a new game).
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    const el = hostRef.current;
    const mountCtx = ctxRef.current;
    if (el === null || mountCtx === null) return;
    setError(null);
    const handle = mountGameBundle({
      load: () => import(/* @vite-ignore */ src),
      el,
      ctx: mountCtx,
      onError: (message) => setError(message),
    });
    handleRef.current = handle;
    return () => {
      handle.dispose();
      handleRef.current = null;
    };
    // Deliberately [src, ready], not ctx: mounts on readiness, not on every later ctx change.
  }, [src, ready]);

  useEffect(() => {
    if (ctx !== null) handleRef.current?.update(ctx);
  }, [ctx]);

  if (!ready) return <div className="room-bundle-slot" data-testid="room-bundle-slot" />;

  return (
    <div className="room-bundle-slot" data-testid="room-bundle-slot">
      <div ref={hostRef} className="room-bundle-slot__host" />
      {error !== null && (
        <div role="alert" className="room-bundle-slot__error" data-testid="room-bundle-slot-error">
          {error}
        </div>
      )}
    </div>
  );
}
