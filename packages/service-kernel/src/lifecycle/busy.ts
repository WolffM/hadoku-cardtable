/**
 * "Would restarting this server destroy work right now?"
 *
 * hadoku_site's deploy asks this before it stops an app. mgmt-api owns the
 * contract (`services/mgmt-api/src/deploy/wait-for-idle.ts`, and the "Deferred
 * deploys" section of its AGENTS.md); this is one app's answer. A deploy that
 * finds it busy is PARKED and runs when the answer turns idle, instead of
 * SIGKILLing a live run.
 *
 * What counts as "busy work" is entirely the app's: this file knows no run
 * kind, only the report's shape and the plumbing around it. The app supplies
 * a `report` function that returns a {@link BusyReport}; everything below is
 * generic across what that report counts.
 *
 * ## Who may ask — and why this is not a tier
 *
 * `/health` is the one route that legitimately sits above the tier floor. This
 * sits above it too, because the caller is the deploy runner on this host, which
 * holds no session key. It stays inside a member-gate app's rule by answering
 * ONLY a genuinely local caller and returning a bare 404 — not 403, which would
 * confirm the route exists — to everyone else.
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
 * A run's `label` is opaque text, never a display name, so an admin deploy log
 * never carries one — that discipline is the app's `report` function's.
 *
 * ## Fail SAFE on our own error
 *
 * mgmt-api treats an unanswerable endpoint as "not busy" and deploys immediately,
 * which is right for a dead service and wrong for a live one whose count failed to
 * compute. If `report` throws, this answers BUSY with one `unknown` run: the
 * deferral is bounded and an operator can force past it, whereas a wrongly-idle
 * answer could end a live run.
 */
import type { Request, RequestHandler } from 'express';

export interface BusyRun {
	id: string;
	/** The app's own label for what kind of run this is. */
	kind: string;
	label: string;
}

export interface BusyReport {
	busy: boolean;
	count: number;
	runs: BusyRun[];
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

/** `report` computes the app's own `BusyReport`; this adds the local-only gate and fail-safe. */
export function busyHandler(report: () => BusyReport): RequestHandler {
	return (req, res) => {
		if (!isLocalProbe(req)) {
			// Bare 404: not 403, which would confirm there is something here.
			res.status(404).end();
			return;
		}
		let out: BusyReport;
		try {
			out = report();
		} catch {
			out = {
				busy: true,
				count: 1,
				runs: [{ id: 'unknown', kind: 'unknown', label: 'could not determine what is running' }],
			};
		}
		res.setHeader('cache-control', 'no-store');
		res.json(out);
	};
}
