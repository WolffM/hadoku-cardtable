/**
 * The layer map, read and resolved. `layers.json` holds four layers —
 * `platform` (MIT, imports platform only), `magic` (GPL, imports platform/magic/tangled),
 * `tangled` (GPL, today's generic-mechanism-plus-Magic debt, an explicit file list that may
 * only shrink) and `site` (GPL for now, the composition roots, may import anything) — plus a
 * `testSupport` list for files that hold test infrastructure under a non-test name and are
 * not classified into any layer.
 *
 * `platform`, `magic` and `site` are globs; the most specific match wins, where specificity is
 * the glob's literal (non-`*`) character count, so an exact file always beats a directory glob
 * that would otherwise also match it. `tangled` and `testSupport` are exact file lists, checked
 * before any glob, so a file on either never falls through to a glob guess.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Layer = 'platform' | 'magic' | 'tangled' | 'site';
export const LAYER_NAMES: readonly Layer[] = ['platform', 'magic', 'tangled', 'site'];

export interface LayersMap {
	platform: string[];
	magic: string[];
	site: string[];
	tangled: string[];
	testSupport: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const LAYERS_JSON_PATH = join(HERE, 'layers.json');
export const BASELINE_JSON_PATH = join(HERE, 'baseline.json');
export const REPO_ROOT = resolve(HERE, '../..');

export function loadLayers(path: string = LAYERS_JSON_PATH): LayersMap {
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	return {
		platform: raw.platform ?? [],
		magic: raw.magic ?? [],
		site: raw.site ?? [],
		tangled: raw.tangled ?? [],
		testSupport: raw.testSupport ?? [],
	};
}

/** A glob: `**` crosses path separators (zero or more segments), `*` stays inside one segment. */
const DOUBLESTAR_TOKEN = '@@DOUBLESTAR@@';

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.split('/')
		.map((seg) => {
			if (seg === '**') return DOUBLESTAR_TOKEN;
			return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
		})
		.join('/');
	const body = escaped
		.split(`${DOUBLESTAR_TOKEN}/`)
		.join('(?:.*/)?')
		.split(`/${DOUBLESTAR_TOKEN}`)
		.join('(?:/.*)?')
		.split(DOUBLESTAR_TOKEN)
		.join('.*');
	return new RegExp(`^${body}$`);
}

/** Literal (non-`*`) character count — the specificity score. A longer literal run wins. */
function specificity(glob: string): number {
	return glob.length - (glob.match(/\*/g)?.length ?? 0);
}

interface CompiledGlob {
	pattern: string;
	regexp: RegExp;
	score: number;
}

function compile(globs: string[]): CompiledGlob[] {
	return globs.map((pattern) => ({ pattern, regexp: globToRegExp(pattern), score: specificity(pattern) }));
}

export interface Resolver {
	/** `platform` | `magic` | `tangled` | `site` | `'testSupport'` | `null` (uncovered). */
	layerOf(relPath: string): Layer | 'testSupport' | null;
	/** Which glob pattern won, for error messages. `null` for tangled/testSupport/uncovered. */
	matchedPatternOf(relPath: string): string | null;
	readonly map: LayersMap;
}

export function buildResolver(map: LayersMap): Resolver {
	const tangledSet = new Set(map.tangled);
	const testSupportCompiled = compile(map.testSupport);
	const globLayers: { layer: Layer; globs: CompiledGlob[] }[] = [
		{ layer: 'platform', globs: compile(map.platform) },
		{ layer: 'magic', globs: compile(map.magic) },
		{ layer: 'site', globs: compile(map.site) },
	];

	function bestGlobMatch(relPath: string): { layer: Layer; pattern: string } | null {
		let best: { layer: Layer; pattern: string; score: number } | null = null;
		for (const { layer, globs } of globLayers) {
			for (const g of globs) {
				if (g.regexp.test(relPath) && (best === null || g.score > best.score)) {
					best = { layer, pattern: g.pattern, score: g.score };
				}
			}
		}
		return best ? { layer: best.layer, pattern: best.pattern } : null;
	}

	return {
		map,
		layerOf(relPath) {
			if (tangledSet.has(relPath)) return 'tangled';
			if (testSupportCompiled.some((g) => g.regexp.test(relPath))) return 'testSupport';
			return bestGlobMatch(relPath)?.layer ?? null;
		},
		matchedPatternOf(relPath) {
			if (tangledSet.has(relPath) || testSupportCompiled.some((g) => g.regexp.test(relPath))) return null;
			return bestGlobMatch(relPath)?.pattern ?? null;
		},
	};
}

/** A workspace package's directory: `apps/<x>`, `packages/<x>`, `games/<game>/packages/<x>` or `games/<game>/server`. */
const PACKAGE_DIR = /^(?:apps\/[^/]+|packages\/[^/]+|games\/[^/]+\/packages\/[^/]+|games\/[^/]+\/server)(?=\/)/;

const packageNames = new Map<string, string>();

/**
 * The package a directory holds, as an `@hadoku/<name>` specifier names it: its `package.json` name
 * without the scope, never the directory's basename (`apps/server` is `server`, `games/magic/server`
 * is `magic-server`).
 */
export function packageNameOf(pkgDir: string): string {
	let name = packageNames.get(pkgDir);
	if (name === undefined) {
		const manifest = join(REPO_ROOT, pkgDir, 'package.json');
		const declared = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name : undefined;
		name = declared?.replace(/^@hadoku\//, '') ?? basename(pkgDir);
		packageNames.set(pkgDir, name);
	}
	return name;
}

/** The directory of the workspace package a source path belongs to (`packages/shared`), or `null` outside them. */
export function packageDirOf(relPath: string): string | null {
	return PACKAGE_DIR.exec(relPath)?.[0] ?? null;
}

/** The name of the workspace package a source path belongs to (see `packageNameOf`), or `null` outside them. */
export function packageOf(relPath: string): string | null {
	const dir = packageDirOf(relPath);
	return dir === null ? null : packageNameOf(dir);
}

/**
 * A package's layer for resolving an `@hadoku/<pkg>` specifier: `platform` only if every one of
 * its OWN classified (non-test, non-test-support) files is `platform`; otherwise `magic` — the
 * same "all platform or it carries GPL content" split the licence check makes. `tangled` and
 * `site` are never a whole package's layer.
 */
export function packageLayerFor(
	pkgName: string,
	resolver: Resolver,
	allFiles: string[],
): 'platform' | 'magic' {
	const files = allFiles.filter((f) => packageOf(f) === pkgName);
	if (files.length === 0) return 'magic'; // unknown package: assume the stricter side
	for (const f of files) {
		const layer = resolver.layerOf(f);
		if (layer === 'testSupport' || layer === null) continue;
		if (layer !== 'platform') return 'magic';
	}
	return 'platform';
}

export function toRepoRelative(absPath: string): string {
	return relative(REPO_ROOT, absPath).split('\\').join('/');
}
