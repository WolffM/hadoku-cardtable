import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../config.ts';
import { callerIdOf, edgeProvenance, edgeSealed, tierOf } from '../edge-auth.ts';
import { identityFromHeaders } from '../room/identity.ts';
import { firstSeen } from '@hadoku/service-kernel/telemetry';
import { createAccountErase } from '@hadoku/service-kernel/erase';
import { ERASE_PATH, fkOf, MERGE_PATH, mergedAccountsOf, personOf, type AccountErase } from './index.ts';
import { legacyIdsStep } from './legacy-ids.ts';

const SECRET = 'edge-secret-for-the-erase-test';
const USER = 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03';
const OTHER = '5b0e3c1d-2a4f-4e6b-8c9d-0f1e2d3c4b5a';

const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
const saved = { secret: config.edgeAuthSecret, hatch: config.allowUnverifiedEdge };

interface Served {
	post(headers: Record<string, string>, path?: string): Promise<{ status: number; body: unknown }>;
	erase: AccountErase;
	seenFile: string;
	legacyFile: string;
	close(): Promise<void>;
}

/** The route as index.ts mounts it: provenance, then the hook, then the floor's `firstSeen` below it. */
async function serve(): Promise<Served> {
	const dir = mkdtempSync(join(tmpdir(), 'erase-'));
	const seenFile = join(dir, 'callers-seen.json');
	// A real store with something to move: the R12 remap record, naming USER twice and OTHER once.
	const legacyFile = join(dir, 'legacy-ids.done.json');
	writeFileSync(legacyFile, JSON.stringify({ 'fk:old1': USER, 'fk:old2': OTHER, 'fk:old3': USER }));
	const erase = createAccountErase({ log: () => {}, edgeSealed, deriveParticipantId: fkOf });
	const app = express();
	app.use(edgeProvenance);
	app.post(ERASE_PATH, (req: Request, res: Response) => void erase.handle(req, res));
	app.post(MERGE_PATH, (req: Request, res: Response) => void erase.handleMerge(req, res));
	const seen = firstSeen({ file: seenFile, userIdOf: callerIdOf, tierOf, log: () => {} });
	app.use(seen);
	app.get('/api/whoami', (_req, res) => void res.json({}));
	erase.register({ what: 'callersSeen', erase: (p) => seen.forget(p.userId), merge: () => 0 });
	erase.register(legacyIdsStep(legacyFile));
	const server = app.listen(0, '127.0.0.1');
	await new Promise((r) => server.once('listening', r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	// Two accounts seen through the edge, as a real visit records them.
	for (const id of [USER, OTHER]) await fetch(`${base}/api/whoami`, { headers: { 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member', 'x-user-id': id } });
	return {
		erase,
		seenFile,
		legacyFile,
		async post(headers, path = ERASE_PATH) {
			const res = await fetch(`${base}${path}`, { method: 'POST', headers });
			return { status: res.status, body: await res.json() };
		},
		close: () => new Promise((r) => server.close(() => r())),
	};
}

const sealed = (userId = USER) => ({ 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member', 'x-user-id': userId });
const seenIn = (file: string): string[] => JSON.parse(readFileSync(file, 'utf8'));

describe('POST /api/_account/erase', () => {
	let s: Served;
	beforeEach(async () => {
		config.edgeAuthSecret = SECRET;
		config.allowUnverifiedEdge = false;
		s = await serve();
	});
	afterEach(async () => {
		await s.close();
		config.edgeAuthSecret = saved.secret;
		config.allowUnverifiedEdge = saved.hatch;
	});

	it("erases the person's records under the seal, and answers zeros the second time", async () => {
		expect(seenIn(s.seenFile).sort()).toEqual([OTHER, USER].sort());

		expect(await s.post(sealed())).toEqual({ status: 200, body: { erased: { callersSeen: 1, legacyIds: 2 } } });
		expect(seenIn(s.seenFile)).toEqual([OTHER]);

		expect(await s.post(sealed())).toEqual({ status: 200, body: { erased: { callersSeen: 0, legacyIds: 0 } } });
		expect(seenIn(s.seenFile)).toEqual([OTHER]);
	});

	it('refuses a forged call with no edge seal, and erases nothing', async () => {
		const { 'x-edge-auth': _seal, ...forged } = sealed();
		expect((await s.post(forged)).status).toBe(401);
		expect((await s.post({ ...forged, 'x-edge-auth': 'not-the-seal' })).status).toBe(401);
		expect(seenIn(s.seenFile)).toContain(USER);
	});

	it('stays shut under the bare-local hatch, which believes any header', async () => {
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = true;
		expect((await s.post(sealed())).status).toBe(401);
		expect((await s.post({ 'x-hadoku-tier': 'admin', 'x-user-id': USER })).status).toBe(401);
		expect(seenIn(s.seenFile)).toContain(USER);
	});

	it('needs to be told whose data', async () => {
		const { 'x-user-id': _id, ...nobody } = sealed();
		expect((await s.post(nobody)).status).toBe(400);
	});

	it('answers 500, never a partial count, when a step fails', async () => {
		s.erase.register({
			what: 'broken',
			erase: () => {
				throw new Error('disk full');
			},
			merge: () => 0,
		});
		expect(await s.post(sealed())).toEqual({ status: 500, body: { error: 'disk full' } });
	});

	it('refuses a second step under one name', () => {
		expect(() => s.erase.register({ what: 'callersSeen', erase: () => 0, merge: () => 0 })).toThrow(/twice/);
	});
});

describe('POST /api/_account/merge', () => {
	let s: Served;
	const merging = (into = OTHER) => ({ ...sealed(USER), 'x-merge-into': into });
	const legacyIn = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
	beforeEach(async () => {
		config.edgeAuthSecret = SECRET;
		config.allowUnverifiedEdge = false;
		s = await serve();
	});
	afterEach(async () => {
		await s.close();
		config.edgeAuthSecret = saved.secret;
		config.allowUnverifiedEdge = saved.hatch;
	});

	it("moves the merged-away account's records to the kept one under the seal, and answers zeros the second time", async () => {
		expect(await s.post(merging(), MERGE_PATH)).toEqual({ status: 200, body: { merged: { callersSeen: 0, legacyIds: 2 } } });
		expect(legacyIn(s.legacyFile)).toEqual({ 'fk:old1': OTHER, 'fk:old2': OTHER, 'fk:old3': OTHER });
		// First-seen is per account: the merge leaves both entries, and the erase sweep takes USER's.
		expect(seenIn(s.seenFile).sort()).toEqual([OTHER, USER].sort());
		expect(await s.post(merging(), MERGE_PATH)).toEqual({ status: 200, body: { merged: { callersSeen: 0, legacyIds: 0 } } });
	});

	it('refuses a forged call with no edge seal, and under the bare-local hatch, and moves nothing', async () => {
		const { 'x-edge-auth': _seal, ...forged } = merging();
		expect((await s.post(forged, MERGE_PATH)).status).toBe(401);
		expect((await s.post({ ...forged, 'x-edge-auth': 'not-the-seal' }, MERGE_PATH)).status).toBe(401);
		config.edgeAuthSecret = '';
		config.allowUnverifiedEdge = true;
		expect((await s.post(merging(), MERGE_PATH)).status).toBe(401);
		expect((await s.post({ 'x-hadoku-tier': 'admin', 'x-user-id': USER, 'x-merge-into': OTHER }, MERGE_PATH)).status).toBe(401);
		expect(legacyIn(s.legacyFile)).toEqual({ 'fk:old1': USER, 'fk:old2': OTHER, 'fk:old3': USER });
	});

	it('needs the kept account, and one that is not the account going away', async () => {
		expect((await s.post(sealed(), MERGE_PATH)).status).toBe(400);
		expect((await s.post(merging(''), MERGE_PATH)).status).toBe(400);
		expect((await s.post(merging(USER), MERGE_PATH)).status).toBe(400);
		expect(legacyIn(s.legacyFile)).toEqual({ 'fk:old1': USER, 'fk:old2': OTHER, 'fk:old3': USER });
	});
});

describe('personOf', () => {
	it('names the person by the same fk: id a request from them is seated by', () => {
		const person = personOf(USER);
		expect(person.userId).toBe(USER);
		expect(person.participantId).toBe(identityFromHeaders({ 'x-user-id': USER }, 'socket'));
		expect(person.participantId.startsWith('fk:')).toBe(true);
	});
});

describe('mergedAccountsOf', () => {
	it('renames the registry id and the fk: id each to its own counterpart', () => {
		const m = mergedAccountsOf(USER, OTHER);
		expect([...m.renames]).toEqual([
			[USER, OTHER],
			[fkOf(USER), fkOf(OTHER)],
		]);
		expect(m.into.participantId).toBe(identityFromHeaders({ 'x-user-id': OTHER }, 'socket'));
	});
});
