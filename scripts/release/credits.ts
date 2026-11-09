/**
 * The credits post as the next release would make it, for /cutrelease's attribution step.
 *
 *   node scripts/release/credits.ts [<draft notes file>...]
 *
 * Reads every `docs/releases/vX.Y.Z.md`, plus any draft notes files named (the release being cut,
 * before it lands), and `docs/releases/before-releases.md`. Prints the credits post's text exactly
 * as prod will post it under the new notes (docs/RELEASE.md § "Attribution"). Its names are the
 * ones the operator has used so far, to pick from when crediting a new bullet. It writes nothing.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { allReleases, creditsBody, creditsIn, parseNotes } from '../../packages/service-kernel/src/lifecycle/announce.ts';
import { releaseFilesNewestFirst } from './build-version.ts';

const RELEASES = 'docs/releases';

const ordering = { newestFirst: releaseFilesNewestFirst, newest: (names: readonly string[]) => releaseFilesNewestFirst(names)[0] ?? null };
const released = await allReleases(RELEASES, ordering);
const drafts = await Promise.all(process.argv.slice(2).map(async (file) => parseNotes(basename(file, '.md'), await readFile(file, 'utf8'))));
const earlier = creditsIn(await readFile(join(RELEASES, 'before-releases.md'), 'utf8'));
console.log(creditsBody([...drafts, ...released.filter((r) => !drafts.some((d) => d.version === r.version))], earlier) ?? '(nobody is credited yet: no credits post)');
