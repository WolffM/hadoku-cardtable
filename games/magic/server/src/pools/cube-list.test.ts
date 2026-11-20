/**
 * `parseCubeList`: every shape a pasted list arrives in gives the same names.
 */
import { describe, expect, it } from 'vitest';

import { CUBE_LIST_MAX_CARDS, parseCubeList } from './cube-list.ts';

const names = (text: string): readonly string[] => {
	const parsed = parseCubeList(text);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.names;
};

describe('parseCubeList', () => {
	it('reads one name a line, blank lines and comments dropped', () => {
		expect(names('Lightning Bolt\n\n# removal\n// more\n; and more\nCounterspell\r\n  Llanowar Elves  \n')).toEqual(['Lightning Bolt', 'Counterspell', 'Llanowar Elves']);
	});

	it('reads a count as that many copies, with or without an x', () => {
		expect(names('2 Forest\n3x Island\n1X Swamp')).toEqual(['Forest', 'Forest', 'Island', 'Island', 'Island', 'Swamp']);
	});

	it('drops the printing a line names: Forge, Arena and Moxfield spellings', () => {
		expect(names('1 Stoneforge Mystic|PRM\n1 Lightning Bolt (M10) 146\n1 Counterspell (7ED)\n1 Brainstorm (MMQ) 61 *F*\n1 Ponder *F*')).toEqual([
			'Stoneforge Mystic',
			'Lightning Bolt',
			'Counterspell',
			'Brainstorm',
			'Ponder',
		]);
	});

	it('keeps a name that has its own brackets or a split bar', () => {
		expect(names('B.F.M. (Big Furry Monster)\nFire // Ice\nBorrowing 100,000 Arrows')).toEqual(['B.F.M. (Big Furry Monster)', 'Fire // Ice', 'Borrowing 100,000 Arrows']);
	});

	it("reads a Forge .dck's main section and nothing else", () => {
		expect(names('[metadata]\nName=My Cube\n[Main]\n1 Forest|LEA\n2 Island\n[Sideboard]\n1 Swamp')).toEqual(['Forest', 'Island', 'Island']);
	});

	it("reads Cube Cobra's CSV export by its name column, less the maybeboard", () => {
		const csv = [
			'name,CMC,Type,Color,Set,Collector Number,Rarity,Color Category,status,Finish,board,maybeboard,image URL,image Back URL,tags,Notes,MTGO ID',
			'"Fire // Ice",2,Instant,UR,"apc","128",uncommon,Hybrid,Owned,Non-foil,mainboard,false,,,"",,',
			'"Borrowing 100,000 Arrows",3,Sorcery,U,"ptk","35",uncommon,Blue,Owned,Non-foil,mainboard,false,,,"",,',
			'"Black Lotus",0,Artifact,,"lea","232",rare,Colorless,Owned,Non-foil,mainboard,true,,,"",,',
			'"Mox Pearl",0,Artifact,,"lea","263",rare,Colorless,Owned,Non-foil,maybeboard,false,,,"",,',
			'Counterspell,2,Instant,U,"7ed","67",common,Blue,Owned,Non-foil,mainboard,false,,,"",,',
		].join('\n');
		expect(names(csv)).toEqual(['Fire // Ice', 'Borrowing 100,000 Arrows', 'Counterspell']);
	});

	it("reads Cube Cobra's plaintext export: the mainboard's cards, not the maybeboard's", () => {
		expect(names('# mainboard\nForest\nIsland\n# maybeboard\nSwamp\n')).toEqual(['Forest', 'Island']);
	});

	it('refuses a list with no card in it', () => {
		expect(parseCubeList('# nothing\n\n')).toEqual({ ok: false, error: 'no card names in that list' });
	});

	it('refuses a list past the cap, copies counted', () => {
		expect(parseCubeList(`${String(CUBE_LIST_MAX_CARDS + 1)} Forest`).ok).toBe(false);
		expect(names(`${String(CUBE_LIST_MAX_CARDS)} Forest`)).toHaveLength(CUBE_LIST_MAX_CARDS);
	});
});
