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
 * Once the next game exists, this draws `SeriesEnterNext` — the SAME press-to-enter gate
 * `GameResultScreen` draws — rather than `TablePage.tsx`'s own `TableCard` ("Return to game"),
 * even though that card is drawn one level up the instant ITS OWN (much slower) table read shows
 * `matchId`. This component learns `next` off its own `roomFeed().follow` subscription — the same
 * mechanism `GameResultScreen` uses — rather than `TablePage`'s outer read.
 *
 * This renders `SeriesSideboardPanel`/`SeriesEnterNext` — `play/live/series/GameResultScreen.tsx`'s
 * own components, the SAME ones the in-game result screen draws, not a lookalike — and holds the
 * chrome shell as `'match'` while either is drawn, so the lobby path sits in the game's own frame
 * (`chrome/shell.ts`'s `hold()` stacks holders per attribute, so this gives the frame back to the
 * room's own `'fit'` once the step is gone).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useChromeShell } from '@hadoku/ui-shell/chrome/shell';

import { myChoice, rematchOf, SeriesEnterNext, SeriesSideboardPanel, startNextGame, useMatchExits, useSideboardInputs } from '../play/live/series/GameResultScreen.tsx';
import { openNewMatch } from '../play/live/matchStart.ts';
import { roomFeed } from '../rooms/follow.ts';
import { tablesClient, type RoomTable, type SeatChoice, type TablesClient } from './tables.ts';
import './TableSideboard.css';

export interface TableSideboardProps {
  roomId: string;
  tableId: string;
  /**
   * The room screen's last read of the room (which follows the room's feed):
   * a new one means the room moved — a Ready, a game starting — so the table
   * is read again. This component also follows the room's feed directly
   * (below), so this is a belt-and-braces re-read, not its only signal.
   */
  refresh: unknown;
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  tables?: TablesClient;
}

export function TableSideboard({ roomId, tableId, refresh, tables: given }: TableSideboardProps) {
  const tables = useMemo(() => given ?? tablesClient(), [given]);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const titleId = useId();
  const shellRef = useChromeShell('match');
  // The in-game step's own ways off (Back to room, Main menu): the room draws this panel alone in the
  // match's frame, with no room chrome around it, so without them a player who opened it from the
  // room had no way back but the browser's.
  const { exits } = useMatchExits(roomId);

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

  // The room's own feed, directly — not only `refresh`'s own re-renders: the same subscription
  // `GameResultScreen`'s own table read follows, so a Ready or a game start reaches this screen on
  // the room's own ping, not a fixed-interval poll.
  useEffect(() => roomFeed().follow({ room: roomId }, () => void readTable()), [roomId, readTable]);

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
   * Once the next game exists (this screen's own ask, right away, or its own feed-triggered table
   * read, once the OTHER screen's ask lands), this stays here — never the board — with one press
   * onward. `openNewMatch` is called ONLY from that press, exactly as `GameResultScreen`'s own.
   */
  const next = readyMatchId ?? table?.room.matchId ?? null;

  // `data-testid="table-sideboard"` is kept on the OUTER wrapper, both branches, for every other
  // lane/wave's existing e2e driver (and two unit tests) that finds the room's table-page step by
  // it — `e2e/w72-pod.spec.ts` among them. `table-sideboard-frame` (`TableSideboard.css`) gives the
  // panel inside (`.board__over`, `position: absolute; inset: 0`) a sized box to resolve against on
  // this page, unlike the match's own `.live`.
  if (next !== null) {
    return (
      <div className="table-sideboard-frame" data-testid="table-sideboard" ref={shellRef}>
        <SeriesEnterNext titleId={titleId} title="Sideboard" onEnter={() => openNewMatch(next)} exits={exits} />
      </div>
    );
  }

  if (table === null || choice === null || inputs === undefined) return null;
  return (
    <div className="table-sideboard-frame" data-testid="table-sideboard" ref={shellRef}>
      <SeriesSideboardPanel
        titleId={titleId}
        roomId={roomId}
        tableId={tableId}
        tables={tables}
        choice={choice}
        inputs={inputs}
        title="Sideboard"
        refusal={refusal}
        exits={exits}
      />
    </div>
  );
}
