/**
 * The one handshake gate, the base-path contract, and the origin stamp — the
 * HTTP-and-sockets half of the platform's edge auth. Knows no game: the
 * surface label a refusal is reported under, the app's display name and
 * embed-bundle filenames, and the functions that read its tier ladder and its
 * secret are all supplied by the app that binds this module.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sep } from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';

/* ── The gate: sanitize, rank, refuse, report ─────────────────────────── */

/** The app's own label for a `seal-refused` report, e.g. `'http' | 'draft-socket'`. */
export type GateSurface = string;

/** `minTier`: the app's configured floor. `surface`: the `reportSealRefused` label. */
export interface GateOptions {
	minTier: string;
	surface: GateSurface;
}

/** `reportSealRefused`'s own shape — the app supplies the implementation. */
export type SealRefusedReporter = (
	surface: GateSurface,
	headers: Record<string, unknown>,
	path: string | null,
) => void;

export interface GateDeps {
	/** Sanitize `headers` in place against edge provenance (the app's `createEdgeAuth(...).sanitizeHeaders`). */
	sanitizeHeaders(headers: Record<string, unknown>): void;
	/** Express/engine.io middleware that does the same, for a socket's handshake (the app's `createEdgeAuth(...).edgeProvenance`). */
	edgeProvenance(req: Request, res: Response, next: NextFunction): void;
	/** The app's own `tierOf` (its auth binding's, so a verified-member promotion if any applies). */
	tierOf(req: Request): string;
	rankOf(tier: string): number;
	reportSealRefused: SealRefusedReporter;
	/** The app's configured floor for `requireMinTier`, read live (HTTP has one fixed floor; sockets and upgrades take their own per call). */
	minTier(): string;
}

export interface Gate {
	/** Sanitize `headers` in place against edge provenance, then rank the result against `minTier`. */
	floor(headers: Record<string, unknown>, minTier: string): { ok: boolean; tier: string };
	/** Provenance + the floor on a socket.io handshake. `next(new Error('not found'))` is the client's `connect_error`. */
	gateSocketIo(io: SocketIOServer, opts: GateOptions): void;
	/** The floor for a raw upgrade: no middleware chain runs, so the caller answers the refusal itself. */
	gateUpgrade(req: IncomingMessage, opts: GateOptions): { ok: boolean; tier: string };
	/**
	 * Express middleware: refuse anything below the configured floor. 404, not
	 * 403 — a private app should not confirm its own existence to a caller who
	 * was never meant to reach it.
	 */
	requireMinTier(req: Request, res: Response, next: NextFunction): void;
}

/** One gate, bound to an app's auth functions and its `reportSealRefused`. */
export function createGate(deps: GateDeps): Gate {
	function floor(headers: Record<string, unknown>, minTier: string): { ok: boolean; tier: string } {
		deps.sanitizeHeaders(headers);
		const tier = deps.tierOf({ headers } as unknown as Request);
		return { ok: deps.rankOf(tier) >= deps.rankOf(minTier), tier };
	}

	function gateSocketIo(io: SocketIOServer, opts: GateOptions): void {
		io.engine.use(deps.edgeProvenance);
		io.use((socket, next) => {
			const result = floor(socket.request.headers as Record<string, unknown>, opts.minTier);
			if (!result.ok) {
				deps.reportSealRefused(opts.surface, socket.request.headers as Record<string, unknown>, null);
				next(new Error('not found'));
				return;
			}
			next();
		});
	}

	function gateUpgrade(req: IncomingMessage, opts: GateOptions): { ok: boolean; tier: string } {
		const result = floor(req.headers as Record<string, unknown>, opts.minTier);
		if (!result.ok) deps.reportSealRefused(opts.surface, req.headers as Record<string, unknown>, req.url ?? null);
		return result;
	}

	function requireMinTier(req: Request, res: Response, next: NextFunction): void {
		if (floor(req.headers as Record<string, unknown>, deps.minTier()).ok) return next();
		deps.reportSealRefused('http', req.headers as Record<string, unknown>, req.path);
		res.status(404).type('text/plain').send('not found');
	}

	return { floor, gateSocketIo, gateUpgrade, requireMinTier };
}

/* ── The base-path contract, checked at boot ──────────────────────────── */

/**
 * This is the one thing about a loopback-UI app that breaks SILENTLY, so it is
 * the one thing a server built this way refuses to guess about.
 *
 * The edge gives us stripPrefix: hadoku.me/<app>/assets/x.js arrives here as
 * /assets/x.js, which we serve happily. But the BROWSER is at
 * hadoku.me/<app>/, so a bundle built with the default base emits
 * `src="/assets/x.js"` — an absolute URL with no prefix. The browser asks the
 * edge for hadoku.me/assets/x.js, which is not this app's route, and the page
 * renders blank with a 404 in the console and a 200 on every server-side probe.
 *
 * So: compare them here, once, at boot, and say precisely what to change.
 *
 * ## Reading the file is not serving it
 *
 * `checkBasePath` proves index.html exists and is built right. It does not
 * prove the server can HAND IT OUT, and those came apart in practice: express's
 * `res.sendFile` goes through `send`, whose default `dotfiles: 'ignore'` refuses
 * any absolute path with a segment starting with `.` — so a server started from
 * a dot-segment path (every agent worktree) answered every page with a 404
 * while `readFileSync` read the same file happily and `/health` said `healthy`.
 *
 * So `checkBundle` finishes by asking the serving mechanism itself: it mounts
 * `sendIndex` — the exact function the SPA fallback uses — on a throwaway
 * loopback server and fetches it. If that is not a 200, the verdict is
 * `unservable`. It deliberately does not special-case dot segments: any future
 * reason `sendFile` refuses the file fails the same way.
 */
export interface BasePathVerdict {
	ok: boolean;
	/** 'ok' | 'missing' | 'unprefixed' | 'unservable' — machine-readable for /health. */
	reason: 'ok' | 'missing' | 'unprefixed' | 'unservable';
	/** Root-relative URLs in index.html that do not carry the prefix. */
	offenders: string[];
	detail: string;
}

/** `src="/…"` / `href="/…"` — root-relative only. Protocol-relative `//` is not ours. */
const ROOT_RELATIVE = /(?:src|href)\s*=\s*"(\/(?!\/)[^"]*)"/g;
const BASE_HREF = /<base\b[^>]*\bhref\s*=\s*"([^"]*)"/i;

/**
 * Root-relative URLs that are MEANT for the site root: hadoku.me itself serves
 * them, for every app, so resolving them against the root is the intent rather
 * than the drift this check exists to catch. Exact paths, never a prefix — a
 * pattern here would wave through the very assets this guards.
 */
const SITE_ROOT_URLS: ReadonlySet<string> = new Set(['/favicon.svg']);

/**
 * @param indexHtmlPath absolute path to the built index.html
 * @param basePrefix e.g. `/cardtable` (no trailing slash)
 */
export function checkBasePath(indexHtmlPath: string, basePrefix: string): BasePathVerdict {
	let html: string;
	try {
		html = readFileSync(indexHtmlPath, 'utf8');
	} catch {
		return {
			ok: false,
			reason: 'missing',
			offenders: [],
			detail: `No built bundle at ${indexHtmlPath}. Run the child repo's build (it must emit index.html plus its assets into this directory).`,
		};
	}

	const wanted = basePrefix.endsWith('/') ? basePrefix : `${basePrefix}/`;

	// A <base href> that already points at the prefix rebases every relative URL
	// in the document, so root-relative stragglers are the only remaining risk —
	// and <base> does NOT rebase those. Check them either way.
	const declaredBase = BASE_HREF.exec(html)?.[1];

	const offenders: string[] = [];
	for (const m of html.matchAll(ROOT_RELATIVE)) {
		const url = m[1];
		if (url === wanted || url.startsWith(wanted) || SITE_ROOT_URLS.has(url)) continue;
		offenders.push(url);
	}

	if (offenders.length > 0) {
		return {
			ok: false,
			reason: 'unprefixed',
			offenders,
			detail:
				`index.html emits ${offenders.length} root-relative URL(s) that do not start with "${wanted}". ` +
				`The browser is at hadoku.me${wanted} and will resolve them against the site root, not this app. ` +
				`Fix it where the bundle is BUILT — for Vite that is \`base: '${wanted}'\` in vite.config.ts — ` +
				`not by adding a rewrite here.` +
				(declaredBase && declaredBase !== wanted
					? ` (index.html also declares <base href="${declaredBase}">, which disagrees with the edge's stripPrefix "${basePrefix}".)`
					: ''),
		};
	}

	return { ok: true, reason: 'ok', offenders: [], detail: `base path "${wanted}" verified` };
}

export function isEmbedEntry(filePath: string, embedEntries: readonly string[]): boolean {
	return embedEntries.some((name) => filePath.endsWith(`${sep}embed${sep}${name}`));
}

/**
 * Serve index.html. The ONE place a page leaves this server, shared by the SPA
 * fallback and by `probeIndex`, so the probe cannot drift from what it vouches
 * for: change an option here and the boot check changes with it.
 */
export function sendIndex(res: Response, indexHtmlPath: string, done: (err?: Error) => void): void {
	res.set('Cache-Control', 'no-store').type('html').sendFile(indexHtmlPath, (err?: Error) => done(err));
}

/**
 * The HTTP status `sendIndex` actually produces for this file, measured over a
 * real loopback request rather than predicted — `send`'s refusals are decided
 * inside `send`, and re-deriving its rules here would be a second copy of them.
 */
export async function probeIndex(indexHtmlPath: string): Promise<number> {
	const probe = express();
	probe.get('/', (_req, res, next) => sendIndex(res, indexHtmlPath, (err) => err && next(err)));
	// A refusal is the expected outcome being measured, not a fault: answer with
	// send's status and keep express's default handler from printing a stack.
	probe.use((err: Error & { status?: number }, _req: unknown, res: Response, _next: unknown) => {
		res.status(err.status ?? 500).end();
	});
	const server = createServer(probe);
	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	try {
		const { port } = server.address() as AddressInfo;
		const answer = await fetch(`http://127.0.0.1:${port}/`);
		await answer.arrayBuffer();
		return answer.status;
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}

/**
 * The whole boot verdict: built right (`checkBasePath`) AND servable
 * (`probeIndex`). This, not `checkBasePath` alone, is what `/health` should report.
 */
export async function checkBundle(indexHtmlPath: string, basePrefix: string): Promise<BasePathVerdict> {
	const built = checkBasePath(indexHtmlPath, basePrefix);
	if (!built.ok) return built;

	const status = await probeIndex(indexHtmlPath);
	if (status === 200) return built;

	const dotSegments = indexHtmlPath.split(sep).filter((part) => part.startsWith('.') && part.length > 1);
	return {
		ok: false,
		reason: 'unservable',
		offenders: [],
		detail:
			`index.html is at ${indexHtmlPath} and reads fine, but serving it answered ${status}. ` +
			(dotSegments.length > 0
				? `The path has a dot-segment (${dotSegments.join(', ')}), and express's sendFile refuses those ` +
					`(send's dotfiles: 'ignore'). Run the server from a copy outside it — an e2e harness usually does.`
				: `express's sendFile refused a file that exists; check its permissions and sendIndex's options.`),
	};
}

/** The page served in place of a bundle that would render blank. */
export function diagnosticPage(verdict: BasePathVerdict, basePrefix: string, appName: string): string {
	const list =
		verdict.offenders.length > 0
			? `<ul>${verdict.offenders
					.slice(0, 12)
					.map((u) => `<li><code>${escapeHtml(u)}</code></li>`)
					.join('')}</ul>`
			: '';
	return `<!doctype html><meta charset=utf-8><title>${escapeHtml(appName)} — not serving</title>
<style>body{font:15px/1.6 system-ui,Segoe UI,Roboto,sans-serif;background:#15171c;color:#e7e9ee;margin:0;padding:40px;display:flex;justify-content:center}
main{max-width:720px}h1{font-size:19px;font-weight:600}code{background:#22252c;padding:2px 6px;border-radius:4px}
p.why{color:#9aa3b2}</style>
<main><h1>${escapeHtml(appName)} is running, but its bundle would not load</h1>
<p>${escapeHtml(verdict.detail)}</p>${list}
<p class=why>Served by the ${escapeHtml(appName.toLowerCase())} loopback server on behalf of <code>${escapeHtml(basePrefix)}/</code>.
This page exists so the failure is visible: the alternative is a blank page and a green health check.</p></main>`;
}

function escapeHtml(s: string): string {
	return s.replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
	);
}

/* ── The origin stamp ──────────────────────────────────────────────────── */

/**
 * Every response a server built this way sends carries this header, so the
 * edge can tell "nothing is listening yet" (a 502 worth holding through a
 * restart) from an answer the app itself produced (a 502 of its own, which
 * must reach the browser at once). Set at the socket level so it covers
 * express, socket.io's polling and every error path alike.
 */
export const ORIGIN_HEADER = 'X-Hadoku-Origin';

export function stampOrigin(server: Server, originValue: string): void {
	server.prependListener('request', (_req, res) => {
		res.setHeader(ORIGIN_HEADER, originValue);
	});
}
