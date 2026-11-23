/**
 * Account erase in the per-person store (`users/store.ts`): the person's document is deleted,
 * whole. It holds nothing anyone else needs (their favourites, when they last played each deck,
 * the decks they built, their art picks), so nothing is anonymised and kept.
 *
 * An account merge folds the merged-away account's document into the kept one, by the game's own
 * merge (the kept account wins each conflict), and deletes it.
 */

import type { UserStore } from '../users/store.js';
import type { EraseStep } from './index.js';

export function usersEraseStep(store: Pick<UserStore<unknown>, 'remove' | 'move'>): EraseStep {
	return {
		what: 'users',
		erase: ({ userId }) => store.remove(userId),
		merge: ({ from, into }) => store.move(from.userId, into.userId),
	};
}
