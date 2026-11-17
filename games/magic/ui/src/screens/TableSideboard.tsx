/*
 * The sideboard step between games of a series, in the room itself — a pod's
 * (`PodScreen.tsx`) or a 1v1 room's (`ConstructedScreen.tsx`).
 *
 * The result screen draws it over the game that just ended — but only while
 * that page is open. A player who closed the tab and came back through the
 * room (or the front page) landed on the room with no way into it, while
 * their opponent waited on theirs (the rejoin audit, 2026-10-19). So the room
 * draws the same step for the player's own table whenever it is `sideboarding`,
 * and asks for the next game once both have readied, as the result screen does
 * — the server joins the two asks into one start.
 *
 * Nothing is drawn until the table, the 75 and the drafted pool have all
 * answered: the step opens whole, never empty-then-filled.
 *
 * **AF639 (2026-11-16).** Once the next game exists, this draws `SeriesEnterNext` — the SAME
 * press-to-enter gate `GameResultScreen` draws — rather than `TablePage.tsx`'s own `TableCard`
 * ("Return to game"), even though that card is drawn one level up the instant ITS OWN table read
 * shows `matchId`. Measured (wave 122 §F, a real run against Forge): that OUTER read
 * (`magic-room-ui.tsx`'s `view`, threaded down as `refresh`) took well over two minutes to learn
 * the match existed, where THIS component's own read (below) learned it in single-digit seconds.
 * Both read the same table; only one of them is prompt enough to act as the gate. `next`'s own
 * source — this component's OWN successful ask, or its OWN next table read, never the outer one —
 * is why.
 *
 * **The fallback poll.** This component has no subscription of its own the way
 * `GameResultScreen`'s `roomFeed().follow` effect does — only whatever `refresh` the room screen's
 * last read hands down, which the same measurement found was not prompt either. `FALLBACK_POLL_MS`
 * is a plain interval, standing in for that missing subscription, while there is no next game yet.
 *
 * **AF628 (2026-11-16).** The operator: *"sideboarding entered from the room
 * lobby is exactly the in-game sideboarding screen; the site's top bar does
 * not show."* This component now renders `SeriesSideboardPanel` / `SeriesEnterNext` —
 * `play/live/series/GameResultScreen.tsx`'s own components, the SAME ones
 * `LiveBoard.tsx`'s result screen draws, rather than a lookalike of this file's own. That is
 * the half of AF628 a screen's own markup can fix.
 *
 * **What this file does NOT fix.** The site's top bar is drawn by the app's
 * chrome shell (`@hadoku/ui-shell`'s `useChromeShell`), which is `'fit'` for
 * every screen `RoomTableScreen` draws (`screens/magic-room-ui.tsx`) — this
 * component included, since it is one of them — and `'match'` only for
 * `MatchScreen.tsx`'s own board. `chrome/shell.ts`'s `hold()` keys one
 * attribute on the room's OUTER frame by whichever holder last set it; having
 * THIS component also call `useChromeShell('match')` while it is mounted
 * would — on unmount, back to a plain room's table — leave the frame with
 * NEITHER value (`hold()`'s cleanup only clears "if it is still mine", it does
 * not know `'fit'` is still held underneath), stripping the room's own
 * `100dvh` sizing for the rest of that visit. `chrome/shell.ts` is not this
 * lane's file and is shared by every game on the platform, not only Magic's
 * rooms; see `docs/handoff/w122-F/af628-measure.md` for the measurement and
 * the exact lines in `magic-room-ui.tsx` / `chrome/shell.ts` the manager or a
 * later wave would need to touch to close this half.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { myChoice, rematchOf, SeriesEnterNext, SeriesSideboardPanel, startNextGame, useSideboardInputs } from '../play/live/series/GameResultScreen.tsx';
import { openNewMatch } from '../play/live/matchStart.ts';
import { tablesClient, type RoomTable, type SeatChoice, type TablesClient } from './tables.ts';
import './TableSideboard.css';

export interface TableSideboardProps {
  roomId: string;
  tableId: string;
  /**
   * The room screen's last read of the room (which follows the room's feed):
   * a new one means the room moved — a Ready, a game starting — so the table
   * is read again. No second feed of its own.
   */
  refresh: unknown;
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  tables?: TablesClient;
}

/** While there is no next game yet, how often this polls the table on its own (see the effect below). */
const FALLBACK_POLL_MS = 3_000;

export function TableSideboard({ roomId, tableId, refresh, tables: given }: TableSideboardProps) {
  const tables = useMemo(() => given ?? tablesClient(), [given]);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const titleId = useId();

  const readTable = useCallback((): Promise<void> => {
    return tables.table(roomId, tableId).then(
      (answer) => {
        if (answer.ok) setTable(answer.table);
      },
      () => undefined,
    );
  }, [tables, roomId, tableId]);

  useEffect(() => {
    void readTable();
  }, [readTable, refresh]);

  // By content: every table read is a fresh object, and the 75 is read once per choice.
  const choiceKey = JSON.stringify(myChoice(table));
  const choice = useMemo(() => JSON.parse(choiceKey) as SeatChoice | null, [choiceKey]);
  const inputs = useSideboardInputs(choice, tables);

  const solo = table !== null && table.players.length === 1;
  const rematch = rematchOf(table, solo);
  const go = rematch.agreed || (solo && rematch.mine);
  const asked = useRef(false);
  /** This screen's OWN ask's answer, the instant it is known — see `GameResultScreen`'s own `readyMatchId`. */
  const [readyMatchId, setReadyMatchId] = useState<string | null>(null);
  useEffect(() => {
    if (!go || asked.current) return;
    asked.current = true;
    startNextGame(tables, roomId, tableId, solo).then(
      (answer) => {
        if (answer.ok) setReadyMatchId(answer.matchId);
        else {
          asked.current = false;
          setRefusal(answer.error);
        }
      },
      (err: unknown) => {
        asked.current = false;
        setRefusal(err instanceof Error ? err.message : String(err));
      },
    );
  }, [go, solo, tables, roomId, tableId]);

  /**
   * AF639: once the next game exists (this screen's own ask, right away, or this component's own
   * fallback-polled table read, once the OTHER screen's ask lands), this stays here — never the
   * board, and never waiting on `TablePage`'s own slower outer read — with one press onward.
   * `openNewMatch` is called ONLY from that press, exactly as `GameResultScreen`'s own.
   */
  const next = readyMatchId ?? table?.room.matchId ?? null;

  /**
   * A fallback poll, independent of `refresh`: see this file's header comment. Stops once `next`
   * is known — there is nothing left to learn once the next game exists.
   */
  useEffect(() => {
    if (next !== null) return undefined;
    const timer = setInterval(() => void readTable(), FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [next, readTable]);

  // `data-testid="table-sideboard"` is kept on the OUTER wrapper, both branches, for every other
  // lane/wave's existing e2e driver (and two unit tests) that finds the room's table-page step by
  // it — `e2e/w72-pod.spec.ts` (wave 122 lane E's, not touched here) among them. The PANEL inside
  // (AF628) is what moved; this wrapper's own testid did not. `table-sideboard-frame`
  // (`TableSideboard.css`) is this file's own fix for the panel's `.board__over` (`position:
  // absolute; inset: 0`) having no sized box to resolve against on this page, unlike the match's
  // own `.live` — read "hidden" by Playwright before this wrapper gave it one.
  if (next !== null) {
    return (
      <div className="table-sideboard-frame" data-testid="table-sideboard">
        <SeriesEnterNext titleId={titleId} title="Sideboard" onEnter={() => openNewMatch(next)} />
      </div>
    );
  }

  if (table === null || choice === null || inputs === undefined) return null;
  return (
    <div className="table-sideboard-frame" data-testid="table-sideboard">
      <SeriesSideboardPanel
        titleId={titleId}
        roomId={roomId}
        tableId={tableId}
        tables={tables}
        choice={choice}
        inputs={inputs}
        title="Sideboard"
        refusal={refusal}
      />
    </div>
  );
}
