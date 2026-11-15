// The published build of one platform package (`.github/workflows/publish-kernel.yml`):
//
//   node scripts/publish/build.ts packages/<name>
//
// tsc emits dist/ from the package's src/, with the package's own tsconfig.json as the base (so a
// UI package keeps its JSX and DOM settings) and every relative `.ts`/`.tsx` import rewritten to
// `.js`. Inside this workspace nothing reads dist/: consumers import src/ directly.
//
// What is left out, and printed, so the published file list is a decision you can read in the log:
//   - tests and test support: `*.test.*`, `*.testing.*`, anything importing vitest or
//     @testing-library, and anything under a `fixtures/` directory;
//   - a file whose relative imports leave the package (it would point at a path no tarball has),
//     and every file that imports one of those, transitively;
//   - a file under one of the package.json's `publishLeaveOut` paths (relative to src/, a
//     trailing `/` for a directory): this repo's own code that a published package does not carry,
//     such as game-server's Forge hosting. Its importers go too, as above. The workflow writes the
//     published manifest before it builds, so manifest.ts keeps this field for the build to read.
//
// After tsc: declarations get the same `.ts` → `.js` rewrite the JavaScript already has (TypeScript
// leaves .d.ts specifiers alone, and a consumer resolving `./x.ts` from one finds nothing); every
// import of a sibling this repo publishes is renamed from its workspace name to its published one
// (`@hadoku/platform-wire` → `@wolffm/platform-wire`, `manifest.ts`); and the non-TypeScript files
// the kept sources import (CSS, JSON) are copied beside their JavaScript.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import { publishedName } from './manifest.ts';

const TEST_FILE = /\.(test|testing)\.tsx?$|(^|\/)fixtures\//;
const TEST_IMPORT = /from\s+['"](vitest|@testing-library\/[^'"]+)['"]/;
const SOURCE = /\.tsx?$/;
// Static, dynamic and side-effect imports, and `export … from`: the specifier only.
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

export interface Plan {
	/** Sources tsc compiles, relative to src/. */
	keep: string[];
	/** Sources left out, relative to src/, with the reason. */
	dropped: { file: string; why: string }[];
	/** Non-TypeScript files the kept sources import, relative to src/. */
	assets: string[];
}

/** Every relative specifier `text` imports. */
export function relativeImports(text: string): string[] {
	return [...text.matchAll(SPECIFIER)].map((m) => m[1]!).filter((s) => s.startsWith('.'));
}

/** Which of `src`'s files ship, decided from their own text and the package's `leaveOut` paths. */
export function plan(src: string, leaveOut: readonly string[] = []): Plan {
	const all = readdirSync(src, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => relative(src, join(e.parentPath, e.name)))
		.sort();
	const sources = all.filter((f) => SOURCE.test(f) && !f.endsWith('.d.ts'));
	const dropped = new Map<string, string>();
	const imports = new Map<string, string[]>();
	for (const file of sources) {
		const text = readFileSync(join(src, file), 'utf8');
		const left = leaveOut.find((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
		if (left !== undefined) dropped.set(file, `under publishLeaveOut ${left}`);
		else if (TEST_FILE.test(file)) dropped.set(file, 'test or test support');
		else if (TEST_IMPORT.test(text)) dropped.set(file, 'imports a test library');
		// nodenext source names the `.js` tsc will emit; the file it means is the `.ts`/`.tsx` beside it.
		const targets = relativeImports(text).map((s) => {
			const target = relative(src, resolve(src, dirname(file), s));
			const stem = target.replace(/\.js$/, '');
			return target === stem ? target : (['.ts', '.tsx'].map((x) => stem + x).find((t) => all.includes(t)) ?? target);
		});
		const outside = targets.find((t) => t.startsWith('..'));
		if (outside !== undefined && !dropped.has(file)) dropped.set(file, `imports ${outside}, outside the package`);
		imports.set(file, targets);
	}
	// A file that imports a dropped one is dropped too, until nothing changes.
	for (let grew = true; grew; ) {
		grew = false;
		for (const file of sources) {
			if (dropped.has(file)) continue;
			const via = imports.get(file)!.find((t) => dropped.has(t));
			if (via === undefined) continue;
			dropped.set(file, `imports ${via}, which is left out`);
			grew = true;
		}
	}
	const keep = sources.filter((f) => !dropped.has(f));
	const assets = [...new Set(keep.flatMap((f) => imports.get(f)!).filter((t) => !SOURCE.test(t) && all.includes(t)))].sort();
	return { keep, dropped: [...dropped].map(([file, why]) => ({ file, why })), assets };
}

/** A declaration file's relative `.ts`/`.tsx` specifiers, pointed at the `.js` tsc emitted beside it. */
export function repointDeclaration(text: string): string {
	return text.replace(/((?:\bfrom\s+|\bimport\s*\(\s*)(['"])\.{1,2}\/[^'"]*?)\.tsx?\2/g, '$1.js$2');
}

/** Each import of a sibling this repo publishes, under the name it is published as. */
export function renameSiblings(text: string): string {
	return text.replace(/((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"]))(@hadoku\/[^/'"]+)/g, (whole, head: string, _q: string, pkg: string) => {
		const published = publishedName(pkg);
		return published === null ? whole : head + published;
	});
}

export function build(pkgDir: string): Plan & { repointed: number; renamed: number } {
	const root = resolve(pkgDir);
	const src = join(root, 'src');
	const dist = join(root, 'dist');
	const leaveOut = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { publishLeaveOut?: string[] }).publishLeaveOut ?? [];
	const p = plan(src, leaveOut);
	rmSync(dist, { recursive: true, force: true });

	const tsconfig = join(root, 'tsconfig.publish.json');
	writeFileSync(
		tsconfig,
		JSON.stringify({
			extends: './tsconfig.json',
			compilerOptions: {
				noEmit: false,
				declaration: true,
				sourceMap: false,
				rewriteRelativeImportExtensions: true,
				rootDir: 'src',
				outDir: 'dist',
			},
			include: [],
			files: p.keep.map((f) => `src/${f}`),
		}),
	);
	try {
		// Resolved, not looked up on PATH: CI runs this with node directly.
		const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
		execFileSync(process.execPath, [tsc, '-p', tsconfig], { stdio: 'inherit' });
	} finally {
		rmSync(tsconfig);
	}

	let repointed = 0;
	let renamed = 0;
	for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.(d\.ts|js)$/.test(entry.name)) continue;
		const file = join(entry.parentPath, entry.name);
		const text = readFileSync(file, 'utf8');
		const pointed = entry.name.endsWith('.d.ts') ? repointDeclaration(text) : text;
		const out = renameSiblings(pointed);
		if (pointed !== text) repointed++;
		if (out !== pointed) renamed++;
		if (out !== text) writeFileSync(file, out);
	}
	for (const asset of p.assets) {
		mkdirSync(dirname(join(dist, asset)), { recursive: true });
		copyFileSync(join(src, asset), join(dist, asset));
	}
	return { ...p, repointed, renamed };
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (dir === undefined || !existsSync(join(dir, 'src'))) {
		console.error('usage: node scripts/publish/build.ts packages/<name>');
		process.exit(2);
	}
	const p = build(dir);
	const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string }).name;
	console.log(`${name}: built dist/ from ${p.keep.length} sources, ${p.repointed} declarations re-pointed at .js, ${p.renamed} files' sibling imports renamed, ${p.assets.length} assets copied`);
	for (const { file, why } of p.dropped.filter((d) => !/test/.test(d.why))) console.log(`  left out src/${file}: ${why}`);
}
