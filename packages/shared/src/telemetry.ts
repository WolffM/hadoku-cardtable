/*
 * Client telemetry: what a seat's browser knows and the server cannot — its
 * settings, and what its gesture layer drew — sent to the play server to be
 * written into the match's log beside the server's own events, so a report
 * ("the card just appeared") is read from the log, never deduced from code.
 *
 * The operator, 2026-10-08: *"why don't you have telemetry to answer that
 * question? you should always confirm everything with telemetry."*
 *
 * A message names no hidden information: a card id is Forge's own, already on
 * the wire to both seats, and the values are flat scalars. Nothing is relayed
 * to the other seat; the server logs it and keeps nothing else.
 */
import { z } from 'zod';

export const CLIENT_EVENT = 'forge:client';

const ScalarSchema = z.union([z.string().max(80), z.number().finite(), z.boolean()]);

/** An event's facts: flat scalars, a bounded field set. */
const ClientDataSchema = z.record(z.string().min(1).max(32), ScalarSchema).refine((d) => Object.keys(d).length <= 16, 'at most 16 fields');

export const ClientEventSchema = z
  .object({
    matchId: z.string().min(1),
    /**
     * `info`: the seat's settings, on join and on each change, with `ui`, the
     * version of the bundle the tab is running, so a report of behaviour a
     * deploy had already replaced is read as a stale tab or a regression
     * from the log; `what: 'pick-drawn'` is a selection's pop-up, and every
     * fact that decides it, as the pick opens and 3 s later. `handover`: a
     * played card's stand-in giving way to its stack card; `landing`: to the
     * card in its row — on either screen. `sound`: what the table raised to
     * play and why — a view's derived events, a decision's chime, a button's
     * press — so "it played three times" is read from the log (the operator,
     * 2026-10-10: *"as we investigate these things, please make sure we have
     * ample telemetry"*). `bar-stuck`: the server's latest bar for this seat had
     * an enabled button and the screen offered nothing to press for longer than
     * `BAR_STUCK_MS` (`phase: 'held'`), and again when that ends (`'cleared'`).
     * `stand-in`: the other seat's back, standing in for a play of theirs, taken
     * down by a clock (`how: 'grace' | 'timeout'`) rather than by its card — how
     * long it stood, so a back left on the board is read from the log.
     * `effect`: what a view's change was drawn as — a resolution's reveal beat,
     * its hits and the permanents it made arriving (`live/numbers.ts`), with
     * how long each waited, so "it was too instant" is read from the log.
     * `park`: a played or aimed card's wait over the board ended — how
     * (landed, floated home unanswered, offered back, …), after how long, and
     * the decision open at that moment, so "it went back to my hand while the
     * question was up" is read from the log.
     * `perf`: the frame rate (`live/frame-watch.ts`) — a stretch of dropped
     * frames, what the board was drawing as it began and, where the browser
     * can say, the code the long frames ran; and a periodic summary of every
     * frame, so "it has gotten a lot more laggy" is read from the log.
     * `connection`: this socket's own link — on a rejoin after a drop, why the
     * last connection closed (socket.io's reason) and how long the board was
     * without one, so the next drop explains itself. Kept from any joined
     * socket, not only the seat's controller: it is about the socket, and a
     * spectator's drop is as much a question as a player's.
     */
    kind: z.enum(['info', 'handover', 'landing', 'sound', 'bar-stuck', 'stand-in', 'effect', 'park', 'perf', 'connection']),
    data: ClientDataSchema,
  })
  .strict();

export type ClientEvent = z.output<typeof ClientEventSchema>;

/** Where a page event is sent, under `/api/`: a screen with no match has no match socket to carry it. */
export const PAGE_EVENT_PATH = 'client-events';

/**
 * The same telemetry from a screen outside a match, sent over HTTP to `PAGE_EVENT_PATH` and written
 * into the server's log as a `client` event keyed by page and user. `page: 'front'`, `kind: 'perf'`:
 * the room list's scroll smoothness, one summary per scroll burst (`apps/ui/src/rooms/scroll-watch.ts`).
 */
export const PageEventSchema = z
  .object({
    page: z.enum(['front']),
    kind: z.enum(['perf']),
    data: ClientDataSchema,
  })
  .strict();

export type PageEvent = z.output<typeof PageEventSchema>;

/** A socket sending more than this in one second is a client bug; the rest of that second is dropped. */
export const CLIENT_EVENT_MAX_PER_SECOND = 20;
