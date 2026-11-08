import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import type { Tournament } from '@hadoku/shared';

import type { People, Person } from '../people.ts';
import { attachTournaments } from './tournaments.ts';

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const RECORD: Tournament = {
	id: 'r-1-1',
	name: 'Cube night',
	startedAt: 1,
	endedAt: 2,
	closed: false,
	rounds: 1,
	names: { 'fk:a': 'old-ari', 'fk:b': 'bo', ai: 'Knight' },
	users: { 'fk:a': 'uid-ari', 'fk:b': 'uid-bo' },
	faces: { ai: { avatarId: 'knight' } },
	standings: [],
	results: [],
};

async function serve(list: Tournament[], found: Record<string, Person>, now = Date.now): Promise<string> {
	const people: People = { resolve: async (ids) => new Map(ids.flatMap((id) => (found[id] === undefined ? [] : [[id, found[id]!] as const]))), peek: () => undefined };
	const api = express.Router();
	attachTournaments(api, { tournaments: { record: () => undefined, list: async () => list }, people, now });
	const app = express();
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tournaments`;
}

describe('GET /api/tournaments', () => {
	it('draws each person as they are now, by the userId the record kept, and never sends the userIds', async () => {
		const look = { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.crown' } };
		const url = await serve([RECORD], { 'uid-ari': { name: 'Ari', sprite: 'mage', look } });
		const body = (await (await fetch(url)).json()) as { tournaments: Tournament[] };
		const [t] = body.tournaments;
		expect(t).not.toHaveProperty('users');
		expect(JSON.stringify(body)).not.toContain('uid-');
		expect(t?.names).toEqual({ 'fk:a': 'Ari', 'fk:b': 'bo', ai: 'Knight' });
		expect(t?.faces).toEqual({ 'fk:a': { avatarId: 'mage', look }, ai: { avatarId: 'knight' } });
	});

	it('names a person it cannot look up, in a record that kept no name, as an unnamed caller is', async () => {
		const url = await serve([{ ...RECORD, names: { ai: 'Knight' } }], {});
		const [t] = ((await (await fetch(url)).json()) as { tournaments: Tournament[] }).tournaments;
		expect(t?.names).toEqual({ 'fk:a': 'friend', 'fk:b': 'friend', ai: 'Knight' });
	});

	it('a record from before userIds were kept is drawn by the names it kept, with no faces', async () => {
		const { users: _users, faces: _faces, ...old } = RECORD;
		const url = await serve([old], {});
		const [t] = ((await (await fetch(url)).json()) as { tournaments: Tournament[] }).tournaments;
		expect(t?.names).toEqual(RECORD.names);
		expect(t?.faces).toEqual({});
	});
});

describe('GET /api/tournaments/featured', () => {
	const standing = (id: string, rank: number) => ({ id, matchPoints: 0, opponentMatchWinPct: 0, gameWinPct: 0, opponentGameWinPct: 0, medianGameMs: null, rank, decidedBy: null });
	const POD: Tournament = { ...RECORD, endedAt: 1_000, standings: [standing('fk:a', 1), standing('fk:b', 2), standing('ai', 3)] };

	it('answers the seated tournament, drawn as /api/tournaments draws it', async () => {
		const url = await serve([POD], { 'uid-ari': { name: 'Ari', sprite: 'mage', look: {} } }, () => 2_000);
		const body = (await (await fetch(`${url}/featured`)).json()) as { tournament: Tournament | null };
		expect(body.tournament?.id).toBe(POD.id);
		expect(body.tournament?.names['fk:a']).toBe('Ari');
		expect(JSON.stringify(body)).not.toContain('uid-');
	});

	it('answers null when nothing holds the seat', async () => {
		const url = await serve([{ ...POD, closed: true }], {}, () => 2_000);
		expect(await (await fetch(`${url}/featured`)).json()).toEqual({ tournament: null });
	});
});
