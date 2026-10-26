/*
 * The constructed table's client: the calls `ConstructedScreen` and the deck
 * builder make, and nothing that renders.
 *
 * The server is the authority on every one of them — which formats exist,
 * which decks exist, whether a deck is legal, who is ready — and this file only
 * asks and reads the answer (`apps/server/src/http/routes.ts` has the
 * contract). In particular there is no legality check here: the verdict a
 * screen shows is the server's (`POST /api/tables/check`, or the verdict stored
 * when a deck is loaded into a room), and the one that refuses a match is the
 * server's gate on `POST /api/play/matches`. A client-side copy of the
 * validator would be a second opinion that could disagree with the one that
 * counts.
 *
 * A match against a PERSON starts from a room — `startRoom`, which names the
 * room and no deck at all, because each player loaded their own. `start` is the
 * AI arm, where both decks are the one caller's to choose; the server refuses
 * that shape against a human (Wave 13 §C).
 *
 * ## The room's pool is the room's, so `loadDeck` names a deck and nothing else
 *
 * Wave 25: the format was per-SEAT — each caller sent its own `rules` with its
 * deck and the server stored them — so two players could load decks legal in
 * two different Standard pools and the match started anyway. The pool is the
 * TABLE's now, set by the leader through `PATCH /api/rooms/:id`
 * (`rooms/api.ts`'s `setFormat`), and `PUT …/deck` therefore carries `{ deck }`
 * only. A body that still carries `rules` is refused with 400, so this is not a
 * field that could be sent and quietly ignored.
 *
 * `check` is unchanged and still takes a whole `SeatChoice`: it is the question
 * "would this deck be legal in that pool", asked of no room at all, by the deck
 * builder. `legal` asks the same of the whole library at once, for the picker.
 *
 * `fetch` is an argument so a test can answer without a server. Production
 * passes nothing and gets the global.
 *
 * Every path is relative to `import.meta.env.BASE_URL` — `/cardtable/` in
 * production, where the edge strips the prefix before the server sees it. An
 * absolute `/api/…` would reach `hadoku.me/api/…`, which is somebody else.
 */

import { GauntletViewSchema, newestStandardEra, type GauntletAct, type GauntletView } from '@hadoku/shared';

import { apiBase, getJson, sendJson, type Fetch } from '../http.ts';

/**
 * Which ruleset family an era belongs to (wave 48). Mirrors the server's own
 * `FormatFamily` (`apps/server/src/http/library.ts`) over the wire.
 */
export type FormatFamily = 'standard' | 'modern' | 'legacy';

/**
 * The three ruleset tabs, operator order (2026-10-05): *"i'll need a tab
 * selector at the top for picking the format as well obviously"*. A drafted
 * deck is never a room's format: it is one of Free pick's "My decks".
 */
export const FORMAT_TABS: ReadonlyArray<{ id: FormatFamily; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'modern', label: 'Modern' },
  { id: 'legacy', label: 'Legacy' },
];

/** A frozen era — not Free pick, whose row also carries a `family`. */
export function isEra(f: TableFormat): boolean {
  return f.source !== 'free';
}

export type GauntletOutcome = { ok: true; view: GauntletView } | { ok: false; error: string };

/** One era a Gauntlet may be played in, as `GET /api/tables/gauntlet/eras` names it ("Modern — 2022"). */
export interface GauntletEraOption {
  id: string;
  family: FormatFamily;
  title: string;
}

export interface TableFormat {
  id: string;
  name: string;
  effective: string;
  sets: string[];
  banned: string[];
  cardCount: number;
  source: string;
  /** Which tab this era belongs to. The server sends it; this is never parsed from `name`. */
  family: FormatFamily;
}

/**
 * `formats`, narrowed to one tab's own eras, newest year first.
 *
 * Grouped on `family` — data the server sends — never on a parsed name
 * (brief item 2): a `Standard (ORI)` string tells a person which card frame
 * it was, not which of three tabs it belongs on.
 *
 * Sorted by `id` descending rather than by a parsed date: a Standard id IS its
 * bare `YYYY-MM-DD` date, and a Modern/Legacy id is `<family>-<date>` with the
 * SAME family prefix for every era in one tab's own list, so lexicographic
 * order on `id` is chronological order within the tab either way.
 */
export function erasOf(formats: readonly TableFormat[], tab: FormatFamily): TableFormat[] {
  return formats
    .filter((f) => isEra(f) && f.family === tab)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Whether `poolId` — the room's ACTUAL pool — is one of the options `tab`
 * itself offers.
 *
 * Found live (w48 §U): a native `<select>` whose `value` matches none of its
 * `<option>`s falls back to showing the FIRST option as already selected, so
 * a leader browsing a tab the room is not on would see an era highlighted
 * that was never chosen — and clicking that exact one fires no `change`
 * event (the browser already considered it selected), so the room could
 * never be moved to it. The caller uses this to render no selection at all
 * on a tab the room's own era is not part of, rather than let the DOM invent
 * one.
 */
export function poolIsOnTab(formats: readonly TableFormat[], tab: FormatFamily, poolId: string): boolean {
  return erasOf(formats, tab).some((f) => f.id === poolId);
}

export interface DeckLine {
  count: number;
  name: string;
}

export interface TableDeck {
  id: string;
  collection: string;
  /**
   * The id of the era its collection was catalogued for. Not `format` + `date`:
   * `date` is the event's and `effective` is when Forge's ruleset began, so the
   * two differ whenever an event came weeks after a release (Legacy 2025: FIN
   * from 2025-06-13, the event 2025-06-30).
   */
  era: string;
  name: string;
  /**
   * `name`'s two halves as the library records them (`Archetype` and `Pilot`
   * in the deck's own file): what the deck is, and who played it. Absent for
   * nothing — every library deck has both.
   */
  archetype: string;
  pilot: string;
  format: string;
  date: string;
  provenance: string;
  citation: string;
  main: DeckLine[];
  sideboard: DeckLine[];
}

export interface WireIssue {
  kind: string;
  message: string;
  cardName: string | null;
  count: number | null;
  limit: number | null;
}

export interface Verdict {
  deckName: string;
  rulesName: string;
  legal: boolean;
  issues: WireIssue[];
  note: string | null;
}

export type DeckRef = { library: string } | { dck: string };
export type DeckRules = { kind: 'standard'; format: string } | { kind: 'draft'; draftId: string } | { kind: 'free' };
export interface SeatChoice {
  deck: DeckRef;
  rules: DeckRules;
}

export type StartOutcome =
  | { ok: true; matchId: string }
  /** `seats` is present when the server refused a deck: one verdict per seat. */
  | { ok: false; error: string; seats: Verdict[] | null };

/* ── a room's table ──────────────────────────────────────────────────── */

/**
 * Your own deck at a room's table, as only you are told it: its name, the
 * pool's words for it, whether it is legal and how many faults it has, and
 * the choice that restores your picker.
 */
export interface SeatDeck {
  name: string;
  rulesName: string;
  legal: boolean;
  issueCount: number;
  choice: SeatChoice;
}

/**
 * One player at a room's table, as the CALLER is told it.
 *
 * Another player's row is their name and whether they are ready, and nothing
 * of their deck (the operator, 2026-10-21: "don't reveal the deck that someone
 * has picked … just showing whether or not they are ready is good enough").
 * Ready already means a legal deck: the server refuses it without one.
 * `deck` is on your own row only — `null` while your seat has none yet
 * (2026-10-12: sitting is its own act).
 */
export interface RoomPlayer {
  seat: number;
  name: string;
  you: boolean;
  ready: boolean;
  deck?: SeatDeck | null;
}

/**
 * What the CALLER is at this table, which the room record cannot say.
 *
 * `leader` is the server's answer to "is the leader me" — `RoomView.leader` is a
 * hashed participant id and no browser can derive its own, so this is the only
 * thing that can tell a screen whether it owns the table's settings.
 */
export interface RoomTableYou {
  player: boolean;
  leader: boolean;
}

export interface RoomTable {
  /**
   * `locked`: a match is live, or both players are ready — nobody stands up (the operator's ruling, 2026-10-12).
   * `phase`: the table's series phase (`seating`/`playing`/`sideboarding`/`done`).
   */
  room: { id: string; name: string; gameType: string; matchId: string | null; seats: number; locked?: boolean; phase?: string };
  you: RoomTableYou;
  players: RoomPlayer[];
}

/** Every table call answers the whole table, or says why it would not. */
export type TableOutcome =
  | { ok: true; table: RoomTable }
  | { ok: false; error: string; status: number };

export interface TablesClient {
  formats(): Promise<TableFormat[]>;
  decks(): Promise<TableDeck[]>;
  check(seat: SeatChoice): Promise<Verdict>;
  /** Which library decks are legal in a Standard-family era: the gate's answer, in one call. */
  legal(formatId: string): Promise<string[]>;
  /** The eras a Gauntlet can be played in: the server's own list, each with ten decks or more. */
  gauntletEras(): Promise<GauntletEraOption[]>;
  /**
   * A Gauntlet room's state as this caller may see it, at `tableId` (a
   * tournament's own table; absent for the room's first, same as every
   * other table-scoped call — `withTable`'s own doc). Throws with the
   * server's sentence.
   */
  gauntlet(roomId: string, tableId?: string): Promise<GauntletView>;
  /** Ready (or not) at a Gauntlet table; `ai` plays Forge's AI from the other seat. */
  gauntletReady(roomId: string, ready: boolean, ai?: boolean, tableId?: string): Promise<GauntletOutcome>;
  /** A ban or a pick, on this seat's turn. */
  gauntletAct(roomId: string, act: GauntletAct, deck: string, tableId?: string): Promise<GauntletOutcome>;
  /** This seat's hidden choice of its deck for the next game. */
  gauntletChoose(roomId: string, deck: string, tableId?: string): Promise<GauntletOutcome>;
  /** Against Forge's AI only. A match against a person starts from a room. */
  start(opponent: 'human' | 'ai', seats: [SeatChoice, SeatChoice]): Promise<StartOutcome>;
  /**
   * Both players' state at a room's table. `tableId` names one of the room's
   * tables (`RoomView.tables`, `@hadoku/shared`'s `RoomTable.id`); absent
   * means the room's first table, same as every caller before wave 72's
   * multi-table rooms (`routes.ts`'s `resolveTable`).
   */
  table(roomId: string, tableId?: string): Promise<TableOutcome>;
  /**
   * Load MY deck. There is no call that names anybody else's, and none that
   * names a format either: the ROOM's pool is the rules for both seats, and a
   * body carrying `rules` is refused with 400.
   */
  loadDeck(roomId: string, deck: DeckRef, tableId?: string): Promise<TableOutcome>;
  /** `rematch`: readied by a finished game's Rematch, not the room's Ready — an All Random table keeps its decks. */
  ready(roomId: string, ready: boolean, tableId?: string, opts?: { rematch?: boolean }): Promise<TableOutcome>;
  /** `POST …/sit`: take a free seat, before choosing a deck. 409 when the table is full or locked. */
  sit(roomId: string, tableId?: string): Promise<TableOutcome>;
  /** `POST …/stand`: give the seat back. 409 once both are ready or the match is live. */
  stand(roomId: string, tableId?: string): Promise<TableOutcome>;
  /** Start the room's match. Either player may; the server answers one match. */
  startRoom(roomId: string, tableId?: string): Promise<StartOutcome>;
  /**
   * Start a match against Forge's AI from a room where you are the only
   * member — the server picks a random library deck legal in the room's pool
   * for the bot's seat (`apps/server/src/http/routes.ts`'s `startFromRoom`,
   * `vsBot` arm). Refused with a second member in the room, before a deck is
   * loaded, or for a drafted pool (no library deck is legal in one).
   * `rematch` says the start is a finished game's Rematch, so the bot plays
   * the deck it just played; any other start of a new series draws a new one.
   */
  startVsBot(roomId: string, tableId?: string, opts?: { rematch?: boolean }): Promise<StartOutcome>;
  /**
   * `GET /api/play/queue`: my place, 1-based, while a start I am waiting on waits for a Forge JVM
   * (`./queue-place.ts`); null when none is waiting. Throws when the server cannot answer.
   */
  queuePlace(): Promise<number | null>;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: the 404 below the friend floor is `text/plain`, and a proxy
    // error page is HTML. Both are reported by status, below.
  }
  return { error: `the server answered ${res.status} without a JSON body` };
}

function errorOf(body: Record<string, unknown>, status: number): string {
  return typeof body.error === 'string' ? body.error : `the server answered ${status}`;
}

/**
 * `payload` with `table` set ONLY when `tableId` is given — an absent key, not
 * an explicit `undefined`, so a pre-wave-72 body (every call made before a
 * table id existed to pass) still serialises exactly as it always did and the
 * server's `resolveTable` still reads "named no table" as `tables[0]`.
 */
function withTable<T extends Record<string, unknown>>(payload: T, tableId: string | undefined): T & { table?: string } {
  return tableId === undefined ? payload : { ...payload, table: tableId };
}

export function tablesClient(fetchImpl: Fetch = (input, init) => fetch(input, init), base = apiBase()): TablesClient {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const res = await getJson(`${base}${path}`, fetchImpl);
    const body = await readJson(res);
    if (!res.ok) throw new Error(errorOf(body, res.status));
    return body;
  };
  const send = async (
    method: 'POST' | 'PUT',
    path: string,
    payload: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await sendJson(`${base}${path}`, method, payload, fetchImpl);
    return { status: res.status, body: await readJson(res) };
  };
  const post = (path: string, payload: unknown) => send('POST', path, payload);
  /** A Gauntlet move: the view as it now stands, or the server's refusal in its words. */
  const gauntletWrite = async (roomId: string, move: 'ready' | 'act' | 'choose', payload: unknown): Promise<GauntletOutcome> => {
    const { status, body } = await post(`tables/rooms/${encodeURIComponent(roomId)}/gauntlet/${move}`, payload);
    if (status !== 200) return { ok: false, error: errorOf(body, status) };
    const view = GauntletViewSchema.safeParse(body);
    return view.success ? { ok: true, view: view.data } : { ok: false, error: 'the server answered with something that is not a Gauntlet' };
  };

  /** A table call's answer: the whole table, or the server's sentence. */
  const table = ({ status, body }: { status: number; body: Record<string, unknown> }): TableOutcome => {
    if (status === 200) return { ok: true, table: body as unknown as RoomTable };
    return { ok: false, error: errorOf(body, status), status };
  };

  return {
    formats: async () => ((await get('tables/formats')).formats ?? []) as TableFormat[],
    decks: async () => ((await get('tables/decks')).decks ?? []) as TableDeck[],
    check: async (seat) => {
      const { status, body } = await post('tables/check', seat);
      if (status !== 200) throw new Error(errorOf(body, status));
      return body as unknown as Verdict;
    },
    legal: async (formatId) => {
      const res = await getJson(`${base}tables/legal/${encodeURIComponent(formatId)}`, fetchImpl);
      const body = await readJson(res);
      if (res.status !== 200) throw new Error(errorOf(body, res.status));
      return Array.isArray(body.legal) ? body.legal.filter((id): id is string => typeof id === 'string') : [];
    },
    gauntletEras: async () => {
      const eras = (await get('tables/gauntlet/eras')).eras;
      return Array.isArray(eras) ? (eras as GauntletEraOption[]) : [];
    },
    gauntlet: async (roomId, tableId) =>
      GauntletViewSchema.parse(await get(`tables/rooms/${encodeURIComponent(roomId)}/gauntlet${tableId === undefined ? '' : `?table=${encodeURIComponent(tableId)}`}`)),
    gauntletReady: (roomId, ready, ai, tableId) => gauntletWrite(roomId, 'ready', withTable(ai === true ? { ready, ai } : { ready }, tableId)),
    gauntletAct: (roomId, act, deck, tableId) => gauntletWrite(roomId, 'act', withTable({ act, deck }, tableId)),
    gauntletChoose: (roomId, deck, tableId) => gauntletWrite(roomId, 'choose', withTable({ deck }, tableId)),
    start: async (opponent, seats) => {
      const { status, body } = await post('play/matches', { opponent, seats });
      if (status === 201 && typeof body.matchId === 'string') return { ok: true, matchId: body.matchId };
      const verdicts = Array.isArray(body.seats) ? (body.seats as Verdict[]) : null;
      return { ok: false, error: errorOf(body, status), seats: verdicts };
    },
    table: async (roomId, tableId) => {
      const query = tableId === undefined ? '' : `?table=${encodeURIComponent(tableId)}`;
      const res = await getJson(`${base}tables/rooms/${encodeURIComponent(roomId)}${query}`, fetchImpl);
      return table({ status: res.status, body: await readJson(res) });
    },
    loadDeck: async (roomId, deck, tableId) =>
      table(await send('PUT', `tables/rooms/${encodeURIComponent(roomId)}/deck`, withTable({ deck }, tableId))),
    ready: async (roomId, ready, tableId, opts) =>
      table(await post(`tables/rooms/${encodeURIComponent(roomId)}/ready`, withTable({ ready, ...(opts?.rematch === true ? { rematch: true } : {}) }, tableId))),
    sit: async (roomId, tableId) => table(await post(`tables/rooms/${encodeURIComponent(roomId)}/sit`, withTable({}, tableId))),
    stand: async (roomId, tableId) => table(await post(`tables/rooms/${encodeURIComponent(roomId)}/stand`, withTable({}, tableId))),
    startRoom: async (roomId, tableId) => {
      // 201 started it; 200 is the match the other player already started.
      const { status, body } = await post('play/matches', withTable({ room: roomId }, tableId));
      if ((status === 201 || status === 200) && typeof body.matchId === 'string') return { ok: true, matchId: body.matchId };
      return { ok: false, error: errorOf(body, status), seats: null };
    },
    startVsBot: async (roomId, tableId, opts) => {
      // 201 started it; 200 is the match already running at this table.
      const { status, body } = await post('play/matches', withTable({ room: roomId, bot: true, ...(opts?.rematch === true ? { rematch: true } : {}) }, tableId));
      if ((status === 201 || status === 200) && typeof body.matchId === 'string') return { ok: true, matchId: body.matchId };
      return { ok: false, error: errorOf(body, status), seats: null };
    },
    queuePlace: async () => {
      const { place } = await get('play/queue');
      return typeof place === 'number' && Number.isInteger(place) && place >= 1 ? place : null;
    },
  };
}

/* ── the deck dropdown's two derived things ──────────────────────────── */

/**
 * The `Random` entry's option value. Not a deck id and not choosable as one:
 * every library id is a slug of an event and a player, and this is neither.
 */
export const RANDOM_DECK = '__random__';

export { pickRandom, secureRandom } from '@hadoku/shared';

/**
 * The newest STANDARD era — never just "the last element".
 *
 * Wave 48 put Modern and Legacy eras in the same `formats` list
 * (`TableFormat.family`), so `formats.at(-1)` is no longer necessarily a
 * Standard era: the room's own default is the newest Standard pool
 * (operator, 2026-09-27), and a catalog ordered with Modern or Legacy last
 * would silently hand that default to the wrong family. The server's own
 * default reads the same `newestStandardEra` — this is used only as the fallback for a room whose record has not been read yet, or a server too
 * old to send one. Never as a second opinion about a room that answered.
 */
export function newestFormat(formats: readonly TableFormat[]): string {
  return newestStandardEra(formats) ?? '';
}

/** Which decks a pool offers, and whether the server answered for all of them. */
export interface LegalSweep {
  /** The format this was asked about. */
  readonly formatId: string;
  /** Legal in it — or every deck, when the era could not be asked about. */
  readonly ids: ReadonlySet<string>;
  /** Why the era could not be asked. Null when it answered. */
  readonly error: string | null;
}

/**
 * Which of `decks` are legal in `formatId`, asked of the server.
 *
 * **One request per era.** The gate is the only thing that can answer "is this
 * deck legal in this format" — a client-side copy would be a second opinion
 * free to disagree with the one that counts — so the server runs it over the
 * whole library (`GET /api/tables/legal/:format`) and sends the legal ids.
 * Until 2026-10-06 this was one `POST /api/tables/check` per deck: with w48's
 * 338-deck library that was ~3.5 s of round trips per era for gate work that
 * takes the server well under a second. The caller still asks once per era and
 * remembers the answer.
 *
 * If the era cannot be asked, every deck is **offered**, not hidden: the server
 * refuses an illegal deck when it is loaded and says which card, so failing
 * open costs a refusal the person can read, while failing closed would silently
 * empty the library over a dropped request. The failure is returned rather
 * than swallowed.
 */
export async function legalDecksIn(
  client: Pick<TablesClient, 'legal'>,
  formatId: string,
  decks: readonly TableDeck[],
): Promise<LegalSweep> {
  try {
    const legal = new Set(await client.legal(formatId));
    return { formatId, ids: new Set(decks.filter((d) => legal.has(d.id)).map((d) => d.id)), error: null };
  } catch (err: unknown) {
    return { formatId, ids: new Set(decks.map((d) => d.id)), error: err instanceof Error ? err.message : String(err) };
  }
}
