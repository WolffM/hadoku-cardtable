/**
 * Starting a relay room's match: who may, who hosts it, and the 3-2-1 every screen counts.
 * Generic to every game whose match runs in one browser and reaches the others over the relay
 * (`play/relay-socket.ts`); moved here from hadoku-bomberman, its first.
 *
 * ## Why the server holds this
 *
 * The match runs in ONE browser, its host's: that page runs the sim and sends
 * every snapshot over the relay (docs/NETCODE.md). The relay refuses anything
 * a watcher sends, so a spectating leader could never start a match from
 * their own page — the Start press has to land somewhere every page can see.
 * Here: `POST /api/rooms/:id/start` (`relay-game.ts`) records a PENDING start, every room body
 * carries it (`relay-game.ts`'s room view), every page counts down to it, and the
 * one page it names as host sends the relay `start` at zero.
 *
 * ## Who may start, and who hosts
 *
 * The leader, always — seated or watching. Anyone seated, too (the old rule:
 * any player starts an idle room). The host is the caller when seated,
 * otherwise the first seated person; a room with nobody seated has nobody to
 * run the match, and says so.
 *
 * The host is also who the relay accepts a round's end from
 * (the relay match's `leaderSeat`, `relay-game.ts`): the relay protocol's "host" was the leader's
 * seat, which refused the end of any round the leader did not start.
 *
 * A start is pending only until zero. After that it is the host's match, and
 * a page that loads later (a reload, a remount) must not find it: it would
 * count down from nothing, hide Start, and — on the host's page — begin the
 * same match a second time. Only `hostOf` outlives zero, for the relay.
 *
 * ## A room's starts are numbered
 *
 * Every start carries `round`, its place in the room's run of starts (0, 1, 2, …), and `series`,
 * a number drawn at the room's first start that stays the same for all of them. A seed alone has
 * no memory, so a game that picks from a small pool by seed repeats itself by chance; with these
 * two a game deals in an order instead — a map rotation that plays every map before any comes
 * round again, a first turn that moves round the table. Every page reads the same pair from the
 * room body, so every page deals alike without having seen the rounds before.
 *
 * In memory only: a countdown lasts seconds, and a restart mid-countdown
 * costs one press of Start. The numbering goes with it: after a restart a room's
 * next start is round 0 of a new series.
 */

/** The 3-2-1. */
export const COUNTDOWN_MS = 3_000;

interface PendingStart {
  matchId: string;
  seed: number;
  round: number;
  series: number;
  hostId: string;
  startsAt: number;
}

/** What a room body carries while a start is pending. `startsInMs` is relative, so no two clocks need agree. */
export interface StartView {
  matchId: string;
  seed: number;
  /** This start's place in the room's run of starts, from 0. */
  round: number;
  /** Drawn at the room's first start; the same for every start of the room after it. */
  series: number;
  hostId: string;
  startsInMs: number;
}

export interface StartableRoom {
  id: string;
  leader: string;
  seats: readonly (string | null)[];
  members: readonly { id: string }[];
}

export type StartRefusal = 'not-allowed' | 'no-player';

export interface Starts {
  /** The leader's or a seated player's Start. A start already pending is answered as is. */
  request(room: StartableRoom, callerId: string): { ok: true; start: StartView } | { ok: false; reason: StartRefusal };
  /** The pending start a room body carries, or null. */
  view(roomId: string): StartView | null;
  /** Who hosts the room's current (or last) match, or null before the first. */
  hostOf(roomId: string): string | null;
  /** The room is gone. */
  forget(roomId: string): void;
}

export function createStarts(opts: { now?: () => number; random?: () => number; countdownMs?: number } = {}): Starts {
  const now = opts.now ?? Date.now;
  const countdownMs = opts.countdownMs ?? COUNTDOWN_MS;
  const random = opts.random ?? Math.random;
  const pending = new Map<string, PendingStart>();
  const hosts = new Map<string, string>();
  /** Each room's run of starts: its series number, and how many starts it has had. */
  const runs = new Map<string, { series: number; started: number }>();

  const live = (roomId: string): PendingStart | null => {
    const p = pending.get(roomId);
    if (p === undefined) return null;
    if (now() >= p.startsAt) {
      pending.delete(roomId);
      return null;
    }
    return p;
  };
  const toView = (p: PendingStart): StartView => ({
    matchId: p.matchId,
    seed: p.seed,
    round: p.round,
    series: p.series,
    hostId: p.hostId,
    startsInMs: Math.max(0, p.startsAt - now()),
  });

  return {
    request(room, callerId) {
      const isPerson = (holder: string | null): holder is string =>
        holder !== null && room.members.some((m) => m.id === holder);
      const seated = room.seats.includes(callerId);
      if (!seated && room.leader !== callerId) return { ok: false, reason: 'not-allowed' };
      const already = live(room.id);
      if (already !== null) return { ok: true, start: toView(already) };
      const hostId = seated ? callerId : room.seats.find(isPerson);
      if (hostId === undefined) return { ok: false, reason: 'no-player' };
      const t = now();
      const run = runs.get(room.id) ?? { series: Math.floor(random() * 0x7fffffff), started: 0 };
      runs.set(room.id, run);
      const start: PendingStart = {
        // The stats store's MATCH_ID_PATTERN holds: [A-Za-z0-9_-]{8,64}.
        matchId: `m-${t.toString(36)}-${Math.floor(random() * 1e9).toString(36)}`,
        seed: Math.floor(random() * 0x7fffffff),
        round: run.started,
        series: run.series,
        hostId,
        startsAt: t + countdownMs,
      };
      run.started += 1;
      pending.set(room.id, start);
      hosts.set(room.id, hostId);
      return { ok: true, start: toView(start) };
    },
    view(roomId) {
      const p = live(roomId);
      return p === null ? null : toView(p);
    },
    hostOf(roomId) {
      return hosts.get(roomId) ?? null;
    },
    forget(roomId) {
      pending.delete(roomId);
      hosts.delete(roomId);
      runs.delete(roomId);
    },
  };
}

