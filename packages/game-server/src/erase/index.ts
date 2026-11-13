/**
 * Cardtable's binding of `@hadoku/service-kernel/erase` — `POST /api/_account/erase`.
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
	personOf as kernelPersonOf,
	type AccountErase,
	type EraseCounts,
	type ErasedPerson,
	type EraseStep,
} from '@hadoku/service-kernel/erase';

import { deriveParticipantId } from '../room/identity.js';

export { ERASE_PATH };
export type { AccountErase, EraseCounts, ErasedPerson, EraseStep };

export const fkOf = (userId: string): string => deriveParticipantId({ accountId: userId, socketId: '' });

export function personOf(userId: string): ErasedPerson {
	return kernelPersonOf(userId, fkOf);
}
