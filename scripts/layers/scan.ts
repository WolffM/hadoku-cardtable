/**
 * The ratchet's scan: every source file, its layer, the import edges between layers, and the
 * per-package licence check. Shared by `ratchet.test.ts` (which compares against `baseline.json`)
 * and `baseline.ts` (which regenerates it), so the two can never disagree on what counts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';

import { type Layer, type Resolver, REPO_ROOT, packageDirOf, packageLayerFor, packageNameOf, packageOf } from './classify.ts';
import { exportOf, hadokuSubpath } from './exports.ts';

// Every .ts/.tsx file git tracks under an app's or a package's src dir (`packages/*`, a game's
// `games/*/packages/*`, its `games/*/server` or its `games/*/ui`), repo-relative, /-joined.
export function listSourceFiles(): string[] {
	const out = execFileSync(
		'git',
		[
			'ls-files',
			'apps/*/src/*.ts',
			'apps/*/src/**/*.ts',
			'apps/*/src/*.tsx',
			'apps/*/src/**/*.tsx',
			'packages/*/src/*.ts',
			'packages/*/src/**/*.ts',
			'packages/*/src/*.tsx',
			'packages/*/src/**/*.tsx',
			'games/*/packages/*/src/*.ts',
			'games/*/packages/*/src/**/*.ts',
			'games/*/packages/*/src/*.tsx',
			'games/*/packages/*/src/**/*.tsx',
			'games/*/server/src/*.ts',
			'games/*/server/src/**/*.ts',
			'games/*/server/src/*.tsx',
			'games/*/server/src/**/*.tsx',
			'games/*/ui/src/*.ts',
			'games/*/ui/src/**/*.ts',
			'games/*/ui/src/*.tsx',
			'games/*/ui/src/**/*.tsx',
		],
		{ cwd: REPO_ROOT, encoding: 'utf8' },
	)
		.split('\n')
		.filter(Boolean);
	return [...new Set(out)].sort();
}

/** `*.test.ts(x)`, `*.jvm.test.ts` and `__tests__/**` — never classified, never counted (rule 4). */
export function isTestFile(relPath: string): boolean {
	return /\.test\.tsx?$/.test(relPath) || /(^|\/)__tests__\//.test(relPath);
}

export interface Edge {
	fromFile: string;
	fromLayer: Layer;
	toLayer: Layer;
	spec: string;
	line: number;
}

const ALLOWED: Record<Layer, readonly Layer[]> = {
	platform: ['platform'],
	magic: ['platform', 'magic', 'tangled'],
	tangled: ['platform', 'magic', 'tangled'],
	site: ['platform', 'magic', 'tangled', 'site'],
};

export function isViolation(fromLayer: Layer, toLayer: Layer): boolean {
	return !ALLOWED[fromLayer].includes(toLayer);
}

function lineOf(src: string, pos: number): number {
	let line = 1;
	for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
	return line;
}

/** A relative specifier's target file, resolved on disk (`.js` specifiers point at `.ts` source). */
function resolveRelative(fromAbsFile: string, spec: string): string | null {
	const dir = dirname(fromAbsFile);
	const raw = join(dir, spec);
	const candidates = /\.(ts|tsx)$/.test(raw)
		? [raw]
		: raw.endsWith('.js')
			? [raw.replace(/\.js$/, '.ts'), raw.replace(/\.js$/, '.tsx')]
			: [raw]; // .json, .css etc — not a layer edge
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}

/**
 * Every module a file names, with the offset of its specifier: `import`/`import type`, every
 * `export … from` (`export * as ns from` included, which `ts.preProcessFile` does not report),
 * `import x = require(…)`, and a dynamic `import(…)`/`require(…)` or `import('…')` type with a literal.
 */
export function moduleSpecifiers(relPath: string, src: string): { fileName: string; pos: number }[] {
	const file = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, /* setParentNodes */ false, relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const out: { fileName: string; pos: number }[] = [];
	const add = (node: ts.Node | undefined): void => {
		if (node !== undefined && ts.isStringLiteralLike(node)) out.push({ fileName: node.text, pos: node.getStart(file) });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
		else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
		else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length === 1) add(node.arguments[0]);
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return out;
}

/**
 * The repo-relative file an `@hadoku/<pkg>[/<sub>]` specifier names: the package's own `exports`
 * entry for that subpath (`@hadoku/shared/platform` is `packages/shared/src/platform.ts`, `@hadoku/shared`
 * its `.` barrel), or null when the package or the entry is not found.
 */
export function resolvePackageImport(spec: string, allFiles: string[]): string | null {
	const sub = hadokuSubpath(spec);
	if (sub === null) return null;
	const dir = packageDirsByName(allFiles).get(sub.pkg);
	if (dir === undefined) return null;
	const manifest = join(REPO_ROOT, dir, 'package.json');
	if (!existsSync(manifest)) return null;
	const target = exportOf((JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: Record<string, string> }).exports, sub.key);
	if (target === undefined) return null;
	const file = posix.join(dir, target);
	return existsSync(join(REPO_ROOT, file)) ? file : null;
}

const packageDirsCache = new WeakMap<string[], Map<string, string>>();
function packageDirsByName(allFiles: string[]): Map<string, string> {
	let dirs = packageDirsCache.get(allFiles);
	if (dirs === undefined) {
		dirs = new Map();
		for (const f of allFiles) {
			const dir = packageDirOf(f);
			if (dir !== null && !dirs.has(packageNameOf(dir))) dirs.set(packageNameOf(dir), dir);
		}
		packageDirsCache.set(allFiles, dirs);
	}
	return dirs;
}

/**
 * The layer an `@hadoku/*` import lands in: the layer of the file the package exports at that
 * subpath, so a platform file may import a mixed package's platform entry and not its Magic barrel.
 * A specifier no `exports` entry resolves falls back to the whole package's layer
 * (`packageLayerFor`), the stricter side for a package with any Magic file.
 */
export function packageImportLayer(spec: string, resolver: Resolver, allFiles: string[]): Layer | 'testSupport' | null {
	const file = resolvePackageImport(spec, allFiles);
	const layer = file === null ? null : resolver.layerOf(file);
	return layer ?? packageLayerFor(hadokuSubpath(spec)!.pkg, resolver, allFiles);
}

/**
 * Every import/re-export/dynamic-import edge out of the repo's non-test source files, whichever
 * direction it points. `@wolffm/*` and other external packages are skipped (rule: "not counted").
 */
export function collectEdges(resolver: Resolver, allFiles: string[]): Edge[] {
	const edges: Edge[] = [];
	for (const relPath of allFiles) {
		if (isTestFile(relPath)) continue;
		const fromLayer = resolver.layerOf(relPath);
		if (fromLayer === 'testSupport' || fromLayer === null) continue;
		const abs = join(REPO_ROOT, relPath);
		const src = readFileSync(abs, 'utf8');
		for (const imp of moduleSpecifiers(relPath, src)) {
			const spec = imp.fileName;
			let toLayer: Layer | 'testSupport' | null;
			if (spec.startsWith('.')) {
				if (!/\.(ts|tsx|js)$/.test(spec)) continue; // .css, .json, assets — not a layer edge
				const target = resolveRelative(abs, spec);
				if (!target || !/\.(ts|tsx)$/.test(target)) continue;
				const targetRel = posix.relative(REPO_ROOT.split('\\').join('/'), target.split('\\').join('/'));
				toLayer = resolver.layerOf(targetRel);
			} else if (hadokuSubpath(spec) !== null) {
				toLayer = packageImportLayer(spec, resolver, allFiles);
			} else {
				continue; // external: node builtins, @wolffm/*, npm deps — not counted
			}
			if (toLayer === 'testSupport' || toLayer === null) continue;
			edges.push({ fromFile: relPath, fromLayer, toLayer, spec, line: lineOf(src, imp.pos) });
		}
	}
	return edges;
}

export interface EdgeCounts {
	[pairKey: string]: number;
}

export function pairKey(from: Layer, to: Layer): string {
	return `${from}→${to}`;
}

export function countViolations(edges: Edge[]): EdgeCounts {
	const counts: EdgeCounts = {};
	for (const e of edges) {
		if (!isViolation(e.fromLayer, e.toLayer)) continue;
		const key = pairKey(e.fromLayer, e.toLayer);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/**
 * An edge's identity, stable across line-number churn elsewhere in the file (never includes
 * `line`): the importing file plus the specifier it wrote. Used to tell a genuinely NEW edge from
 * one the baseline already accepts, so a risen count's failure message names only what is new.
 */
export function edgeKey(e: Pick<Edge, 'fromFile' | 'spec'>): string {
	return `${e.fromFile}→${e.spec}`;
}

export interface EdgeKeysByPair {
	[pairKey: string]: string[];
}

/** Every violating edge's `edgeKey`, grouped and deduped by (from, to) pair, sorted for a stable diff. */
export function groupEdgeKeysByPair(edges: Edge[]): EdgeKeysByPair {
	const byPair = new Map<string, Set<string>>();
	for (const e of edges) {
		if (!isViolation(e.fromLayer, e.toLayer)) continue;
		const key = pairKey(e.fromLayer, e.toLayer);
		if (!byPair.has(key)) byPair.set(key, new Set());
		byPair.get(key)!.add(edgeKey(e));
	}
	const out: EdgeKeysByPair = {};
	for (const [pair, keys] of byPair) out[pair] = [...keys].sort();
	return out;
}

export interface CoverageResult {
	uncovered: string[]; // tracked files with no layer and not test-support
	stale: string[]; // map entries (tangled/testSupport exact files) that no longer exist
}

export interface TangledDisciplineResult {
	/** `layers.json`'s `tangled` entries that use a glob — rejected outright; it is an exact list. */
	globEntries: string[];
	/** `layers.json`'s `tangled` entries not in `baseline.json`'s snapshot — a file can never become
	 * newly tangled; a generic-mechanism-plus-Magic file goes to `platform`, `magic` or `site`. */
	newEntries: string[];
}

/** `tangled` is a closed, explicit, shrink-only list — never a glob, never grown. */
export function checkTangledDiscipline(
	currentTangled: string[],
	baselineTangled: string[],
): TangledDisciplineResult {
	const globEntries = currentTangled.filter((f) => f.includes('*'));
	const baselineSet = new Set(baselineTangled);
	const newEntries = currentTangled.filter((f) => !f.includes('*') && !baselineSet.has(f));
	return { globEntries, newEntries };
}

export function checkCoverage(resolver: Resolver, allFiles: string[]): CoverageResult {
	const trackedSet = new Set(allFiles);
	const uncovered: string[] = [];
	for (const relPath of allFiles) {
		if (isTestFile(relPath)) continue;
		if (resolver.layerOf(relPath) === null) uncovered.push(relPath);
	}
	const stale: string[] = [];
	for (const f of resolver.map.tangled) if (!trackedSet.has(f)) stale.push(f);
	for (const f of resolver.map.testSupport) {
		// testSupport entries may be globs (play/monkey/**); only flag exact-file entries gone missing.
		if (!f.includes('*') && !trackedSet.has(f)) stale.push(f);
	}
	return { uncovered, stale };
}

export interface LicenceMismatch {
	pkg: string;
	path: string;
	declared: string;
	expected: string;
}

/** `platform` iff every one of a package's classified files is `platform`; else GPL-3.0-or-later. */
export function expectedLicenceOf(pkgDir: string, resolver: Resolver, allFiles: string[]): string {
	return packageLayerFor(packageNameOf(pkgDir), resolver, allFiles) === 'platform' ? 'MIT' : 'GPL-3.0-or-later';
}

interface PackageLicenceRow {
	name: string;
	path: string;
	declared: string;
	expected: string;
}

function allPackageLicenceRows(resolver: Resolver, allFiles: string[]): PackageLicenceRow[] {
	const out = execFileSync('git', ['ls-files', 'apps/*/package.json', 'packages/*/package.json', 'games/*/packages/*/package.json', 'games/*/server/package.json', 'games/*/ui/package.json'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
	})
		.split('\n')
		.filter(Boolean);
	return out.map((relPath) => {
		const pkgDir = dirname(relPath); // e.g. apps/server, packages/shared, games/magic/packages/deck, games/magic/server or games/magic/ui
		const name = packageNameOf(pkgDir);
		const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
		return {
			name,
			path: relPath,
			declared: pkgJson.license ?? 'MISSING',
			expected: expectedLicenceOf(pkgDir, resolver, allFiles),
		};
	});
}

export function checkLicences(
	resolver: Resolver,
	allFiles: string[],
	pendingLicence: string[],
): LicenceMismatch[] {
	const mismatches: LicenceMismatch[] = [];
	for (const row of allPackageLicenceRows(resolver, allFiles)) {
		if (pendingLicence.includes(row.name)) continue;
		if (row.declared !== row.expected) {
			mismatches.push({ pkg: row.name, path: row.path, declared: row.declared, expected: row.expected });
		}
	}
	return mismatches;
}

export interface StalePendingLicence {
	pkg: string;
	path: string;
	declared: string;
}

/**
 * `pendingLicence` may only shrink. An entry is stale — and must be removed by hand, never
 * silently dropped by a test — once its package's declared licence already matches what the layer
 * map says it should be (the relicense that `pendingLicence` was waiting on has happened).
 */
export function checkStalePendingLicence(
	resolver: Resolver,
	allFiles: string[],
	pendingLicence: string[],
): StalePendingLicence[] {
	const rows = allPackageLicenceRows(resolver, allFiles);
	const stale: StalePendingLicence[] = [];
	for (const name of pendingLicence) {
		const row = rows.find((r) => r.name === name);
		if (row && row.declared === row.expected) stale.push({ pkg: name, path: row.path, declared: row.declared });
	}
	return stale;
}

export interface ProvenanceViolation {
	file: string;
	line: number;
}

/** No `platform` file carries a GPL header. */
export function checkProvenance(resolver: Resolver, allFiles: string[]): ProvenanceViolation[] {
	const violations: ProvenanceViolation[] = [];
	const gplPattern = /SPDX-License-Identifier:\s*GPL|GNU General Public License/;
	for (const relPath of allFiles) {
		if (isTestFile(relPath)) continue;
		if (resolver.layerOf(relPath) !== 'platform') continue;
		const src = readFileSync(join(REPO_ROOT, relPath), 'utf8');
		const m = gplPattern.exec(src);
		if (m) violations.push({ file: relPath, line: lineOf(src, m.index) });
	}
	return violations;
}

export { packageOf };
