/**
 * What a release contains, gathered for whoever writes its patch notes.
 *
 *   node scripts/release/collect.ts [--since <ref>] [--to <ref>]
 *
 * `--since` defaults to the newest `release/*` tag reachable from `--to`
 * (default `origin/main`); with no release tag yet it is required. Prints
 * markdown on stdout: the playtest ledger rows the range added or changed, then
 * the commit subjects. It writes nothing.
 *
 * The ledger is the source because its rows are already in the player's terms:
 * every row says what was asked (`item`) and how a player sees it (`check it
 * by`). Commit subjects are engineering prose, listed only so nothing shipped
 * without a row goes unnoticed. The notes themselves are written from this by
 * an agent and edited by the operator — see docs/RELEASE.md.
 */
import { execFileSync } from 'node:child_process';

const LEDGER = 'docs/planning/playtest-ledger.md';

export interface LedgerRow {
	id: string;
	item: string;
	status: string;
	checkItBy: string;
	operatorCheck: string;
}

/** Splits one markdown table row on unescaped pipes. */
function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

/**
 * A ledger row, or null for anything that is not one.
 *
 * The header is `| ID | item | asked | status | evidence | check it by | your check |`,
 * but rows drift: many carry an extra design column before `evidence`, and a few
 * have an unescaped pipe in a code span. The columns a note needs are read from
 * the ends, where every shape agrees.
 */
export function parseLedgerRow(line: string): LedgerRow | null {
	if (!/^\|\s*AF\d+\s*\|/.test(line)) return null;
	const row = cells(line);
	return {
		id: row[0],
		item: row[1] ?? '',
		status: row[3] ?? '',
		checkItBy: row.length >= 7 ? row[row.length - 2] : '',
		operatorCheck: row.length >= 7 ? row[row.length - 1] : '',
	};
}

/**
 * The rows a ledger diff added or changed, newest version of each, in ledger
 * order. A row only removed (renumbered, merged) is not release content.
 */
export function changedRows(diff: string): LedgerRow[] {
	const byId = new Map<string, LedgerRow>();
	for (const line of diff.split('\n')) {
		if (!line.startsWith('+') || line.startsWith('+++')) continue;
		const row = parseLedgerRow(line.slice(1));
		if (row !== null) byId.set(row.id, row);
	}
	return [...byId.values()];
}

export interface Commit {
	sha: string;
	subject: string;
}

export function render(range: { since: string; to: string }, rows: LedgerRow[], commits: Commit[]): string {
	const out = [`# Release content: ${range.since}..${range.to}`, '', `## Ledger rows added or changed (${rows.length})`, ''];
	for (const row of rows) {
		out.push(`### ${row.id} — ${row.status}`, '', `- asked: ${row.item}`, `- a player sees it by: ${row.checkItBy}`);
		if (row.operatorCheck !== '') out.push(`- operator's check: ${row.operatorCheck}`);
		out.push('');
	}
	out.push(`## Commits (${commits.length})`, '');
	for (const commit of commits) out.push(`- ${commit.sha} ${commit.subject}`);
	return `${out.join('\n')}\n`;
}

function git(...args: string[]): string {
	return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function flag(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at === -1 ? undefined : argv[at + 1];
}

function main(argv: string[]): void {
	const to = flag(argv, '--to') ?? 'origin/main';
	let since = flag(argv, '--since');
	if (since === undefined) {
		try {
			since = git('describe', '--tags', '--abbrev=0', '--match', 'release/*', to).trim();
		} catch {
			throw new Error(`no release/* tag is reachable from ${to}: pass --since <ref> for the first release`);
		}
	}
	const rows = changedRows(git('diff', '--unified=0', `${since}..${to}`, '--', LEDGER));
	const commits = git('log', '--no-merges', '--format=%h%x09%s', `${since}..${to}`)
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => {
			const [sha, subject] = line.split('\t');
			return { sha, subject };
		});
	process.stdout.write(render({ since, to }, rows, commits));
}

if (import.meta.main) main(process.argv.slice(2));
