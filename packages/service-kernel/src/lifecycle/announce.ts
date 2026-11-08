/*
 * Prod posts its release's patch notes to a Discord server's #announcements at boot, through
 * ArchiveBot's signed `/api/messages/send` (contract: docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md).
 *
 * The release is the newest `vX.Y.Z.md` release notes file in the tree. Every boot sends; the
 * idempotency key `<service>-release-<version>` is deduped by ArchiveBot for 7 days, so a restart
 * posts nothing new.
 *
 * A bug's reporter is named in its bullet as `@name` (their hadoku name; docs/RELEASE.md § "Attribution").
 * Those names ride as `mentions`, and ArchiveBot turns each `@name` in the notes into the person's
 * Discord mention, inline where the bullet credits them. No separate thank-you line.
 *
 * `secret` is the app's webhook secret (empty = skip, never an error); a failed post never blocks
 * boot, and the next boot retries it.
 *
 * `ordering` decides which release files are newest: the kernel does not read a release-notes
 * directory layout itself. The app supplies it (cardtable's adapter injects
 * `scripts/release/build-version.ts`'s `newestReleaseFile`/`releaseFilesNewestFirst`, since the
 * kernel cannot import `scripts/`).
 *
 * Imports only; nothing runs at import.
 */
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonLog } from '../log/log.ts';

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

/**
 * How release-notes file names are ordered: the kernel knows no directory layout of its own, so
 * the app supplies this (cardtable's adapter binds `scripts/release/build-version.ts`).
 */
export interface ReleaseOrdering {
	/** The newest release file name among `names`, or null when there is none. */
	newest(names: readonly string[]): string | null;
	/** Every release file name among `names`, newest first. */
	newestFirst(names: readonly string[]): string[];
}

/** The newest release notes in `dir`, by `ordering`, or null when there are none. */
export async function latestRelease(dir: string, ordering: ReleaseOrdering): Promise<ReleaseNotes | null> {
	const newest = ordering.newest(await readdir(dir));
	if (newest === null) return null;
	return parseNotes(newest.slice(0, -'.md'.length), await readFile(join(dir, newest), 'utf8'));
}

/**
 * How many releases, newest first, a boot re-sends as edits. ArchiveBot keeps a post's record for 7
 * days and refuses an edit it has no record of, so older notes cannot be changed this way anyway.
 */
export const EDITABLE_RELEASES = 3;

/** The newest `count` release notes in `dir`, newest first, by `ordering`. */
export async function recentReleases(dir: string, ordering: ReleaseOrdering, count = EDITABLE_RELEASES): Promise<ReleaseNotes[]> {
	const names = ordering.newestFirst(await readdir(dir)).slice(0, count);
	return Promise.all(names.map(async (name) => parseNotes(name.slice(0, -'.md'.length), await readFile(join(dir, name), 'utf8'))));
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

export function releaseEmbeds(notes: ReleaseNotes, appUrl: string): Embed[] {
	return splitBody(forDiscord(notes.body)).map((description, i) => ({
		...(i === 0 ? { title: notes.title } : {}),
		description,
		url: appUrl,
		color: 0x2f855a,
	}));
}

export interface AnnounceOptions {
	/** This app's id: the idempotency key and `source` field are `<service>-release-<version>` / `service`. */
	service: string;
	ordering: ReleaseOrdering;
	releasesDir: string;
	/** The app's webhook secret; empty = skip. */
	secret: string;
	/** The secret's env var name, used only in the "no secret" skip log line. */
	secretEnvName: string;
	archivebotUrl: string;
	appUrl: string;
	log: JsonLog;
	fetch?: typeof fetch;
	now?: () => Date;
}

/** The signed ArchiveBot request for one release's notes: its idempotency key is the release's own. */
function notesPayload(service: string, notes: ReleaseNotes, appUrl: string, now: Date): string {
	const mentions = mentionsIn(notes.body);
	return JSON.stringify({
		idempotencyKey: `${service}-release-${notes.version}`,
		timestamp: now.getTime(),
		source: service,
		...(mentions.length === 0 ? {} : { mentions }),
		embeds: releaseEmbeds(notes, appUrl),
	});
}

async function postSigned(options: AnnounceOptions, path: string, body: string): Promise<Response> {
	const signature = createHmac('sha256', options.secret).update(body).digest('hex');
	return (options.fetch ?? fetch)(`${options.archivebotUrl}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Hadoku-Signature': `sha256=${signature}` },
		body,
		signal: AbortSignal.timeout(10_000),
	});
}

/**
 * Post the current release's notes, then re-send the newest few as edits, so a corrected notes file
 * (a credit added to a bullet, a typo) changes its post at the next boot. ArchiveBot edits only a post
 * whose shown text differs and never posts from an edit. Resolves on every outcome; the outcome is
 * logged, never thrown.
 */
export async function announceRelease(options: AnnounceOptions): Promise<void> {
	const { log, service, ordering } = options;
	if (options.secret === '') {
		log({ event: 'release-announce', outcome: 'skipped', reason: `no ${options.secretEnvName}` });
		return;
	}
	const now = () => (options.now ?? (() => new Date()))();
	try {
		const notes = await latestRelease(options.releasesDir, ordering);
		if (notes === null) {
			log({ event: 'release-announce', outcome: 'skipped', reason: `no release notes in ${options.releasesDir}` });
			return;
		}
		const res = await postSigned(options, '/api/messages/send', notesPayload(service, notes, options.appUrl, now()));
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
			// A name ArchiveBot could not match to anyone is posted as plain text: say so, so it can be fixed.
			...(answer.unresolved !== undefined && answer.unresolved.length > 0 ? { unresolved: answer.unresolved } : {}),
		});
	} catch (err) {
		log({ event: 'release-announce', outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
		return;
	}
	let recent: ReleaseNotes[];
	try {
		recent = await recentReleases(options.releasesDir, ordering);
	} catch (err) {
		log({ event: 'release-edit', outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
		return;
	}
	for (const notes of recent) {
		try {
			const res = await postSigned(options, '/api/messages/edit', notesPayload(service, notes, options.appUrl, now()));
			const reply = await res.text();
			// 404: ArchiveBot holds no post for it (older than its 7-day record): nothing to change.
			if (res.status === 404) continue;
			if (!res.ok) {
				log({ event: 'release-edit', outcome: 'failed', version: notes.version, status: res.status, reply: reply.slice(0, 500) });
				continue;
			}
			const answer = JSON.parse(reply) as { edited?: boolean; unresolved?: string[] };
			if (answer.edited !== true) continue;
			log({
				event: 'release-edit',
				outcome: 'edited',
				version: notes.version,
				...(answer.unresolved !== undefined && answer.unresolved.length > 0 ? { unresolved: answer.unresolved } : {}),
			});
		} catch (err) {
			log({ event: 'release-edit', outcome: 'failed', version: notes.version, error: err instanceof Error ? err.message : String(err) });
		}
	}
}
