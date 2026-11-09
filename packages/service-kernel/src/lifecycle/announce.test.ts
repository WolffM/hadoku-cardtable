/*
 * Generic behaviour only, against synthetic release notes and a loopback stand-in for ArchiveBot.
 * `service` is a sample value ('myapp'), never cardtable's. The tests that exercise this repo's
 * real `docs/releases` content (length caps, no mid-sentence breaks, the pending-notes style rule)
 * stay next to cardtable's adapter, since they pin THIS repo's own notes, not generic behaviour.
 * `ordering` here is a tiny synthetic stand-in for `scripts/release/build-version.ts`'s
 * `newestReleaseFile`/`releaseFilesNewestFirst`, which the kernel cannot import.
 */
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { allReleases, announceRelease, creditCounts, creditMark, creditsBody, creditsIn, forDiscord, latestRelease, parseNotes, releaseEmbeds, showCredits, splitBody, type ReleaseOrdering } from './announce.ts';

const SECRET = 'test-secret';
const SERVICE = 'myapp';

const RELEASE_FILE = /^v(\d+)\.(\d+)\.(\d+)\.md$/;
/** A minimal semver-by-filename ordering, standing in for `scripts/release/build-version.ts`. */
const ORDERING: ReleaseOrdering = {
	newestFirst(names) {
		const parsed = names.flatMap((name) => {
			const m = RELEASE_FILE.exec(name);
			return m === null ? [] : [{ name, parts: [Number(m[1]), Number(m[2]), Number(m[3])] }];
		});
		parsed.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
		return parsed.map((p) => p.name);
	},
	newest(names) {
		return ORDERING.newestFirst(names)[0] ?? null;
	},
};

interface Received {
	url: string | undefined;
	signature: string | undefined;
	raw: string;
}

let server: Server | null = null;

afterEach(async () => {
	await new Promise<void>((done) => (server === null ? done() : server.close(() => done())));
	server = null;
});

type Reply = [number, unknown];
const NOT_FOUND: Reply = [404, { error: 'message_not_found' }];

/**
 * A stand-in ArchiveBot: verifies the signature and answers `/api/messages/send` with `reply`,
 * `/api/messages/edit` with `editReply` and `/api/messages/delete` with `deleteReply`, each given the
 * request's idempotency key (defaults for the last two: no post on record).
 */
async function archivebot(reply: (key: string) => Reply, editReply: (key: string) => Reply = () => NOT_FOUND, deleteReply: (key: string) => Reply = () => NOT_FOUND): Promise<{ url: string; received: Received[] }> {
	const received: Received[] = [];
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		req.on('end', () => {
			const signature = req.headers['x-hadoku-signature'] as string | undefined;
			received.push({ url: req.url, signature, raw });
			const expected = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
			const key = String(JSON.parse(raw).idempotencyKey);
			const routes: Record<string, (key: string) => Reply> = { '/api/messages/send': reply, '/api/messages/edit': editReply, '/api/messages/delete': deleteReply };
			const route = routes[req.url ?? ''];
			const [status, body] = signature !== expected ? [401, { error: 'invalid_signature' }] : route ? route(key) : [404, { error: 'not_found' }];
			res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
		});
	});
	await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
	return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, received };
}

function logs(): { entries: Record<string, unknown>[]; log: (e: Record<string, unknown>) => void } {
	const entries: Record<string, unknown>[] = [];
	return { entries, log: (e) => entries.push(e) };
}

describe('release notes', () => {
	it('reads the newest notes among several, titled by their heading', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-releases-'));
		try {
			await writeFile(resolve(dir, 'v0.9.0.md'), '# v0.9.0 — older\n\nold');
			await writeFile(resolve(dir, 'v0.10.0.md'), '# v0.10.0 — newer\n\nnew');
			await writeFile(resolve(dir, 'README.md'), 'not a release');
			const notes = await latestRelease(dir, ORDERING);
			expect(notes?.title).toBe('v0.10.0 — newer');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('null when there are no release files', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-releases-'));
		try {
			expect(await latestRelease(dir, ORDERING)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('allReleases is every release, newest first, and nothing else in the directory', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-releases-'));
		try {
			for (const v of ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0']) await writeFile(resolve(dir, `${v}.md`), `# ${v}\n\nbody`);
			await writeFile(resolve(dir, 'before-releases.md'), '- @someone');
			const all = await allReleases(dir, ORDERING);
			expect(all.map((n) => n.version)).toEqual(['v1.3.0', 'v1.2.0', 'v1.1.0', 'v1.0.0']);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('keeps a body under the cap in one embed', () => {
		const notes = parseNotes('v1.0.0', '# v1.0.0 — short\n\nOne line.\n\n## Fixed\n\n- A fix.');
		const embeds = releaseEmbeds(notes, 'https://example.com/');
		expect(embeds).toHaveLength(1);
		expect(embeds[0]).toEqual({ title: notes.title, description: forDiscord(notes.body), url: 'https://example.com/', color: 0x2f855a });
	});

	it('joins a wrapped sentence back into one line and drops the blank lines beside a heading, keeping list items and fences apart', () => {
		const body = [
			'Some app now has its own Discord server. Big turns',
			'also got a lot smoother.',
			'',
			'## New',
			'',
			'- **A Discord button in the top bar**, next to the theme picker. It opens',
			'  the invite.',
			'- **Patch notes post themselves.**',
			'',
			'```',
			'kept',
			'as is',
			'```',
		].join('\n');
		expect(forDiscord(body)).toBe(
			[
				'Some app now has its own Discord server. Big turns also got a lot smoother.',
				'## New',
				'- **A Discord button in the top bar**, next to the theme picker. It opens the invite.',
				'- **Patch notes post themselves.**',
				'',
				'```',
				'kept',
				'as is',
				'```',
			].join('\n'),
		);
	});

	it('splits a long body at ## headings, never truncating', () => {
		const section = (n: number): string => `## Part ${n}\n\n${'- a line of notes\n'.repeat(150)}`;
		const body = `Intro.\n\n${section(1)}\n${section(2)}\n${section(3)}`;
		const pieces = splitBody(body);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(4096);
		expect(pieces.slice(1).every((p) => p.startsWith('## Part'))).toBe(true);
		expect(pieces.join('\n').replace(/\s+/g, '')).toBe(body.replace(/\s+/g, ''));
	});

	it('cuts a single oversized section at line breaks', () => {
		const body = `## Huge\n\n${'- x'.repeat(10).concat('\n').repeat(300)}`;
		const pieces = splitBody(body, 1000);
		for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(1000);
		expect(pieces.join('\n').replace(/\s+/g, '')).toBe(body.replace(/\s+/g, ''));
	});

	it('treats a file with no heading as all body', () => {
		expect(parseNotes('v1.0.0', 'just text')).toEqual({ version: 'v1.0.0', title: 'v1.0.0', body: 'just text' });
	});
});

describe('credits', () => {
	it('creditsIn is every @name, once each, in order, without a sentence’s full stop', () => {
		const body = '## Fixed\n- The grid holds still in Rally. (@ohmusama)\n- A wheel scrolls one thing. Thanks @OhMuSama and @bob.\n- Mail me at a@b.c, see example.com/@x';
		expect(creditsIn(body)).toEqual(['ohmusama', 'bob']);
		expect(creditsIn('## Fixed\n- Something.')).toEqual([]);
	});

	it('shows each credit bold, italic and underlined, never as an @, escaping markup in a name', () => {
		expect(showCredits('- A fix. (@ohmusama, @the.scrubdaddy)\n- Mail a@b.c')).toBe('- A fix. (***__ohmusama__***, ***__the.scrubdaddy__***)\n- Mail a@b.c');
		expect(creditMark('snake_case*')).toBe('***__snake\\_case\\*__***');
	});

	it('the posted notes carry no @ at all', () => {
		const embeds = releaseEmbeds(parseNotes('v1.0.0', '# v1.0.0 — t\n\n## Fixed\n- A fix. (@ohmusama)'), 'https://example.com/');
		expect(embeds[0]!.description).toBe('## Fixed\n- A fix. (***__ohmusama__***)');
	});

	it('counts one credit per bullet across every release, most first, then by name, one person whatever the case', () => {
		const releases = [
			parseNotes('v1.1.0', '# v1.1.0\n\n## Fixed\n- One. (@bob)\n- Two. (@Ohmusama, @bob)\n- Three, said twice. (@zed) (@zed)'),
			parseNotes('v1.0.0', '# v1.0.0\n\n## Fixed\n- Wrapped over\n  two lines. (@ohmusama)\n- Four. (@amy)'),
		];
		expect(creditCounts(releases)).toEqual([
			{ name: 'bob', count: 2 },
			{ name: 'Ohmusama', count: 2 },
			{ name: 'amy', count: 1 },
			{ name: 'zed', count: 1 },
		]);
	});

	it('the credits post is a plain numbered list, then a sentence thanking the people from before the notes, and null when there is nobody', () => {
		const releases = [parseNotes('v1.0.0', '# v1.0.0\n\n## Fixed\n- One. (@bob)\n- Two. (@bob, @amy)')];
		expect(creditsBody(releases, ['early', 'bird', 'owl'])).toBe(
			['1. bob — 2', '2. amy — 1', '', 'Extra thanks to early, bird, and owl, who contributed many things before the release notes started crediting anyone.'].join('\n'),
		);
		expect(creditsBody([parseNotes('v1.0.0', '# v1.0.0\n\n- Nobody.')], [])).toBeNull();
		expect(creditsBody([], ['early'])).toBe('Extra thanks to early, who contributed many things before the release notes started crediting anyone.');
		expect(creditsBody([], ['early', 'bird'])).toBe('Extra thanks to early and bird, who contributed many things before the release notes started crediting anyone.');
	});
});

describe('announceRelease', () => {
	it('sends no mentions and no content: a credit is shown, nobody is pinged', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v9.9.0.md'), '# v9.9.0 — thanks\n\n## Fixed\n- The grid holds still in Rally. (@ohmusama)\n');
			const bot = await archivebot(() => [200, { success: true, messageId: '1' }]);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			const sent = JSON.parse(bot.received[0]!.raw);
			expect(sent).not.toHaveProperty('mentions');
			expect(sent).not.toHaveProperty('content');
			expect(sent.embeds[0].description).toContain('(***__ohmusama__***)');
			expect(entries[0]).toEqual({ event: 'release-announce', outcome: 'posted', version: 'v9.9.0' });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('posts the release once per key, signed, with idempotencyKey and source named by `service`', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v2.0.0.md'), '# v2.0.0 — t\n\n## Fixed\n- A fix.\n');
			const bot = await archivebot(() => [200, { success: true, messageId: '1' }]);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			expect(bot.received.filter((r) => r.url === '/api/messages/send')).toHaveLength(1);
			const sent = JSON.parse(bot.received[0].raw);
			expect(sent).toMatchObject({ idempotencyKey: 'myapp-release-v2.0.0', source: 'myapp' });
			expect(sent).not.toHaveProperty('channel_id');
			expect(Math.abs(sent.timestamp - Date.now())).toBeLessThan(60_000);
			expect(entries).toEqual([{ event: 'release-announce', outcome: 'posted', version: 'v2.0.0' }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('then re-sends every release as an edit that keeps its record and can find an old post, logging only the posts it changed', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			for (const v of ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0']) await writeFile(resolve(dir, `${v}.md`), `# ${v} — t\n\n## Fixed\n- A fix.\n`);
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0 — t\n\n## New\n- Mana floating asks first. (@the.scrubdaddy)\n');
			const bot = await archivebot(
				() => [200, { success: true, messageId: '1' }],
				(key) => (key === 'myapp-release-v1.0.0' ? [200, { success: true, messageId: '2', edited: true }] : [200, { success: true, messageId: '3', unchanged: true }]),
			);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			const edits = bot.received.filter((r) => r.url === '/api/messages/edit').map((r) => JSON.parse(r.raw));
			expect(edits.filter((e) => e.idempotencyKey.startsWith('myapp-release-')).map((e) => [e.idempotencyKey, e.retain, e.find])).toEqual(
				['v1.3.0', 'v1.2.0', 'v1.1.0', 'v1.0.0'].map((v) => [`myapp-release-${v}`, true, { titlePrefix: `${v} ` }]),
			);
			expect(edits.find((e) => e.idempotencyKey === 'myapp-release-v1.0.0').embeds[0].description).toContain('(***__the.scrubdaddy__***)');
			expect(entries.filter((e) => e.event !== 'release-credits')).toEqual([
				{ event: 'release-announce', outcome: 'posted', version: 'v1.3.0' },
				{ event: 'release-edit', outcome: 'edited', version: 'v1.0.0' },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('deletes the older releases\' credits, posts the notes, edits, then posts this release\'s credits last', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0 — t\n\n## Fixed\n- One. (@bob)\n');
			await writeFile(resolve(dir, 'v1.1.0.md'), '# v1.1.0 — t\n\n## Fixed\n- Two. (@amy, @bob)\n');
			await writeFile(resolve(dir, 'before-releases.md'), '# Before\n\n- @early\n');
			const bot = await archivebot(
				() => [200, { success: true, messageId: '1' }],
				() => [200, { success: true, unchanged: true }],
				(key) => (key === 'myapp-credits-v1.0.0' ? [200, { success: true, deleted: true }] : NOT_FOUND),
			);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log, earlierCreditsFile: resolve(dir, 'before-releases.md') });
			expect(bot.received.map((r) => `${r.url} ${JSON.parse(r.raw).idempotencyKey}`)).toEqual([
				'/api/messages/delete myapp-credits-v1.0.0',
				'/api/messages/send myapp-release-v1.1.0',
				'/api/messages/edit myapp-release-v1.1.0',
				'/api/messages/edit myapp-release-v1.0.0',
				'/api/messages/send myapp-credits-v1.1.0',
			]);
			const credits = JSON.parse(bot.received.at(-1)!.raw);
			expect(credits).toMatchObject({ retain: true, source: SERVICE });
			expect(credits).not.toHaveProperty('mentions');
			expect(credits.embeds).toEqual([
				{ title: 'Credits & attribution', description: creditsBody(await allReleases(dir, ORDERING), ['early']), url: 'https://example.com/', color: 0x2f855a },
			]);
			expect(entries).toEqual([
				{ event: 'release-credits', outcome: 'deleted', version: 'v1.0.0' },
				{ event: 'release-announce', outcome: 'posted', version: 'v1.1.0' },
				{ event: 'release-credits', outcome: 'posted', version: 'v1.1.0' },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('credits already posted are edited instead, so a credit added later shows', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0 — t\n\n## Fixed\n- One. (@bob)\n');
			const bot = await archivebot(
				() => [200, { success: true, messageId: '1', deduped: true }],
				(key) => (key === 'myapp-credits-v1.0.0' ? [200, { success: true, edited: true }] : [200, { success: true, unchanged: true }]),
			);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log, earlierCreditsFile: resolve(dir, 'missing.md') });
			expect(bot.received.at(-1)!.url).toBe('/api/messages/edit');
			expect(entries).toEqual([
				{ event: 'release-announce', outcome: 'already-posted', version: 'v1.0.0' },
				{ event: 'release-credits', outcome: 'edited', version: 'v1.0.0' },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('posts no credits when nobody is credited', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0 — t\n\n## Fixed\n- One.\n');
			const bot = await archivebot(() => [200, { success: true, messageId: '1' }]);
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log: logs().log });
			expect(bot.received.map((r) => JSON.parse(r.raw).idempotencyKey)).not.toContain('myapp-credits-v1.0.0');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('a failed send makes no edits', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0\n\nbody');
			const bot = await archivebot(() => [500, { error: 'boom' }], () => [200, { edited: true }]);
			const { log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			expect(bot.received.map((r) => r.url)).toEqual(['/api/messages/send']);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('logs a deduped reply as already posted', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0\n\nbody');
			const bot = await archivebot(() => [200, { success: true, messageId: '1', deduped: true }]);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			expect(entries[0]).toMatchObject({ outcome: 'already-posted' });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('skips, naming secretEnvName, without a secret and sends nothing', async () => {
		const bot = await archivebot(() => [200, { success: true }]);
		const { entries, log } = logs();
		await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: '/does/not/matter', secret: '', secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
		expect(bot.received).toHaveLength(0);
		expect(entries[0]).toEqual({ event: 'release-announce', outcome: 'skipped', reason: 'no SOME_WEBHOOK_SECRET' });
	});

	it('skips when there are no release notes', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			const bot = await archivebot(() => [200, { success: true }]);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			expect(bot.received).toHaveLength(0);
			expect(entries[0]).toMatchObject({ outcome: 'skipped' });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('logs a refusal with its status and resolves', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0\n\nbody');
			const bot = await archivebot(() => [400, { error: 'invalid_embeds', detail: 'embeds[0].image is not accepted' }]);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			expect(entries[0]).toMatchObject({ outcome: 'failed', status: 400 });
			expect(String(entries[0].reply)).toContain('invalid_embeds');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('logs a wrong secret as the 401 it is', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0\n\nbody');
			const bot = await archivebot(() => [200, { success: true }]);
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: 'wrong', secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: bot.url, appUrl: 'https://example.com/', log });
			expect(entries[0]).toMatchObject({ outcome: 'failed', status: 401 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('resolves when ArchiveBot is down', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'service-kernel-announce-'));
		try {
			await writeFile(resolve(dir, 'v1.0.0.md'), '# v1.0.0\n\nbody');
			const { entries, log } = logs();
			await announceRelease({ service: SERVICE, ordering: ORDERING, releasesDir: dir, secret: SECRET, secretEnvName: 'SOME_WEBHOOK_SECRET', archivebotUrl: 'http://127.0.0.1:1', appUrl: 'https://example.com/', log });
			expect(entries[0]).toMatchObject({ outcome: 'failed' });
			expect(entries[0].error).toBeTruthy();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
