/**
 * Account deletion's erase hook (hadoku_site IDENTITY_MODEL R12, "Erase hooks"; the caller is
 * edge-router's `eraseMemberData`, which runs it on account delete and on the merged-away side of
 * an account merge).
 *
 * The edge calls it with its own seal and `X-User-Id`, and wants 200 `{ erased: { <what>: <count> } }`
 * back, zeros on a second call. Anything else fails the whole delete, which the edge retries, so a
 * step that throws answers 500 rather than a partial count.
 *
 * Only the seal admits it — `edgeSealed` is an injected check, never a tier: this module knows no
 * app's edge-auth binding. `deriveParticipantId` is likewise injected: the id a person is also
 * known by (the `fk:`/`dev:`/`eph:` scheme, whichever app provides it) is platform but app-bound,
 * not this kernel's to import.
 *
 * What is erased is a list of steps each store registers where it is built (`register`), so a
 * store and its erase live side by side in the app. Steps run one at a time, in registration
 * order, so two never rewrite one file at once.
 *
 * ## Account merge, `POST /api/_account/merge`
 *
 * The edge merges one person's two accounts (hadoku_site `docs/planning/account-journeys-2026-11-18.md`
 * §J6; edge-router `account-erase.ts`'s `mergeMemberData`): the same seal, `X-User-Id` the account
 * going away (`from`), `X-Merge-Into` the account kept (`into`). It wants 200 `{ merged: { <what>:
 * <count> } }`, zeros on a second call, and anything else leaves both accounts as they were for
 * the edge to retry. Then it closes `from` and calls the erase hook on it as a sweep, so whatever a
 * merge leaves under `from` is erased: a merge MOVES what should survive, and only that.
 *
 * The rule (operator, 2026-11-18): the kept account wins any conflict; otherwise union. Every
 * step decides its own store's merge beside its erase — `EraseStep.merge` is required, so a store
 * cannot gain an erase without a merge decision — and one that moves nothing answers 0 and says
 * why where it is written.
 */

import type { Request, Response } from 'express';

import { placeholderId } from './anonymise.ts';
import { reportSealRefused } from '../telemetry/telemetry.ts';

/** `/api/_account/erase` — the one path every app answers this hook on. */
export const ERASE_PATH = '/api/_account/erase';
/** `/api/_account/merge` — the merge hook's path, beside the erase hook's. */
export const MERGE_PATH = '/api/_account/merge';

/** One account, by every id this app knows it by. */
export interface AccountIds {
	/** The registry userId, as the edge sent it. */
	userId: string;
	/** The app's own id for this person (its identity scheme's derived id). */
	participantId: string;
	/** Both of the above: what a shared record names them by (`replaceIds`). */
	ids: ReadonlySet<string>;
}

/** Whom one erase is for. */
export interface ErasedPerson extends AccountIds {
	/** What they become in a shared record, one per erase (`placeholderId`). */
	placeholder: string;
}

/** One merge: `from` goes away, `into` is kept. */
export interface MergedAccounts {
	from: AccountIds;
	into: AccountIds;
	/** Each of `from`'s ids → `into`'s counterpart: userId → userId, participantId → participantId (`renameIds`, `moveIds`). */
	renames: ReadonlyMap<string, string>;
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
	/**
	 * This store's part of an account merge: move what `from` holds here to `into`, the kept
	 * account winning any conflict, and answer what moved, zero once nothing is left to move.
	 * Required, so no store is erased on a merge by omission: a store that moves nothing answers 0,
	 * with the reason written beside it.
	 */
	merge(accounts: MergedAccounts): EraseCounts | Promise<EraseCounts>;
}

export interface AccountErase {
	/** Add a store's step. A second step under one name, or one with no `merge`, is a wiring bug and throws. */
	register(step: EraseStep): void;
	/** Run every step for this userId. Throws the first step's failure. */
	erase(userId: string): Promise<Record<string, number>>;
	/** Run every step's merge of `fromUserId` into `intoUserId`. Throws the first step's failure. */
	merge(fromUserId: string, intoUserId: string): Promise<Record<string, number>>;
	/** The erase route's handler. */
	handle(req: Request, res: Response): Promise<void>;
	/** The merge route's handler. */
	handleMerge(req: Request, res: Response): Promise<void>;
}

export interface AccountEraseOptions {
	log: (entry: Record<string, unknown>) => void;
	/** Did this request carry the edge's own seal? Never a tier check. */
	edgeSealed: (req: Request) => boolean;
	/** This app's own identity scheme's derived id for a registry userId. */
	deriveParticipantId: (userId: string) => string;
}

export function personOf(userId: string, deriveParticipantId: (userId: string) => string): ErasedPerson {
	return { ...accountOf(userId, deriveParticipantId), placeholder: placeholderId() };
}

function accountOf(userId: string, deriveParticipantId: (userId: string) => string): AccountIds {
	const participantId = deriveParticipantId(userId);
	return { userId, participantId, ids: new Set([userId, participantId]) };
}

export function mergedAccountsOf(fromUserId: string, intoUserId: string, deriveParticipantId: (userId: string) => string): MergedAccounts {
	const from = accountOf(fromUserId, deriveParticipantId);
	const into = accountOf(intoUserId, deriveParticipantId);
	return {
		from,
		into,
		renames: new Map([
			[from.userId, into.userId],
			[from.participantId, into.participantId],
		]),
	};
}

/** A trimmed header, or '' for none. */
function headerOf(req: Request, name: string): string {
	const raw = req.headers[name];
	return typeof raw === 'string' ? raw.trim() : '';
}

function totalOf(into: Record<string, number>, step: EraseStep, counts: EraseCounts): void {
	if (typeof counts === 'number') into[step.what] = counts;
	else Object.assign(into, counts);
}

export function createAccountErase(opts: AccountEraseOptions): AccountErase {
	const steps: EraseStep[] = [];

	const erase = async (userId: string): Promise<Record<string, number>> => {
		const person = personOf(userId, opts.deriveParticipantId);
		const erased: Record<string, number> = {};
		for (const step of steps) totalOf(erased, step, await step.erase(person));
		return erased;
	};

	const merge = async (fromUserId: string, intoUserId: string): Promise<Record<string, number>> => {
		const accounts = mergedAccountsOf(fromUserId, intoUserId, opts.deriveParticipantId);
		const merged: Record<string, number> = {};
		for (const step of steps) totalOf(merged, step, await step.merge(accounts));
		return merged;
	};

	return {
		register(step) {
			if (steps.some((s) => s.what === step.what)) throw new Error(`erase step '${step.what}' is registered twice`);
			// The type already requires it; this catches a step built where the type was cast away.
			if (typeof (step as Partial<EraseStep>).merge !== 'function') throw new Error(`erase step '${step.what}' has no merge decision`);
			steps.push(step);
		},
		erase,
		merge,
		async handle(req, res) {
			if (!opts.edgeSealed(req)) {
				reportSealRefused('http', req.headers, req.path);
				res.status(401).json({ error: "erase needs the edge's seal" });
				return;
			}
			const userId = headerOf(req, 'x-user-id');
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
		async handleMerge(req, res) {
			if (!opts.edgeSealed(req)) {
				reportSealRefused('http', req.headers, req.path);
				res.status(401).json({ error: "merge needs the edge's seal" });
				return;
			}
			const from = headerOf(req, 'x-user-id');
			const into = headerOf(req, 'x-merge-into');
			if (from === '' || into === '') {
				res.status(400).json({ error: 'X-User-Id: the account going away; X-Merge-Into: the account kept' });
				return;
			}
			if (from === into) {
				res.status(400).json({ error: 'an account cannot be merged into itself' });
				return;
			}
			try {
				const merged = await merge(from, into);
				opts.log({ evt: 'account-merged', from, into, merged });
				res.json({ merged });
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				opts.log({ evt: 'account-merge-failed', from, into, reason });
				res.status(500).json({ error: reason });
			}
		},
	};
}
