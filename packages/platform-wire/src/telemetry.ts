/*
 * Client telemetry: what a browser knows and the server cannot, written into the server's log so a
 * report is read from the log, never deduced from code (the operator, 2026-10-08: *"you should
 * always confirm everything with telemetry."*). Flat scalars, no hidden information, nothing relayed.
 */
import { z } from 'zod';

const ScalarSchema = z.union([z.string().max(80), z.number().finite(), z.boolean()]);

/** An event's facts: flat scalars, a bounded field set. */
export const ClientDataSchema = z.record(z.string().min(1).max(32), ScalarSchema).refine((d) => Object.keys(d).length <= 16, 'at most 16 fields');

/** One event from a match's socket, of one of the game's own `kinds`. */
export const clientEventSchema = <const K extends readonly [string, ...string[]]>(kinds: K) =>
  z.object({ matchId: z.string().min(1), kind: z.enum(kinds), data: ClientDataSchema }).strict();

/** Where a page event is sent, under `/api/`: a screen with no match has no match socket to carry it. */
export const PAGE_EVENT_PATH = 'client-events';

/**
 * The same telemetry from a screen outside a match, sent over HTTP to `PAGE_EVENT_PATH` and written
 * into the server's log as a `client` event keyed by page and user. `kind: 'perf'`: on `page: 'front'`,
 * a list's scroll smoothness, one summary per scroll burst; on `'front'` and `'draft'`, the screen's frame
 * rate, the same events a match's frame watch sends (bad stretches, long frames, summaries, the machine).
 */
export const PageEventSchema = z.object({ page: z.enum(['front', 'draft']), kind: z.enum(['perf']), data: ClientDataSchema }).strict();

export type PageEvent = z.output<typeof PageEventSchema>;

/** A socket sending more than this in one second is a client bug; the rest of that second is dropped. */
export const CLIENT_EVENT_MAX_PER_SECOND = 20;

/** Where the browser's usage batches go, under `/api/`. */
export const USAGE_PATH = 'usage';

/** The most entries one usage batch may carry; a page flushes well before it. */
export const USAGE_BATCH_MAX = 200;

/**
 * A name a usage entry carries: a screen (a route's `kind`) or a target (an element's
 * `data-testid`, ids stripped). Lowercase words, digits and `-`, `_`, `.`, `:` and `/` — never a
 * label, a name or anything a player typed.
 */
const UsageNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_.:/-]*$/);

/** A page's own `Date.now()`: only ever read relative to the batch's `sentAt`. */
const PageClockSchema = z.number().int().nonnegative();

/**
 * What the browser reports about how the app is used: each screen it shows and each named control
 * pressed, batched, each stamped with the page's clock (`at`) and the batch with when it left
 * (`sentAt`). The server counts them for everyone and keeps each person's own ordered trail.
 * `at`/`sentAt` are optional only for a tab opened before they existed.
 */
const UsageEntrySchema = z
  .object({ kind: z.enum(['view', 'click']), screen: UsageNameSchema, target: UsageNameSchema.optional(), at: PageClockSchema.optional() })
  .strict();
export const UsageBatchSchema = z
  .object({ entries: z.array(UsageEntrySchema).min(1).max(USAGE_BATCH_MAX), sentAt: PageClockSchema.optional() })
  .strict();

export type UsageBatch = z.output<typeof UsageBatchSchema>;
