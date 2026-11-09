/*
 * Prod posts its release's patch notes to a Discord server's #announcements at boot, through
 * ArchiveBot's signed `/api/messages/send` (contract: docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md).
 *
 * The release is the newest `vX.Y.Z.md` release notes file in the tree. Every boot sends; the
 * idempotency key `<service>-release-<version>` is deduped by ArchiveBot for 7 days, so a restart
 * posts nothing new.
 *
 * Whoever a bullet credits is named in it as `@name` (docs/RELEASE.md § "Attribution"). The post
 * shows each as ***__name__*** (bold, italic, underlined) and pings nobody: the operator, 2026-11-09,
 * "we should not do discord @ mentions anymore".
 *
 * Under the newest notes stands one credits post, "Credits & attribution": everyone the notes have
 * ever credited, most credits first, and the people the app's earlier-credits file names, who helped
 * before there were release notes. Each release deletes the previous release's credits post and
 * posts its own after its notes, so the credits are always the newest post.
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

/** Every release's notes in `dir`, newest first, by `ordering`. */
export async function allReleases(dir: string, ordering: ReleaseOrdering): Promise<ReleaseNotes[]> {
	const names = ordering.newestFirst(await readdir(dir));
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

/** A credit in notes text: `@name`, not inside a word, a path or an address; a closing full stop is not part of it. */
const CREDIT = /(?<![\w@/])@([A-Za-z0-9_.-]*[A-Za-z0-9_])/g;

/** Who a text credits: every `@name` in it, each once (case-insensitive), in the order it first names them. */
export function creditsIn(text: string): string[] {
	const names = new Map<string, string>();
	for (const match of text.matchAll(CREDIT)) {
		if (!names.has(match[1]!.toLowerCase())) names.set(match[1]!.toLowerCase(), match[1]!);
	}
	return [...names.values()];
}

/** A credited name as the post shows it: bold, italic and underlined, its own markup characters escaped. */
export function creditMark(name: string): string {
	return `***__${name.replace(/[\\*_~`|]/g, (c) => `\\${c}`)}__***`;
}

/** Notes text with every `@name` credit shown as `creditMark(name)`: nobody is pinged. */
export function showCredits(text: string): string {
	return text.replace(CREDIT, (_, name: string) => creditMark(name));
}

export function releaseEmbeds(notes: ReleaseNotes, appUrl: string): Embed[] {
	return splitBody(showCredits(forDiscord(notes.body))).map((description, i) => ({
		...(i === 0 ? { title: notes.title } : {}),
		description,
		url: appUrl,
		color: 0x2f855a,
	}));
}

export interface CreditCount {
	name: string;
	count: number;
}

/**
 * How many things each person is credited with across `releases`: one per line of notes (a
 * bullet) that names them, however often it does. Most credits first, then by name. Two spellings
 * of one name differing only in case are one person, shown as first seen.
 */
export function creditCounts(releases: readonly ReleaseNotes[]): CreditCount[] {
	const counts = new Map<string, CreditCount>();
	for (const notes of releases) {
		for (const line of forDiscord(notes.body).split('\n')) {
			for (const name of creditsIn(line)) {
				const key = name.toLowerCase();
				const entry = counts.get(key) ?? { name, count: 0 };
				entry.count += 1;
				counts.set(key, entry);
			}
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export const CREDITS_TITLE = 'Credits & attribution';

/**
 * The credits post's text: everyone the notes credit, most first, with their count, then the people
 * `earlier` names (credited before there were release notes). Null when it would name nobody.
 */
export function creditsBody(releases: readonly ReleaseNotes[], earlier: readonly string[]): string | null {
	const counts = creditCounts(releases);
	if (counts.length === 0 && earlier.length === 0) return null;
	const sections: string[] = [];
	if (counts.length > 0) {
		sections.push(['## In the release notes', ...counts.map((c, i) => `${i + 1}. ${creditMark(c.name)} — ${c.count}`)].join('\n'));
	}
	if (earlier.length > 0) sections.push(['## Before the release notes', earlier.map(creditMark).join(', ')].join('\n'));
	return sections.join('\n');
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
	/**
	 * A file whose `@name`s are the people credited before there were release notes, listed after
	 * the counts in the credits post. Absent or missing file: nobody.
	 */
	earlierCreditsFile?: string;
	archivebotUrl: string;
	appUrl: string;
	log: JsonLog;
	fetch?: typeof fetch;
	now?: () => Date;
}

/**
 * The signed ArchiveBot request for one release's notes: its idempotency key is the release's own,
 * its record is kept for good (`retain`), and an edit with no record finds the post by its title's
 * version (`find`), so a release of any age can still be corrected.
 */
function notesPayload(service: string, notes: ReleaseNotes, appUrl: string, now: Date): string {
	const titlePrefix = notes.title.startsWith(`${notes.version} `) ? `${notes.version} ` : notes.title;
	return JSON.stringify({
		idempotencyKey: `${service}-release-${notes.version}`,
		timestamp: now.getTime(),
		source: service,
		retain: true,
		find: { titlePrefix },
		embeds: releaseEmbeds(notes, appUrl),
	});
}

const creditsKey = (service: string, version: string): string => `${service}-credits-${version}`;

async function postSigned(options: AnnounceOptions, path: string, body: string): Promise<Response> {
	const signature = createHmac('sha256', options.secret).update(body).digest('hex');
	return (options.fetch ?? fetch)(`${options.archivebotUrl}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Hadoku-Signature': `sha256=${signature}` },
		body,
		signal: AbortSignal.timeout(10_000),
	});
}

/** POST `body` to ArchiveBot's `path`: the status, the raw reply, and a 2xx reply parsed (`{}` otherwise). */
async function call(options: AnnounceOptions, path: string, body: string): Promise<{ status: number; ok: boolean; raw: string; answer: Record<string, unknown> }> {
	const res = await postSigned(options, path, body);
	const raw = await res.text();
	return { status: res.status, ok: res.ok, raw, answer: res.ok ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

async function readEarlierCredits(file: string | undefined): Promise<string[]> {
	if (file === undefined) return [];
	try {
		return creditsIn(await readFile(file, 'utf8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
}

/**
 * At boot, in this order: delete the credits post of every older release (404, none on record, is
 * the usual answer); post the current release's notes; re-send every release's notes as edits, so a
 * corrected notes file (a credit added, a typo) changes its post; then post the current release's
 * credits, or edit them when already posted. ArchiveBot edits only a post whose shown text differs
 * and never posts from an edit. Resolves on every outcome; each is logged, never thrown.
 */
export async function announceRelease(options: AnnounceOptions): Promise<void> {
	const { log, service, ordering } = options;
	if (options.secret === '') {
		log({ event: 'release-announce', outcome: 'skipped', reason: `no ${options.secretEnvName}` });
		return;
	}
	const now = () => (options.now ?? (() => new Date()))();
	let releases: ReleaseNotes[];
	try {
		releases = await allReleases(options.releasesDir, ordering);
	} catch (err) {
		log({ event: 'release-announce', outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
		return;
	}
	const notes = releases[0];
	if (notes === undefined) {
		log({ event: 'release-announce', outcome: 'skipped', reason: `no release notes in ${options.releasesDir}` });
		return;
	}

	for (const older of releases.slice(1)) {
		try {
			const res = await call(options, '/api/messages/delete', JSON.stringify({ idempotencyKey: creditsKey(service, older.version), timestamp: now().getTime(), source: service }));
			if (res.status === 404) continue;
			log({ event: 'release-credits', outcome: res.ok ? 'deleted' : 'failed', version: older.version, ...(res.ok ? {} : { status: res.status, reply: res.raw.slice(0, 500) }) });
		} catch (err) {
			log({ event: 'release-credits', outcome: 'failed', version: older.version, error: err instanceof Error ? err.message : String(err) });
		}
	}

	try {
		const res = await call(options, '/api/messages/send', notesPayload(service, notes, options.appUrl, now()));
		if (!res.ok) {
			log({ event: 'release-announce', outcome: 'failed', version: notes.version, status: res.status, reply: res.raw.slice(0, 500) });
			return;
		}
		log({ event: 'release-announce', outcome: res.answer.deduped === true ? 'already-posted' : 'posted', version: notes.version });
	} catch (err) {
		log({ event: 'release-announce', outcome: 'failed', version: notes.version, error: err instanceof Error ? err.message : String(err) });
		return;
	}

	for (const release of releases) {
		try {
			const res = await call(options, '/api/messages/edit', notesPayload(service, release, options.appUrl, now()));
			// 404: no post for it, on record or in the channel's history: nothing to change.
			if (res.status === 404) continue;
			if (!res.ok) {
				log({ event: 'release-edit', outcome: 'failed', version: release.version, status: res.status, reply: res.raw.slice(0, 500) });
				continue;
			}
			if (res.answer.edited === true) log({ event: 'release-edit', outcome: 'edited', version: release.version });
		} catch (err) {
			log({ event: 'release-edit', outcome: 'failed', version: release.version, error: err instanceof Error ? err.message : String(err) });
		}
	}

	try {
		const body = creditsBody(releases, await readEarlierCredits(options.earlierCreditsFile));
		if (body === null) return;
		const payload = (at: Date): string =>
			JSON.stringify({
				idempotencyKey: creditsKey(service, notes.version),
				timestamp: at.getTime(),
				source: service,
				retain: true,
				embeds: splitBody(body).map((description, i) => ({ ...(i === 0 ? { title: CREDITS_TITLE } : {}), description, url: options.appUrl, color: 0x2f855a })),
			});
		const sent = await call(options, '/api/messages/send', payload(now()));
		if (!sent.ok) {
			log({ event: 'release-credits', outcome: 'failed', version: notes.version, status: sent.status, reply: sent.raw.slice(0, 500) });
			return;
		}
		if (sent.answer.deduped !== true) {
			log({ event: 'release-credits', outcome: 'posted', version: notes.version });
			return;
		}
		const edited = await call(options, '/api/messages/edit', payload(now()));
		if (!edited.ok) log({ event: 'release-credits', outcome: 'failed', version: notes.version, status: edited.status, reply: edited.raw.slice(0, 500) });
		else if (edited.answer.edited === true) log({ event: 'release-credits', outcome: 'edited', version: notes.version });
	} catch (err) {
		log({ event: 'release-credits', outcome: 'failed', version: notes.version, error: err instanceof Error ? err.message : String(err) });
	}
}
