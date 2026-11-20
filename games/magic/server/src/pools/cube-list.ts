/**
 * A pasted card list, read into card names: the import a cube takes when it
 * is not on Cube Cobra, or is exported from it as a file.
 *
 * Three shapes, told apart by the text itself:
 *
 *   - a Forge `.dck` (it has a `[section]` line): its `[main]` section, read by
 *     `@hadoku/carddata`'s own `parseDck`;
 *   - Cube Cobra's CSV export (its first line is a header whose first column is
 *     `name`): the `name` column, less the rows its `board` or `maybeboard`
 *     column puts off the mainboard;
 *   - anything else: one card a line, as `Name`, `1 Name`, `2x Name`,
 *     `1 Name|SET` (Forge), or `1 Name (SET) 123` (Arena, MTGO, Moxfield).
 *     `#`, `;` and `//` lines are comments, except Cube Cobra's own
 *     `# mainboard` / `# maybeboard` headings, which say whose cards follow.
 *
 * The mainboard only, in every shape: that is the cube, as it is for a link.
 *
 * Names only. A set code on a line is dropped: which printing a card draws is
 * the catalog's answer, as it is for a Cube Cobra import.
 */

import { parseCardLine, parseDck } from '@hadoku/carddata';

/** The most cards one list may hold, copies counted. The largest cubes on Cube Cobra are under 1,500. */
export const CUBE_LIST_MAX_CARDS = 2000;

export type ParsedCubeList = { readonly ok: true; readonly names: readonly string[] } | { readonly ok: false; readonly error: string };

interface Entry {
	readonly count: number;
	readonly name: string;
}

/** `Name (SET) 123`, `Name (SET)`, each with an optional `*F*` finish: what Arena, MTGO and Moxfield append to a name. */
const PRINTING_SUFFIX_RE = /\s+\([A-Za-z0-9]{2,6}\)(?:\s+\S+)?(?:\s+\*[A-Za-z]+\*)?$|\s+\*[A-Za-z]+\*$/;

/** Cube Cobra's plaintext export heads each board: `# mainboard`, `# maybeboard`. */
const BOARD_HEADING_RE = /^#\s*([a-z]+board)\s*$/i;

/** One CSV row's cells, quotes honoured (`"Fire // Ice"`, `"Borrowing 100,000 Arrows"`, `""` for a quote). */
function csvCells(row: string): string[] {
	const cells: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i]!;
		if (quoted) {
			if (ch !== '"') cell += ch;
			else if (row[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = false;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			cells.push(cell);
			cell = '';
		} else cell += ch;
	}
	cells.push(cell);
	return cells.map((c) => c.trim());
}

function csvEntries(lines: readonly string[], header: readonly string[]): Entry[] {
	const board = header.indexOf('board');
	const maybeboard = header.indexOf('maybeboard');
	const entries: Entry[] = [];
	for (const line of lines) {
		const cells = csvCells(line);
		const name = cells[0] ?? '';
		if (name === '') continue;
		if (board !== -1 && (cells[board] ?? '') !== '' && cells[board]!.toLowerCase() !== 'mainboard') continue;
		if (maybeboard !== -1 && cells[maybeboard]?.toLowerCase() === 'true') continue;
		entries.push({ count: 1, name });
	}
	return entries;
}

function lineEntries(lines: readonly string[]): Entry[] {
	const entries: Entry[] = [];
	let mainboard = true;
	for (const line of lines) {
		const heading = BOARD_HEADING_RE.exec(line);
		if (heading !== null) mainboard = heading[1]!.toLowerCase() === 'mainboard';
		if (!mainboard || line.startsWith('//')) continue;
		const entry = parseCardLine(line.replace(/^(\d+)x\s+/i, '$1 ').replace(PRINTING_SUFFIX_RE, ''));
		if (entry !== null) entries.push({ count: entry.count, name: entry.card.name });
	}
	return entries;
}

/** Every card the list names, a line of `3 Forest` three times over. Never throws. */
export function parseCubeList(text: string): ParsedCubeList {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== '');
	const header = csvCells(lines[0] ?? '').map((c) => c.toLowerCase());

	let entries: readonly Entry[];
	if (lines.some((l) => l.startsWith('[') && l.endsWith(']'))) entries = (parseDck(text).sections.get('main') ?? []).map((e) => ({ count: e.count, name: e.card.name }));
	else if (header.length > 1 && header[0] === 'name') entries = csvEntries(lines.slice(1), header);
	else entries = lineEntries(lines);

	const names: string[] = [];
	for (const { count, name } of entries) {
		if (name === '') continue;
		if (names.length + count > CUBE_LIST_MAX_CARDS) return { ok: false, error: `a list holds at most ${String(CUBE_LIST_MAX_CARDS)} cards` };
		for (let i = 0; i < count; i++) names.push(name);
	}
	if (names.length === 0) return { ok: false, error: 'no card names in that list' };
	return { ok: true, names };
}
