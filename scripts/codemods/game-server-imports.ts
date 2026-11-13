/**
 * The import codemod for the server's platform code leaving `apps/server/src` for
 * `packages/game-server/src` (same relative path inside `src/`).
 *
 *   node scripts/codemods/game-server-imports.ts [--dry]
 *
 * Run after the `git mv`. Two passes over the tracked tree:
 *
 * 1. Specifiers. Every quoted relative specifier (`from`, `import()`, `vi.mock`, any string) in a
 *    `.ts`/`.tsx`/`.mjs` file under apps/, e2e/, scripts/ and games/ that no longer resolves, but
 *    resolves once its `apps/server/src/` target is read as `packages/game-server/src/`, is
 *    rewritten: inside a workspace package to the subpath `@hadoku/game-server/<path>` (the
 *    package's `./*` export), and in `scripts/` (not a package, no `node_modules` of its own) to
 *    the relative path of the moved file. A specifier that resolves today is never touched.
 * 2. Mentions. `apps/server/src/<file>` naming a moved file, in code comments and the current docs
 *    (not `docs/planning/`, `docs/releases/` or the selector's frozen `scripts/ci/fixtures/`, which
 *    record what was true then, nor the selector test's made-up fixture repo), becomes `packages/game-server/src/<file>`.
 *
 * Prints every rewrite. Idempotent: a second run finds nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = 'apps/server/src/';
const NEW = 'packages/game-server/src/';
const PKG = '@hadoku/game-server';
const dry = process.argv.includes('--dry');

const tracked = (...globs: string[]): string[] =>
	execFileSync('git', ['ls-files', ...globs], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

const isFile = (rel: string): boolean => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile();

/** The repo file a relative specifier names (`.js` may be `.ts`/`.tsx`), or null. */
function resolveRel(base: string): string | null {
	const stem = base.replace(/\.(js|ts|tsx|mjs)$/, '');
	return [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}/index.ts`].find(isFile) ?? null;
}

const changed = new Map<string, string>();
const read = (f: string): string => changed.get(f) ?? readFileSync(join(ROOT, f), 'utf8');

// ── 1. specifiers ────────────────────────────────────────────────────────
let specs = 0;
for (const f of tracked('apps', 'e2e', 'scripts', 'games', 'packages/game-server').filter((x) => /\.(ts|tsx|mjs)$/.test(x))) {
	if (f.startsWith('scripts/ci/fixtures/') || f.startsWith('scripts/codemods/')) continue;
	const src = read(f);
	const out = src.replace(/(['"])(\.\.?\/[^'"\n]*)\1/g, (whole, q: string, spec: string) => {
		const base = posix.normalize(posix.join(posix.dirname(f), spec));
		if (resolveRel(base) !== null || !base.startsWith(OLD)) return whole;
		const moved = resolveRel(NEW + base.slice(OLD.length));
		if (moved === null) return whole;
		if (f.startsWith(NEW)) return whole; // moved beside its target: the same relative path still resolves
		let next: string;
		if (f.startsWith('scripts/')) {
			const ext = /\.(js|ts|tsx|mjs)$/.exec(spec)?.[0] ?? '';
			const rel = posix.relative(posix.dirname(f), moved.replace(/\.ts$/, ext));
			next = rel.startsWith('.') ? rel : `./${rel}`;
		} else {
			next = `${PKG}/${moved.slice(NEW.length).replace(/\.ts$/, '')}`;
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
		/\.(ts|tsx|mjs|js|md|sh|yml|yaml|json|txt|java)$/.test(f) &&
		!/^(forge|docs\/planning|docs\/releases|scripts\/ci\/fixtures|scripts\/codemods)\//.test(f) &&
		f !== 'scripts/layers/layers.json' &&
		f !== 'scripts/ci/select-forge-tests.test.ts', // its fixture repo's paths are made up, not ours
);
for (const f of mentionFiles) {
	if (!isFile(f)) continue;
	const src = read(f);
	if (!src.includes(OLD)) continue;
	const out = src.replace(/apps\/server\/src\/([\w./-]+?\.(?:ts|json))(?![\w])/g, (whole, path: string) => {
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
if (!dry) for (const [f, text] of changed) writeFileSync(join(ROOT, f), text);
