/*
 * The sideboard step between games of a series, in the room itself — a pod's
 * (`PodScreen.tsx`) or a 1v1 room's (`ConstructedScreen.tsx`).
 *
 * The result screen draws it over the game that just ended — but only while
 * that page is open. A player who closed the tab and came back through the
 * room (or the front page) landed on the room with no way into it, while
 * their opponent waited on theirs (the rejoin audit, 2026-10-19). So the room
 * draws the same step (`LiveBoard.tsx`'s `SideboardStep`) for the player's
 * own table whenever it is `sideboarding`, and asks for the next game once
 * both have readied, as the result screen does — the server joins the two
 * asks into one start, and the room follows the new match.
 *
 * Nothing is drawn until the table, the 75 and the drafted pool have all
 * answered: the step opens whole, never empty-then-filled.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { myChoice, rematchOf, SideboardStep, startNextGame, useSideboardInputs } from '../play/live/LiveBoard.tsx';
import { tablesClient, type RoomTable, type SeatChoice, type TablesClient } from './tables.ts';

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

export function TableSideboard({ roomId, tableId, refresh, tables: given }: TableSideboardProps) {
  const tables = useMemo(() => given ?? tablesClient(), [given]);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Unreachable for a moment: the last answer stays, and the next room read asks again.
    tables.table(roomId, tableId).then(
      (answer) => {
        if (live && answer.ok) setTable(answer.table);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [roomId, tableId, tables, refresh]);

  // By content: every table read is a fresh object, and the 75 is read once per choice.
  const choiceKey = JSON.stringify(myChoice(table));
  const choice = useMemo(() => JSON.parse(choiceKey) as SeatChoice | null, [choiceKey]);
  const inputs = useSideboardInputs(choice, tables);

  const solo = table !== null && table.players.length === 1;
  const rematch = rematchOf(table, solo);
  const go = rematch.agreed || (solo && rematch.mine);
  const asked = useRef(false);
  useEffect(() => {
    if (!go || asked.current) return;
    asked.current = true;
    startNextGame(tables, roomId, tableId, solo).then(
      (answer) => {
        if (answer.ok) return;
        asked.current = false;
        setRefusal(answer.error);
      },
      (err: unknown) => {
        asked.current = false;
        setRefusal(err instanceof Error ? err.message : String(err));
      },
    );
  }, [go, solo, tables, roomId, tableId]);

  if (table === null || choice === null || inputs === undefined) return null;
  return (
    <div className="table-sideboard" data-testid="table-sideboard">
      {refusal !== null && (
        <p className="lobby__error" role="alert" data-testid="table-sideboard-refusal">
          {refusal}
        </p>
      )}
      <SideboardStep roomId={roomId} tableId={tableId} tables={tables} choice={choice} inputs={inputs} />
    </div>
  );
}
