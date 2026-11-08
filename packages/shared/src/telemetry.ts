/*
 * A seat's client telemetry (the generic schemas are `@hadoku/platform-wire/telemetry`): its
 * event name, and the kinds a seat's gesture layer reports. A card id in one is Forge's own,
 * already on the wire to both seats.
 */
import { clientEventSchema } from '@hadoku/platform-wire/telemetry';
import type { z } from 'zod';

export const CLIENT_EVENT = 'forge:client';

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
export const ClientEventSchema = clientEventSchema(['info', 'handover', 'landing', 'sound', 'bar-stuck', 'stand-in', 'effect', 'park', 'perf', 'connection']);

export type ClientEvent = z.output<typeof ClientEventSchema>;
