/**
 * A workspace package's `exports` map, read the way Node resolves a subpath: the exact key, else a
 * single-`*` pattern with `*` filled in. Shared by the layer ratchet (`scan.ts`, which classifies the
 * file an `@hadoku/<pkg>/<sub>` import names) and the Forge test selector
 * (`scripts/ci/select-forge-tests.ts`, which follows the same import to the module it changes).
 */

/** What an `exports` map gives for `key` (`.`, `./platform`, `./room/session`): the exact entry, else a `./*` pattern's, with `*` filled in. */
export function exportOf(exports: Record<string, string> | undefined, key: string): string | undefined {
	if (exports === undefined) return undefined;
	if (typeof exports[key] === 'string') return exports[key];
	for (const [pattern, target] of Object.entries(exports)) {
		const [head, tail, extra] = pattern.split('*');
		if (tail === undefined || extra !== undefined || typeof target !== 'string') continue;
		if (key.length >= head.length + tail.length && key.startsWith(head) && key.endsWith(tail)) return target.replace('*', key.slice(head.length, key.length - tail.length));
	}
	return undefined;
}

/** An `@hadoku/<pkg>[/<sub>]` specifier's package name and its `exports` key (`.` or `./<sub>`), or null for any other specifier. */
export function hadokuSubpath(spec: string): { pkg: string; key: string } | null {
	const m = /^@hadoku\/([\w-]+)(\/.+)?$/.exec(spec);
	return m === null ? null : { pkg: m[1], key: `.${m[2] ?? ''}` };
}
