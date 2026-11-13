/**
 * The operator's hand on past tournaments (the operator, 2026-11-08: *"make
 * adhoc changes to the scoring, regenerate the results … update the database
 * values and refresh what shows on prod"*): read, correct and re-rank the
 * records the Tournaments tab shows, in the file the running server serves.
 *
 * The server re-reads that file whenever it changes on disk
 * (`room/tournaments.ts`), so a write here shows on the next page load with no
 * restart, and the server's own next write keeps it. Every change re-ranks the
 * standings from the results with the live pods' own ranking (`withStandings`),
 * so the standings shown can never disagree with the results kept.
 *
 * Nothing is written without `--write`: without it a change prints the
 * standings before and after and stops. With it, the file as it was is copied
 * to `<file>.bak/<time>.json` first.
 *
 *   tsx games/magic/server/src/cli/tournaments.ts <command> [--site prod|ppe | --file <path>] [--write]
 *
 *   list                                   every record, newest first
 *   show <id>                              its results (numbered) and standings
 *   add <id> --a <who> --b <who|bye> --games 2-1 [--round n]
 *                                          a result; --round defaults to one past the last
 *   set <id> <n> [--a …] [--b …] [--games …] [--round …]
 *                                          change result n (as `show` numbers them)
 *   rm <id> <n>                            remove result n
 *   rename <id> <name>                     the name the tab shows
 *   regenerate <id>                        re-rank from the results as they are
 *
 * `<id>` is a tournament id or a unique start of one. `<who>` is an entrant's
 * id or their name, any case. A person's name is looked up live with the repo's
 * service key (`.devvault.local.json`), as the server does; without one only
 * the AI entrants have names. `--site` reads `$CARDTABLE_STATE_ROOT`
 * (default `~/srv-data`), the root hadoku_site's PM2 wrapper gives each site.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { PodMatchResult, PodStandingsRow, Tournament } from '@hadoku/shared';

import { createPeople } from '@hadoku/game-server/people';
import { readTournaments, withStandings, writeTournaments } from '../room/tournaments.js';

const SITES = { prod: 'cardtable', ppe: 'cardtable-ppe' } as const;

function fail(message: string): never {
	console.error(`tournaments: ${message}`);
	process.exit(1);
}

function fileOf(site: string | undefined, file: string | undefined): string {
	if (file !== undefined) return resolve(file);
	if (site === undefined) fail('say which file: --site prod|ppe or --file <path>');
	if (!(site in SITES)) fail(`--site is prod or ppe, not ${site}`);
	return join(process.env.CARDTABLE_STATE_ROOT ?? join(homedir(), 'srv-data'), SITES[site as keyof typeof SITES], 'tournaments.json');
}

/** The repo's service key, from the main checkout's `.devvault.local.json`; null without one. */
async function serviceKey(): Promise<string | null> {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const vault = join(dir, '.devvault.local.json');
		if (existsSync(vault)) return (JSON.parse(await readFile(vault, 'utf8')) as { key?: string }).key ?? null;
		const git = join(dir, '.git');
		// A worktree's `.git` is a file naming the main checkout's git dir; the key lives beside that.
		if (existsSync(git)) {
			const pointer = await readFile(git, 'utf8').catch(() => null);
			const common = pointer?.match(/^gitdir: (.*)\/\.git\/worktrees\//m)?.[1];
			if (common === undefined) return null;
			dir = common;
			continue;
		}
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/** Every entrant's name: the AI's as kept, a person's as they are now (or as kept, from before #27). */
async function namesOf(t: Tournament): Promise<Map<string, string>> {
	const names = new Map(Object.entries(t.names).filter(([, n]) => n !== ''));
	const users = Object.entries(t.users ?? {});
	const key = users.length === 0 ? null : await serviceKey();
	if (key !== null) {
		const people = createPeople({ baseUrl: process.env.CARDTABLE_PREFS_BASE_URL ?? 'https://hadoku.me/prefs', serviceKey: key, log: (e) => console.error('people:', JSON.stringify(e)) });
		const found = await people.resolve(users.map(([, u]) => u));
		for (const [id, userId] of users) {
			const name = found.get(userId)?.name;
			if (name) names.set(id, name);
		}
	}
	return names;
}

function pick(all: readonly Tournament[], id: string | undefined): Tournament {
	if (id === undefined) fail('which tournament? give its id (see `list`)');
	const exact = all.find((t) => t.id === id);
	if (exact !== undefined) return exact;
	const starts = all.filter((t) => t.id.startsWith(id));
	if (starts.length === 1) return starts[0]!;
	fail(starts.length === 0 ? `no tournament ${id}` : `${id} could be ${starts.map((t) => t.id).join(' or ')}`);
}

function entrant(who: string, t: Tournament, names: Map<string, string>): string {
	const ids = new Set([...t.standings.map((s) => s.id), ...t.results.flatMap((r) => [r.playerA, r.playerB ?? []].flat())]);
	if (ids.has(who)) return who;
	const named = [...ids].filter((id) => names.get(id)?.toLowerCase() === who.toLowerCase());
	if (named.length === 1) return named[0]!;
	fail(named.length === 0 ? `no entrant ${who} in ${t.id}: ${[...ids].map((id) => names.get(id) ?? id).join(', ')}` : `${who} names ${named.length} entrants; use an id`);
}

function games(text: string): { gamesA: number; gamesB: number } {
	const m = /^(\d+)-(\d+)$/.exec(text);
	if (m === null) fail(`--games is wins-wins for --a then --b, like 2-1, not ${text}`);
	return { gamesA: Number(m[1]), gamesB: Number(m[2]) };
}

function resultNumber(t: Tournament, n: string | undefined): number {
	const i = Number(n) - 1;
	if (!Number.isInteger(i) || i < 0 || i >= t.results.length) fail(`result number 1 to ${t.results.length}, not ${n ?? 'none'} (see \`show\`)`);
	return i;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function standingsLines(rows: readonly PodStandingsRow[], t: Tournament, names: Map<string, string>): string[] {
	const record = (id: string): string => {
		let w = 0;
		let l = 0;
		let d = 0;
		for (const r of t.results) {
			if (r.playerA !== id && r.playerB !== id) continue;
			if (r.playerB === null) w++;
			else {
				const [mine, theirs] = r.playerA === id ? [r.gamesA, r.gamesB] : [r.gamesB, r.gamesA];
				if (mine > theirs) w++;
				else if (mine < theirs) l++;
				else d++;
			}
		}
		return d === 0 ? `${w}-${l}` : `${w}-${l}-${d}`;
	};
	return rows.map(
		(r) =>
			`  ${r.rank}. ${(names.get(r.id) ?? r.id).padEnd(20)} ${record(r.id).padEnd(6)} ${String(r.matchPoints).padStart(2)} pts  omw ${pct(r.opponentMatchWinPct)}  gw ${pct(r.gameWinPct)}  ogw ${pct(r.opponentGameWinPct)}${r.decidedBy === null ? '' : `  (below on ${r.decidedBy})`}`,
	);
}

function resultLine(r: PodMatchResult, i: number, names: Map<string, string>): string {
	const name = (id: string): string => names.get(id) ?? id;
	return r.playerB === null ? `  ${i + 1}. round ${r.round}: ${name(r.playerA)} has a bye` : `  ${i + 1}. round ${r.round}: ${name(r.playerA)} ${r.gamesA}-${r.gamesB} ${name(r.playerB)}`;
}

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			site: { type: 'string' },
			file: { type: 'string' },
			write: { type: 'boolean', default: false },
			a: { type: 'string' },
			b: { type: 'string' },
			games: { type: 'string' },
			round: { type: 'string' },
		},
	});
	const [command, id, ...rest] = positionals;
	const file = fileOf(values.site, values.file);
	const all = await readTournaments(file, (e) => fail(`${file}: ${JSON.stringify(e)}`));

	if (command === 'list') {
		for (const t of [...all].sort((a, b) => b.endedAt - a.endedAt)) {
			console.log(`${t.id}  ${new Date(t.endedAt).toISOString().slice(0, 10)}  ${t.name}  (${t.rounds} rounds, ${t.results.length} results${t.closed ? ', closed early' : ''})`);
		}
		return;
	}

	const before = pick(all, id);
	const names = await namesOf(before);
	if (command === 'show') {
		console.log(`${before.id}  ${before.name}  ${new Date(before.startedAt).toISOString().slice(0, 16)} → ${new Date(before.endedAt).toISOString().slice(0, 16)}, ${before.rounds} rounds${before.closed ? ', closed early' : ''}`);
		console.log('results:');
		before.results.forEach((r, i) => console.log(resultLine(r, i, names)));
		console.log('standings:');
		for (const line of standingsLines(before.standings, before, names)) console.log(line);
		return;
	}

	let after: Tournament;
	if (command === 'add') {
		if (values.a === undefined || values.b === undefined) fail('add needs --a and --b (--b bye for a bye)');
		const bye = values.b.toLowerCase() === 'bye';
		const round = values.round === undefined ? Math.max(0, ...before.results.map((r) => r.round)) + 1 : Number(values.round);
		if (!Number.isInteger(round) || round < 1) fail(`--round is a whole number from 1, not ${values.round}`);
		if (!bye && values.games === undefined) fail('add needs --games, like 2-1');
		const result: PodMatchResult = {
			round,
			playerA: entrant(values.a, before, names),
			playerB: bye ? null : entrant(values.b, before, names),
			...(bye ? { gamesA: 2, gamesB: 0 } : games(values.games!)),
		};
		after = withStandings({ ...before, results: [...before.results, result] });
	} else if (command === 'set') {
		const i = resultNumber(before, rest[0]);
		const old = before.results[i]!;
		const b = values.b === undefined ? old.playerB : values.b.toLowerCase() === 'bye' ? null : entrant(values.b, before, names);
		const changed: PodMatchResult = {
			...old,
			...(values.round === undefined ? {} : { round: Number(values.round) }),
			playerA: values.a === undefined ? old.playerA : entrant(values.a, before, names),
			playerB: b,
			...(values.games === undefined ? {} : games(values.games)),
		};
		after = withStandings({ ...before, results: before.results.map((r, j) => (j === i ? changed : r)) });
	} else if (command === 'rm') {
		const i = resultNumber(before, rest[0]);
		after = withStandings({ ...before, results: before.results.filter((_, j) => j !== i) });
	} else if (command === 'rename') {
		const name = rest.join(' ').trim();
		if (name === '') fail('rename needs the new name');
		after = { ...before, name };
	} else if (command === 'regenerate') {
		after = withStandings(before);
	} else {
		fail(`no command ${command ?? ''}: list, show, add, set, rm, rename, regenerate`);
	}

	console.log(`${after.id}  ${before.name === after.name ? after.name : `${before.name} → ${after.name}`}`);
	console.log('results:');
	after.results.forEach((r, i) => console.log(resultLine(r, i, names)));
	console.log('standings before:');
	for (const line of standingsLines(before.standings, before, names)) console.log(line);
	console.log('standings after:');
	for (const line of standingsLines(after.standings, after, names)) console.log(line);
	if (!values.write) {
		console.log('\n(dry run: nothing written; add --write to save)');
		return;
	}

	// Re-read right before writing: anything the server recorded since this command started is kept.
	const now = await readTournaments(file, (e) => fail(`${file}: ${JSON.stringify(e)}`));
	if (JSON.stringify(now.find((t) => t.id === after.id)) !== JSON.stringify(before)) fail(`${after.id} changed while this ran; run it again`);
	const backups = `${file}.bak`;
	await mkdir(backups, { recursive: true });
	const backup = join(backups, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	await copyFile(file, backup);
	await writeTournaments(file, now.map((t) => (t.id === after.id ? after : t)));
	console.log(`\nwritten to ${file} (the file as it was: ${backup})`);
}

await main();
