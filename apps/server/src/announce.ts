/*
 * Prod posts its release's patch notes to the Discord server's #announcements at boot, through
 * ArchiveBot's signed `/api/messages/send` (contract: docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md).
 *
 * The release is the newest `docs/releases/vX.Y.Z.md` in the tree: `release.yml` refuses a sha
 * without that file, and prod only ever runs a released sha. Every boot sends; the idempotency key
 * `cardtable-release-<version>` is deduped by ArchiveBot for 7 days, so a restart posts nothing new.
 *
 * A bug's reporter is named in its bullet as `@name` (their hadoku name; docs/RELEASE.md § "Attribution").
 * Those names ride as `mentions` with a thank-you line as `content`, and ArchiveBot turns each one into
 * the Discord account linked to it, so the people who reported what the release fixed are pinged.
 *
 * Prod only, by the secret: PPE's wrapper deliberately does not hold it, and an unset secret is a
 * skip, not an error. A failed post never blocks boot; the next boot retries it.
 *
 * Imports only; nothing runs at import (the server is one bundle — see `index.ts`).
 */
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newestReleaseFile } from '../../../scripts/release/build-version.js';
import type { JsonLog } from './log.js';

/** ArchiveBot's per-embed description cap. */
const DESCRIPTION_MAX = 4096;

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
}

/** The newest release notes in `dir`, by semver, or null when there are none. */
export async function latestRelease(dir: string): Promise<ReleaseNotes | null> {
	const newest = newestReleaseFile(await readdir(dir));
	if (newest === null) return null;
	return parseNotes(newest.slice(0, -'.md'.length), await readFile(join(dir, newest), 'utf8'));
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

/** A line that starts its own block in Markdown: a heading, a list item, a quote, a fence. */
const BLOCK_START = /^\s*(#|[-*+] |\d+\. |>|```)/;

/**
 * The body as Discord should get it. Discord breaks the line at every newline it is sent, and a
 * notes file is wrapped at about a hundred columns, so a line that continues the one above is
 * joined to it. Discord also spaces a heading by itself, so a blank line beside one would double
 * the gap: those go. Other blank lines, block starts and anything inside a code fence stay.
 */
export function forDiscord(body: string): string {
	const out: string[] = [];
	let fenced = false;
	for (const line of body.split('\n')) {
		const fence = line.trimStart().startsWith('```');
		const last = out.length - 1;
		if (!fenced && !fence && line.trim() !== '' && last >= 0 && out[last].trim() !== '' && !BLOCK_START.test(line) && !out[last].trimStart().startsWith('#')) {
			out[last] = `${out[last].trimEnd()} ${line.trim()}`;
		} else {
			out.push(line);
		}
		if (fence) fenced = !fenced;
	}
	const heading = (line: string | undefined): boolean => line !== undefined && line.trimStart().startsWith('#');
	return out.filter((line, i) => line.trim() !== '' || !(heading(out[i - 1]) || heading(out[i + 1]))).join('\n');
}

/**
 * Who a release thanks: every `@name` in its notes, the hadoku name of whoever reported a bug the
 * release fixes (docs/RELEASE.md § "Attribution"), each once, in the order the notes first name them.
 * A sentence's closing full stop is not part of a name.
 */
export function mentionsIn(body: string): string[] {
	const names = new Map<string, string>();
	for (const match of body.matchAll(/(?<![\w@/])@([A-Za-z0-9_.-]+)/g)) {
		const name = match[1]!.replace(/[.-]+$/, '');
		if (name !== '' && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
	}
	return [...names.values()];
}

/** The line above the embeds that pings them: Discord never pings from an embed. ArchiveBot turns each `@name` into the person. */
export function thanksLine(mentions: readonly string[]): string {
	return `Thanks for the reports: ${mentions.map((name) => `@${name}`).join(' ')}`;
}

export function releaseEmbeds(notes: ReleaseNotes, appUrl: string): Embed[] {
	return splitBody(forDiscord(notes.body)).map((description, i) => ({
		...(i === 0 ? { title: notes.title } : {}),
		description,
		url: appUrl,
		color: 0x2f855a,
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
		const mentions = mentionsIn(notes.body);
		const body = JSON.stringify({
			idempotencyKey: `cardtable-release-${notes.version}`,
			timestamp: now.getTime(),
			source: 'cardtable',
			...(mentions.length === 0 ? {} : { content: thanksLine(mentions), mentions }),
			embeds: releaseEmbeds(notes, options.appUrl),
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
		const answer = JSON.parse(reply) as { deduped?: boolean; unresolved?: string[] };
		log({
			event: 'release-announce',
			outcome: answer.deduped === true ? 'already-posted' : 'posted',
			version: notes.version,
			// A name no linked Discord account carries is posted as plain text: say so, so it can be fixed.
			...(answer.unresolved !== undefined && answer.unresolved.length > 0 ? { unresolved: answer.unresolved } : {}),
		});
	} catch (err) {
		log({ event: 'release-announce', outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
	}
}
