/**
 * Which card Forge plays for a deck line naming a two-faced card, through the
 * bridge's own `parseDeck` — the one place every deck becomes Forge's deck.
 *
 * Scryfall names every two-faced card `Front // Back`; the cube stores it so,
 * and a drafted deck's `.dck` carries that name. Forge files a card under its
 * `CardRules.getName()` (`forge-core/.../card/CardRules.java:200-207`): the two
 * faces joined with ` // ` only when the layout COMBINES them
 * (`CardSplitType.Split` — split, aftermath, fuse and rooms are all
 * `AlternateMode:Split`), the front face alone for every other layout
 * (transform, modal DFC, adventure, flip, omen, meld). A line naming a
 * transform, modal or adventure card the Scryfall way found no card, and Forge
 * removed it at the start of the match.
 *
 * Every two-faced card of the committed cube, written exactly as the browser
 * writes a drafted card, plus a card of each other layout by name.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   pnpm exec vitest run apps/server/src/play/deck-names.jvm.test.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeCardRequest } from '@hadoku/deck';
import { describe, expect, it } from 'vitest';

import { draftCardRequest } from '../http/draftPool.js';
import { loadPool } from '../room/pool.js';
import { bridgeLaunch, jvmHostConfig } from './host.js';

const available = jvmHostConfig();
const title = available.ok
	? 'a deck line naming a two-faced card the Scryfall way is the card Forge plays'
	: `a deck line naming a two-faced card the Scryfall way is the card Forge plays — SKIPPED: ${available.reason}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'jvm', 'DeckNamesCheck.java');

const cube = loadPool(resolve(HERE, '../../../ui/src/draft/pool.json'));
if (!cube.ok) throw new Error(`cube pool did not load: ${cube.detail}`);

/** The card Forge files each of the cube's two-faced cards under, by layout. */
const CUBE: Record<string, string> = {
	// split, and a room (AlternateMode:Split): both faces, as written
	'Life // Death': 'Life // Death',
	'Walk-In Closet // Forgotten Cellar': 'Walk-In Closet // Forgotten Cellar',
	// transform
	'Ajani, Nacatl Pariah // Ajani, Nacatl Avenger': 'Ajani, Nacatl Pariah',
	'Tamiyo, Inquisitive Student // Tamiyo, Seasoned Scholar': 'Tamiyo, Inquisitive Student',
	"Jace, Vryn's Prodigy // Jace, Telepath Unbound": "Jace, Vryn's Prodigy",
	'Cecil, Dark Knight // Cecil, Redeemed Paladin': 'Cecil, Dark Knight',
	'Concealing Curtains // Revealing Eye': 'Concealing Curtains',
	'Etali, Primal Conqueror // Etali, Primal Sickness': 'Etali, Primal Conqueror',
	'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki': 'Fable of the Mirror-Breaker',
	"Aang, Swift Savior // Aang and La, Ocean's Fury": 'Aang, Swift Savior',
	// modal double-faced
	'Witch Enchanter // Witch-Blessed Meadow': 'Witch Enchanter',
	'Sink into Stupor // Soporific Springs': 'Sink into Stupor',
	'Sundering Eruption // Volcanic Fissure': 'Sundering Eruption',
	// adventure
	'Brazen Borrower // Petty Theft': 'Brazen Borrower',
	'Bonecrusher Giant // Stomp': 'Bonecrusher Giant',
	'Embereth Shieldbreaker // Battle Display': 'Embereth Shieldbreaker',
};

/** Layouts the cube does not hold, and names already in Forge's own form, by name alone. */
const OTHERS: Record<string, string> = {
	'Fire // Ice': 'Fire // Ice', // split
	'Cut // Ribbons': 'Cut // Ribbons', // aftermath
	'Wear // Tear': 'Wear // Tear', // fuse
	'Akki Lavarunner // Tok-Tok, Volcano Born': 'Akki Lavarunner', // flip
	'Dirgur Island Dragon // Skimming Strike': 'Dirgur Island Dragon', // omen
	'Bruna, the Fading Light': 'Bruna, the Fading Light', // meld: Scryfall names each half alone
	'Bonecrusher Giant': 'Bonecrusher Giant', // Forge's own name for an adventure
	'Lightning Bolt': 'Lightning Bolt',
};

describe.skipIf(!available.ok)(title, () => {
	it('every two-faced card of the cube, and one of each other layout, is the card Forge files it under', { timeout: 190_000 }, () => {
		if (!available.ok) return;
		const twoFaced = cube.pool.cards.filter((c) => c.name.includes(' // '));
		expect(twoFaced.map((c) => c.name).sort()).toEqual(Object.keys(CUBE).sort());

		/** Each line Forge reads, the card it should play, and the set a drafted line names. */
		const lines = new Map<string, { name: string; set: string | null }>([
			...twoFaced.map((c) => [composeCardRequest(draftCardRequest(c)), { name: CUBE[c.name]!, set: c.setCode }] as const),
			...Object.entries(OTHERS).map(([line, name]) => [line, { name, set: null }] as const),
			// A back face that is not the front's: not a card, so Forge removes it — never guessed at.
			['Etali, Primal Conqueror // Stomp', { name: 'Etali, Primal Conqueror // Stomp', set: null }],
		]);
		const removed = (line: string): boolean => line === 'Etali, Primal Conqueror // Stomp';

		const launch = bridgeLaunch(available.config, (e) => console.log(`[deck-names.jvm] ${JSON.stringify(e)}`));
		expect(launch.how, 'the bridge compiles, so the check can load its classes').toBe('compiled');
		const dir = mkdtempSync(join(tmpdir(), 'deck-names-'));
		try {
			const file = join(dir, 'lines.txt');
			writeFileSync(file, [...lines.keys()].join('\n'));
			// Compiled beside the bridge's classes rather than source-launched: the source launcher's own
			// class loader is another runtime package, and `parseDeck` is package-private.
			const classpath = `${dir}:${launch.args[1]!}`;
			const javac = spawnSync(join(dirname(available.config.java), 'javac'), ['-proc:none', '-nowarn', '-cp', launch.args[1]!, '-d', dir, CHECK], { encoding: 'utf8', timeout: 120_000 });
			expect(javac.status, javac.stderr).toBe(0);
			const run = spawnSync(available.config.java, ['-cp', classpath, 'DeckNamesCheck', available.config.res, file], {
				encoding: 'utf8',
				maxBuffer: 16 * 1024 * 1024,
				timeout: 180_000,
			});
			expect(run.status, run.stderr.slice(-4000)).toBe(0);
			const got: Record<string, string> = {};
			for (const row of run.stdout.split('\n')) {
				const cells = row.split('\t');
				if (cells.length !== 5) continue;
				const [section, line, name, edition, kind] = cells as [string, string, string, string, string];
				console.log(`[deck-names.jvm] ${section} ${line} -> ${name} ${edition} ${kind}`);
				const set = lines.get(line)?.set ?? null;
				got[`${section}\t${line}`] = `${name}\t${set === null ? '' : edition}\t${kind}`;
			}
			const want: Record<string, string> = {};
			for (const section of ['Main', 'Sideboard']) {
				for (const [line, { name, set }] of lines) want[`${section}\t${line}`] = `${name}\t${set ?? ''}\t${removed(line) ? 'UNSUPPORTED' : 'OK'}`;
			}
			expect(got).toEqual(want);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
