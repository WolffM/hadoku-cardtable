/*
 * Prod posts its release's patch notes to the Discord server's #announcements at boot, through
 * ArchiveBot's signed `/api/messages/send` (contract: docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md).
 *
 * The release is the newest `docs/releases/vX.Y.Z.md` in the tree: `release.yml` refuses a sha
 * without that file, and prod only ever runs a released sha. Every boot sends; the idempotency key
 * `cardtable-release-<version>` is deduped by ArchiveBot for 7 days, so a restart posts nothing new.
 *
 * Prod only, by the secret: PPE's wrapper deliberately does not hold it, and an unset secret is a
 * skip, not an error. A failed post never blocks boot; the next boot retries it.
 *
 * Imports only; nothing runs at import (the server is one bundle — see `index.ts`).
 */
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonLog } from './log.js';

/** ArchiveBot's per-embed description cap. */
const DESCRIPTION_MAX = 4096;
const RELEASE_FILE = /^v(\d+)\.(\d+)\.(\d+)\.md$/;

export interface ReleaseNotes {
	version: string;
	title: string;
	body: string;
}

export interface Embed {
	title?: string;
	description: string;
	url: string;
	color: number;
	footer: { text: string };
	timestamp: string;
}

/** The newest release notes in `dir`, by semver, or null when there are none. */
export async function latestRelease(dir: string): Promise<ReleaseNotes | null> {
	const files = (await readdir(dir)).flatMap((name) => {
		const m = RELEASE_FILE.exec(name);
		return m === null ? [] : [{ name, parts: [Number(m[1]), Number(m[2]), Number(m[3])] }];
	});
	if (files.length === 0) return null;
	files.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
	const newest = files[0];
	return parseNotes(newest.name.slice(0, -'.md'.length), await readFile(join(dir, newest.name), 'utf8'));
}

/** The `# ` heading is the title; everything after it is the body. */
export function parseNotes(version: string, text: string): ReleaseNotes {
	const lines = text.split('\n');
	const at = lines.findIndex((line) => line.startsWith('# '));
	if (at === -1) return { version, title: version, body: text.trim() };
	return { version, title: lines[at].slice(2).trim(), body: lines.slice(at + 1).join('\n').trim() };
}

/**
 * The body cut into descriptions of at most 4096 characters: whole `## ` sections packed in order,
 * and a section that alone is too long cut at line breaks. Never truncated.
 */
export function splitBody(body: string, max = DESCRIPTION_MAX): string[] {
	const sections = body.split(/\n(?=## )/);
	const pieces = sections.flatMap((section) => (section.length <= max ? [section] : splitLines(section, max)));
	const out: string[] = [];
	for (const piece of pieces) {
		const last = out.length - 1;
		if (last >= 0 && out[last].length + 1 + piece.length <= max) out[last] = `${out[last]}\n${piece}`;
		else out.push(piece);
	}
	return out.map((d) => d.trim()).filter((d) => d !== '');
}

function splitLines(section: string, max: number): string[] {
	const out: string[] = [];
	let current = '';
	for (const line of section.split('\n')) {
		// A single line past the cap is cut where it stands; nothing in a notes file comes close.
		for (let rest = line; ; rest = rest.slice(max)) {
			const chunk = rest.slice(0, max);
			if (current === '') current = chunk;
			else if (current.length + 1 + chunk.length <= max) current = `${current}\n${chunk}`;
			else {
				out.push(current);
				current = chunk;
			}
			if (rest.length <= max) break;
		}
	}
	if (current !== '') out.push(current);
	return out;
}

export function releaseEmbeds(notes: ReleaseNotes, appUrl: string, now: Date): Embed[] {
	return splitBody(notes.body).map((description, i) => ({
		...(i === 0 ? { title: notes.title } : {}),
		description,
		url: appUrl,
		color: 0x2f855a,
		footer: { text: `Card Table ${notes.version}` },
		timestamp: now.toISOString(),
	}));
}

export interface AnnounceOptions {
	releasesDir: string;
	/** `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`; empty = skip. */
	secret: string;
	archivebotUrl: string;
	appUrl: string;
	log: JsonLog;
	fetch?: typeof fetch;
	now?: () => Date;
}

/** Post the current release's notes. Resolves on every outcome; the outcome is logged, never thrown. */
export async function announceRelease(options: AnnounceOptions): Promise<void> {
	const { log } = options;
	if (options.secret === '') {
		log({ event: 'release-announce', outcome: 'skipped', reason: 'no ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET' });
		return;
	}
	try {
		const notes = await latestRelease(options.releasesDir);
		if (notes === null) {
			log({ event: 'release-announce', outcome: 'skipped', reason: `no release notes in ${options.releasesDir}` });
			return;
		}
		const now = (options.now ?? (() => new Date()))();
		const body = JSON.stringify({
			idempotencyKey: `cardtable-release-${notes.version}`,
			timestamp: now.getTime(),
			source: 'cardtable',
			embeds: releaseEmbeds(notes, options.appUrl, now),
		});
		const signature = createHmac('sha256', options.secret).update(body).digest('hex');
		const res = await (options.fetch ?? fetch)(`${options.archivebotUrl}/api/messages/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Hadoku-Signature': `sha256=${signature}` },
			body,
			signal: AbortSignal.timeout(10_000),
		});
		const reply = await res.text();
		if (!res.ok) {
			log({ event: 'release-announce', outcome: 'failed', version: notes.version, status: res.status, reply: reply.slice(0, 500) });
			return;
		}
		const deduped = (JSON.parse(reply) as { deduped?: boolean }).deduped === true;
		log({ event: 'release-announce', outcome: deduped ? 'already-posted' : 'posted', version: notes.version });
	} catch (err) {
		log({ event: 'release-announce', outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
	}
}
