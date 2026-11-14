/**
 * The credits post as the next release would make it, for /cutrelease's attribution step.
 *
 *   node scripts/release/credits.ts [<draft notes file>...]    # cardtable's entry point
 *
 * Reads every `vX.Y.Z.md` in the config's `releases.dir`, plus any draft notes files named (the
 * release being cut, before it lands), and that dir's `before-releases.md`. Prints the credits
 * post's text exactly as prod will post it under the new notes (cardtable's docs/RELEASE.md §
 * "Attribution"). Its names are the ones the operator has used so far, to pick from when crediting
 * a new bullet. It writes nothing.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { allReleases, creditsBody, creditsIn, parseNotes } from '../../../service-kernel/src/lifecycle/announce.ts';
import { findRoot, loadConfig } from '../config.ts';
import { releaseFilesNewestFirst } from './build-version.ts';

export async function main(argv: string[], root: string): Promise<void> {
	const releases = loadConfig(root).releases.dir;
	const ordering = { newestFirst: releaseFilesNewestFirst, newest: (names: readonly string[]) => releaseFilesNewestFirst(names)[0] ?? null };
	const released = await allReleases(releases, ordering);
	const drafts = await Promise.all(argv.map(async (file) => parseNotes(basename(file, '.md'), await readFile(file, 'utf8'))));
	const earlier = creditsIn(await readFile(join(releases, 'before-releases.md'), 'utf8'));
	console.log(creditsBody([...drafts, ...released.filter((r) => !drafts.some((d) => d.version === r.version))], earlier) ?? '(nobody is credited yet: no credits post)');
}

if (import.meta.main) await main(process.argv.slice(2), findRoot());
