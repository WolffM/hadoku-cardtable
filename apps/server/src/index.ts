/**
 * Cardtable — loopback-UI tunnel server
 *
 * ## Where this sits
 *
 *   browser ──► hadoku.me/cardtable/*
 *            ──► edge-router          tier gate + stripPrefix '/cardtable'
 *            ──► cardtable.hadoku.me  cloudflared
 *            ──► 127.0.0.1:9008    ◄── THIS process
 *
 * Because the edge strips the prefix, this server is handed ROOT paths: `/`,
 * `/assets/…`, `/api/…`, `/health`. The browser is not — see src/base-path.ts,
 * which is the whole reason that file exists.
 *
 * ## What this shape is for
 *
 * An app that owns BOTH its front end and its back end in one repo, with no
 * third-party backend to demux in front of. It publishes no `@wolffm/*` package,
 * has no GitHub-Pages shell, no `registry.json` entry and no `[app].astro` route:
 * the bundle it builds is the bundle it serves.
 *
 * Its neighbours, and why they are not this:
 *   tunnel            API only; the UI is a published micro-frontend on GH Pages.
 *   tunnel-proxy      demuxes a third-party backend; ships NO hadoku chrome.
 *   tunnel-contained  demuxes a third-party backend AND serves its own React UI.
 *   ui-app            a published micro-frontend with no service at all.
 *
 * ## The contract this server keeps
 *
 * 1. `/health` answers unauthenticated, always — the monitoring probe has no key.
 * 2. Everything else is refused below the tier floor, independently of the edge.
 * 3. A bundle that would render blank is replaced by a page that says why.
 */

import express from 'express';
import type { Request, Response } from 'express';
import { mkdirSync } from 'node:fs';
import { CONFIG, INDEX_HTML } from './config.js';
import { edgeProvenance, requireMinTier, tierOf, userIdOf } from './edge-auth.js';
import { checkBasePath, diagnosticPage } from './base-path.js';

mkdirSync(CONFIG.logDir, { recursive: true });

const app = express();
app.set('trust proxy', true);
// The edge already sets security headers for hadoku.me; this one is ours because
// the tunnel hostname can be hit directly and must not be framed.
app.disable('x-powered-by');

// ── Boot-time checks ─────────────────────────────────────────────────────────
// Evaluated once. The bundle does not change under a running process — a rebuild
// is a redeploy, which restarts us — so re-reading per request would buy nothing
// and would put a synchronous file read on the hot path.
const basePath = checkBasePath(INDEX_HTML, CONFIG.basePrefix);

// ── Provenance + access log ──────────────────────────────────────────────────
app.use(edgeProvenance);
app.use((req, res, next) => {
	const start = process.hrtime.bigint();
	res.on('finish', () => {
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		// One line per completed request, with the EFFECTIVE identity — what the
		// handlers actually saw, post-sanitize. A spoofed request logs as public.
		console.log(
			JSON.stringify({
				t: new Date().toISOString(),
				svc: 'cardtable',
				method: req.method,
				path: req.path,
				status: res.statusCode,
				ms: Math.round(ms),
				user: userIdOf(req),
				tier: tierOf(req),
			})
		);
	});
	next();
});

// ── Health (public, never gated) ─────────────────────────────────────────────
// The monitoring probe reaches this without a session key, so it must sit ahead
// of requireMinTier. It reports the base-path verdict: a server that is up but
// serving a bundle nobody can load is degraded, not healthy, and saying so here
// is what keeps "green probe, blank page" from being a state this app can be in.
app.get('/health', (_req: Request, res: Response) => {
	res.status(basePath.ok ? 200 : 503).json({
		status: basePath.ok ? 'healthy' : 'degraded',
		service: 'cardtable-tunnel',
		bundle: basePath.reason,
		timestamp: new Date().toISOString(),
	});
});

// ── The tier floor ───────────────────────────────────────────────────────────
// Everything below this line is gated. Register new public routes ABOVE it and
// say why in a comment — this line moving down is the shape of a privilege bug.
app.use(requireMinTier);

// ── API ──────────────────────────────────────────────────────────────────────
// Mount the app's own routes here. They arrive prefix-stripped, so a browser
// call to hadoku.me/cardtable/api/thing lands on `/api/thing`.
const api = express.Router();
api.use(express.json({ limit: '1mb' }));

api.get('/whoami', (req: Request, res: Response) => {
	// Handed straight through from the edge, post-sanitize. Useful as the first
	// thing to curl when wiring the tunnel up: it proves provenance end to end.
	res.json({ userId: userIdOf(req), tier: tierOf(req) });
});

app.use('/api', api);

// ── Static bundle ────────────────────────────────────────────────────────────
// Hashed filenames, so assets are immutable. index.html is handled separately
// below with no-store: it is the one file whose name does not change, and a
// cached copy pointing at bundles that no longer exist is a redeploy that looks
// like it broke the app.
if (basePath.ok) {
	app.use(
		express.static(CONFIG.webDir, {
			index: false,
			maxAge: '1y',
			immutable: true,
			setHeaders: (res, filePath) => {
				if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
			},
		})
	);
}

// ── SPA fallback ─────────────────────────────────────────────────────────────
// Every client-routed path serves the same index.html. Scoped to GET/HEAD: a
// POST to a path that does not exist is a bug in the caller, and answering it
// with an HTML page hides that.
app.get(/.*/, (_req: Request, res: Response) => {
	if (!basePath.ok) {
		return res.status(503).type('html').send(diagnosticPage(basePath, CONFIG.basePrefix));
	}
	res.set('Cache-Control', 'no-store').type('html').sendFile(INDEX_HTML);
});

// ── Listen ───────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, CONFIG.host, () => {
	console.log(`[cardtable] listening on ${CONFIG.host}:${CONFIG.port}`);
	console.log(`[cardtable] tier floor: ${CONFIG.minTier}`);
	if (CONFIG.edgeAuthSecret === '') {
		console.warn(
			CONFIG.allowUnverifiedEdge
				? '[cardtable] EDGE_AUTH_SECRET unset and INSECURE_NO_EDGE_AUTH=1 — identity headers are TRUSTED UNVERIFIED. Local dev only.'
				: '[cardtable] EDGE_AUTH_SECRET unset — failing closed, every request degraded to public/anon.'
		);
	}
	if (!basePath.ok) {
		// Loud, because the alternative failure mode is a blank page nobody can
		// diagnose from the outside.
		console.error(`[cardtable] BUNDLE NOT SERVABLE (${basePath.reason}): ${basePath.detail}`);
	} else {
		console.log(`[cardtable] ${basePath.detail}`);
	}
});
