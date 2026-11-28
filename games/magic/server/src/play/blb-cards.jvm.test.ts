/**
 * Bloomburrow's mechanics, each played on a board of its own against real Forge, and each checked by
 * what it did to the board: a life total, a token, a counter, a card that moved. The card sweep
 * (`monkey/sweep/`) proves every Bloomburrow card can be cast and every question it raises answered;
 * it does not say the answer did what the card says. These are the shapes a Bloomburrow set-cube pod
 * leans on that the sweep cannot judge: each gift kind (a card, a Food, a Treasure, a tapped Fish, and
 * Jolly Gerbils seeing it given), offspring whose copy has a triggered ability, forage by Food and by
 * graveyard, expend, valiant once per turn, a Season's pawprints with a repeated mode, a Talent's
 * levels, Dragonhawk's exile-and-play, Eluge's flood counters and cost reduction, the Bat life
 * payoffs, Ygra making creatures Food, Lumra's mill, Fountainport and Fabled Passage.
 *
 * Seat 1 is Forge's AI with nothing in hand, so nothing answers a spell, and every board starts in
 * seat 0's own main phase with no opening (`skipOpening`). The seat answers every question itself:
 * an ask by `reply`, a board pick by clicking the card the test names, a yes/no by its button.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run games/magic/server/src/play/blb-cards.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { currentFace, intOf, type ServerFrame } from '@hadoku/forge-wire';

import { available, deck, landPayer, promptBar, startScenario, timeline, waitUntil, type Card, type Scenario } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

type Side = 'me' | 'ai';
type Zone = 'Hand' | 'Battlefield' | 'Graveyard' | 'Exile';
type Ask = ServerFrame & Record<string, unknown>;

/** Seat 0's life, or the AI's: the one player in seat 0's view that is not seat 0. */
function life(s: Scenario, who: Side): number {
	const mine = s.match.seats[0]?.playerId ?? -1;
	const obj = [...s.state(0).values()].find((o) => o._type === 1 && (who === 'me') === (o._id === mine));
	return (obj?.Life as { v?: number } | undefined)?.v ?? -1;
}

const cards = (s: Scenario, side: Side, zone: Zone): Card[] => s.zone(0, zone, side === 'me' ? 0 : 1);
const names = (s: Scenario, side: Side, zone: Zone): string[] => cards(s, side, zone).map((c) => c.name).sort();
const count = (s: Scenario, side: Side, zone: Zone, name: string): number => cards(s, side, zone).filter((c) => c.name === name).length;

function one(s: Scenario, side: Side, zone: Zone, name: string): Card {
	const c = cards(s, side, zone).find((x) => x.name === name);
	if (c === undefined) throw new Error(`no ${name} in ${side}'s ${zone}: ${names(s, side, zone).join(', ')}`);
	return c;
}

/** A card's power and toughness as seat 0 sees them. */
function pt(s: Scenario, id: number): [number | null, number | null] {
	const face = currentFace(s.state(0), id);
	return [intOf(face, 'Power'), intOf(face, 'Toughness')];
}

/** A card's counters of `kind` (Forge's counter name, any case), as seat 0 sees them. */
function counters(s: Scenario, id: number, kind: RegExp): number {
	const obj = [...s.state(0).values()].find((o) => o._type === 0 && o._id === id);
	const list = ((obj?.Counters as { v?: [string, number][] } | undefined)?.v ?? []) as [string, number][];
	return list.filter(([k]) => kind.test(k)).reduce((n, [, v]) => n + Number(v), 0);
}

/** Seat 0 holds priority in a main phase with nothing on the stack and its OK live: everything it did has resolved. */
const settled = (s: Scenario): boolean => /^Priority: /.test(s.prompt(0)) && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;

/** A board pick: while the seat's prompt matches `when`, click `ids` one per prompt, then OK if `ok`. */
interface Pick {
	when: RegExp;
	ids: number[];
	ok?: boolean;
}

/** A yes/no on Forge's two buttons: Yes (OK) or No (Cancel), once. */
interface Bar {
	when: RegExp;
	yes: boolean;
}

interface Drive {
	picks?: Pick[];
	bars?: Bar[];
	/** OK every new empty-stack priority window, and declare no attackers: to move the turn on. */
	pass?: boolean;
}

/**
 * Answer seat 0's windows by `d` until `done`. One act per prompt Forge sends: a click re-renders the
 * prompt, so the next click waits for the new one. A payment Forge's Auto did not settle within 2.5 s
 * is paid land by land.
 */
async function drive(s: Scenario, label: string, done: () => boolean, d: Drive = {}, ms = 60_000): Promise<void> {
	const picks = (d.picks ?? []).map((p) => ({ ...p, next: 0, finished: false }));
	const bars = (d.bars ?? []).map((b) => ({ ...b, used: false }));
	const pay = landPayer(s, 0);
	let acted = -1;
	let payingSince: number | null = null;
	await waitUntil(
		() => {
			s.answerAsks();
			if (done()) return true;
			const at = s.sent.findLastIndex((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
			const msg = s.prompt(0);
			if (/Pay Mana Cost/.test(msg)) {
				payingSince ??= Date.now();
				if (Date.now() - payingSince > 2_500) pay();
				return false;
			}
			payingSince = null;
			if (at === acted || promptBar(s, 0) === null) return false;
			const bar = s.buttons(0);
			const pick = picks.find((p) => !p.finished && p.when.test(msg));
			if (pick !== undefined) {
				acted = at;
				if (pick.next < pick.ids.length) s.select(0, pick.ids[pick.next++]!);
				else {
					pick.finished = true;
					if (pick.ok === true && bar?.enable1 === true) s.ok(0);
				}
				return false;
			}
			const yesNo = bars.find((b) => !b.used && b.when.test(msg));
			if (yesNo !== undefined && bar !== null) {
				acted = at;
				yesNo.used = true;
				if (yesNo.yes) s.ok(0);
				else s.cancel(0);
				return false;
			}
			if (d.pass === true && bar?.enable1 === true && (/^Select creatures to attack/.test(msg) || (/^Priority: /.test(msg) && /^Stack: Empty$/m.test(msg)))) {
				acted = at;
				s.ok(0);
			}
			return false;
		},
		label,
		ms,
		s,
	);
}

/** Click `name` in seat 0's hand (or `zone`) and drive until it resolved and `effect` holds. */
async function cast(s: Scenario, name: string, effect: () => boolean, d: Drive = {}, zone: Zone = 'Hand'): Promise<void> {
	await waitUntil(() => (s.answerAsks(), settled(s) && cards(s, 'me', zone).some((c) => c.name === name)), `seat 0 to hold ${name} with priority`, 60_000, s);
	const card = one(s, 'me', zone, name);
	s.select(0, card.id);
	await drive(s, `${name} to resolve and do what it says`, () => !cards(s, 'me', zone).some((c) => c.id === card.id) && settled(s) && effect(), d);
}

/** Click a permanent seat 0 controls (an ability, a level) and drive until `effect` holds. */
async function activate(s: Scenario, id: number, label: string, effect: () => boolean, d: Drive = {}): Promise<void> {
	await waitUntil(() => (s.answerAsks(), settled(s)), `priority before ${label}`, 60_000, s);
	s.select(0, id);
	await drive(s, label, () => settled(s) && effect(), d);
}

const list = (xs: readonly string[]): string => xs.join(';');
const n = (name: string, k: number): string[] => Array.from({ length: k }, () => name);

interface Board {
	hand?: string[];
	battlefield?: string[];
	graveyard?: string[];
	library?: string[];
	aiBattlefield?: string[];
	aiLibrary?: string[];
	life?: number;
}

function stateOf(b: Board): string {
	return [
		'turn=3',
		'activeplayer=human',
		'activephase=MAIN1',
		`humanlife=${b.life ?? 20}`,
		'ailife=20',
		`humanhand=${list(b.hand ?? [])}`,
		`humanbattlefield=${list(b.battlefield ?? [])}`,
		`humangraveyard=${list(b.graveyard ?? [])}`,
		`humanlibrary=${list(b.library ?? n('Plains', 10))}`,
		'aihand=',
		`aibattlefield=${list(b.aiBattlefield ?? [])}`,
		'aigraveyard=',
		`ailibrary=${list(b.aiLibrary ?? n('Plains', 10))}`,
	].join('\n');
}

/**
 * Asks answered by the test, in order of arrival: the first handler that returns an answer takes the
 * ask. Anything none answers is answered plainly (`Scenario.answerAsks`).
 */
type Answer = (f: Ask) => unknown;

/** The `getChoices` option labelled `label`, ticked (the gift's "Promise Gift"; a Season's mode). */
const choose =
	(label: RegExp): Answer =>
	(f) => {
		if (f.method !== 'getChoices') return undefined;
		const opt = (f.choices as { key: string; label: string }[]).find((c) => label.test(c.label));
		return opt === undefined ? undefined : [opt.key];
	};

/** The offered ability whose label matches (an alternative cost, a land's one ability of several). */
const ability =
	(label: RegExp): Answer =>
	(f) =>
		f.method === 'getAbilityToPlay' ? ((f.abilities as { label?: string }[]).find((a) => label.test(a.label ?? '')) ?? undefined) : undefined;

async function withBoard(seed: number, board: Board, answers: Answer[], body: (s: Scenario, asked: Ask[]) => Promise<void>): Promise<void> {
	if (!available.ok) return;
	const asked: Ask[] = [];
	const s = await startScenario(available.config, {
		seed,
		decks: [deck('BLB A', ['40 Plains']), deck('BLB B', ['40 Plains'])],
		aiOpponent: true,
		skipOpening: true,
		scenario: stateOf(board),
		reply: (f) => {
			asked.push(f);
			for (const a of answers) {
				const r = a(f);
				if (r !== undefined) return r;
			}
			return undefined;
		},
	});
	const from = s.lines.length;
	try {
		await waitUntil(() => (s.answerAsks(), settled(s) && s.turn(0)?.n === 3), "seat 0's turn-3 main with the board", 90_000, s);
		await body(s, asked);
	} catch (e) {
		console.log(`[blb] timeline:\n${timeline(s, 0, from)}`);
		throw e;
	} finally {
		await s.stop();
	}
}

const PROMISE = choose(/Promise Gift/);
const T = 240_000;

describe.skipIf(!available.ok)(title('Bloomburrow mechanics do what the card says, against real Forge'), () => {
	it('gift a card: Wear Down promised destroys two, the opponent draws, and Jolly Gerbils draws for the giver', { timeout: T }, async () => {
		await withBoard(
			2911,
			{ hand: ['Wear Down'], battlefield: [...n('Forest', 2), 'Jolly Gerbils'], aiBattlefield: ['Mind Stone', 'Intangible Virtue', 'Plains'] },
			[PROMISE],
			async (s) => {
				const stone = one(s, 'ai', 'Battlefield', 'Mind Stone');
				const virtue = one(s, 'ai', 'Battlefield', 'Intangible Virtue');
				const myHand = cards(s, 'me', 'Hand').length;
				const theirHand = cards(s, 'ai', 'Hand').length;
				await cast(s, 'Wear Down', () => names(s, 'ai', 'Graveyard').length === 2, { picks: [{ when: /Select target artifact or enchantment/, ids: [stone.id, virtue.id] }] });
				expect(names(s, 'ai', 'Graveyard')).toEqual(['Intangible Virtue', 'Mind Stone']);
				expect(cards(s, 'ai', 'Hand').length, 'the gift: the opponent drew a card').toBe(theirHand + 1);
				expect(cards(s, 'me', 'Hand').length, 'Wear Down left, Jolly Gerbils drew one').toBe(myHand);
			},
		);
	});

	it('gift a card refused: Wear Down destroys one, nobody draws', { timeout: T }, async () => {
		await withBoard(
			2912,
			{ hand: ['Wear Down'], battlefield: [...n('Forest', 2), 'Jolly Gerbils'], aiBattlefield: ['Mind Stone', 'Intangible Virtue', 'Plains'] },
			[],
			async (s) => {
				const stone = one(s, 'ai', 'Battlefield', 'Mind Stone');
				const theirHand = cards(s, 'ai', 'Hand').length;
				const myHand = cards(s, 'me', 'Hand').length;
				await cast(s, 'Wear Down', () => names(s, 'ai', 'Graveyard').length === 1, { picks: [{ when: /Select target artifact or enchantment/, ids: [stone.id] }] });
				expect(names(s, 'ai', 'Graveyard')).toEqual(['Mind Stone']);
				expect(names(s, 'ai', 'Battlefield')).toContain('Intangible Virtue');
				expect(cards(s, 'ai', 'Hand').length).toBe(theirHand);
				expect(cards(s, 'me', 'Hand').length, 'no gift, so Jolly Gerbils drew nothing').toBe(myHand - 1);
			},
		);
	});

	it('gift a Food: Crumb and Get It promised gives the opponent a Food and makes the Bears 4/4', { timeout: T }, async () => {
		await withBoard(2913, { hand: ['Crumb and Get It'], battlefield: ['Plains', 'Grizzly Bears'] }, [PROMISE], async (s) => {
			const bears = one(s, 'me', 'Battlefield', 'Grizzly Bears');
			await cast(s, 'Crumb and Get It', () => count(s, 'ai', 'Battlefield', 'Food Token') === 1 && pt(s, bears.id)[0] === 4, {
				picks: [{ when: /Select target creature you control/, ids: [bears.id] }],
			});
			expect(pt(s, bears.id)).toEqual([4, 4]);
			expect(count(s, 'me', 'Battlefield', 'Food Token')).toBe(0);
		});
	});

	it('gift a Treasure: Blooming Blast promised kills the Bears, deals 3 to their controller, and gives them a Treasure', { timeout: T }, async () => {
		await withBoard(2914, { hand: ['Blooming Blast'], battlefield: n('Mountain', 2), aiBattlefield: ['Grizzly Bears'] }, [PROMISE], async (s) => {
			const bears = one(s, 'ai', 'Battlefield', 'Grizzly Bears');
			await cast(s, 'Blooming Blast', () => life(s, 'ai') === 17 && count(s, 'ai', 'Battlefield', 'Treasure Token') === 1, { picks: [{ when: /Select target creature/, ids: [bears.id] }] });
			expect(names(s, 'ai', 'Graveyard')).toEqual(['Grizzly Bears']);
		});
	});

	it('gift a tapped Fish: Into the Flood Maw promised bounces a creature and a nonland permanent, and the Fish enters tapped', { timeout: T }, async () => {
		await withBoard(2915, { hand: ['Into the Flood Maw'], battlefield: ['Island'], aiBattlefield: ['Grizzly Bears', 'Mind Stone', 'Plains'] }, [PROMISE], async (s) => {
			const bears = one(s, 'ai', 'Battlefield', 'Grizzly Bears');
			const stone = one(s, 'ai', 'Battlefield', 'Mind Stone');
			const theirHand = cards(s, 'ai', 'Hand').length;
			await cast(s, 'Into the Flood Maw', () => cards(s, 'ai', 'Hand').length === theirHand + 2, {
				picks: [
					{ when: /Select target creature an opponent controls/, ids: [bears.id] },
					{ when: /Select target nonland permanent an opponent controls/, ids: [stone.id] },
				],
			});
			expect(names(s, 'ai', 'Battlefield')).toEqual(['Fish Token', 'Plains']);
			expect(one(s, 'ai', 'Battlefield', 'Fish Token').tapped, 'a tapped Fish').toBe(true);
		});
	});

	it('offspring: Coruscation Mage paid makes a token copy, and both copies ping when a noncreature spell is cast', { timeout: T }, async () => {
		await withBoard(2916, { hand: ['Coruscation Mage', 'Mind Stone'], battlefield: n('Mountain', 6) }, [], async (s) => {
			await cast(s, 'Coruscation Mage', () => count(s, 'me', 'Battlefield', 'Coruscation Mage') === 2, { bars: [{ when: /Offspring/, yes: true }] });
			const mages = cards(s, 'me', 'Battlefield').filter((c) => c.name === 'Coruscation Mage');
			expect(mages.map((m) => pt(s, m.id)).sort(), 'the card and its 1/1 copy').toEqual([
				[1, 1],
				[2, 2],
			]);
			await cast(s, 'Mind Stone', () => life(s, 'ai') === 18);
			expect(life(s, 'ai'), 'one damage from each Mage').toBe(18);
		});
	});

	it('forage by Food: Feed the Cycle with the forage cost sacrifices the Food and destroys the target', { timeout: T }, async () => {
		await withBoard(
			2917,
			{ hand: ['Feed the Cycle'], battlefield: [...n('Swamp', 2), 'T:c_a_food_sac'], graveyard: ['Grizzly Bears', 'Shock', 'Forest'], aiBattlefield: ['Hill Giant'] },
			[ability(/Additional cost: Forage/)],
			async (s) => {
				const giant = one(s, 'ai', 'Battlefield', 'Hill Giant');
				await cast(s, 'Feed the Cycle', () => names(s, 'ai', 'Graveyard').includes('Hill Giant') && count(s, 'me', 'Battlefield', 'Food Token') === 0, {
					picks: [{ when: /Select target creature or planeswalker/, ids: [giant.id] }],
					bars: [{ when: /Sacrifice Food/, yes: true }],
				});
				expect(cards(s, 'me', 'Exile'), 'the Food paid it, not the graveyard').toHaveLength(0);
				expect(cards(s, 'me', 'Battlefield').filter((c) => c.tapped), 'the forage path costs {1}{B}: both Swamps').toHaveLength(2);
			},
		);
	});

	it('forage by graveyard: Feed the Cycle exiles three graveyard cards when the Food is refused', { timeout: T }, async () => {
		await withBoard(
			2918,
			{ hand: ['Feed the Cycle'], battlefield: [...n('Swamp', 2), 'T:c_a_food_sac'], graveyard: ['Grizzly Bears', 'Shock', 'Forest', 'Island'], aiBattlefield: ['Hill Giant'] },
			[ability(/Additional cost: Forage/)],
			async (s) => {
				const giant = one(s, 'ai', 'Battlefield', 'Hill Giant');
				const yard = cards(s, 'me', 'Graveyard').filter((c) => c.name !== 'Island');
				await cast(s, 'Feed the Cycle', () => names(s, 'ai', 'Graveyard').includes('Hill Giant'), {
					picks: [
						{ when: /Select target creature or planeswalker/, ids: [giant.id] },
						{ when: /to exile/, ids: yard.map((c) => c.id), ok: true },
					],
					bars: [{ when: /Sacrifice Food/, yes: false }],
				});
				expect(names(s, 'me', 'Exile')).toEqual(['Forest', 'Grizzly Bears', 'Shock']);
				expect(names(s, 'me', 'Graveyard')).toEqual(['Feed the Cycle', 'Island']);
				expect(count(s, 'me', 'Battlefield', 'Food Token'), 'the Food stayed').toBe(1);
			},
		);
	});

	it('expend 4: Bakersbane Duo gets +1/+1 as the fourth mana is spent on spells this turn', { timeout: T }, async () => {
		await withBoard(2919, { hand: ['Grizzly Bears', 'Grizzly Bears'], battlefield: [...n('Forest', 4), 'Bakersbane Duo'] }, [], async (s) => {
			const duo = one(s, 'me', 'Battlefield', 'Bakersbane Duo');
			await cast(s, 'Grizzly Bears', () => count(s, 'me', 'Battlefield', 'Grizzly Bears') === 1);
			expect(pt(s, duo.id), 'two mana spent: not yet').toEqual([2, 2]);
			await cast(s, 'Grizzly Bears', () => count(s, 'me', 'Battlefield', 'Grizzly Bears') === 2 && pt(s, duo.id)[0] === 3);
			expect(pt(s, duo.id)).toEqual([3, 3]);
		});
	});

	it('valiant: Heartfire Hero gets one counter the first time it is targeted this turn, none the second', { timeout: T }, async () => {
		await withBoard(2920, { hand: ['Giant Growth', 'Giant Growth'], battlefield: [...n('Forest', 2), 'Heartfire Hero'] }, [], async (s) => {
			const hero = one(s, 'me', 'Battlefield', 'Heartfire Hero');
			const target = { picks: [{ when: /Select target creature/, ids: [hero.id] }] };
			await cast(s, 'Giant Growth', () => pt(s, hero.id)[0] === 5, target);
			expect(counters(s, hero.id, /p1p1|\+1\/\+1/i)).toBe(1);
			await cast(s, 'Giant Growth', () => pt(s, hero.id)[0] === 8, { picks: [{ when: /Select target creature/, ids: [hero.id] }] });
			expect(counters(s, hero.id, /p1p1|\+1\/\+1/i), 'valiant triggers once each turn').toBe(1);
		});
	});

	it('pawprints: Season of Loss with the sacrifice mode twice and the life loss once spends exactly five', { timeout: T }, async () => {
		const modes = [/sacrifices a creature/, /sacrifices a creature/, /loses X life/];
		let picked = 0;
		const season: Answer = (f) => {
			if (f.method !== 'getChoices' || !/Choose a mode/.test(String(f.message))) return undefined;
			const want = modes[picked];
			if (want === undefined) return [];
			picked++;
			return choose(want)(f);
		};
		await withBoard(
			2921,
			{ hand: ['Season of Loss'], battlefield: [...n('Swamp', 5), 'Grizzly Bears', 'Savannah Lions'], aiBattlefield: ['Hill Giant', 'Craw Wurm'] },
			[season],
			async (s, asked) => {
				const mine = cards(s, 'me', 'Battlefield').filter((c) => c.creature);
				await cast(s, 'Season of Loss', () => life(s, 'ai') === 18, { picks: [{ when: /to sacrifice|Select 1 creature/, ids: mine.map((c) => c.id) }] });
				expect(cards(s, 'me', 'Battlefield').filter((c) => c.creature), 'two sacrifices each').toHaveLength(0);
				expect(cards(s, 'ai', 'Battlefield').filter((c) => c.creature)).toHaveLength(0);
				expect(life(s, 'ai'), 'two creature cards in the graveyard').toBe(18);
				const modeAsks = asked.filter((f) => f.method === 'getChoices' && /Choose a mode/.test(String(f.message)));
				expect(modeAsks.length, 'five pawprints spent in three picks: no fourth question').toBe(3);
				expect((modeAsks[2]!.choices as unknown[]).length, 'with three pawprints left, only the modes that fit are offered').toBeLessThanOrEqual(3);
			},
		);
	});

	it('a Talent levels up: Caretaker’s Talent level 2 copies a token (drawing once), level 3 makes creature tokens +2/+2', { timeout: T }, async () => {
		await withBoard(2922, { hand: ["Caretaker's Talent"], battlefield: [...n('Plains', 8), 'T:g_1_1_squirrel'] }, [ability(/Level 2/), ability(/Level 3/)], async (s) => {
			const squirrel = one(s, 'me', 'Battlefield', 'Squirrel Token');
			await cast(s, "Caretaker's Talent", () => count(s, 'me', 'Battlefield', "Caretaker's Talent") === 1);
			const talent = one(s, 'me', 'Battlefield', "Caretaker's Talent");
			const hand = cards(s, 'me', 'Hand').length;
			await activate(s, talent.id, 'level 2 and its copy', () => count(s, 'me', 'Battlefield', 'Squirrel Token') === 2, {
				picks: [{ when: /Select target token you control/, ids: [squirrel.id] }],
			});
			expect(cards(s, 'me', 'Hand').length, 'a token entered: draw a card').toBe(hand + 1);
			await activate(s, talent.id, 'level 3', () => cards(s, 'me', 'Battlefield').filter((c) => c.name === 'Squirrel Token').every((c) => pt(s, c.id)[0] === 3));
			for (const sq of cards(s, 'me', 'Battlefield').filter((c) => c.name === 'Squirrel Token')) expect(pt(s, sq.id)).toEqual([3, 3]);
		});
	});

	it('Dragonhawk exiles one card per big creature, one is played from exile, and the end step deals 2 for the one left', { timeout: T }, async () => {
		await withBoard(
			2923,
			{ hand: ["Dragonhawk, Fate's Tempest"], battlefield: [...n('Mountain', 5), 'Craw Wurm|SummonSick'], library: ['Forest', 'Plains', ...n('Plains', 8)] },
			[],
			async (s) => {
				await cast(s, "Dragonhawk, Fate's Tempest", () => cards(s, 'me', 'Exile').length === 2);
				expect(names(s, 'me', 'Exile')).toEqual(['Forest', 'Plains']);
				const forest = one(s, 'me', 'Exile', 'Forest');
				await activate(s, forest.id, 'the exiled Forest played', () => count(s, 'me', 'Battlefield', 'Forest') === 1);
				expect(names(s, 'me', 'Exile')).toEqual(['Plains']);
				await drive(s, 'the end step: 2 damage for the card still exiled', () => life(s, 'ai') === 18, { pass: true }, 90_000);
				expect(life(s, 'ai')).toBe(18);
			},
		);
	});

	it('Eluge floods a Forest into an Island, counts it, and makes the first instant or sorcery {U} cheaper', { timeout: T }, async () => {
		await withBoard(2924, { hand: ['Eluge, the Shoreless Sea', 'Divination'], battlefield: [...n('Island', 4), 'Forest', 'Mountain'] }, [], async (s) => {
			const forest = one(s, 'me', 'Battlefield', 'Forest');
			await cast(s, 'Eluge, the Shoreless Sea', () => counters(s, forest.id, /flood/i) === 1, { picks: [{ when: /Select target land/, ids: [forest.id] }] });
			const eluge = one(s, 'me', 'Battlefield', 'Eluge, the Shoreless Sea');
			expect(pt(s, eluge.id), 'four Islands and the flooded Forest').toEqual([5, 5]);
			const hand = cards(s, 'me', 'Hand').length;
			await cast(s, 'Divination', () => cards(s, 'me', 'Hand').length === hand + 1);
			expect(cards(s, 'me', 'Battlefield').filter((c) => c.land && !c.tapped), 'Divination cost {2}: the Forest and the Mountain').toHaveLength(0);
		});
	});

	it('Bat life payoffs: a Food’s life gain drains with Starscape Cleric and pumps the Bats with Moonstone Harbinger', { timeout: T }, async () => {
		await withBoard(2925, { battlefield: [...n('Plains', 2), 'Starscape Cleric', 'Moonstone Harbinger', 'T:c_a_food_sac'] }, [], async (s) => {
			const cleric = one(s, 'me', 'Battlefield', 'Starscape Cleric');
			const harbinger = one(s, 'me', 'Battlefield', 'Moonstone Harbinger');
			const food = one(s, 'me', 'Battlefield', 'Food Token');
			await activate(s, food.id, 'the Food eaten', () => life(s, 'me') === 23 && life(s, 'ai') === 19 && pt(s, harbinger.id)[0] === 2);
			expect(pt(s, cleric.id), 'a Bat: +1/+0').toEqual([3, 1]);
			expect(pt(s, harbinger.id)).toEqual([2, 3]);
		});
	});

	it('Ygra makes other creatures Food: eating the Bears gains 3 and puts two counters on Ygra', { timeout: T }, async () => {
		await withBoard(2926, { battlefield: [...n('Forest', 2), 'Ygra, Eater of All', 'Grizzly Bears'] }, [ability(/gain 3 life/i)], async (s) => {
			const ygra = one(s, 'me', 'Battlefield', 'Ygra, Eater of All');
			const bears = one(s, 'me', 'Battlefield', 'Grizzly Bears');
			await activate(s, bears.id, 'the Bears eaten', () => life(s, 'me') === 23 && counters(s, ygra.id, /p1p1|\+1\/\+1/i) === 2);
			expect(names(s, 'me', 'Graveyard')).toEqual(['Grizzly Bears']);
		});
	});

	it('Lumra mills four, returns the lands among them tapped, and counts every land', { timeout: T }, async () => {
		await withBoard(
			2927,
			{ hand: ['Lumra, Bellow of the Woods'], battlefield: n('Forest', 6), library: ['Island', 'Grizzly Bears', 'Mountain', 'Shock', ...n('Plains', 6)] },
			[],
			async (s) => {
				await cast(s, 'Lumra, Bellow of the Woods', () => names(s, 'me', 'Graveyard').length === 2 && cards(s, 'me', 'Battlefield').filter((c) => c.land).length === 8);
				expect(names(s, 'me', 'Graveyard')).toEqual(['Grizzly Bears', 'Shock']);
				expect(one(s, 'me', 'Battlefield', 'Island').tapped).toBe(true);
				expect(pt(s, one(s, 'me', 'Battlefield', 'Lumra, Bellow of the Woods').id)).toEqual([8, 8]);
			},
		);
	});

	it('Fountainport: {3}, {T}, pay 1 life makes a Fish', { timeout: T }, async () => {
		await withBoard(2928, { battlefield: [...n('Plains', 3), 'Fountainport'] }, [ability(/Fish/)], async (s) => {
			const port = one(s, 'me', 'Battlefield', 'Fountainport');
			await activate(s, port.id, 'the Fish made', () => count(s, 'me', 'Battlefield', 'Fish Token') === 1);
			expect(life(s, 'me')).toBe(19);
			expect(one(s, 'me', 'Battlefield', 'Fountainport').tapped).toBe(true);
		});
	});

	for (const [lands, untapped] of [
		[3, true],
		[2, false],
	] as const) {
		it(`Fabled Passage with ${lands} other lands: the basic enters ${untapped ? 'and untaps' : 'tapped'}`, { timeout: T }, async () => {
			await withBoard(2929 + lands, { battlefield: [...n('Plains', lands), 'Fabled Passage'], library: ['Island', 'Forest', ...n('Plains', 6)] }, [], async (s) => {
				const passage = one(s, 'me', 'Battlefield', 'Fabled Passage');
				await activate(s, passage.id, 'the Passage cracked', () => cards(s, 'me', 'Battlefield').filter((c) => c.land).length === lands + 1 && !names(s, 'me', 'Battlefield').includes('Fabled Passage'));
				expect(names(s, 'me', 'Graveyard')).toEqual(['Fabled Passage']);
				const fetched = cards(s, 'me', 'Battlefield').filter((c) => c.land && c.name !== 'Plains');
				expect(fetched).toHaveLength(1);
				expect(fetched[0]!.tapped).toBe(!untapped);
			});
		});
	}

	it('Hunter’s Talent enters and makes the Wurm fight-bite the Giant', { timeout: T }, async () => {
		await withBoard(2933, { hand: ["Hunter's Talent"], battlefield: [...n('Forest', 2), 'Craw Wurm'], aiBattlefield: ['Hill Giant'] }, [], async (s) => {
			const wurm = one(s, 'me', 'Battlefield', 'Craw Wurm');
			const giant = one(s, 'ai', 'Battlefield', 'Hill Giant');
			await cast(s, "Hunter's Talent", () => names(s, 'ai', 'Graveyard').includes('Hill Giant'), {
				picks: [
					{ when: /Select target creature you control/, ids: [wurm.id] },
					{ when: /Select target creature you don't control/, ids: [giant.id] },
				],
			});
			expect(names(s, 'me', 'Battlefield')).toContain('Craw Wurm');
		});
	});
});
