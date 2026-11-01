/*
 * Arrangement sync: this seat's placement of its own battlefield goes to the
 * other seat, and theirs comes here, so both screens draw each side as its
 * owner placed it (`@hadoku/shared`'s `arrangement.ts` says why and what).
 *
 * Sending: `Board`'s store tells `onOwnArrangement` of every change this seat
 * makes to its rows (never its hand); each goes out at once — a placement is
 * one message, and the server bounds a runaway sender. Receiving: an echo
 * from the other seat is written under their player id with
 * `applyTheirArrangement`, which wakes the mounted board. A watcher (no seat)
 * sends nothing and is shown both sides as their owners placed them.
 *
 * An echo is applied to the player of the SEAT it is stamped with
 * (`playerOfSeat`, `forge:seats`' join key), never to "the other player": a
 * watcher hears both seats, and which of them is drawn at the bottom is its
 * own choice (`flipPerspective`). Before the first party (2026-10-12) every
 * echo went to the non-viewer, so on a watcher's screen seat 0's rows landed on
 * seat 1's side and the bottom side never moved at all — the operator: *"card
 * placement on board doesnt update as players move things around."* A seat's
 * own window still drops its own echo (a resync's replay of it).
 *
 * Only the seat table says whose an echo is — never "the other player". The
 * server sends `forge:seats` on every join and resync, right behind the ack;
 * an echo that arrives first (the join's replay) is held for it. Guessing in
 * that window is wrong for a watcher in particular: its ack names the seat it
 * is ORIENTED as, so for a moment it looks seated, and a guess put seat 0's
 * rows on seat 1's side.
 */
import { ARRANGEMENT_EVENT, ArrangementEchoSchema, type ArrangementMessage } from '@hadoku/shared';
import { viewerOf, type BoardView } from '../adapter.ts';
import { applyTheirArrangement, onOwnArrangement, type BoardLayout } from '../Board.tsx';
import type { MatchTransport } from './match.ts';

export interface ArrangementHost {
  readonly matchId: string;
  /** This seat's number; null while unseated (a spectator): then nothing is sent. */
  readonly seat: number | null;
  /** The Forge player a seat holds (`match.ts`'s `playerIdOfSeat`); null until `forge:seats` has named it. */
  readonly playerOfSeat: (seat: number) => number | null;
  readonly transport: Pick<MatchTransport, 'on' | 'emit'>;
  /** The board as the match holds it now; null before the first view. */
  readonly view: () => BoardView | null;
  /** The layout this seat draws with — the rows its arrangement names. */
  readonly layout: () => BoardLayout;
  /** Wake on every change of the match (`subscribe`): an echo that came before the view names their player is applied then. */
  readonly watch: (onChange: () => void) => () => void;
}

export interface ArrangementHandle {
  dispose(): void;
}

/**
 * Each seat's last echo per match, held until the view names its player. Module
 * state, not the handle's: the server replays a joiner the held arrangements
 * BEFORE the join's own ack, and the board re-installs this sync as the role
 * lands a moment later (`spectator` is a dependency of its effect) — an echo held
 * by the first handle alone went down with it, and a late watcher saw both
 * sides in Forge's order (2026-10-12). `presence.ts`'s `pendingPlaced` is the
 * same shape for the same reason.
 */
const HELD = new Map<string, Map<number, ArrangementMessage['rows']>>();

/** Tests: start from nothing held. */
export function forgetHeldArrangements(): void {
  HELD.clear();
}

export function installArrangementSync(host: ArrangementHost): ArrangementHandle {
  let live = true;
  const pending = HELD.get(host.matchId) ?? new Map<number, ArrangementMessage['rows']>();
  HELD.set(host.matchId, pending);

  const stopOwn = onOwnArrangement(({ playerId, rows }) => {
    if (!live || host.seat === null) return;
    const view = host.view();
    const mine = viewerOf(view)?.id;
    if (mine === undefined || mine !== playerId) return;
    const message: ArrangementMessage = {
      matchId: host.matchId,
      type: 'arrangement',
      layout: host.layout(),
      rows: Object.fromEntries(Object.entries(rows).map(([slot, piles]) => [slot, piles.map((pile) => [...pile])])),
    };
    host.transport.emit(ARRANGEMENT_EVENT, message);
  });

  function applyPending(): void {
    if (pending.size === 0) return;
    const view = host.view();
    if (view === null) return;
    for (const [seat, rows] of pending) {
      const owner = host.playerOfSeat(seat);
      if (owner === null || !view.players.some((p) => p.id === owner)) continue;
      applyTheirArrangement(view, owner, rows);
      pending.delete(seat);
    }
    if (pending.size === 0) HELD.delete(host.matchId);
  }

  function onEcho(payload: unknown): void {
    if (!live) return;
    const parsed = ArrangementEchoSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== host.matchId || parsed.data.seat === host.seat) return;
    pending.set(parsed.data.seat, parsed.data.rows);
    HELD.set(host.matchId, pending);
    applyPending();
  }
  host.transport.on(ARRANGEMENT_EVENT, onEcho);
  const stopWatch = host.watch(() => {
    if (live) applyPending();
  });

  return {
    dispose() {
      live = false;
      stopOwn();
      stopWatch();
    },
  };
}
