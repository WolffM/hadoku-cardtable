/**
 * "Would restarting this server destroy work right now?"
 *
 * hadoku_site's deploy asks this before it stops cardtable. mgmt-api owns the
 * contract (`services/mgmt-api/src/deploy/wait-for-idle.ts`, and the "Deferred
 * deploys" section of its AGENTS.md); this is cardtable's answer. A deploy that
 * finds it busy is PARKED and runs when the answer turns idle, instead of
 * SIGKILLing a match.
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
 *
 * ## Who may ask — and why this is not a tier
 *
 * The repo's rule is "keep the friend gate; never add a public or anonymous tier",
 * and `/health` is the one route that legitimately sits above the tier floor. This
 * sits above it too, because the caller is the deploy runner on this host, which
 * holds no session key. It stays inside that rule by answering ONLY a genuinely
 * local caller and returning a bare 404 — not 403, which would confirm the route
 * exists — to everyone else.
 *
 * "Local" cannot be decided by source address alone: cloudflared connects from
 * loopback for EVERY request, edge-routed or direct-to-the-tunnel-hostname, so
 * `remoteAddress` is 127.0.0.1 for the whole internet. What does tell them apart is
 * that anything which came through Cloudflare carries headers Cloudflare itself
 * adds (`cf-ray`, `cf-connecting-ip`, …) and a caller cannot strip headers added
 * after it sent the request. So: loopback socket AND none of those headers.
 *
 * ## No names
 *
 * Runs are described by opaque id and a count ("2 seats", "pack 2 pick 7") — never
 * a display name. mgmt-api copies this into deploy logs that an admin reads.
 *
 * ## Fail SAFE on our own error
 *
 * mgmt-api treats an unanswerable endpoint as "not busy" and deploys immediately,
 * which is right for a dead service and wrong for a live one whose count failed to
 * compute. If computing the report throws, this answers BUSY with an `unknown` run:
 * the deferral is bounded and an operator can force past it, whereas a wrongly-idle
 * answer ends a game.
 */
import type { Request, RequestHandler } from 'express';

export interface BusyRun {
	id: string;
	kind: 'match' | 'draft' | 'unknown';
	label: string;
}

export interface BusyReport {
	busy: boolean;
	count: number;
	runs: BusyRun[];
}

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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Headers that mean "this request came through Cloudflare or the edge". Cloudflare
 * adds the first group to every proxied request, tunnel-hostname traffic included;
 * edge-router stamps the last. A local caller sends none of them.
 */
const PROXIED_HEADERS = [
	'cf-ray',
	'cf-connecting-ip',
	'cf-visitor',
	'cf-ipcountry',
	'x-forwarded-for',
	'x-forwarded-host',
	'x-forwarded-proto',
	'x-real-ip',
	'forwarded',
	'x-edge-auth',
] as const;

export function isLocalProbe(req: Pick<Request, 'socket' | 'headers'>): boolean {
	const addr = req.socket?.remoteAddress;
	if (addr === undefined || !LOOPBACK.has(addr)) return false;
	return !PROXIED_HEADERS.some((h) => req.headers[h] !== undefined);
}

export function busyHandler(src: BusySources): RequestHandler {
	return (req, res) => {
		if (!isLocalProbe(req)) {
			// Bare 404: not 403, which would confirm there is something here.
			res.status(404).end();
			return;
		}
		let report: BusyReport;
		try {
			report = busyReport(src);
		} catch {
			report = {
				busy: true,
				count: 1,
				runs: [{ id: 'unknown', kind: 'unknown', label: 'could not determine what is running' }],
			};
		}
		res.setHeader('cache-control', 'no-store');
		res.json(report);
	};
}
