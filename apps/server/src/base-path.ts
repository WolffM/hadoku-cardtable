/**
 * The base-path contract, checked at boot — cardtable's binding of the
 * platform kernel (`@hadoku/service-kernel/http`).
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

import { type BasePathVerdict, diagnosticPage as kernelDiagnosticPage, sendIndex } from '@hadoku/service-kernel/http';

export type { BasePathVerdict };
export { sendIndex };

/**
 * The embed bundle's two fixed-name files (D21): `apps/ui/vite.embed.config.ts`
 * emits them, watchparty imports the `.js`. Every other file in the bundle is
 * content-hashed; these are the only ones whose bytes change under one name.
 */
export const EMBED_ENTRIES = ['cardtable-embed.js', 'cardtable-embed.css'] as const;

/** The page served in place of a bundle that would render blank, under cardtable's own name. */
export function diagnosticPage(verdict: BasePathVerdict, basePrefix: string): string {
	return kernelDiagnosticPage(verdict, basePrefix, 'Cardtable');
}
