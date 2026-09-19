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
 * `fetch` is an argument so a test can answer without a server. Production
 * passes nothing and gets the global.
 *
 * Every path is relative to `import.meta.env.BASE_URL` — `/cardtable/` in
 * production, where the edge strips the prefix before the server sees it. An
 * absolute `/api/…` would reach `hadoku.me/api/…`, which is somebody else.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TableFormat {
  id: string;
  name: string;
  effective: string;
  sets: string[];
  banned: string[];
  cardCount: number;
  source: string;
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

export interface RoomTable {
  room: { id: string; name: string; gameType: string; matchId: string | null; seats: number };
  you: { player: boolean };
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
  /** Against Forge's AI only. A match against a person starts from a room. */
  start(opponent: 'human' | 'ai', seats: [SeatChoice, SeatChoice]): Promise<StartOutcome>;
  /** Both players' state at a room's table. */
  table(roomId: string): Promise<TableOutcome>;
  /** Load MY deck. There is no call that names anybody else's. */
  loadDeck(roomId: string, choice: SeatChoice): Promise<TableOutcome>;
  ready(roomId: string, ready: boolean): Promise<TableOutcome>;
  /** Start the room's match. Either player may; the server answers one match. */
  startRoom(roomId: string): Promise<StartOutcome>;
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
    loadDeck: async (roomId, choice) => table(await send('PUT', `tables/rooms/${encodeURIComponent(roomId)}/deck`, choice)),
    ready: async (roomId, ready) => table(await post(`tables/rooms/${encodeURIComponent(roomId)}/ready`, { ready })),
    startRoom: async (roomId) => {
      // 201 started it; 200 is the match the other player already started.
      const { status, body } = await post('play/matches', { room: roomId });
      if ((status === 201 || status === 200) && typeof body.matchId === 'string') return { ok: true, matchId: body.matchId };
      return { ok: false, error: errorOf(body, status), seats: null };
    },
  };
}

/** A deck's size, for the picker: maindeck and sideboard card counts. */
export function deckSize(deck: TableDeck): { main: number; sideboard: number } {
  const sum = (lines: DeckLine[]) => lines.reduce((n, l) => n + l.count, 0);
  return { main: sum(deck.main), sideboard: sum(deck.sideboard) };
}
