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
 *
 * ## `ctx.channel`
 *
 * A room whose game type says `runtime: 'relay'` (`packages/shared/src/game-type-spec.ts`) gets a
 * `MatchChannel` built from a relay socket (`./relay-channel.ts`), the host's own transport for a
 * game with no server of its own — never both a channel AND the game's own server; today only
 * bomberman registers at all, and it does not set `runtime` yet (phase 6's own step). The channel
 * is opened once per room (`view.id`), not rebuilt on every `ctx` change, and disposed the moment
 * this slot stops needing it — a room that is no longer relay-typed, or unmounts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mountGameBundle, type GameBundleHandle } from '@wolffm/rooms-client';
import type { GameBundleContext, MatchChannel, MatchInfo, SeatInfo } from '@wolffm/rooms-protocol';
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
import { gameTypeSpec, registerGameType } from '../../../../packages/shared/src/game-type-spec.ts';

import { useWhoami } from '../room/whoami.ts';
import { registerGameRoomUi, type RoomViewBase } from './game-setup.ts';
import { openRelayChannel } from './relay-channel.ts';
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

  const isRelay = view !== null && gameTypeSpec(view.gameType)?.runtime === 'relay';
  const [channel, setChannel] = useState<MatchChannel | null>(null);

  // One channel per room, never rebuilt on a theme/identity/seat change — disposed the moment
  // this slot no longer needs one (a different room, or this one turning out not to be relay).
  useEffect(() => {
    if (!isRelay || view === null) return;
    const ch = openRelayChannel(view.id);
    setChannel(ch);
    return () => {
      ch.close();
      setChannel(null);
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

/**
 * The relay channel's own e2e fixture, and only it. `relay-test` is never a real room type a player can
 * pick — the server's own `relay-test` (`apps/server/src/plugins/relay.ts`) is registered only
 * behind `CARDTABLE_PLAY_PROBE=1`, never in production — so this client-side registration needs
 * the same kind of fence, but a browser bundle has no env var to read. `e2e/relay-fixture.spec.ts`
 * sets `window.__CARDTABLE_E2E_RELAY_TEST__` with Playwright's `addInitScript`, BEFORE this
 * module (already reachable from `rooms/games/bomberman.tsx` → `composition.tsx`, eagerly
 * imported at boot) ever evaluates, so the flag is in place the moment this line runs. Never set
 * outside that one spec: dead code for every real player and every other test.
 */
declare global {
  interface Window {
    __CARDTABLE_E2E_RELAY_TEST__?: boolean;
  }
}
if (typeof window !== 'undefined' && window.__CARDTABLE_E2E_RELAY_TEST__ === true) {
  registerGameType({
    id: 'relay-test',
    runtime: 'relay',
    seats: { min: 2, max: 2 },
    ready: false,
    series: { length: 1 },
    canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
  });
  registerGameRoomUi('relay-test', {
    game: (p) => <BundleSlot src="/relay-fixture/relay-test-embed.js" view={p.view} me={p.me} />,
  });
}
