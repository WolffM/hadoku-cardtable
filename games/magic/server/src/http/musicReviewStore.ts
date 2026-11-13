/**
 * Where a person's match-music review lives: their own prefs-api row, app `cardtable-music-review`
 * (hadoku_site IDENTITY_MODEL R12, cardtable#25). A record that belongs to one person is that person's
 * data, so deleting their account (prefs-api `_account/erase`) erases it with everything else of theirs,
 * and cardtable keeps no copy.
 *
 * The server writes the row rather than the browser, so a submission is still checked against what each
 * slot offers (`musicReviewProblems`) and still needs friend tier, while the row is named by the
 * submitter's OWN live key: `writeFor` has prefs-api resolve whose row it is, and a retired key writes
 * nothing. Reads go by userId with this server's service key, on the `prefs-cardtable` allow list.
 */

import { createServicePrefsClient } from '@wolffm/prefs-client/service';

import { MUSIC_REVIEW_APP_ID, MusicReviewRecordSchema, type MusicReviewList, type MusicReviewRecord } from '@hadoku/shared';

export interface MusicReviewStore {
	/** The person's review, or null when they have none. */
	mine(userId: string): Promise<MusicReviewRecord | null>;
	/** Replace the person's review with this one; `userKey` is their own live key, from this request. */
	save(userKey: string, record: MusicReviewRecord): Promise<void>;
	/** Every person's review. */
	all(): Promise<MusicReviewList['reviews']>;
}

export interface MusicReviewStoreOptions {
	/** The prefs mount, without `/api/v1` (`CONFIG.prefsBaseUrl`). */
	baseUrl: string;
	/** This server's service key (`CARDTABLE_SERVICE_KEY`). */
	serviceKey: string;
	fetch?: typeof fetch;
	/** A row whose blob does not parse is skipped, and said here. */
	onBadRow(userId: string): void;
}

/** The fields a review replaces. `writeFor` merges shallowly, so naming both replaces the whole review. */
type ReviewBlob = MusicReviewRecord;

export function createMusicReviewStore(opts: MusicReviewStoreOptions): MusicReviewStore {
	const prefs = createServicePrefsClient({
		app: 'cardtable',
		serviceKey: opts.serviceKey,
		baseUrl: opts.baseUrl,
		...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
	});
	const parse = (userId: string, blob: unknown): MusicReviewRecord | null => {
		const parsed = MusicReviewRecordSchema.safeParse(blob);
		if (parsed.success) return parsed.data;
		opts.onBadRow(userId);
		return null;
	};
	return {
		async mine(userId) {
			const [row] = await prefs.read<ReviewBlob>(MUSIC_REVIEW_APP_ID, [userId]);
			return row === undefined ? null : parse(row.userId, row.blob);
		},
		async save(userKey, record) {
			const result = await prefs.writeFor<ReviewBlob>(MUSIC_REVIEW_APP_ID, userKey, { at: record.at, slots: record.slots });
			// No expectedVersion is sent, so prefs-api has nothing to refuse on: a conflict here is a contract break.
			if (!result.ok) throw new Error('prefs-api refused an unversioned music-review write');
		},
		async all() {
			const out: MusicReviewList['reviews'] = [];
			for await (const row of prefs.all<ReviewBlob>(MUSIC_REVIEW_APP_ID)) {
				const review = parse(row.userId, row.blob);
				if (review !== null) out.push({ userId: row.userId, ...review });
			}
			return out;
		},
	};
}
