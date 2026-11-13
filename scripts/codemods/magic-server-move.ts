/**
 * The path codemod for `apps/server` becoming `games/magic/server` (`@hadoku/magic-server`), with the
 * site — `src/index.ts`, `src/plugins/{index,bomberman}.ts`, their tests and `src/route-table.json` —
 * moved back to `apps/server`.
 *
 *   git mv apps/server games/magic/server
 *   git mv games/magic/server/src/<site file> apps/server/src/<site file>   (each file in SITE below)
 *   node scripts/codemods/magic-server-move.ts [--dry]
 *
 * Two passes over the tracked tree:
 *
 * 1. Specifiers. Every quoted relative specifier (`from`, `import()`, `typeof import()`, `vi.mock`) in a
 *    `.ts`/`.tsx`/`.mjs` file is read as it was written, from the file's OLD place, and its target
 *    moved the same way. If it no longer names that target from the file's NEW place it is
 *    rewritten: from the site into Magic as `@hadoku/magic-server/<path>` (the package's `./*`
 *    export), anywhere else as the new relative path, in the specifier's own extension style.
 * 2. Mentions. `apps/server/<path>` in comments and current docs (not `docs/planning/`,
 *    `docs/releases/`, the selector's frozen `scripts/ci/fixtures/` or its test's made-up repo),
 *    where `<path>` is now under `games/magic/server/` and not under `apps/server/`, becomes
 *    `games/magic/server/<path>`. Bare `apps/server`, `apps/server/src` and `apps/server/dist` name
 *    the site, which is still there, and are left alone, as is `apps/server/node_modules/.bin/*`.
 *
 * Prints every rewrite. Idempotent: a second run finds nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = 'apps/server/';
const NEW = 'games/magic/server/';
const PKG = '@hadoku/magic-server';
const SITE = new Set(
	['package.json', 'src/index.ts', 'src/index.test.ts', 'src/route-table.json', 'src/plugins/index.ts', 'src/plugins/bomberman.ts', 'src/plugins/bomberman.test.ts', 'src/plugins/presence.test.ts'].map(
		(f) => OLD + f,
	),
);
const dry = process.argv.includes('--dry');

const tracked = (...globs: string[]): string[] =>
	execFileSync('git', ['ls-files', ...globs], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

const exists = (rel: string): boolean => existsSync(join(ROOT, rel));
const isFile = (rel: string): boolean => exists(rel) && statSync(join(ROOT, rel)).isFile();

/** The repo file a relative specifier's base names (`.js` may be `.ts`/`.tsx`), or null. */
function resolveRel(base: string): string | null {
	const stem = base.replace(/\.(js|ts|tsx|mjs)$/, '');
	return [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}/index.ts`].find(isFile) ?? null;
}

/** Where a file that is now at `rel` was before the move. */
const before = (rel: string): string => (rel.startsWith(NEW) ? OLD + rel.slice(NEW.length) : rel);
/** Where a path that was at `rel` before the move is now. */
const after = (rel: string): string => (rel.startsWith(OLD) && !SITE.has(rel) ? NEW + rel.slice(OLD.length) : rel);

const changed = new Map<string, string>();
const read = (f: string): string => changed.get(f) ?? readFileSync(join(ROOT, f), 'utf8');

// ── 1. specifiers ────────────────────────────────────────────────────────
let specs = 0;
for (const f of tracked().filter((x) => /\.(ts|tsx|mjs)$/.test(x))) {
	if (/^(forge|scripts\/ci\/fixtures|scripts\/codemods)\//.test(f)) continue;
	const src = read(f);
	const out = src.replace(/(['"])(\.\.?\/[^'"\n]*)\1/g, (whole, q: string, spec: string) => {
		const was = posix.normalize(posix.join(posix.dirname(before(f)), spec));
		// What the specifier named before the move, read in the moved tree.
		const stem = was.replace(/\.(js|ts|tsx|mjs)$/, '');
		const candidates = [was, `${stem}.ts`, `${stem}.tsx`, `${was}.ts`, `${was}/index.ts`].map(after);
		const target = candidates.find(isFile) ?? null;
		if (target === null) return whole; // never resolved, or not a file (a fixture string, a URL path)
		const now = resolveRel(posix.normalize(posix.join(posix.dirname(f), spec)));
		if (now === target) return whole;
		let next: string;
		if (f.startsWith(OLD) && target.startsWith(NEW + 'src/')) {
			next = `${PKG}/${target.slice(NEW.length + 'src/'.length).replace(/\.(ts|tsx)$/, '')}`;
		} else {
			const ext = /\.(js|ts|tsx|mjs|json)$/.exec(spec)?.[0] ?? '';
			const tail = ext === '' ? target.replace(/(\/index)?\.(ts|tsx)$/, '') : ext === '.js' ? target.replace(/\.(ts|tsx)$/, '.js') : target;
			const rel = posix.relative(posix.dirname(f), tail);
			next = rel.startsWith('.') ? rel : `./${rel}`;
		}
		specs++;
		console.log(`${f}: ${spec} → ${next}`);
		return `${q}${next}${q}`;
	});
	if (out !== src) changed.set(f, out);
}

// ── 2. mentions ──────────────────────────────────────────────────────────
let mentions = 0;
const mentionFiles = tracked().filter(
	(f) =>
		/\.(ts|tsx|mjs|js|md|sh|yml|yaml|json|txt|java|py)$/.test(f) &&
		!/^(forge|docs\/planning|docs\/releases|scripts\/ci\/fixtures|scripts\/codemods)\//.test(f) &&
		f !== 'scripts/layers/layers.json' &&
		f !== 'scripts/ci/select-forge-tests.test.ts',
);
for (const f of mentionFiles) {
	if (!isFile(f)) continue;
	const src = read(f);
	if (!src.includes(OLD)) continue;
	const out = src.replace(/(?<![\w/.-])apps\/server\/([\w.-]+(?:\/[\w.-]+)*\/?)/g, (whole, path: string) => {
		const bare = path.replace(/\/$/, '').replace(/\.$/, '');
		// `node_modules` is never tracked: both packages have one, and the tools in the site's run its scripts.
		if (bare === '' || bare.startsWith('node_modules') || exists(OLD + bare) || !exists(NEW + bare)) return whole;
		mentions++;
		return NEW + path;
	});
	if (out !== src) {
		changed.set(f, out);
		console.log(`${f}: path mentions`);
	}
}

console.log(`\n${specs} specifier(s), ${mentions} mention(s) in ${changed.size} file(s)${dry ? ' (dry run)' : ''}`);
if (!dry) for (const [f, text] of changed) writeFileSync(join(ROOT, f), text);
