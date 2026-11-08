/**
 * `POST /api/_account/erase` — account deletion's erase hook (hadoku_site
 * IDENTITY_MODEL R12, "Erase hooks"; the caller is edge-router's
 * `eraseMemberData`, which runs it on account delete and on the merged-away
 * side of an account merge).
 *
 * The edge calls it on the tunnel origin with `X-Edge-Auth` (its seal),
 * `X-Hadoku-Tier: member` and `X-User-Id`, and wants 200
 * `{ erased: { <what>: <count> } }` back, zeros on a second call. Anything
 * else fails the whole delete, which the edge retries, so a step that throws
 * answers 500 rather than a partial count.
 *
 * Only the seal admits it. The bare-local escape hatch (`allowUnverifiedEdge`)
 * believes any header and so does NOT open this route, and no tier does
 * either: `edgeSealed` is checked, not `tierOf`. The edge 404s every inbound
 * path with an `_account` segment, so no page reaches it through hadoku.me;
 * the seal keeps a direct hit on the tunnel hostname out.
 *
 * Mounted above the tier floor and `firstSeen`: the edge sends `member`, and
 * a wrapper that lost `CARDTABLE_MIN_TIER` floors at friend, which would 404
 * every delete; and `firstSeen` below it would record the person again on the
 * very call that erases them.
 *
 * What is erased is a list of steps each store registers where it is built
 * (`register`), so a store and its erase live side by side in `index.ts`. A
 * person is named here two ways, both handed to every step: the registry
 * userId, and the `fk:` participant id derived from it (`room/identity.ts`),
 * which is what rooms, pods and recordings carry. Steps run one at a time, in
 * registration order, so two never rewrite one file at once.
 */

import type { Request, Response } from 'express';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import { edgeSealed } from '../edge-auth.js';
import type { JsonLog } from '../log.js';
import { deriveParticipantId } from '../room/identity.js';
import { reportSealRefused } from '../telemetry.js';
import { placeholderId } from './anonymise.js';

export const ERASE_PATH = '/api/_account/erase';

/** Whom one erase is for. */
export interface ErasedPerson {
	/** The registry userId, as the edge sent it. */
	userId: string;
	/** The `fk:` id this server knows them by, derived from the userId. */
	participantId: ParticipantId;
	/** Both of the above: what a shared record names them by (`anonymise.ts`'s `replaceIds`). */
	ids: ReadonlySet<string>;
	/** What they become in a shared record, one per erase (`placeholderId`). */
	placeholder: string;
}

/**
 * One store's part of an erase: how many of the person's records it erased or anonymised,
 * zero when none are left. A store with several kinds of record answers a count for each,
 * by name, and `what` only names the step.
 */
export type EraseCounts = number | Record<string, number>;
export interface EraseStep {
	what: string;
	erase(person: ErasedPerson): EraseCounts | Promise<EraseCounts>;
}

export interface AccountErase {
	/** Add a store's step. A second step under one name is a wiring bug and throws. */
	register(step: EraseStep): void;
	/** Run every step for this userId. Throws the first step's failure. */
	erase(userId: string): Promise<Record<string, number>>;
	/** The route's handler. */
	handle(req: Request, res: Response): Promise<void>;
}

export function personOf(userId: string): ErasedPerson {
	const participantId = deriveParticipantId({ accountId: userId, socketId: '' });
	return { userId, participantId, ids: new Set([userId, participantId]), placeholder: placeholderId() };
}

export function createAccountErase(opts: { log: JsonLog }): AccountErase {
	const steps: EraseStep[] = [];

	const erase = async (userId: string): Promise<Record<string, number>> => {
		const person = personOf(userId);
		const erased: Record<string, number> = {};
		for (const step of steps) {
			const counts = await step.erase(person);
			if (typeof counts === 'number') erased[step.what] = counts;
			else Object.assign(erased, counts);
		}
		return erased;
	};

	return {
		register(step) {
			if (steps.some((s) => s.what === step.what)) throw new Error(`erase step '${step.what}' is registered twice`);
			steps.push(step);
		},
		erase,
		async handle(req, res) {
			if (!edgeSealed(req)) {
				reportSealRefused('http', req.headers, req.path);
				res.status(401).json({ error: "erase needs the edge's seal" });
				return;
			}
			const raw = req.headers['x-user-id'];
			const userId = typeof raw === 'string' ? raw.trim() : '';
			if (userId === '') {
				res.status(400).json({ error: 'X-User-Id: whose data to erase' });
				return;
			}
			try {
				const erased = await erase(userId);
				opts.log({ evt: 'account-erased', userId, erased });
				res.json({ erased });
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				opts.log({ evt: 'account-erase-failed', userId, reason });
				res.status(500).json({ error: reason });
			}
		},
	};
}
