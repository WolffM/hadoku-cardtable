/*
 * The boot announcement against the repo's real release notes and a loopback server that checks
 * the request the way ArchiveBot does (HMAC-SHA256 of the raw body, `sha256=<hex>`).
 */
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { announceRelease, latestRelease, parseNotes, releaseEmbeds, splitBody, unwrap } from './announce.ts';

const RELEASES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/releases');
const SECRET = 'test-secret';

interface Received {
	signature: string | undefined;
	raw: string;
}

let server: Server | null = null;

afterEach(async () => {
	await new Promise<void>((done) => (server === null ? done() : server.close(() => done())));
	server = null;
});

/** A stand-in ArchiveBot: verifies the signature, answers like `/api/messages/send`. */
async function archivebot(reply: () => [number, unknown]): Promise<{ url: string; received: Received[] }> {
	const received: Received[] = [];
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		req.on('end', () => {
			const signature = req.headers['x-hadoku-signature'] as string | undefined;
			received.push({ signature, raw });
			const expected = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
			const [status, body] =
				req.url !== '/api/messages/send' ? [404, { error: 'not_found' }] : signature !== expected ? [401, { error: 'invalid_signature' }] : reply();
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
	it('reads the newest notes in the repo, titled by their heading', async () => {
		const notes = await latestRelease(RELEASES);
		expect(notes?.version).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(notes?.title).not.toMatch(/^#/);
		expect(notes?.body).not.toContain(`# ${notes?.title}`);
	});

	it('orders by semver, not by name', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'cardtable-releases-'));
		try {
			await writeFile(resolve(dir, 'v0.9.0.md'), '# v0.9.0 — older\n\nold');
			await writeFile(resolve(dir, 'v0.10.0.md'), '# v0.10.0 — newer\n\nnew');
			await writeFile(resolve(dir, 'README.md'), 'not a release');
			expect((await latestRelease(dir))?.title).toBe('v0.10.0 — newer');
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it('keeps a body under the cap in one embed', async () => {
		const notes = (await latestRelease(RELEASES))!;
		const embeds = releaseEmbeds(notes, 'https://hadoku.me/cardtable/');
		expect(embeds).toHaveLength(1);
		// The title already names the version and Discord dates the message: no footer, no timestamp.
		expect(embeds[0]).toEqual({ title: notes.title, description: unwrap(notes.body), url: 'https://hadoku.me/cardtable/', color: 0x2f855a });
	});

	it('joins a wrapped sentence back into one line, keeping paragraphs, headings and list items apart', () => {
		const body = [
			'Card Table now has its own Discord server. Big turns',
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
		expect(unwrap(body)).toBe(
			[
				'Card Table now has its own Discord server. Big turns also got a lot smoother.',
				'',
				'## New',
				'',
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

	it('posts no line of a release notes file broken mid-sentence', async () => {
		for (const name of (await readdir(RELEASES)).filter((n) => /^v\d+\.\d+\.\d+\.md$/.test(n))) {
			const notes = parseNotes(name.slice(0, -3), await readFile(resolve(RELEASES, name), 'utf8'));
			const lines = unwrap(notes.body).split('\n');
			lines.forEach((line, i) => {
				const next = lines[i + 1] ?? '';
				if (line.trim() !== '' && next.trim() !== '') expect(next, `${name}: "${line}" then "${next}"`).toMatch(/^\s*(#|[-*+] |\d+\. |>|```)/);
			});
		}
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

describe('announceRelease', () => {
	it('posts the release once per key, signed, to #announcements by default', async () => {
		const bot = await archivebot(() => [200, { success: true, messageId: '1' }]);
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: SECRET, archivebotUrl: bot.url, appUrl: 'https://hadoku.me/cardtable/', log });
		const notes = (await latestRelease(RELEASES))!;
		expect(bot.received).toHaveLength(1);
		const sent = JSON.parse(bot.received[0].raw);
		expect(sent).toMatchObject({ idempotencyKey: `cardtable-release-${notes.version}`, source: 'cardtable' });
		expect(sent).not.toHaveProperty('channel_id');
		expect(Math.abs(sent.timestamp - Date.now())).toBeLessThan(60_000);
		expect(entries).toEqual([{ event: 'release-announce', outcome: 'posted', version: notes.version }]);
	});

	it('logs a deduped reply as already posted', async () => {
		const bot = await archivebot(() => [200, { success: true, messageId: '1', deduped: true }]);
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: SECRET, archivebotUrl: bot.url, appUrl: 'https://hadoku.me/cardtable/', log });
		expect(entries[0]).toMatchObject({ outcome: 'already-posted' });
	});

	it('skips without a secret and sends nothing', async () => {
		const bot = await archivebot(() => [200, { success: true }]);
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: '', archivebotUrl: bot.url, appUrl: 'https://hadoku.me/cardtable/', log });
		expect(bot.received).toHaveLength(0);
		expect(entries[0]).toMatchObject({ outcome: 'skipped' });
	});

	it('logs a refusal with its status and resolves', async () => {
		const bot = await archivebot(() => [400, { error: 'invalid_embeds', detail: 'embeds[0].image is not accepted' }]);
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: SECRET, archivebotUrl: bot.url, appUrl: 'https://hadoku.me/cardtable/', log });
		expect(entries[0]).toMatchObject({ outcome: 'failed', status: 400 });
		expect(String(entries[0].reply)).toContain('invalid_embeds');
	});

	it('logs a wrong secret as the 401 it is', async () => {
		const bot = await archivebot(() => [200, { success: true }]);
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: 'wrong', archivebotUrl: bot.url, appUrl: 'https://hadoku.me/cardtable/', log });
		expect(entries[0]).toMatchObject({ outcome: 'failed', status: 401 });
	});

	it('resolves when ArchiveBot is down', async () => {
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: SECRET, archivebotUrl: 'http://127.0.0.1:1', appUrl: 'https://hadoku.me/cardtable/', log });
		expect(entries[0]).toMatchObject({ outcome: 'failed' });
		expect(entries[0].error).toBeTruthy();
	});
});
