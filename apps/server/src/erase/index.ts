/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/erase`'s account-erase registry
 * (w93-K3) — `POST /api/_account/erase`.
 *
 * The edge calls it on the tunnel origin with `X-Edge-Auth` (its seal), `X-Hadoku-Tier: member`
 * and `X-User-Id`. Only the seal admits it: the bare-local escape hatch (`allowUnverifiedEdge`)
 * believes any header and so does NOT open this route, and no tier does either — `edgeSealed` is
 * checked, not `tierOf`, injected here from `edge-auth.js` since the kernel knows no app's binding
 * of it. `deriveParticipantId` (`room/identity.ts`) is likewise injected: the `fk:` id a person is
 * also known by is platform but app-bound, not the kernel's to import.
 *
 * Mounted above the tier floor and `firstSeen` (`index.ts`): the edge sends `member`, and a
 * wrapper that lost `CARDTABLE_MIN_TIER` floors at friend, which would 404 every delete; and
 * `firstSeen` below it would record the person again on the very call that erases them.
 *
 * Every export and signature below is unchanged from before this moved into the kernel:
 * `index.ts` imports this path exactly as it did, passing only `{ log }` — this file supplies
 * `edgeSealed` and `deriveParticipantId` itself, so no call site needs to change.
 */

import {
	createAccountErase as kernelCreateAccountErase,
	ERASE_PATH,
	personOf as kernelPersonOf,
	type AccountErase,
	type EraseCounts,
	type ErasedPerson,
	type EraseStep,
} from '@hadoku/service-kernel/erase';

import { edgeSealed } from '../edge-auth.js';
import type { JsonLog } from '@hadoku/service-kernel/log';
import { deriveParticipantId } from '../room/identity.js';

export { ERASE_PATH };
export type { AccountErase, EraseCounts, ErasedPerson, EraseStep };

const fkOf = (userId: string): string => deriveParticipantId({ accountId: userId, socketId: '' });

export function personOf(userId: string): ErasedPerson {
	return kernelPersonOf(userId, fkOf);
}

export function createAccountErase(opts: { log: JsonLog }): AccountErase {
	return kernelCreateAccountErase({ log: opts.log, edgeSealed, deriveParticipantId: fkOf });
}
