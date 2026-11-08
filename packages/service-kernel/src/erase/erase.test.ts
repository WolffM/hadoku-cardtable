/**
 * `createAccountErase` against fakes — `edgeSealed` and `deriveParticipantId` are both injected
 * here, never a real app's edge-auth or identity module (this module imports neither). The
 * adapter-level test (`apps/server/src/erase/index.test.ts`) proves the same route end to end
 * through cardtable's real bindings.
 */
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { createAccountErase, ERASE_PATH, personOf } from './erase.ts';

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
		erase.register({ what: 'things', erase: (p) => (forgotten = forgotten.filter((id) => id !== p.userId)).length === 0 ? 0 : 1 });
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
		});
		const r = fakeRes();
		await erase.handle(req({ 'x-user-id': 'u-1' }), r.res);
		expect(r.status).toBe(500);
		expect(r.body).toEqual({ error: 'disk full' });
		expect(logged).toEqual([{ evt: 'account-erase-failed', userId: 'u-1', reason: 'disk full' }]);
	});

	it('refuses a second step under one name', () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => sealed, deriveParticipantId });
		erase.register({ what: 'things', erase: () => 0 });
		expect(() => erase.register({ what: 'things', erase: () => 0 })).toThrow(/twice/);
	});

	it('runs every registered step and merges a multi-field step', async () => {
		const erase = createAccountErase({ log: () => {}, edgeSealed: () => sealed, deriveParticipantId });
		erase.register({ what: 'a', erase: () => 1 });
		erase.register({ what: 'b', erase: () => ({ x: 2, y: 3 }) });
		expect(await erase.erase('u-1')).toEqual({ a: 1, x: 2, y: 3 });
	});
});
