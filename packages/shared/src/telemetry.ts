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
     * `info`: the seat's settings, on join and on each change. `handover`: a
     * played card's stand-in giving way to its stack card; `landing`: to the
     * card in its row — on either screen. `sound`: what the table raised to
     * play and why — a view's derived events, a decision's chime, a button's
     * press — so "it played three times" is read from the log (the operator,
     * 2026-10-10: *"as we investigate these things, please make sure we have
     * ample telemetry"*). `bar-stuck`: the server's latest bar for this seat had
     * an enabled button and the screen offered nothing to press for longer than
     * `BAR_STUCK_MS` (`phase: 'held'`), and again when that ends (`'cleared'`).
     */
    kind: z.enum(['info', 'handover', 'landing', 'sound', 'bar-stuck']),
    data: z.record(z.string().min(1).max(32), ScalarSchema).refine((d) => Object.keys(d).length <= 16, 'at most 16 fields'),
  })
  .strict();

export type ClientEvent = z.output<typeof ClientEventSchema>;

/** A socket sending more than this in one second is a client bug; the rest of that second is dropped. */
export const CLIENT_EVENT_MAX_PER_SECOND = 20;
