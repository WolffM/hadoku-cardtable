/**
 * Reporting a finished match to the game-stats store (prefs-api, `/prefs/api/v1/_games/<game>/*`):
 * fire and forget, with a bounded, idempotent retry. Every attempt re-posts the same `matchId`,
 * and the store keeps the first report per id, so a retry after a lost response cannot count a
 * match twice. Moved here from hadoku-bomberman; any game reporting matches uses it.
 */

import {
  GameStatsError,
  recordMatch as recordMatchHttp,
  type MatchReport,
  type RecordMatchOptions,
  type RecordMatchResult,
} from '@wolffm/prefs-client/games';

export type RecordMatch = (
  opts: RecordMatchOptions,
  report: MatchReport,
) => Promise<RecordMatchResult>;

export interface StatsReporterOptions {
  /** The store's game id: `/_games/<gameId>/*`. */
  gameId: string;
  /** This server's service-tier key. Empty or absent = reporting is off. */
  serviceKey: string | undefined;
  /** The env var that sets it, named in the one line that says reporting is off. */
  serviceKeyEnvVar?: string;
  /** The prefs mount the store is under, without `/api/v1`. Default: prefs-client's own (hadoku.me). */
  baseUrl?: string;
  log: (line: Record<string, unknown>) => void;
  /** Injected by tests. `recordMatch` from @wolffm/prefs-client/games otherwise. */
  record?: RecordMatch;
  /**
   * Waits before each RETRY. Bounded: a store that is down for longer than
   * this loses the round, which is better than a queue that grows without one.
   */
  retryDelaysMs?: readonly number[];
}

export interface StatsReporter {
  readonly enabled: boolean;
  /** Fire and forget. Never throws, never blocks the caller. */
  report(report: MatchReport): void;
  /** Resolves when every report in flight has settled. For tests and shutdown. */
  idle(): Promise<void>;
}

export const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 60_000] as const;

/**
 * A 4xx other than 408/429 is the store REFUSING this report — a bad key, a
 * key that does not resolve, a malformed payload. Sending it again changes
 * nothing. Everything else (network, 5xx, 408, 429) may be transient.
 */
function retryable(err: unknown): boolean {
  if (err instanceof GameStatsError) {
    return err.status >= 500 || err.status === 408 || err.status === 429;
  }
  return true;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/**
 * Report matches to the store, or log once that it will not.
 *
 * Every attempt re-posts the same `matchId`, and the store treats a repeat as
 * a no-op, so a retry after a response that was lost in transit cannot count a
 * round twice.
 */
export function createStatsReporter(opts: StatsReporterOptions): StatsReporter {
  const { log } = opts;
  const record = opts.record ?? recordMatchHttp;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const serviceKey = opts.serviceKey ?? '';
  const inFlight = new Set<Promise<void>>();

  if (serviceKey === '') {
    log({ evt: 'stats-disabled', reason: `${opts.serviceKeyEnvVar ?? 'the service key'} unset` });
  }

  const send = async (report: MatchReport): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await record({ gameId: opts.gameId, serviceKey, ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }) }, report);
        log({
          evt: 'stats-recorded',
          matchId: report.matchId,
          duplicate: res.duplicate,
          attempt: attempt + 1,
        });
        return;
      } catch (err) {
        const status = err instanceof GameStatsError ? err.status : null;
        const message = err instanceof Error ? err.message : String(err);
        const again = retryable(err) && attempt < delays.length;
        log({
          evt: again ? 'stats-retry' : 'stats-failed',
          matchId: report.matchId,
          attempt: attempt + 1,
          status,
          error: message,
        });
        if (!again) return;
        await sleep(delays[attempt] ?? 0);
      }
    }
  };

  return {
    enabled: serviceKey !== '',
    report(report) {
      if (serviceKey === '') return;
      const p = send(report).finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}

