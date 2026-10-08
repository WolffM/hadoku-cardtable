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
 */
import { ARRANGEMENT_EVENT, ArrangementEchoSchema, type ArrangementMessage } from '@hadoku/shared';
import type { BoardView } from '../adapter.ts';
import { applyTheirArrangement, onOwnArrangement, type BoardLayout } from '../Board.tsx';
import type { MatchTransport } from './match.ts';

export interface ArrangementHost {
  readonly matchId: string;
  /** This seat's number; null while unseated (a spectator): then nothing is sent. */
  readonly seat: number | null;
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

export function installArrangementSync(host: ArrangementHost): ArrangementHandle {
  let live = true;
  /** The other seat's last echo, held until the view names their player (a reload's replay can land first). */
  let pending: { seat: number; rows: ArrangementMessage['rows'] } | null = null;

  const stopOwn = onOwnArrangement(({ playerId, rows }) => {
    if (!live || host.seat === null) return;
    const view = host.view();
    const mine = view?.players.find((p) => p.isViewer)?.id;
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
    if (pending === null) return;
    const view = host.view();
    const theirs = view?.players.find((p) => !p.isViewer);
    if (view === null || view === undefined || theirs === undefined) return;
    applyTheirArrangement(view, theirs.id, pending.rows);
    pending = null;
  }

  function onEcho(payload: unknown): void {
    if (!live) return;
    const parsed = ArrangementEchoSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== host.matchId || parsed.data.seat === host.seat) return;
    pending = { seat: parsed.data.seat, rows: parsed.data.rows };
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
