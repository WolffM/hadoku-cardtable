/*
 * Opening a room drawn.
 *
 * The operator, 2026-10-10: *"when creating a room it instantly navigates to
 * the new page before it's ready creating a weird flicker effect. can we make
 * sure the whole page is ready before we navigate users there?"* The room
 * screen's first render had nothing: its title fell back to the room id, its
 * body waited on the room record, the deck picker on the table and the
 * catalogue, and the dropdown narrowed again when the pool's legality sweep
 * landed.
 *
 * So the list reads all of that BEFORE it navigates (`warmRoom`), and the room
 * screen takes it as its initial state (`takeWarmRoom`). The screen still runs
 * every one of its own reads and polls exactly as before: a warm only means
 * the first paint is the finished page, never that a read is skipped for good.
 *
 * One room, taken once. A warm for another room, or one already taken, is
 * never drawn: a stale table from an earlier visit is worse than a load.
 */

import {
  draftPoolPod,
  legalDecksIn,
  newestFormat,
  tablesClient,
  type LegalSweep,
  type RoomTable,
  type TableDeck,
  type TableFormat,
  type TablesClient,
} from '../screens/tables.ts';
import type { RoomView } from './api.ts';

export interface WarmRoom {
  readonly view: RoomView;
  readonly table: RoomTable;
  /** The formats and decks; absent for a draft room, which holds no deck. */
  readonly catalogue?: { formats: TableFormat[]; decks: TableDeck[] };
  /** The room pool's legality sweep, when its deck picker would ask for one. */
  readonly sweep?: LegalSweep;
}

/** How long the list waits before it navigates anyway, to a page that then loads as before. */
export const WARM_TIMEOUT_MS = 4000;

let pending: { roomId: string; warm: WarmRoom } | null = null;

/** What the room screen's first render needs, read while the list is still on screen. */
async function readRoom(view: RoomView, tables: TablesClient): Promise<WarmRoom | null> {
  const draft = view.gameType === 'draft';
  const [table, catalogue] = await Promise.all([
    tables.table(view.id),
    draft ? undefined : Promise.all([tables.formats(), tables.decks()]).then(([formats, decks]) => ({ formats, decks })),
  ]);
  // A table the server refused is the screen's to explain, in its own words.
  if (!table.ok) return null;
  if (catalogue === undefined) return { view, table: table.table };
  const poolId = view.format !== '' ? view.format : newestFormat(catalogue.formats);
  if (poolId === '' || draftPoolPod(poolId) !== null) return { view, table: table.table, catalogue };
  const sweep = await legalDecksIn(tables, poolId, catalogue.decks);
  // A refused sweep is not handed on: the screen asks again and reports it.
  return sweep.error === null ? { view, table: table.table, catalogue, sweep } : { view, table: table.table, catalogue };
}

/**
 * Reads what `view`'s room screen draws first, so navigating there shows the
 * finished page. Resolves within `timeoutMs` whatever the server does: a slow
 * or failed read only means the screen loads the way it always has.
 */
export async function warmRoom(
  view: RoomView,
  tables: TablesClient = tablesClient(),
  timeoutMs: number = WARM_TIMEOUT_MS,
): Promise<void> {
  pending = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  // A failed read is not lost: the screen makes the same read on mount and
  // shows its error there, where it belongs.
  const warm = await Promise.race([readRoom(view, tables).catch(() => null), timeout]);
  clearTimeout(timer);
  if (warm !== null) pending = { roomId: view.id, warm };
}

/** The warm for `roomId`, once. */
export function takeWarmRoom(roomId: string): WarmRoom | undefined {
  if (pending === null || pending.roomId !== roomId) return undefined;
  const { warm } = pending;
  pending = null;
  return warm;
}
