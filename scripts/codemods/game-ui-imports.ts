/**
 * The import codemod for the UI's platform code leaving `apps/ui/src` for `packages/game-ui/src`
 * (same relative path inside `src/`).
 *
 *   node scripts/codemods/game-ui-imports.ts [--dry]
 *
 * Run after the `git mv`. Two passes over the tracked tree:
 *
 * 1. Specifiers. Every quoted relative specifier (`from`, `import()`, `vi.mock`/`vi.importActual`, a
 *    side-effect `import './x.css'`) in a `.ts`/`.tsx`/`.mjs` file under apps/, e2e/, scripts/,
 *    games/ and packages/game-ui that no longer resolves, but resolves once its `apps/ui/src/`
 *    target is read as `packages/game-ui/src/`, is rewritten: inside a workspace package to the
 *    subpath `@hadoku/game-ui/<path>` with its extension (the package's `./*` export, which names
 *    files as the UI's own relative imports do), and in `scripts/` (not a package) to the relative
 *    path of the moved file. A specifier that resolves today is never touched. Any other string
 *    naming a moved file (a path read from disk, a fixture's source text, a specifier some other
 *    module resolves from ITS file) is not rewritten but listed for review: what it means depends on
 *    who reads it. A moved file whose
 *    relative import now misses (it named a file that stayed in apps/ui) is reported and fails the
 *    run: a package must not import the app.
 * 2. Mentions. `apps/ui/src/<file>` naming a moved file, in code comments and the current docs
 *    (not `docs/planning/`, `docs/releases/` or the selector's frozen `scripts/ci/fixtures/`, which
 *    record what was true then, nor the selector test's made-up fixture repo), becomes
 *    `packages/game-ui/src/<file>`.
 *
 * Prints every rewrite. Idempotent: a second run finds nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = 'apps/ui/src/';
const NEW = 'packages/game-ui/src/';
const PKG = '@hadoku/game-ui';
const dry = process.argv.includes('--dry');

const tracked = (...globs: string[]): string[] =>
	execFileSync('git', ['ls-files', ...globs], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

const isFile = (rel: string): boolean => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile();

/** The repo file a relative specifier names (a `?query` dropped; `.js` may be `.ts`/`.tsx`), or null. */
function resolveRel(base: string): string | null {
	const path = base.split('?')[0]!;
	const stem = path.replace(/\.(js|ts|tsx|mjs)$/, '');
	return [path, `${stem}.ts`, `${stem}.tsx`, `${path}.ts`, `${path}/index.ts`].find(isFile) ?? null;
}

const changed = new Map<string, string>();
const read = (f: string): string => changed.get(f) ?? readFileSync(join(ROOT, f), 'utf8');

// ── 1. specifiers ────────────────────────────────────────────────────────
let specs = 0;
const strays: string[] = [];
const review: string[] = [];
/** What stands before a quoted module specifier: `from`, a bare `import`, `import(`, `vi.mock(`/`vi.importActual(`/`vi.doMock(`. */
const SPECIFIER = /(?:\bfrom|\bimport|\bimport\s*\(|\bvi\.(?:mock|doMock|importActual)\s*\()\s*$/;
for (const f of tracked('apps', 'e2e', 'scripts', 'games', 'packages/game-ui').filter((x) => /\.(ts|tsx|mjs)$/.test(x))) {
	if (f.startsWith('scripts/ci/fixtures/') || f.startsWith('scripts/codemods/')) continue;
	const src = read(f);
	const out = src.replace(/(['"])(\.\.?\/[^'"\n]*)\1/g, (whole, q: string, spec: string, at: number) => {
		const base = posix.normalize(posix.join(posix.dirname(f), spec));
		if (resolveRel(base) !== null) return whole;
		if (f.startsWith(NEW)) {
			// A moved file's import that missed: if it named something that stayed in the app, say so.
			const before = posix.normalize(posix.join(posix.dirname(OLD + f.slice(NEW.length)), spec));
			if (resolveRel(before) !== null) strays.push(`${f}: ${spec} (${before} did not move)`);
			return whole;
		}
		if (!base.startsWith(OLD)) return whole;
		const moved = resolveRel(NEW + base.slice(OLD.length));
		if (moved === null) return whole;
		if (!SPECIFIER.test(src.slice(Math.max(0, at - 40), at))) {
			review.push(`${f}: ${spec} (names ${moved}; not an import)`);
			return whole;
		}
		const query = spec.includes('?') ? spec.slice(spec.indexOf('?')) : '';
		let next: string;
		if (f.startsWith('scripts/')) {
			const rel = posix.relative(posix.dirname(f), moved);
			next = (rel.startsWith('.') ? rel : `./${rel}`) + query;
		} else {
			next = `${PKG}/${moved.slice(NEW.length)}${query}`;
		}
		specs++;
		console.log(`${f}: ${spec} → ${next}`);
		return `${q}${next}${q}`;
	});
	if (out !== src) changed.set(f, out);
}

// ── 2. mentions ──────────────────────────────────────────────────────────
const movedFiles = new Set(tracked(NEW).map((f) => f.slice(NEW.length)));
let mentions = 0;
const mentionFiles = tracked().filter(
	(f) =>
		/\.(ts|tsx|mjs|js|md|sh|yml|yaml|json|txt|css|html)$/.test(f) &&
		!/^(forge|docs\/planning|docs\/releases|scripts\/ci\/fixtures|scripts\/codemods)\//.test(f) &&
		f !== 'scripts/layers/layers.json' &&
		f !== 'scripts/ci/select-forge-tests.test.ts', // its fixture repo's paths are made up, not ours
);
for (const f of mentionFiles) {
	if (!isFile(f)) continue;
	const src = read(f);
	if (!src.includes(OLD)) continue;
	const out = src.replace(/apps\/ui\/src\/([\w./-]+?\.(?:tsx|ts|css|json))(?![\w])/g, (whole, path: string) => {
		if (!movedFiles.has(path)) return whole;
		mentions++;
		return NEW + path;
	});
	if (out !== src) {
		changed.set(f, out);
		console.log(`${f}: path mentions`);
	}
}

console.log(`\n${specs} specifier(s), ${mentions} mention(s) in ${changed.size} file(s)${dry ? ' (dry run)' : ''}`);
if (review.length > 0) console.log(`\n${review.length} string(s) left for review:\n${review.join('\n')}`);
if (strays.length > 0) {
	console.error(`\n${strays.length} moved file(s) import what stayed in the app:\n${strays.join('\n')}`);
	process.exit(1);
}
if (!dry) for (const [f, text] of changed) writeFileSync(join(ROOT, f), text);
