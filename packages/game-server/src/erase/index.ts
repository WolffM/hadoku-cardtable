/**
 * Cardtable's binding of `@hadoku/service-kernel/erase` — `POST /api/_account/erase` and its
 * merge counterpart, `POST /api/_account/merge` (same admission; the kernel's `erase.ts` has the contract).
 *
 * The edge calls it on the tunnel origin with `X-Edge-Auth` (its seal), `X-Hadoku-Tier: member`
 * and `X-User-Id`. Only the seal admits it (`createGameServer` passes `edgeAuth.edgeSealed`), never
 * a tier: the bare-local escape hatch believes any header and so does NOT open this route. The
 * kernel mounts it above the floor and `firstSeen`: the edge sends `member`, which a wrapper that
 * lost `CARDTABLE_MIN_TIER` would 404, and `firstSeen` would record the person again on the very
 * call that erases them.
 *
 * What stays here is the `fk:` id a person is also known by (`room/identity.ts`), which the
 * kernel is handed as `deriveParticipantId`, and the steps' shared types.
 */
import {
	ERASE_PATH,
	MERGE_PATH,
	mergedAccountsOf as kernelMergedAccountsOf,
	personOf as kernelPersonOf,
	type AccountErase,
	type AccountIds,
	type EraseCounts,
	type ErasedPerson,
	type EraseStep,
	type MergedAccounts,
} from '@hadoku/service-kernel/erase';

import { deriveParticipantId } from '../room/identity.js';

export { ERASE_PATH, MERGE_PATH };
export type { AccountErase, AccountIds, EraseCounts, ErasedPerson, EraseStep, MergedAccounts };

export const fkOf = (userId: string): string => deriveParticipantId({ accountId: userId, socketId: '' });

export function personOf(userId: string): ErasedPerson {
	return kernelPersonOf(userId, fkOf);
}

/** One merge of `fromUserId` into `intoUserId`, by cardtable's `fk:` ids too (`POST /api/_account/merge`). */
export function mergedAccountsOf(fromUserId: string, intoUserId: string): MergedAccounts {
	return kernelMergedAccountsOf(fromUserId, intoUserId, fkOf);
}
