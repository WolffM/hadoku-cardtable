/**
 * Set symbols for Rally's pick rows, drawn by Rally's page from Cardtable's own Keyrune
 * (`apps/ui/src/symbols/`, D20) so Rally ships no font and no glyph of its own.
 *
 *   GET /api/rally/symbols.css   → `.rally-line-symbol[data-line="set/<code>" i]::before` per set
 *   GET /api/rally/keyrune.woff2 → the font that stylesheet names, by a path relative to it
 *
 * Rally gives each option line a `<span class="rally-line-symbol" data-line="set/TMT">` (its
 * view path less the page) and links this stylesheet from `/sources`' `symbols`. A line with no
 * symbol here (a cube) matches no rule and draws nothing in its slot. The glyph takes Rally's
 * text colour, so it reads in every theme. The font keeps its own family name, "Keyrune": the
 * OFL reserves it, and nothing here renames the font (`LICENSE-keyrune.md`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Every `.ss-<code>:before { content: "<glyph>" }` in Keyrune's stylesheet, in its order. */
export function setGlyphs(keyruneCss: string): [code: string, glyph: string][] {
	const out = new Map<string, string>();
	for (const m of keyruneCss.matchAll(/^\.ss-([a-z0-9]+):before\s*\{\s*content:\s*"(\\[0-9a-f]{4})";\s*\}/gm)) out.set(m[1]!, m[2]!);
	return [...out];
}

/** The stylesheet Rally links: the font, then one rule per set. */
export function symbolsCss(keyruneCss: string): string {
	const rules = setGlyphs(keyruneCss).map(([code, glyph]) => `.rally-line-symbol[data-line="set/${code}" i]::before{content:"${glyph}"}`);
	return [
		'/* Keyrune by Andrew Gioia (keyrune.andrewgioia.com): icons GPL-3.0, font SIL OFL 1.1. Set symbols are trademarks of Wizards of the Coast; their use does not indicate endorsement. */',
		'@font-face{font-family:"Keyrune";src:url("keyrune.woff2") format("woff2");font-weight:normal;font-style:normal;font-display:block}',
		'.rally-line-symbol::before{font-family:"Keyrune";font-style:normal;font-weight:normal;line-height:1;speak:never}',
		...rules,
		'',
	].join('\n');
}

export interface RallySymbols {
	css(): Promise<string>;
	font(): Promise<Buffer>;
}

/** Read from `dir` once, on first ask; a failed read is asked again next time rather than cached. */
export function rallySymbols(dir: string): RallySymbols {
	let css: Promise<string> | null = null;
	let font: Promise<Buffer> | null = null;
	return {
		css: () =>
			(css ??= readFile(join(dir, 'keyrune.css'), 'utf8')
				.then(symbolsCss)
				.catch((err: unknown) => {
					css = null;
					throw err;
				})),
		font: () =>
			(font ??= readFile(join(dir, 'fonts', 'keyrune.woff2')).catch((err: unknown) => {
				font = null;
				throw err;
			})),
	};
}
