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
     */
    kind: z.enum(['info', 'handover', 'landing', 'sound', 'bar-stuck', 'stand-in', 'effect', 'park']),
    data: z.record(z.string().min(1).max(32), ScalarSchema).refine((d) => Object.keys(d).length <= 16, 'at most 16 fields'),
  })
  .strict();

export type ClientEvent = z.output<typeof ClientEventSchema>;

/** A socket sending more than this in one second is a client bug; the rest of that second is dropped. */
export const CLIENT_EVENT_MAX_PER_SECOND = 20;
