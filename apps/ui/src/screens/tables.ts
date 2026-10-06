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

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Which ruleset family an era belongs to (wave 48). Mirrors the server's own
 * `FormatFamily` (`apps/server/src/http/library.ts`) over the wire; a drafted
 * pool's `source` is `'draft'` and its `family` is meaningless — the picker
 * groups a pod by `source`, never by `family`.
 */
export type FormatFamily = 'standard' | 'modern' | 'legacy';

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

export interface DeckLine {
  count: number;
  name: string;
}

export interface TableDeck {
  id: string;
  collection: string;
  name: string;
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
export type DeckRules = { kind: 'standard'; format: string } | { kind: 'draft'; draftId: string };
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
 * One player at a room's table, as everyone in the room sees them.
 *
 * `verdict` and `choice` are YOURS only — the server sends null for the other
 * player, because a draft verdict names cards from a pool that is hidden
 * information until the draft is over. What everyone sees of everyone is the
 * deck's name, whether it is legal, how many faults it has, and whether they
 * are ready: enough to know who is being waited on.
 */
export interface RoomPlayer {
  seat: number;
  name: string;
  you: boolean;
  deckName: string;
  rulesName: string;
  legal: boolean;
  issueCount: number;
  ready: boolean;
  verdict: Verdict | null;
  choice: SeatChoice | null;
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
  room: { id: string; name: string; gameType: string; matchId: string | null; seats: number };
  you: RoomTableYou;
  players: RoomPlayer[];
}

/** Every table call answers the whole table, or says why it would not. */
export type TableOutcome =
  | { ok: true; table: RoomTable }
  | { ok: false; error: string; status: number; verdict: Verdict | null };

/** `/cardtable/` → `/cardtable/api/`. Same arithmetic as `socketPath`. */
export function apiBase(base: string): string {
  const prefix = base === '' ? '/' : base;
  return `${prefix.endsWith('/') ? prefix : `${prefix}/`}api/`;
}

function defaultApiBase(): string {
  const base = import.meta.env?.BASE_URL;
  return apiBase(typeof base === 'string' ? base : '/');
}

export interface TablesClient {
  formats(): Promise<TableFormat[]>;
  decks(): Promise<TableDeck[]>;
  check(seat: SeatChoice): Promise<Verdict>;
  /** Which library decks are legal in a Standard-family era: the gate's answer, in one call. */
  legal(formatId: string): Promise<string[]>;
  /** Against Forge's AI only. A match against a person starts from a room. */
  start(opponent: 'human' | 'ai', seats: [SeatChoice, SeatChoice]): Promise<StartOutcome>;
  /** Both players' state at a room's table. */
  table(roomId: string): Promise<TableOutcome>;
  /**
   * Load MY deck. There is no call that names anybody else's, and none that
   * names a format either: the ROOM's pool is the rules for both seats, and a
   * body carrying `rules` is refused with 400.
   */
  loadDeck(roomId: string, deck: DeckRef): Promise<TableOutcome>;
  ready(roomId: string, ready: boolean): Promise<TableOutcome>;
  /** Start the room's match. Either player may; the server answers one match. */
  startRoom(roomId: string): Promise<StartOutcome>;
  /**
   * Start a match against Forge's AI from a room where you are the only
   * member — the server picks a random library deck legal in the room's pool
   * for the bot's seat (`apps/server/src/http/routes.ts`'s `startFromRoom`,
   * `vsBot` arm). Refused with a second member in the room, before a deck is
   * loaded, or for a drafted pool (no library deck is legal in one).
   */
  startVsBot(roomId: string): Promise<StartOutcome>;
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

export function tablesClient(fetchImpl: Fetch = (input, init) => fetch(input, init), base = defaultApiBase()): TablesClient {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${base}${path}`, { headers: { accept: 'application/json' } });
    const body = await readJson(res);
    if (!res.ok) throw new Error(errorOf(body, res.status));
    return body;
  };
  const send = async (
    method: 'POST' | 'PUT',
    path: string,
    payload: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await readJson(res) };
  };
  const post = (path: string, payload: unknown) => send('POST', path, payload);

  /** A table call's answer: the whole table, or the server's sentence. */
  const table = ({ status, body }: { status: number; body: Record<string, unknown> }): TableOutcome => {
    if (status === 200) return { ok: true, table: body as unknown as RoomTable };
    const verdict = typeof body.verdict === 'object' && body.verdict !== null ? (body.verdict as Verdict) : null;
    return { ok: false, error: errorOf(body, status), status, verdict };
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
      const res = await fetchImpl(`${base}tables/legal/${encodeURIComponent(formatId)}`, {
        headers: { accept: 'application/json' },
      });
      const body = await readJson(res);
      if (res.status !== 200) throw new Error(errorOf(body, res.status));
      return Array.isArray(body.legal) ? body.legal.filter((id): id is string => typeof id === 'string') : [];
    },
    start: async (opponent, seats) => {
      const { status, body } = await post('play/matches', { opponent, seats });
      if (status === 201 && typeof body.matchId === 'string') return { ok: true, matchId: body.matchId };
      const verdicts = Array.isArray(body.seats) ? (body.seats as Verdict[]) : null;
      return { ok: false, error: errorOf(body, status), seats: verdicts };
    },
    table: async (roomId) => {
      const res = await fetchImpl(`${base}tables/rooms/${encodeURIComponent(roomId)}`, {
        headers: { accept: 'application/json' },
      });
      return table({ status: res.status, body: await readJson(res) });
    },
    loadDeck: async (roomId, deck) => table(await send('PUT', `tables/rooms/${encodeURIComponent(roomId)}/deck`, { deck })),
    ready: async (roomId, ready) => table(await post(`tables/rooms/${encodeURIComponent(roomId)}/ready`, { ready })),
    startRoom: async (roomId) => {
      // 201 started it; 200 is the match the other player already started.
      const { status, body } = await post('play/matches', { room: roomId });
      if ((status === 201 || status === 200) && typeof body.matchId === 'string') return { ok: true, matchId: body.matchId };
      return { ok: false, error: errorOf(body, status), seats: null };
    },
    startVsBot: async (roomId) => {
      // Always 201: a bot match is yours alone to start, so there is no other
      // player's already-started match to catch up to, unlike `startRoom`.
      const { status, body } = await post('play/matches', { room: roomId, bot: true });
      if (status === 201 && typeof body.matchId === 'string') return { ok: true, matchId: body.matchId };
      return { ok: false, error: errorOf(body, status), seats: null };
    },
  };
}

/* ── the deck dropdown's two derived things ──────────────────────────── */

/**
 * The `Random` entry's option value. Not a deck id and not choosable as one:
 * every library id is a slug of an event and a player, and this is neither.
 */
export const RANDOM_DECK = '__random__';

/**
 * A uniform [0,1) from `crypto`, never `Math.random`.
 *
 * The same rule `route.ts` states for a draft id, for the same reason: one
 * rule, one place, no exception to remember.
 */
export function secureRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

/**
 * One of `items`, or undefined when there are none.
 *
 * `rand` is injectable so "Random picks one of the decks on offer" can be
 * asserted against a pinned source rather than sampled and hoped about.
 */
export function pickRandom<T>(items: readonly T[], rand: () => number = secureRandom): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}

/**
 * The newest STANDARD era — never just "the last element".
 *
 * Wave 48 put Modern and Legacy eras in the same `formats` list
 * (`TableFormat.family`), so `formats.at(-1)` is no longer necessarily a
 * Standard era: the room's own default is the newest Standard pool
 * (operator, 2026-09-27), and a catalog ordered with Modern or Legacy last
 * would silently hand that default to the wrong family. This is the same
 * arithmetic as the server's `room/lobby.ts`'s `newestFormat` — used only as
 * the fallback for a room whose record has not been read yet, or a server too
 * old to send one. Never as a second opinion about a room that answered.
 */
export function newestFormat(formats: readonly TableFormat[]): string {
  let newest: TableFormat | null = null;
  for (const f of formats) {
    if (f.family === 'standard' && (newest === null || f.id > newest.id)) newest = f;
  }
  return newest?.id ?? '';
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
