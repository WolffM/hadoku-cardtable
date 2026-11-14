/**
 * The version a build of this tree carries. Nothing commits a version: no land bumps a
 * package.json, and the per-package `version` fields are inert.
 *
 *   node scripts/release/print-build-version.ts    # cardtable's: prints e.g. v0.45.0+1a2b3c4d5
 *
 * `<envPrefix>_VERSION` (cardtable: `CARDTABLE_VERSION`), when set, is used as it stands, so a CI
 * job or a deploy can name the build. Otherwise it is the newest release whose notes are in the
 * tree (`<releases.dir>/vX.Y.Z.md`; cardtable: `docs/releases/`),
 * plus the commit: a released sha builds as that release (release.yml refuses a sha without its
 * notes), and PPE, which runs main past it, says which release it builds on and exactly which
 * commit. The commit is what tells a stale tab from a regression; the release is what a person
 * reads. Cardtable's apps/ui/build-defines.ts embeds it as `__HADOKU_UI_VERSION__`; its
 * apps/server build writes it to `dist/version.txt` for the recordings' `server` field.
 *
 * It reads those two fields from devkit.config.json itself, as plain JSON: the server bundles
 * this module (announce.ts), and the schema (config.ts) stays out of that bundle.
 *
 * Throws when it cannot read the commit: a build that cannot say what it is fails rather than
 * shipping a label that lies. Nothing runs at import: the server bundles this module (announce.ts).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE_FILE = /^v(\d+)\.(\d+)\.(\d+)\.md$/;

/** The `vX.Y.Z.md` file names, newest first by semver (the name itself). */
export function releaseFilesNewestFirst(names: readonly string[]): string[] {
	const parsed = names.flatMap((name) => {
		const m = RELEASE_FILE.exec(name);
		return m === null ? [] : [{ name, parts: [Number(m[1]), Number(m[2]), Number(m[3])] }];
	});
	parsed.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
	return parsed.map((p) => p.name);
}

/** The newest `vX.Y.Z.md` among file names, by semver (the name itself); null when there is none. */
export function newestReleaseFile(names: readonly string[]): string | null {
	return releaseFilesNewestFirst(names)[0] ?? null;
}

/** The two fields a build version needs, from `<repoRoot>/devkit.config.json`. */
export function versionSource(repoRoot: string): { releasesDir: string; versionEnv: string } {
	const file = join(repoRoot, 'devkit.config.json');
	const c = JSON.parse(readFileSync(file, 'utf8')) as { envPrefix?: unknown; releases?: { dir?: unknown } };
	if (typeof c.envPrefix !== 'string' || typeof c.releases?.dir !== 'string') {
		throw new Error(`build-version: ${file} needs "envPrefix" and "releases.dir" (node packages/devkit/src/config.ts check says what else is wrong)`);
	}
	return { releasesDir: join(repoRoot, c.releases.dir), versionEnv: `${c.envPrefix}_VERSION` };
}

export function buildVersion(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	const { releasesDir, versionEnv } = versionSource(repoRoot);
	const named = env[versionEnv]?.trim();
	if (named) return named;
	const release = newestReleaseFile(readdirSync(releasesDir))?.slice(0, -'.md'.length) ?? 'v0.0.0';
	const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim();
	return `${release}+${sha}`;
}
