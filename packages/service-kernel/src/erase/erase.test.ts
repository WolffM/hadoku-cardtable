/**
 * `createAccountErase` against fakes — `edgeSealed` and `deriveParticipantId` are both injected
 * here, never a real app's edge-auth or identity module (this module imports neither). The
 * adapter-level test (`packages/game-server/src/erase/index.test.ts`) proves the same route end to end
 * through cardtable's real bindings.
 */
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { createAccountErase, ERASE_PATH, MERGE_PATH, mergedAccountsOf, personOf, type EraseStep, type MergedAccounts } from './erase.ts';

const deriveParticipantId = (userId: string): string => `fk:${userId}`;

function fakeRes(): { res: Response; status?: number; body?: unknown } {
	const r: { res: Response; status?: number; body?: unknown } = {} as never;
	r.res = {
		status: (s: number) => {
			r.status = s;
			return { json: (b: unknown) => (r.body = b) };
		},
		json: (b: unknown) => (r.body = b),
	} as unknown as Response;
	return r;
}

function req(headers: Record<string, string>, path = ERASE_PATH): Request {
	return { headers, path } as unknown as Request;
}

describe('ERASE_PATH', () => {
	it('is the one path every app answers this hook on', () => {
		expect(ERASE_PATH).toBe('/api/_account/erase');
	});
});

describe('personOf', () => {
	it('names the person by both the registry id and the derived participant id', () => {
		const person = personOf('u-1', deriveParticipantId);
		expect(person.userId).toBe('u-1');
		expect(person.participantId).toBe('fk:u-1');
		expect(person.ids).toEqual(new Set(['u-1', 'fk:u-1']));
		expect(person.placeholder).toMatch(/^erased:[0-9a-f]+$/);
	});

	it('mints a fresh placeholder each time, so two erased people never merge into one', () => {
		expect(personOf('u-1', deriveParticipantId).placeholder).not.toBe(personOf('u-2', deriveParticipantId).placeholder);
	});
});

describe('createAccountErase', () => {
	const sealed = true;

	it("erases the person's records, and answers zeros the second time", async () => {
		const logged: Record<string, unknown>[] = [];
		const erase = createAccountErase({ log: (e) => logged.push(e), edgeSealed: () => sealed, deriveParticipantId });
		let forgotten: string[] = ['u-1'];
		erase.register({ what: 'things', erase: (p) => (forgotten = forgotten.filter((id) => id !== p.userId)).length === 0 ? 0 : 1, merge: () => 0 });
		const r1 = fakeRes();
		await erase.handle(req({ 'x-user-id': 'u-1' }), r1.res);
		expect(r1.body).toEqual({ erased: { things: 0 } });
		expect(logged).toEqual([{ evt: 'account-erased', userId: 'u-1', erased: { things: 0 } }]);
	});

	it('refuses a call with no edge seal', async () => {
		const logged: Record<string, unknown>[] = [];
		const erase = createAccountErase({ log: (e) => logged.push(e), edgeSealed: () => false, deriveParticipantId });
		const r = fakeRes();
		await erase.handle(req({ 'x-user-id': 'u-1' }), r.res);
		expect(r.status).toBe(401);
		expect(r.body).toEqual({ error: "erase needs the edge's seal" });
	});

	it('needs to be told whose data', async () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => sealed, deriveParticipantId });
		const r = fakeRes();
		await erase.handle(req({}), r.res);
		expect(r.status).toBe(400);
	});

	it('answers 500, never a partial count, when a step fails', async () => {
		const logged: Record<string, unknown>[] = [];
		const erase = createAccountErase({ log: (e) => logged.push(e), edgeSealed: () => sealed, deriveParticipantId });
		erase.register({
			what: 'broken',
			erase: () => {
				throw new Error('disk full');
			},
			merge: () => 0,
		});
		const r = fakeRes();
		await erase.handle(req({ 'x-user-id': 'u-1' }), r.res);
		expect(r.status).toBe(500);
		expect(r.body).toEqual({ error: 'disk full' });
		expect(logged).toEqual([{ evt: 'account-erase-failed', userId: 'u-1', reason: 'disk full' }]);
	});

	it('refuses a second step under one name', () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => sealed, deriveParticipantId });
		erase.register({ what: 'things', erase: () => 0, merge: () => 0 });
		expect(() => erase.register({ what: 'things', erase: () => 0, merge: () => 0 })).toThrow(/twice/);
	});

	it('runs every registered step and merges a multi-field step', async () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => sealed, deriveParticipantId });
		erase.register({ what: 'a', erase: () => 1, merge: () => 0 });
		erase.register({ what: 'b', erase: () => ({ x: 2, y: 3 }), merge: () => 0 });
		expect(await erase.erase('u-1')).toEqual({ a: 1, x: 2, y: 3 });
	});
});

describe('MERGE_PATH', () => {
	it('sits beside the erase path', () => {
		expect(MERGE_PATH).toBe('/api/_account/merge');
	});
});

describe('mergedAccountsOf', () => {
	it("renames each of the merged-away account's ids to the kept account's counterpart", () => {
		const m = mergedAccountsOf('u-1', 'u-2', deriveParticipantId);
		expect(m.from.ids).toEqual(new Set(['u-1', 'fk:u-1']));
		expect(m.into.ids).toEqual(new Set(['u-2', 'fk:u-2']));
		expect([...m.renames]).toEqual([
			['u-1', 'u-2'],
			['fk:u-1', 'fk:u-2'],
		]);
	});
});

describe('createAccountErase: merge', () => {
	/** A store of owned things, by participant id: a merge moves `from`'s to `into` unless `into` has one. */
	function ownedThings(things: Map<string, string>): EraseStep {
		return {
			what: 'things',
			erase: (p) => (things.delete(p.participantId) ? 1 : 0),
			merge: ({ from, into }: MergedAccounts) => {
				const theirs = things.get(from.participantId);
				if (theirs === undefined) return 0;
				things.delete(from.participantId);
				if (things.has(into.participantId)) return 0;
				things.set(into.participantId, theirs);
				return 1;
			},
		};
	}
	const headers = { 'x-user-id': 'u-1', 'x-merge-into': 'u-2' };

	it("moves the merged-away account's records under the seal, and answers zeros the second time", async () => {
		const logged: Record<string, unknown>[] = [];
		const erase = createAccountErase({ log: (e) => logged.push(e), edgeSealed: () => true, deriveParticipantId });
		const things = new Map([['fk:u-1', 'deck']]);
		erase.register(ownedThings(things));
		erase.register({ what: 'multi', erase: () => 0, merge: () => ({ x: 0, y: 0 }) });
		const r1 = fakeRes();
		await erase.handleMerge(req(headers, MERGE_PATH), r1.res);
		expect(r1.body).toEqual({ merged: { things: 1, x: 0, y: 0 } });
		expect([...things]).toEqual([['fk:u-2', 'deck']]);
		const r2 = fakeRes();
		await erase.handleMerge(req(headers, MERGE_PATH), r2.res);
		expect(r2.body).toEqual({ merged: { things: 0, x: 0, y: 0 } });
		expect(logged[0]).toEqual({ evt: 'account-merged', from: 'u-1', into: 'u-2', merged: { things: 1, x: 0, y: 0 } });
	});

	it('refuses a call with no edge seal, and moves nothing', async () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => false, deriveParticipantId });
		const things = new Map([['fk:u-1', 'deck']]);
		erase.register(ownedThings(things));
		const r = fakeRes();
		await erase.handleMerge(req(headers, MERGE_PATH), r.res);
		expect(r.status).toBe(401);
		expect(r.body).toEqual({ error: "merge needs the edge's seal" });
		expect([...things]).toEqual([['fk:u-1', 'deck']]);
	});

	it('needs both accounts, and two different ones', async () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => true, deriveParticipantId });
		const things = new Map([['fk:u-1', 'deck']]);
		erase.register(ownedThings(things));
		const bad: Record<string, string>[] = [{ 'x-user-id': 'u-1' }, { 'x-merge-into': 'u-2' }, { 'x-user-id': 'u-1', 'x-merge-into': '  ' }, { 'x-user-id': 'u-1', 'x-merge-into': 'u-1' }, { 'x-user-id': 'u-1', 'x-merge-into': ' u-1 ' }];
		for (const h of bad) {
			const r = fakeRes();
			await erase.handleMerge(req(h, MERGE_PATH), r.res);
			expect(r.status).toBe(400);
		}
		expect([...things]).toEqual([['fk:u-1', 'deck']]);
	});

	it('answers 500, never a partial count, when a step fails', async () => {
		const logged: Record<string, unknown>[] = [];
		const erase = createAccountErase({ log: (e) => logged.push(e), edgeSealed: () => true, deriveParticipantId });
		erase.register(ownedThings(new Map([['fk:u-1', 'deck']])));
		erase.register({
			what: 'broken',
			erase: () => 0,
			merge: () => {
				throw new Error('disk full');
			},
		});
		const r = fakeRes();
		await erase.handleMerge(req(headers, MERGE_PATH), r.res);
		expect(r.status).toBe(500);
		expect(r.body).toEqual({ error: 'disk full' });
		expect(logged).toEqual([{ evt: 'account-merge-failed', from: 'u-1', into: 'u-2', reason: 'disk full' }]);
	});

	it('cannot register a step with no merge decision', () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => true, deriveParticipantId });
		// @ts-expect-error -- `merge` is required: a store with an erase and no merge decision does not compile.
		const noMerge: EraseStep = { what: 'things', erase: () => 0 };
		expect(() => erase.register(noMerge)).toThrow(/no merge decision/);
	});
});
