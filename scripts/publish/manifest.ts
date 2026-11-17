// Turns one platform package's workspace manifest into the one the registry gets:
//
//   node scripts/publish/manifest.ts packages/<name>
//
// CI only (.github/workflows/publish-kernel.yml), in the runner's checkout, never committed back,
// the same contract as the version, which is CI's too.
//
// In the workspace a package is @hadoku/<name>, exports src/ (Node strips the types inside
// cardtable's own server; Vite serves the UI's), takes @wolffm/* through npmjs aliases because
// cardtable installs without a GitHub token, and takes its platform siblings as `workspace:*`.
// On GitHub Packages it is @wolffm/<name> like every fleet package, exports the dist/ that
// `build.ts` made, and names its siblings at the exact versions this run published them as
// (they publish together, in PUBLISHED's order). hadoku-actions/publish-npmjs renames it back to
// @hadoku/* for npmjs and turns its @wolffm/* dependencies into aliases again.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Every package this repo publishes, a package after everything it depends on: each run publishes
 * them in this order, so a sibling's version is on the registry before a dependent asks for it.
 * The workflow's matrix lists the same names in the same order (a test holds the two together).
 */
export const PUBLISHED = ['platform-wire', 'host-wire', 'room-ask', 'service-kernel', 'ui-shell', 'game-server', 'game-ui'] as const;

type Deps = Record<string, string>;
type Target = string | { types: string; import: string };
export interface Manifest {
	name: string;
	private?: boolean;
	exports: Record<string, Target>;
	dependencies?: Deps;
	peerDependencies?: Deps;
	devDependencies?: Deps;
	[field: string]: unknown;
}

/** The published name of a workspace package this repo publishes, or null for any other. */
export function publishedName(workspaceName: string): string | null {
	const m = /^@hadoku\/(.+)$/.exec(workspaceName);
	return m !== null && (PUBLISHED as readonly string[]).includes(m[1]!) ? `@wolffm/${m[1]}` : null;
}

/** `./src/<p>.ts` → its dist pair. A wildcard source maps to a wildcard pair. */
function distPair(stem: string): { types: string; import: string } {
	return { types: `./dist/${stem}.d.ts`, import: `./dist/${stem}.js` };
}

/**
 * The published exports. Three workspace shapes:
 *   `"./x": "./src/x.ts"`  → `"./x": { types, import }` from dist;
 *   `"./*": "./src/*.ts"`  → the same, as a pattern (`@wolffm/game-server/room/lobby`);
 *   `"./*": "./src/*"`     → the specifier carries its extension (`@wolffm/game-ui/http.ts`), so
 *                            `./*.ts` and `./*.tsx` map to dist's JavaScript and `./*.css` to the
 *                            copied stylesheet: the same specifier works in and out of the workspace.
 */
export function publishedExports(name: string, exports: Record<string, Target>): Record<string, Target> {
	const out: Record<string, Target> = {};
	for (const [sub, target] of Object.entries(exports)) {
		if (typeof target !== 'string') throw new Error(`${name}: export ${sub} is not a source path`);
		// `.tsx` too, not only `.ts` (wave s3 §G.5: game-ui's extensionless `./front/RoomFront` and
		// its siblings are React components) — `build.ts` compiles either extension to the same
		// `dist/<stem>.js` + `.d.ts` pair, so one dist shape serves both.
		const ts = /^\.\/src\/(.+)\.tsx?$/.exec(target);
		if (ts !== null) {
			out[sub] = distPair(ts[1]!);
			continue;
		}
		if (sub === './*' && target === './src/*') {
			out['./*.ts'] = distPair('*');
			out['./*.tsx'] = distPair('*');
			out['./*.css'] = './dist/*.css';
			continue;
		}
		throw new Error(`${name}: export ${sub} is not ./src/<path>.ts`);
	}
	return out;
}

/**
 * @param versionOf the version this run published a sibling at (`@wolffm/<name>` → `x.y.z`)
 */
export function publishManifest(src: Manifest, versionOf: (published: string) => string): Manifest {
	const name = publishedName(src.name);
	if (name === null) throw new Error(`${src.name} is not a package this repo publishes`);
	const pkg: Manifest = structuredClone(src);
	pkg.name = name;
	delete pkg.private;
	// A consumer installs none of them, and a workspace: one names a package no registry has.
	delete pkg.devDependencies;
	pkg.exports = publishedExports(name, src.exports);
	pkg.files = ['dist', 'LICENSE'];

	for (const field of ['dependencies', 'peerDependencies'] as const) {
		const deps = pkg[field];
		if (deps === undefined) continue;
		const out: Deps = {};
		for (const [dep, spec] of Object.entries(deps)) {
			// A sibling: under its published name, at the exact version this run gave it.
			if (spec.startsWith('workspace:')) {
				const sibling = publishedName(dep);
				if (sibling === null) throw new Error(`${name}: ${field} ${dep} is a workspace package this repo does not publish`);
				out[sibling] = versionOf(sibling);
				continue;
			}
			// `npm:@hadoku/<x>@<v>` → `^<v>` under the @wolffm name the key already has. A caret, so
			// a consumer on a newer patch of the same minor shares one copy.
			const m = /^npm:@hadoku\/([^@]+)@(.+)$/.exec(spec);
			if (m !== null) {
				if (`@wolffm/${m[1]}` !== dep) throw new Error(`${name}: ${dep} aliases @hadoku/${m[1]}`);
				out[dep] = /^\d/.test(m[2]!) ? `^${m[2]}` : m[2]!;
				continue;
			}
			// An exact peer (`react: 19.2.8`, the workspace's own pin) as a floor within its major:
			// a consumer on any 19.x satisfies it, rather than every app pinning our patch.
			out[dep] = field === 'peerDependencies' && /^\d+\.\d+\.\d+$/.test(spec) ? `^${spec}` : spec;
		}
		pkg[field] = out;
	}

	pkg.repository = {
		type: 'git',
		url: 'https://github.com/WolffM/hadoku-cardtable.git',
		directory: `packages/${basename(name)}`,
	};
	pkg.publishConfig = { registry: 'https://npm.pkg.github.com', access: 'public' };
	return pkg;
}

/** The newest version the registry has of `published`. A sibling this run has not published yet fails. */
function registryVersion(published: string): string {
	try {
		return execFileSync('npm', ['view', published, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (err) {
		throw new Error(`${published} is not on the registry yet; publish it first (PUBLISHED's order)`, { cause: err });
	}
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (dir === undefined) {
		console.error('usage: node scripts/publish/manifest.ts packages/<name>');
		process.exit(2);
	}
	const file = join(resolve(dir), 'package.json');
	const pkg = publishManifest(JSON.parse(readFileSync(file, 'utf8')) as Manifest, registryVersion);
	writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
	const siblings = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((d) => publishedName(d.replace('@wolffm/', '@hadoku/')) !== null);
	console.log(`${basename(dir)}: manifest is ${pkg.name}, ${Object.keys(pkg.exports).length} exports from dist/${siblings.length > 0 ? `, siblings ${siblings.map((d) => `${d}@${pkg.dependencies?.[d] ?? pkg.peerDependencies?.[d]}`).join(' ')}` : ''}`);
}
