/**
 * Magic's UI moves home: `apps/ui` becomes `games/magic/ui` (`@hadoku/magic-ui`), and the site's
 * own files move back out to a thin `apps/ui` (still `@hadoku/ui`, still where vite builds the SPA).
 *
 *   node scripts/codemods/magic-ui-move.ts --move   # the git mv's, then the rewrite
 *   node scripts/codemods/magic-ui-move.ts [--dry]  # the rewrite alone (idempotent)
 *
 * Every tracked file under the old `apps/ui` lands at `games/magic/ui/<same path>` unless SITE names
 * it (a file, or a directory with a trailing slash), in which case it stays at `apps/ui/<same path>`.
 *
 * 1. Specifiers. Every quoted relative string in a `.ts`/`.tsx`/`.mjs`/`.js` file under apps/, e2e/,
 *    scripts/, games/ and packages/ that no longer resolves, but did from where its file was before
 *    the move, is re-pointed at where its target is now. In a specifier position (`from`, a bare
 *    `import`, `import(`, `vi.mock(`/`vi.doMock(`/`vi.importActual(`): from the site to Magic's UI it
 *    becomes the subpath `@hadoku/magic-ui/<path>` (the package's `./*` export, extension kept, as the
 *    UI's own relative imports name files); anywhere else it stays relative, re-computed. Any other
 *    string (a path read from disk, a directory, a fixture's text) is not rewritten but listed for
 *    review: what it means depends on who reads it. A Magic file that imported a site file is
 *    reported and fails the run: Magic must not import the site.
 *    A stylesheet's `url(…)` or `@import` that named a file before the move and misses it now is
 *    listed for review the same way.
 *    So is a path built from segments, `'apps', 'ui', 'src', …`, which neither pass can read.
 * 2. Mentions. `apps/ui/src/<path>` naming a file or directory now under `games/magic/ui/src`, in
 *    code comments and the current docs (not `docs/planning/`, `docs/releases/`, the selector's frozen
 *    fixtures, its made-up fixture repo, the claim script's made-up areas, or `layers.json`), becomes
 *    `games/magic/ui/src/<path>`. A path that is the site's, or names nothing that exists, is left.
 *
 * Prints every rewrite. A second run finds nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = 'apps/ui/';
const MAGIC = 'games/magic/ui/';
const PKG = '@hadoku/magic-ui';

/** What stays the site, relative to `apps/ui/`. A trailing slash names a directory. */
export const SITE: readonly string[] = [
	// the build: vite's root, its configs and the defines the app and its tests share
	'index.html',
	'vite.config.ts',
	'vite.embed.config.ts',
	'app-base.ts',
	'app-name.ts',
	'build-defines.ts',
	'chunks.ts',
	'stylesheet.ts',
	// the composition roots and the pages vite serves
	'src/main.tsx',
	'src/App.tsx',
	'src/composition.tsx',
	'src/globals.d.ts',
	'src/favicon.svg',
	'src/test-setup.ts',
	'src/embed/',
	'src/fit/',
	'src/play/harness.tsx',
	'src/play/harness.html',
	'src/play/live/harness.tsx',
	'src/play/live/harness.html',
	'src/rooms/games/',
	'src/screens/Screen.tsx',
	'src/screens/LobbyScreen.tsx',
	// tests of the site's own files
	'src/globals.test.ts',
	'src/stylesheet.test.ts',
	'src/controls.test.ts', // reads index.html, main.tsx and the embed's entry
	// tests that render the app or its front page (App.tsx, LobbyScreen.tsx), or a platform module as
	// the app composes it (composition.tsx registers the player mark, the embed address, the sounds)
	'src/chrome/header.test.ts',
	'src/room/RoomShell.test.ts',
	'src/rooms/rooms.test.ts',
	'src/screens/decks.test.ts',
	'src/screens/lobby.test.ts',
	'src/screens/matchRoom.test.ts',
	'src/stats/stats.test.ts',
	'src/components/Avatar.test.ts',
	'src/screens/route.test.ts',
	'src/restart-notice.test.ts',
	'src/usage.test.ts',
];

const isSite = (rel: string): boolean => SITE.some((s) => (s.endsWith('/') ? rel.startsWith(s) : rel === s));

/** Where a path under the old `apps/ui` is now; any other path is where it was. */
export function moved(path: string): string {
	if (!path.startsWith(OLD)) return path;
	const rel = path.slice(OLD.length);
	return isSite(rel) ? path : MAGIC + rel;
}

/** Where a file that is now at `path` was before the move. */
const before = (path: string): string => (path.startsWith(MAGIC) ? OLD + path.slice(MAGIC.length) : path);

const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const tracked = (...globs: string[]): string[] => git('ls-files', ...globs).split('\n').filter(Boolean);

if (process.argv.includes('--move')) {
	const files = tracked(OLD);
	git('mv', 'apps/ui', MAGIC.slice(0, -1));
	const back = files.filter((f) => moved(f) === f);
	for (const f of back) {
		execFileSync('mkdir', ['-p', dirname(join(ROOT, f))]);
		git('mv', MAGIC + f.slice(OLD.length), f);
	}
	console.log(`moved ${files.length - back.length} file(s) to ${MAGIC}, ${back.length} back to ${OLD}`);
}

const dry = process.argv.includes('--dry');
const exists = (rel: string): boolean => existsSync(join(ROOT, rel));
const isFile = (rel: string): boolean => exists(rel) && statSync(join(ROOT, rel)).isFile();
const isDir = (rel: string): boolean => exists(rel) && statSync(join(ROOT, rel)).isDirectory();

/** The file a relative path names now (a `?query` dropped; `.js` may be `.ts`/`.tsx`), or null. */
function resolveNow(base: string, map: (p: string) => string = (p) => p): string | null {
	const path = base.split('?')[0]!;
	const stem = path.replace(/\.(js|ts|tsx|mjs)$/, '');
	for (const c of [path, `${stem}.ts`, `${stem}.tsx`, `${path}.ts`, `${path}/index.ts`]) if (isFile(map(c))) return map(c);
	return null;
}

/**
 * Where a directory that was at `old` is now, or null if there was none. The old `apps/ui` and its
 * `src` exist on both sides now (and `src/play` and the rest of the split ones), so a file reading
 * one means its own side's.
 */
function movedDir(old: string, magicSide: boolean): string | null {
	const path = old === '' ? '.' : old;
	if (path !== 'apps/ui' && !path.startsWith(OLD)) return isDir(path) ? path : null;
	const sides = [MAGIC.slice(0, -1) + path.slice(OLD.length - 1), path];
	return (magicSide ? sides : sides.reverse()).find(isDir) ?? null;
}

const changed = new Map<string, string>();
const read = (f: string): string => changed.get(f) ?? readFileSync(join(ROOT, f), 'utf8');
const relFrom = (from: string, to: string): string => {
	const rel = posix.relative(posix.dirname(from), to);
	return rel.startsWith('.') ? rel : `./${rel}`;
};

// ── 1. specifiers ────────────────────────────────────────────────────────
let specs = 0;
const strays: string[] = [];
const review: string[] = [];
const SPECIFIER = /(?:\bfrom|\bimport|\bimport\s*\(|\bvi\.(?:mock|doMock|importActual)\s*\()\s*$/;
for (const f of tracked('apps', 'e2e', 'scripts', 'games', 'packages').filter((x) => /\.(ts|tsx|mjs|js)$/.test(x))) {
	if (f.startsWith('scripts/ci/fixtures/') || f.startsWith('scripts/codemods/')) continue;
	const src = read(f);
	const was = before(f);
	const out = src.replace(/(['"])(\.\.?\/[^'"\n]*|\.\.?)\1/g, (whole, q: string, spec: string, at: number) => {
		const base = posix.normalize(posix.join(posix.dirname(f), spec));
		const old = posix.normalize(posix.join(posix.dirname(was), spec));
		const dir = movedDir(old, f.startsWith(MAGIC));
		const target = dir === null ? resolveNow(old, moved) : null;
		if (target === null && dir === null) return whole; // named nothing before: a template, a glob, a fixture's text
		const now = (target ?? dir)!;
		if ((target !== null ? resolveNow(base) : isDir(base) ? base : null) === now) return whole;
		const query = spec.includes('?') ? spec.slice(spec.indexOf('?')) : '';
		const specifier = target !== null && SPECIFIER.test(src.slice(Math.max(0, at - 40), at));
		if (specifier && f.startsWith(MAGIC) && now.startsWith(OLD)) {
			strays.push(`${f}: ${spec} (${now} is the site's)`);
			return whole;
		}
		if (!specifier) {
			review.push(`${f}: ${spec} (named ${old === '' ? '.' : old}, now ${now}; ${target === null ? 'a directory' : 'not an import'})`);
			return whole;
		}
		const next = f.startsWith(OLD) && now.startsWith(`${MAGIC}src/`) ? `${PKG}/${now.slice(`${MAGIC}src/`.length)}${query}` : relFrom(f, now) + query;
		specs++;
		console.log(`${f}: ${spec} → ${next}`);
		return `${q}${next}${q}`;
	});
	if (out !== src) changed.set(f, out);
}
// A stylesheet's `url(…)` and `@import` are read by vite, never rewritten here: listed when they miss.
for (const f of tracked('apps', 'games', 'packages').filter((x) => x.endsWith('.css'))) {
	const was = before(f);
	for (const m of read(f).matchAll(/(?:url\(\s*|@import\s+)(['"]?)(\.\.?\/[^'")\s]+)\1/g)) {
		const spec = m[2]!;
		const now = moved(posix.normalize(posix.join(posix.dirname(was), spec)));
		if (isFile(now) && posix.normalize(posix.join(posix.dirname(f), spec)) !== now) review.push(`${f}: ${spec} (names ${now}; a stylesheet's url)`);
	}
}

// A path built from segments (`join(ROOT, 'apps', 'ui', 'src', …)`) is invisible to both passes: listed.
for (const f of tracked('apps', 'e2e', 'scripts', 'games', 'packages').filter((x) => /\.(ts|tsx|mjs|js)$/.test(x))) {
	if (f.startsWith('scripts/codemods/')) continue;
	for (const m of read(f).matchAll(/(['"])apps\1\s*,\s*(['"])ui\2\s*,\s*(['"])src\3[^)\n]*/g)) review.push(`${f}: ${m[0]} (a path built from segments)`);
}

// ── 2. mentions ──────────────────────────────────────────────────────────
let mentions = 0;
const mentionFiles = tracked().filter(
	(f) =>
		/\.(ts|tsx|mjs|js|md|sh|yml|yaml|json|txt|css|html)$/.test(f) &&
		!/^(forge|docs\/planning|docs\/releases|scripts\/ci\/fixtures|scripts\/codemods)\//.test(f) &&
		![
			'scripts/layers/layers.json',
			'scripts/ci/select-forge-tests.test.ts', // its fixture repo's paths are made up, not ours
			'scripts/lanes/claim.test.ts', // areas as examples: a pattern and the path it must match, rewritten as a pair or not at all
			'scripts/lanes/claim.sh',
		].includes(f),
);
for (const f of mentionFiles) {
	if (!isFile(f)) continue;
	const src = read(f);
	if (!src.includes(`${OLD}src/`)) continue;
	const out = src.replace(/apps\/ui\/src\/([\w\-./]*[\w-])/g, (whole, path: string) => {
		const now = `${MAGIC}src/${path}`;
		if (isSite(`src/${path}`) || !exists(now)) return whole;
		mentions++;
		return now;
	});
	if (out !== src) {
		changed.set(f, out);
		console.log(`${f}: path mentions`);
	}
}

console.log(`\n${specs} specifier(s), ${mentions} mention(s) in ${changed.size} file(s)${dry ? ' (dry run)' : ''}`);
if (review.length > 0) console.log(`\n${review.length} string(s) left for review:\n${review.join('\n')}`);
if (strays.length > 0) {
	console.error(`\n${strays.length} Magic file(s) import the site:\n${strays.join('\n')}`);
	process.exit(1);
}
if (!dry) for (const [f, text] of changed) writeFileSync(join(ROOT, f), text);
