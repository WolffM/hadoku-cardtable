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
 * The room's own seats, `view.seats` (`RoomView.seats`): every joiner is sat while a seat is open
 * (the 2026-11-02 ruling, `seats-and-watchers-contract`), and everyone else watches. The relay
 * seats each socket by the same list (`Lobby.gameSeatOf`), so the seat a bundle is told is the
 * seat its channel speaks for. `match.seats` names each held seat by its own number (an open
 * seat is left out, so a pod's eight places do not read as eight players); `match.seat` is the
 * caller's own seat (by `me.userId`, which is `view.you.id`), or null for a watcher.
 *
 * ## When it mounts
 *
 * As soon as `view` and the viewer's identity have both resolved — there is no server-side
 * "start" for a pod game type outside Magic's own draft deal, and the lobby's start route refuses
 * one (`apps/server/src/room/lobby.ts`, nobody's this wave), so gating on `underway` would simply
 * never show the game. `view === null`, or identity not yet settled, both render an empty slot
 * rather than mount with a guess.
 *
 * ## `ctx.channel`
 *
 * A room whose game type says `runtime: 'relay'` (`packages/shared/src/game-type-spec.ts`) gets a
 * `MatchChannel` built from a relay socket (`./relay-channel.ts`), the host's own transport for a
 * game with no server of its own — never both a channel AND the game's own server (bomberman is
 * one). The channel is opened once per room (`view.id`), not rebuilt on every `ctx` change, and
 * disposed the moment this slot stops needing it — a room that is no longer relay-typed, or
 * unmounts.
 *
 * ## The result
 *
 * When the relay match ends on the leader's `{ t: 'over', winners }`, the host says so to every
 * screen (`relay:ended`), and this slot shows the winners under the game: the room's result,
 * not the bundle's. `winners` are seat numbers in `match.seats`' numbering above — the one the
 * bundle itself was handed — so they name the same people on every screen. A screen that loads
 * the room after the end shows it too (the join answers with it), and it stays until the next
 * match is under way.
 *
 * ## The next match
 *
 * A relay room plays one match after another. On the end, the channel has already joined the
 * room's next match (`./relay-channel.ts`), and this slot mounts the bundle afresh on the same
 * channel: a bundle treats `over` as final for the match it was mounted for, so the next match
 * is a fresh mount, exactly as on first entering the room.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mountGameBundle, type GameBundleHandle } from '@wolffm/rooms-client';
import type { GameBundleContext, MatchInfo, SeatInfo } from '@wolffm/rooms-protocol';
import { useHadokuTheme } from '@wolffm/themes';
// A relative cross-package import, not `@hadoku/shared`'s own barrel: the layer ratchet
// (`scripts/layers/scan.ts`) resolves a bare `@hadoku/shared` specifier to the PACKAGE's overall
// layer, which is `magic` (most of its files are) — a platform file importing `@hadoku/shared`
// at all is a `platform→magic` violation regardless of which symbol it names. `game-type-spec.ts`
// is explicitly carved out as `platform` in `layers.json`, and a relative path resolves to that
// ONE file's own classification instead — the same technique `apps/ui/src/play/art.testing.ts`
// already uses to reach `apps/server/src/http/card-art.ts`. Still one module and one registry:
// `@hadoku/shared`'s package.json exports only `.` → `./src/index.ts`, which re-exports this same
// file, so Vite and vitest resolve both paths to the identical module.
import { gameTypeSpec } from '../../../../packages/shared/src/game-type-spec.ts';

import { useWhoami } from '../room/whoami.ts';
import type { RoomViewBase } from './game-setup.ts';
import { openRelayChannel, type RelayChannel } from './relay-channel.ts';
// The relay channel's own e2e fixture (`relay-test`), never a real room type: a side-effect
// import, exactly as `composition.tsx` imports `rooms/games/bomberman.tsx` — see that module's
// own doc for the flag it reads before registering anything.
import './relay-test-fixture.tsx';
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

/** The name of the member holding seat `seat`, or null for an open seat. */
function seatHolderName(view: RoomViewBase, seat: number): string | null {
  const holder = view.seats[seat];
  return view.members.find((m) => m.id === holder)?.name ?? null;
}

function matchOf(view: RoomViewBase, myId: string): MatchInfo {
  const seats: SeatInfo[] = view.seats.flatMap((_, seat) => {
    const name = seatHolderName(view, seat);
    return name === null ? [] : [{ seat, userId: name, name }];
  });
  const seat = view.seats.indexOf(myId);
  return { id: view.id, seat: seat === -1 ? null : seat, seats };
}

export function BundleSlot({ src, view, me, onClose }: BundleSlotProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<GameBundleHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useHadokuTheme();
  const who = useWhoami();

  const isRelay = view !== null && gameTypeSpec(view.gameType)?.runtime === 'relay';
  const [channel, setChannel] = useState<RelayChannel | null>(null);
  /** The room's last result (`RelayChannel.onResult`); null while none is shown. */
  const [winners, setWinners] = useState<readonly number[] | null>(null);
  /** How many of this room's relay matches have ended on this screen: each one remounts the bundle. */
  const [matchesEnded, setMatchesEnded] = useState(0);

  // One channel per room, never rebuilt on a theme/identity/seat change — disposed the moment
  // this slot no longer needs one (a different room, or this one turning out not to be relay).
  useEffect(() => {
    if (!isRelay || view === null) return;
    const ch = openRelayChannel(view.id);
    setChannel(ch);
    const offEnded = ch.onEnded(() => setMatchesEnded((n) => n + 1));
    const offResult = ch.onResult(setWinners);
    return () => {
      offEnded();
      offResult();
      ch.close();
      setChannel(null);
      setWinners(null);
      setMatchesEnded(0);
    };
  }, [isRelay, view?.id]);

  const ctx = useMemo<GameBundleContext | null>(() => {
    if (view === null || who === 'pending' || who === null) return null;
    return {
      roomKey: view.id,
      identity: { userId: who.userId, userType: who.tier, name: who.name },
      theme,
      isLeader: me.isLeader,
      close: () => onClose?.(),
      match: matchOf(view, me.userId),
      ...(channel !== null ? { channel } : {}),
    };
  }, [view, who, theme, me.isLeader, me.userId, onClose, channel]);

  const ready = ctx !== null;

  // Mount once the context first becomes available, and afresh for each relay match after the
  // first; any other context change goes through update() below, never a remount (a seat change
  // is not a new game).
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
    // Deliberately not ctx: mounts on readiness and on a new match, not on every later ctx change.
  }, [src, ready, matchesEnded]);

  useEffect(() => {
    if (ctx !== null) handleRef.current?.update(ctx);
  }, [ctx]);

  if (!ready) return <div className="room-bundle-slot" data-testid="room-bundle-slot" />;

  return (
    <div className="room-bundle-slot" data-testid="room-bundle-slot">
      <div ref={hostRef} className="room-bundle-slot__host" />
      {winners !== null && winners.length > 0 && view !== null && (
        <p className="room-bundle-slot__result" data-testid="room-bundle-result" data-winners={winners.join(',')}>
          {winners.map((w) => seatHolderName(view, w) ?? `Seat ${w + 1}`).join(', ')} won
        </p>
      )}
      {error !== null && (
        <div role="alert" className="room-bundle-slot__error" data-testid="room-bundle-slot-error">
          {error}
        </div>
      )}
    </div>
  );
}
