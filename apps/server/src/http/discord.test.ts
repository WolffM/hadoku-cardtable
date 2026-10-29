/**
 * `/api/discord/recent` (`./discord.ts`) against a fake ArchiveBot that checks the signature the way
 * the real one does (WolffM/ArchiveBot `lib/webhookServer.js`'s `verifySignature`: `sha256=` + the
 * hex HMAC of the raw query string after `?`): a signed read relayed, one read a minute shared by
 * every caller, and every refusal answered as "no snapshot".
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { attachDiscord, CACHE_MS } from './discord.ts';

const SECRET = 'test-archivebot-secret';
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** ArchiveBot's route, as far as cardtable can tell it apart: its signature check, then an answer. */
async function fakeArchiveBot(answer: { status: number; body: unknown }) {
	const seen: { query: string; signed: boolean }[] = [];
	const url = await listen((req, res) => {
		const at = req.url!.indexOf('?');
		const query = at === -1 ? '' : req.url!.slice(at + 1);
		const expected = Buffer.from(`sha256=${createHmac('sha256', SECRET).update(query).digest('hex')}`);
		const got = Buffer.from(String(req.headers['x-hadoku-signature'] ?? ''));
		const signed = expected.length === got.length && timingSafeEqual(expected, got);
		seen.push({ query, signed });
		res.writeHead(signed ? answer.status : 401, { 'content-type': 'application/json' });
		res.end(JSON.stringify(signed ? answer.body : { success: false, error: 'invalid_signature' }));
	});
	return { url, seen };
}

async function openApp(deps: { secret: string; archivebotUrl: string; now?: () => number }) {
	const logged: Record<string, unknown>[] = [];
	const app = express();
	const api = express.Router();
	attachDiscord(api, { ...deps, log: (e) => logged.push(e) });
	app.use('/api', api);
	const base = await listen(app);
	const get = async () => {
		const res = await fetch(`${base}/api/discord/recent`);
		return { status: res.status, body: res.status === 200 ? ((await res.json()) as unknown) : null };
	};
	return { get, logged };
}

const AVATAR = 'data:image/webp;base64,UklGRg==';
const MESSAGES = {
	messages: [
		{ author: 'alice', avatar: AVATAR, color: '#1abc9c', text: 'anyone up for a pod?', at: '2026-10-28T18:02:11Z' },
		{ author: 'bob', avatar: null, color: null, text: 'in 10', at: '2026-10-28T18:03:40Z' },
	],
};

describe('/api/discord/recent', () => {
	it('relays ArchiveBot’s messages, asking for general’s last five with the query signed', async () => {
		const bot = await fakeArchiveBot({ status: 200, body: MESSAGES });
		const { get } = await openApp({ secret: SECRET, archivebotUrl: bot.url });
		expect(await get()).toEqual({ status: 200, body: MESSAGES });
		expect(bot.seen).toEqual([{ query: 'channel=general&limit=5', signed: true }]);
	});

	it('a missing or malformed avatar or colour is null, never the whole snapshot', async () => {
		const bot = await fakeArchiveBot({
			status: 200,
			body: {
				messages: [
					{ author: 'alice', text: 'from before avatars', at: '2026-10-28T18:02:11Z' },
					{ author: 'bob', avatar: 'https://cdn.discordapp.com/avatars/1/2.webp', color: 'teal', text: 'hi', at: '2026-10-28T18:03:40Z' },
				],
			},
		});
		const { get } = await openApp({ secret: SECRET, archivebotUrl: bot.url });
		expect(await get()).toEqual({
			status: 200,
			body: {
				messages: [
					{ author: 'alice', avatar: null, color: null, text: 'from before avatars', at: '2026-10-28T18:02:11Z' },
					{ author: 'bob', avatar: null, color: null, text: 'hi', at: '2026-10-28T18:03:40Z' },
				],
			},
		});
	});

	it('reads ArchiveBot once a minute whoever asks, then again', async () => {
		const clock = { now: 1_000_000 };
		const bot = await fakeArchiveBot({ status: 200, body: MESSAGES });
		const { get } = await openApp({ secret: SECRET, archivebotUrl: bot.url, now: () => clock.now });
		await Promise.all([get(), get(), get()]);
		clock.now += CACHE_MS - 1;
		await get();
		expect(bot.seen).toHaveLength(1);
		clock.now += 2;
		await get();
		expect(bot.seen).toHaveLength(2);
	});

	it('answers 204 for a refusal, an empty channel or an unreadable body, and keeps that a minute too', async () => {
		for (const answer of [
			{ status: 503, body: { success: false, error: 'cardtable_general_not_set_up' } },
			{ status: 200, body: { messages: [] } },
			{ status: 200, body: { nothing: true } },
		]) {
			const bot = await fakeArchiveBot(answer);
			const { get, logged } = await openApp({ secret: SECRET, archivebotUrl: bot.url, now: () => 0 });
			expect((await get()).status).toBe(204);
			await get();
			expect(bot.seen).toHaveLength(1);
			if (answer.status !== 200) expect(logged).toEqual([expect.objectContaining({ event: 'discord-snapshot', outcome: 'refused', status: 503 })]);
		}
	});

	it('a wrong secret is ArchiveBot’s 401, and no snapshot', async () => {
		const bot = await fakeArchiveBot({ status: 200, body: MESSAGES });
		const { get, logged } = await openApp({ secret: 'not-the-secret', archivebotUrl: bot.url });
		expect((await get()).status).toBe(204);
		expect(bot.seen).toEqual([{ query: 'channel=general&limit=5', signed: false }]);
		expect(logged[0]).toMatchObject({ outcome: 'refused', status: 401 });
	});

	it('without the secret it never calls ArchiveBot at all (PPE, local dev)', async () => {
		const bot = await fakeArchiveBot({ status: 200, body: MESSAGES });
		const { get } = await openApp({ secret: '', archivebotUrl: bot.url });
		expect((await get()).status).toBe(204);
		expect(bot.seen).toEqual([]);
	});

	it('an unreachable ArchiveBot is no snapshot, never an error', async () => {
		const { get, logged } = await openApp({ secret: SECRET, archivebotUrl: 'http://127.0.0.1:9' });
		expect((await get()).status).toBe(204);
		expect(logged[0]).toMatchObject({ event: 'discord-snapshot', outcome: 'failed' });
	});
});
