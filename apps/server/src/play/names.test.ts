import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadTablesLibrary } from '../http/library.js';
import { dckNames, faceNames, formatNameSets, namesForFormat, roomFormatNames } from './names.js';

const library = loadTablesLibrary(resolve(import.meta.dirname, '../../../..'));
const CUBE = [{ name: 'Fire // Ice' }, { name: 'Grizzly Bears' }];
const legal = roomFormatNames(library, CUBE);

describe('a card-name ask, narrowed to the format', () => {
	it('a name outside the format is not offered, one inside it is, and Forge order is kept', () => {
		const legacy2005 = legal('legacy-2005-08-20');
		expect(legacy2005).not.toBeNull();
		const offered = ['Goblin Guide', 'Grizzly Bears', 'Llanowar Elves', 'Thoughtseize'];
		expect(namesForFormat(offered, legacy2005, new Set())).toEqual(['Grizzly Bears', 'Llanowar Elves']);
	});

	it('a name either deck plays is offered even when the format does not list it', () => {
		expect(namesForFormat(['Goblin Guide', 'Grizzly Bears'], legal('legacy-2005-08-20'), new Set(['Goblin Guide']))).toEqual([
			'Goblin Guide',
			'Grizzly Bears',
		]);
	});

	it('a format with no list offers Forge’s whole list', () => {
		const offered = ['Goblin Guide', 'Grizzly Bears'];
		expect(legal('no-such-format')).toBeNull();
		expect(namesForFormat(offered, legal('no-such-format'), new Set())).toBe(offered);
	});

	it('Free pick offers what the library’s decks play; a drafted pool offers its cube', () => {
		const free = legal('free')!;
		expect(free.size).toBeGreaterThan(0);
		for (const deck of library.decks) for (const name of dckNames(deck.text)) expect(free.has(name)).toBe(true);
		expect([...legal('draft:abc123')!].sort()).toEqual(['Fire', 'Fire // Ice', 'Grizzly Bears', 'Ice']);
	});

	it('a list that keeps none of Forge’s names falls back to Forge’s', () => {
		const offered = ['Goblin Guide'];
		expect(namesForFormat(offered, new Set(['Grizzly Bears']), new Set())).toBe(offered);
	});

	it('both halves of a split or double-faced card answer to it, as Forge names its faces', () => {
		expect([...faceNames(['Fire // Ice', 'Grizzly Bears'])].sort()).toEqual(['Fire', 'Fire // Ice', 'Grizzly Bears', 'Ice']);
	});

	it('a format’s set is built once and kept', () => {
		let built = 0;
		const sets = formatNameSets(() => {
			built += 1;
			return ['Grizzly Bears'];
		});
		expect(sets('x')).toBe(sets('x'));
		expect(built).toBe(1);
	});

	it('every catalogued format has a list', () => {
		const sizes = [...library.formats.map((f) => f.id), 'free'].map((id) => `${id}=${legal(id)?.size ?? 0}`);
		console.log(`[gg-name] format list sizes: ${sizes.join(' ')}`);
		for (const f of library.formats) expect(legal(f.id)?.size ?? 0).toBeGreaterThan(0);
	});
});
