/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/lifecycle`'s busy probe (w93-K2).
 *
 * The kernel knows only the report's shape, `isLocalProbe` and the HTTP plumbing (fail-safe on
 * `report`'s own throw, 404 to anything proxied). What counts as cardtable's "destroyable work" —
 * a live match or a drafting pod, never a warm JVM or an idle lobby — stays here, unchanged from
 * before this moved (`docs` below is the same text as always).
 *
 * ## What counts as busy — destroyable work, not connections
 *
 * - a match that is `starting` or `running`: a Forge JVM with players seated;
 * - a draft that is `drafting`: picks made, packs mid-pass, held in memory.
 *
 * NOT counted, deliberately:
 *
 * - a match that is `over`, `failed` or `stopped` — finished, nothing left to lose;
 * - a `complete` draft;
 * - **the warm JVM.** `liveJvmCount()` includes it and would report busy every
 *   minute of the day; it is a pre-booted process with nobody in it;
 * - **connected-but-idle clients and open lobbies.** They reconnect fine, they
 *   never disconnect on their own, and counting them would make every deploy sit
 *   until its deadline — at which point the deadline kills the real match anyway.
 */
import { busyHandler as kernelBusyHandler, type BusyReport, type BusyRun } from '@hadoku/service-kernel/lifecycle';
import type { RequestHandler } from 'express';

export { isLocalProbe, type BusyReport, type BusyRun } from '@hadoku/service-kernel/lifecycle';

export interface BusySources {
	matches(): ReadonlyArray<{ id: string; status: string; seats: ReadonlyArray<unknown>; anyoneHere?: () => boolean }>;
	drafts(): ReadonlyArray<{
		id: string;
		status: string | undefined;
		packNumber?: number;
		pickNumber?: number;
	}>;
}

const BUSY_MATCH = new Set(['starting', 'running']);

export function busyReport(src: BusySources): BusyReport {
	const runs: BusyRun[] = [];
	for (const m of src.matches()) {
		if (!BUSY_MATCH.has(m.status)) continue;
		// A running match whose seats have all gone (past the grace) holds nobody's game:
		// the zombie of m-09487f336215 held every deploy for hours on 2026-10-04.
		if (m.status === 'running' && m.anyoneHere !== undefined && !m.anyoneHere()) continue;
		runs.push({ id: m.id, kind: 'match', label: `${m.seats.length} seats, ${m.status}` });
	}
	for (const d of src.drafts()) {
		if (d.status !== 'drafting') continue;
		const at =
			d.packNumber !== undefined && d.pickNumber !== undefined
				? `pack ${d.packNumber} pick ${d.pickNumber}`
				: 'in progress';
		runs.push({ id: d.id, kind: 'draft', label: at });
	}
	return { busy: runs.length > 0, count: runs.length, runs };
}

export function busyHandler(src: BusySources): RequestHandler {
	return kernelBusyHandler(() => busyReport(src));
}
