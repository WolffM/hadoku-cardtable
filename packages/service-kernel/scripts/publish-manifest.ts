// Turns this workspace package's manifest into the one the registry gets.
// CI only (.github/workflows/publish-kernel.yml), in the runner's checkout,
// never committed back — the same contract as the version, which is CI's too.
//
// In the workspace the package is @hadoku/service-kernel, exports src/*.ts
// (Node strips the types inside cardtable's own server) and takes
// @wolffm/rooms-* through npmjs aliases, because cardtable installs without a
// GitHub token. On GitHub Packages it is @wolffm/service-kernel like every
// fleet package; hadoku-actions/publish-npmjs renames it back to @hadoku/* for
// npmjs and turns its @wolffm/* dependencies into aliases again.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Deps = Record<string, string>;
export interface Manifest {
	name: string;
	private?: boolean;
	exports: Record<string, string | { types: string; import: string }>;
	dependencies?: Deps;
	peerDependencies?: Deps;
	[field: string]: unknown;
}

export function publishManifest(src: Manifest): Manifest {
	const pkg: Manifest = structuredClone(src);
	pkg.name = '@wolffm/service-kernel';
	delete pkg.private;

	const exports: Manifest['exports'] = {};
	for (const [sub, target] of Object.entries(src.exports)) {
		const m = typeof target === 'string' ? /^\.\/src\/(.+)\.ts$/.exec(target) : null;
		if (!m) throw new Error(`service-kernel: export ${sub} is not ./src/<path>.ts`);
		exports[sub] = { types: `./dist/${m[1]}.d.ts`, import: `./dist/${m[1]}.js` };
	}
	pkg.exports = exports;
	pkg.files = ['dist', 'LICENSE'];

	// `npm:@hadoku/<x>@<v>` → `^<v>` under the @wolffm name the key already has.
	// A caret, so a consumer on a newer patch of the same minor shares one copy.
	for (const deps of [pkg.dependencies, pkg.peerDependencies]) {
		for (const [dep, spec] of Object.entries(deps ?? {})) {
			const m = /^npm:@hadoku\/([^@]+)@(.+)$/.exec(spec);
			if (!m) continue;
			if (`@wolffm/${m[1]}` !== dep) throw new Error(`service-kernel: ${dep} aliases @hadoku/${m[1]}`);
			deps![dep] = /^\d/.test(m[2]) ? `^${m[2]}` : m[2];
		}
	}

	pkg.repository = {
		type: 'git',
		url: 'https://github.com/WolffM/hadoku-cardtable.git',
		directory: 'packages/service-kernel',
	};
	pkg.publishConfig = { registry: 'https://npm.pkg.github.com', access: 'public' };
	return pkg;
}

if (import.meta.main) {
	const file = join(import.meta.dirname, '..', 'package.json');
	const pkg = publishManifest(JSON.parse(readFileSync(file, 'utf8')) as Manifest);
	writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
	console.log(`service-kernel: manifest is ${pkg.name}, ${Object.keys(pkg.exports).length} exports from dist/`);
}
