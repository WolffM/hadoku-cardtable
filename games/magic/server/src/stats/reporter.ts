/**
 * Sending a finished match to the game-stats store: fire and forget, a few
 * spaced retries, and never a throw — a match's end must not wait on, or
 * fail because of, a stats write. The store is idempotent on `matchId`, so a
 * retry after a write that landed but whose answer was lost is a no-op there.
 *
 * `record` is injected: the composition root binds it to `recordMatch` with the
 * service key, and a server with no key passes null and records nothing.
 */

import type { MatchReport } from '@wolffm/prefs-client/games';

export type RecordFn = (report: MatchReport) => Promise<{ duplicate: boolean }>;

export interface StatsReporterDeps {
	/** Null when no service key is configured: stats are off. */
	record: RecordFn | null;
	log(entry: Record<string, unknown>): void;
	/** Attempts in all, the first included. Default 3. */
	attempts?: number;
	/** Wait before attempt n+1 is `delayMs * n`. Default 2 s. */
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export interface StatsReporter {
	/** Resolves when the report is recorded or given up on; never rejects. */
	report(report: MatchReport): Promise<void>;
}

/** A 4xx other than 408/429 is the request's own fault, and resending it changes nothing. */
function retryable(err: unknown): boolean {
	const status = (err as { status?: unknown } | null)?.status;
	if (typeof status !== 'number') return true;
	return status >= 500 || status === 408 || status === 429;
}

export function createStatsReporter(deps: StatsReporterDeps): StatsReporter {
	const attempts = Math.max(1, deps.attempts ?? 3);
	const delayMs = deps.delayMs ?? 2000;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
	let saidDisabled = false;

	return {
		async report(report) {
			const record = deps.record;
			if (record === null) {
				if (!saidDisabled) deps.log({ evt: 'stats-disabled', reason: 'CARDTABLE_SERVICE_KEY is not set' });
				saidDisabled = true;
				return;
			}
			for (let attempt = 1; ; attempt++) {
				try {
					const result = await record(report);
					deps.log({ evt: 'stats-recorded', matchId: report.matchId, attempt, duplicate: result.duplicate });
					return;
				} catch (err) {
					const status = (err as { status?: unknown } | null)?.status;
					const last = attempt >= attempts || !retryable(err);
					deps.log({
						evt: last ? 'stats-failed' : 'stats-retry',
						matchId: report.matchId,
						attempt,
						...(typeof status === 'number' ? { status } : {}),
						error: (err as Error)?.message ?? String(err),
					});
					if (last) return;
					await sleep(delayMs * attempt);
				}
			}
		},
	};
}
