/**
 * Magic's per-person store: `<stateDir>/users/<userId>.json` (`CONFIG.dataDir` is the state dir
 * when one is set), one document each, in the shape `document.ts` gives.
 *
 * One store per process, opened on first use, so every reader (the `/api/me` routes, the
 * match-end stamp, the art pins read at match start, the account erase) shares one queue of
 * writes per person. A test opens its own with `createMagicUserStore(dir)`.
 */

import { join } from 'node:path';
import { CONFIG } from '@hadoku/game-server/config';
import { createUserStore, type UserStore } from '@hadoku/game-server/users/store';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { MAGIC_USER_DOC, type MagicUserDoc } from './document.js';

export * from './document.js';

export type MagicUserStore = UserStore<MagicUserDoc>;

export function createMagicUserStore(dir: string, log: (entry: Record<string, unknown>) => void = jsonLogger('cardtable-users')): MagicUserStore {
	return createUserStore({ dir, shape: MAGIC_USER_DOC, log });
}

let shared: MagicUserStore | null = null;

/** The process's store, under the state dir. */
export function magicUserStore(): MagicUserStore {
	shared ??= createMagicUserStore(join(CONFIG.dataDir, 'users'));
	return shared;
}
