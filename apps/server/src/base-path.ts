/**
 * The base-path contract, checked at boot.
 *
 * This is the one thing about a loopback-UI app that breaks SILENTLY, so it is
 * the one thing this server refuses to guess about.
 *
 * The edge gives us stripPrefix: hadoku.me/cardtable/assets/x.js arrives here
 * as /assets/x.js, which we serve happily. But the BROWSER is at
 * hadoku.me/cardtable/, so a bundle built with the default base emits
 * `src="/assets/x.js"` — an absolute URL with no prefix. The browser asks the
 * edge for hadoku.me/assets/x.js, which is not this app's route, and the page
 * renders blank with a 404 in the console and a 200 on every server-side probe.
 * games-host shipped exactly this: its edge stripPrefix and its backend's base
 * path are two independent declarations of one fact, and nothing compared them.
 *
 * So: compare them here, once, at boot, and say precisely what to change.
 */

import { readFileSync } from 'node:fs';

export interface BasePathVerdict {
	ok: boolean;
	/** 'ok' | 'missing' | 'unprefixed' — machine-readable for /health. */
	reason: 'ok' | 'missing' | 'unprefixed';
	/** Root-relative URLs in index.html that do not carry the prefix. */
	offenders: string[];
	detail: string;
}

/** `src="/…"` / `href="/…"` — root-relative only. Protocol-relative `//` is not ours. */
const ROOT_RELATIVE = /(?:src|href)\s*=\s*"(\/(?!\/)[^"]*)"/g;
const BASE_HREF = /<base\b[^>]*\bhref\s*=\s*"([^"]*)"/i;

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
		if (url === wanted || url.startsWith(wanted)) continue;
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

/** The page served in place of a bundle that would render blank. */
export function diagnosticPage(verdict: BasePathVerdict, basePrefix: string): string {
	const list =
		verdict.offenders.length > 0
			? `<ul>${verdict.offenders
					.slice(0, 12)
					.map((u) => `<li><code>${escapeHtml(u)}</code></li>`)
					.join('')}</ul>`
			: '';
	return `<!doctype html><meta charset=utf-8><title>Cardtable — not serving</title>
<style>body{font:15px/1.6 system-ui,Segoe UI,Roboto,sans-serif;background:#15171c;color:#e7e9ee;margin:0;padding:40px;display:flex;justify-content:center}
main{max-width:720px}h1{font-size:19px;font-weight:600}code{background:#22252c;padding:2px 6px;border-radius:4px}
p.why{color:#9aa3b2}</style>
<main><h1>Cardtable is running, but its bundle would not load</h1>
<p>${escapeHtml(verdict.detail)}</p>${list}
<p class=why>Served by the cardtable loopback server on behalf of <code>${escapeHtml(basePrefix)}/</code>.
This page exists so the failure is visible: the alternative is a blank page and a green health check.</p></main>`;
}

function escapeHtml(s: string): string {
	return s.replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
	);
}
