/*
 * Adapter: cardtable's binding of `@hadoku/service-kernel/lifecycle`'s release announce (w93-K2).
 *
 * Prod posts its release's patch notes to the Discord server's #announcements at boot, through
 * ArchiveBot's signed `/api/messages/send` (contract: docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md).
 * Prod only, by `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`: PPE's wrapper deliberately does not hold it,
 * and an unset secret is a skip, not an error.
 *
 * Every export and signature here is unchanged from before this moved into the kernel: `index.ts`
 * and `announce.test.ts` import this path exactly as they did. The two cardtable-specific bits are
 * the service id (`cardtable`, which names the idempotency key and the `source` field) and the
 * ordering of release files, which the kernel cannot read itself — it is
 * `scripts/release/build-version.ts`'s `newestReleaseFile`/`releaseFilesNewestFirst`, injected here.
 */
import { newestReleaseFile, releaseFilesNewestFirst } from '../../../scripts/release/build-version.js';
import {
	announceRelease as kernelAnnounceRelease,
	EDITABLE_RELEASES,
	forDiscord,
	latestRelease as kernelLatestRelease,
	mentionsIn,
	parseNotes,
	recentReleases as kernelRecentReleases,
	releaseEmbeds,
	splitBody,
	type AnnounceOptions as KernelAnnounceOptions,
	type Embed,
	type ReleaseNotes,
	type ReleaseOrdering,
} from '@hadoku/service-kernel/lifecycle';

export { EDITABLE_RELEASES, forDiscord, mentionsIn, parseNotes, releaseEmbeds, splitBody, type Embed, type ReleaseNotes };

const SERVICE = 'cardtable';
const SECRET_ENV_NAME = 'ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET';
const ORDERING: ReleaseOrdering = { newest: newestReleaseFile, newestFirst: releaseFilesNewestFirst };

export type AnnounceOptions = Omit<KernelAnnounceOptions, 'service' | 'ordering' | 'secretEnvName'>;

/** The newest release notes in `dir`, by semver, or null when there are none. */
export async function latestRelease(dir: string): Promise<ReleaseNotes | null> {
	return kernelLatestRelease(dir, ORDERING);
}

/** The newest `count` release notes in `dir`, newest first. */
export async function recentReleases(dir: string, count = EDITABLE_RELEASES): Promise<ReleaseNotes[]> {
	return kernelRecentReleases(dir, ORDERING, count);
}

/** cardtable's release announce: service `cardtable`, `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`. */
export async function announceRelease(options: AnnounceOptions): Promise<void> {
	return kernelAnnounceRelease({ ...options, service: SERVICE, ordering: ORDERING, secretEnvName: SECRET_ENV_NAME });
}
