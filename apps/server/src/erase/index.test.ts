import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../config.ts';
import { callerIdOf, edgeProvenance, tierOf } from '../edge-auth.ts';
import { identityFromHeaders } from '../room/identity.ts';
import { firstSeen } from '../telemetry.ts';
import { createAccountErase, ERASE_PATH, personOf, type AccountErase } from './index.ts';

const SECRET = 'edge-secret-for-the-erase-test';
const USER = 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03';
const OTHER = '5b0e3c1d-2a4f-4e6b-8c9d-0f1e2d3c4b5a';

const config = CONFIG as { -readonly [K in keyof typeof CONFIG]: (typeof CONFIG)[K] };
const saved = { secret: config.edgeAuthSecret, hatch: config.allowUnverifiedEdge };

interface Served {
	post(headers: Record<string, string>): Promise<{ status: number; body: unknown }>;
	erase: AccountErase;
	seenFile: string;
	close(): Promise<void>;
}

/** The route as index.ts mounts it: provenance, then the hook, then the floor's `firstSeen` below it. */
async function serve(): Promise<Served> {
	const seenFile = join(mkdtempSync(join(tmpdir(), 'erase-')), 'callers-seen.json');
	const erase = createAccountErase({ log: () => {} });
	const app = express();
	app.use(edgeProvenance);
	app.post(ERASE_PATH, (req: Request, res: Response) => void erase.handle(req, res));
	const seen = firstSeen({ file: seenFile, userIdOf: callerIdOf, tierOf, log: () => {} });
	app.use(seen);
	app.get('/api/whoami', (_req, res) => void res.json({}));
	erase.register({ what: 'callersSeen', erase: (p) => seen.forget(p.userId) });
	const server = app.listen(0, '127.0.0.1');
	await new Promise((r) => server.once('listening', r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	// Two accounts seen through the edge, as a real visit records them.
	for (const id of [USER, OTHER]) await fetch(`${base}/api/whoami`, { headers: { 'x-edge-auth': SECRET, 'x-hadoku-tier': 'member', 'x-user-id': id } });
	return {
		erase,
		seenFile,
		async post(headers) {
			const res = await fetch(`${base}${ERASE_PATH}`, { method: 'POST', headers });
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

		expect(await s.post(sealed())).toEqual({ status: 200, body: { erased: { callersSeen: 1 } } });
		expect(seenIn(s.seenFile)).toEqual([OTHER]);

		expect(await s.post(sealed())).toEqual({ status: 200, body: { erased: { callersSeen: 0 } } });
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
		});
		expect(await s.post(sealed())).toEqual({ status: 500, body: { error: 'disk full' } });
	});

	it('refuses a second step under one name', () => {
		expect(() => s.erase.register({ what: 'callersSeen', erase: () => 0 })).toThrow(/twice/);
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
