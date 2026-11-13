/*
 * Adapter: cardtable's binding of `@hadoku/service-kernel/lifecycle`'s release announce (w93-K2).
 *
 * Prod posts its release's patch notes to the Discord server's #announcements at boot, through
 * ArchiveBot's signed `/api/messages/send` (contract: docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md).
 * Prod only, by `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`: PPE's wrapper deliberately does not hold it,
 * and an unset secret is a skip, not an error.
 *
 * The cardtable-specific bits are the service id (`cardtable`, which names the idempotency keys and
 * the `source` field), the ordering of release files, which the kernel cannot read itself — it is
 * `scripts/release/build-version.ts`'s `newestReleaseFile`/`releaseFilesNewestFirst`, injected here —
 * and the earlier-credits file, `docs/releases/before-releases.md` (docs/RELEASE.md § "Attribution").
 */
import { join } from 'node:path';
import { newestReleaseFile, releaseFilesNewestFirst } from '../../../scripts/release/build-version.js';
import {
	allReleases as kernelAllReleases,
	announceRelease as kernelAnnounceRelease,
	creditsBody,
	creditsIn,
	forDiscord,
	latestRelease as kernelLatestRelease,
	parseNotes,
	releaseEmbeds,
	splitBody,
	type AnnounceOptions as KernelAnnounceOptions,
	type Embed,
	type ReleaseNotes,
	type ReleaseOrdering,
} from '@hadoku/service-kernel/lifecycle';

export { creditsBody, creditsIn, forDiscord, parseNotes, releaseEmbeds, splitBody, type Embed, type ReleaseNotes };

const SERVICE = 'cardtable';
const SECRET_ENV_NAME = 'ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET';
const ORDERING: ReleaseOrdering = { newest: newestReleaseFile, newestFirst: releaseFilesNewestFirst };

/** People credited before there were release notes, as `@name`s, in the releases directory. */
export const EARLIER_CREDITS_FILE = 'before-releases.md';

export type AnnounceOptions = Omit<KernelAnnounceOptions, 'service' | 'ordering' | 'secretEnvName' | 'earlierCreditsFile'>;

/** The newest release notes in `dir`, by semver, or null when there are none. */
export async function latestRelease(dir: string): Promise<ReleaseNotes | null> {
	return kernelLatestRelease(dir, ORDERING);
}

/** Every release's notes in `dir`, newest first. */
export async function allReleases(dir: string): Promise<ReleaseNotes[]> {
	return kernelAllReleases(dir, ORDERING);
}

/** cardtable's release announce: service `cardtable`, `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`. */
export async function announceRelease(options: AnnounceOptions): Promise<void> {
	return kernelAnnounceRelease({
		...options,
		service: SERVICE,
		ordering: ORDERING,
		secretEnvName: SECRET_ENV_NAME,
		earlierCreditsFile: join(options.releasesDir, EARLIER_CREDITS_FILE),
	});
}
