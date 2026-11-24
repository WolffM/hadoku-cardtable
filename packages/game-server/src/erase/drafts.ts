/**
 * Account erase in a game's draft record (Magic's `history/drafts.ts`, `<stateDir>/history/drafts.jsonl`).
 * A record keeps every seat of a draft: the other drafters' picks and the draft's counts hang on
 * it, so the person's seat is anonymised and kept, never removed. The game's store decides what
 * an anonymised seat looks like; this step only says whose.
 *
 * An account merge moves the merged-away account's seats to the kept account.
 *
 * Generic on purpose: this package is the platform (MIT) and knows no game's record, so the game
 * hands its store in where it registers the step.
 */

import type { EraseStep } from './index.js';

export interface SeatRecords {
	/** Every seat naming one of `userIds` is anonymised. Answers the seats changed. */
	anonymise(userIds: ReadonlySet<string>): Promise<number>;
	/** Every seat naming a key of `renames` names its value instead. Answers the seats changed. */
	move(renames: ReadonlyMap<string, string>): Promise<number>;
}

export function draftsEraseStep(store: SeatRecords): EraseStep {
	return {
		what: 'drafts',
		erase: ({ userId }) => store.anonymise(new Set([userId])),
		merge: ({ from, into }) => store.move(new Map([[from.userId, into.userId]])),
	};
}
