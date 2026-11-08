/*
 * The frozen pin: cardtable's idempotency key (`cardtable-release-<version>`), its `source` field
 * (`cardtable`) and the secret-skip reason naming `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` — plus a
 * few checks against this repo's REAL `docs/releases` content (length caps, no mid-sentence
 * breaks, the pending-notes style rule), which a synthetic fixture cannot stand in for. The
 * generic logic (parseNotes, splitBody, forDiscord, mentionsIn, the full announceRelease flow)
 * is proved in `@hadoku/service-kernel`'s own suite now (w93-K2).
 */
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { announceRelease, latestRelease, parseNotes, releaseEmbeds, forDiscord } from './announce.ts';

const RELEASES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/releases');
const SECRET = 'test-secret';

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

/** A stand-in ArchiveBot: verifies the signature, answers like `/api/messages/send`. */
async function archivebot(reply: () => [number, unknown]): Promise<{ url: string; received: Received[] }> {
	const received: Received[] = [];
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		req.on('end', () => {
			const signature = req.headers['x-hadoku-signature'] as string | undefined;
			received.push({ url: req.url, signature, raw });
			const expected = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
			const [status, body] = signature !== expected ? [401, { error: 'invalid_signature' }] : req.url === '/api/messages/send' ? reply() : [404, { error: 'not_found' }];
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

describe('release notes against this repo\'s real docs/releases', () => {
	it('reads the newest notes in the repo, titled by their heading', async () => {
		const notes = await latestRelease(RELEASES);
		expect(notes?.version).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(notes?.title).not.toMatch(/^#/);
		expect(notes?.body).not.toContain(`# ${notes?.title}`);
	});

	it('orders by semver through the real build-version ordering, not by name', async () => {
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

	it('fits every release in one Discord message — 6000 characters across its embeds', async () => {
		for (const name of (await readdir(RELEASES)).filter((n) => /^v\d+\.\d+\.\d+\.md$/.test(n))) {
			const notes = parseNotes(name.slice(0, -3), await readFile(resolve(RELEASES, name), 'utf8'));
			const embeds = releaseEmbeds(notes, 'https://hadoku.me/cardtable/');
			const length = embeds.reduce((sum, e) => sum + (e.title?.length ?? 0) + e.description.length, 0);
			expect(length, name).toBeLessThanOrEqual(6000);
		}
	});

	it('has no pending note with a bullet bold from end to end — only a big feature bolds its lead (docs/RELEASE.md)', async () => {
		const pending = resolve(RELEASES, 'pending');
		for (const name of (await readdir(pending)).filter((n) => n.endsWith('.md') && n !== 'README.md')) {
			const bullets = forDiscord(await readFile(resolve(pending, name), 'utf8')).split('\n').filter((line) => line.startsWith('- '));
			for (const bullet of bullets) expect(bullet, `${name}: ${bullet}`).not.toMatch(/^- \*\*[^*]+\*\*$/);
		}
	});

	it('posts no line of a release notes file broken mid-sentence', async () => {
		for (const name of (await readdir(RELEASES)).filter((n) => /^v\d+\.\d+\.\d+\.md$/.test(n))) {
			const notes = parseNotes(name.slice(0, -3), await readFile(resolve(RELEASES, name), 'utf8'));
			const lines = forDiscord(notes.body).split('\n');
			lines.forEach((line, i) => {
				const next = lines[i + 1] ?? '';
				if (line.trim() !== '' && next.trim() !== '') expect(next, `${name}: "${line}" then "${next}"`).toMatch(/^\s*(#|[-*+] |\d+\. |>|```)/);
			});
		}
	});
});

describe('announceRelease: cardtable\'s own frozen literals', () => {
	it('posts the release once per key, signed, with idempotencyKey "cardtable-release-<version>" and source "cardtable"', async () => {
		const bot = await archivebot(() => [200, { success: true, messageId: '1' }]);
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: SECRET, archivebotUrl: bot.url, appUrl: 'https://hadoku.me/cardtable/', log });
		const notes = (await latestRelease(RELEASES))!;
		expect(bot.received.filter((r) => r.url === '/api/messages/send')).toHaveLength(1);
		const sent = JSON.parse(bot.received[0].raw);
		expect(sent).toMatchObject({ idempotencyKey: `cardtable-release-${notes.version}`, source: 'cardtable' });
		expect(entries).toEqual([{ event: 'release-announce', outcome: 'posted', version: notes.version }]);
	});

	it('skips, naming ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET, without a secret and sends nothing', async () => {
		const bot = await archivebot(() => [200, { success: true }]);
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: '', archivebotUrl: bot.url, appUrl: 'https://hadoku.me/cardtable/', log });
		expect(bot.received).toHaveLength(0);
		expect(entries).toEqual([{ event: 'release-announce', outcome: 'skipped', reason: 'no ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET' }]);
	});

	it('resolves when ArchiveBot is down', async () => {
		const { entries, log } = logs();
		await announceRelease({ releasesDir: RELEASES, secret: SECRET, archivebotUrl: 'http://127.0.0.1:1', appUrl: 'https://hadoku.me/cardtable/', log });
		expect(entries[0]).toMatchObject({ outcome: 'failed' });
		expect(entries[0].error).toBeTruthy();
	});
});
