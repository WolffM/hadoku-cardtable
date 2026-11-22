// Refuses a publish that would ship less than the version consumers have now:
//
//   node scripts/publish/shipped.ts packages/<name>
//
// CI only (.github/workflows/publish-kernel.yml), after the build. Every `dist/` path in npmjs's
// newest @hadoku/<name> must still be in the fresh dist/, or be named in the package.json's
// `publishRemoved` (paths under dist/, a trailing `/` for a directory): a removal is a decision a
// consumer has to hear about, never a side effect. @hadoku/game-ui 0.1.104 is why: a relative
// import into another package's src/ made build.ts leave out room/whoami.ts and five modules that
// import it, the publish stayed green, and hadoku-bomberman stopped building (bomberman#15).
//
// npmjs, not GitHub Packages: it is the registry the fleet installs from, and it needs no token.
// A package npmjs has never had passes: there is nothing to keep.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

const NPMJS = 'https://registry.npmjs.org';

/** The `dist/` paths `before` shipped that `after` lacks and `removed` does not name. */
export function lost(before: readonly string[], after: readonly string[], removed: readonly string[] = []): string[] {
	const now = new Set(after);
	return before.filter((p) => !now.has(p) && !removed.some((r) => (r.endsWith('/') ? p.startsWith(`dist/${r}`) : p === `dist/${r}`))).sort();
}

/** Every file under `dir`, as `dist/<path>`. */
function distFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => `dist/${relative(dir, join(e.parentPath, e.name))}`);
}

/** The newest npmjs version's `dist/` paths, or null when npmjs has none. */
function publishedDist(name: string): { version: string; files: string[] } | null {
	let version: string;
	try {
		version = execFileSync('npm', ['view', name, 'version', `--registry=${NPMJS}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (err) {
		if (/E404|404 Not Found/.test(String((err as { stderr?: unknown }).stderr ?? ''))) return null;
		throw err;
	}
	const tmp = mkdtempSync(join(tmpdir(), 'shipped-'));
	try {
		const out = execFileSync('npm', ['pack', `${name}@${version}`, `--registry=${NPMJS}`, '--pack-destination', tmp, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		const [packed] = JSON.parse(out) as { files: { path: string }[] }[];
		return { version, files: packed!.files.map((f) => f.path).filter((p) => p.startsWith('dist/')) };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (dir === undefined) {
		console.error('usage: node scripts/publish/shipped.ts packages/<name>');
		process.exit(2);
	}
	const pkg = JSON.parse(readFileSync(join(resolve(dir), 'package.json'), 'utf8')) as { publishRemoved?: string[] };
	const name = `@hadoku/${basename(resolve(dir))}`;
	const before = publishedDist(name);
	if (before === null) {
		console.log(`${name}: not on npmjs yet, nothing it shipped to keep`);
		process.exit(0);
	}
	const gone = lost(before.files, distFiles(join(resolve(dir), 'dist')), pkg.publishRemoved);
	if (gone.length === 0) {
		console.log(`${name}: every one of ${before.files.length} dist paths ${before.version} shipped is still here`);
		process.exit(0);
	}
	for (const p of gone) console.log(`::error title=${name} drops a shipped path::${p} was in ${name}@${before.version} and this build has no such file (build.ts's "left out" lines say why; a deliberate removal goes in publishRemoved)`);
	process.exit(1);
}
