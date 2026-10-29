/**
 * Which cards' conditions are on, on the wire, against real Forge.
 *
 * The operator, 2026-10-15: "i would like it if the game told you when things like 'metalcraft' are
 * active. other things like threshold, delirium, etc. anything that has some count and matters for
 * the card should somehow indicate as being active." The two seats hold the same conditional cards
 * on opposite sides of each count — seat 0 controls three artifacts and has seven cards of five types
 * in its graveyard and cards in hand; seat 1 controls two artifacts, has six lands in its graveyard
 * and an empty hand — so each kind is asked once met and once not:
 *
 *   metalcraft  Carapace Forger (static `Condition$`), Galvanic Blast in hand (`Count$Metalcraft.4.2`)
 *   threshold   Anurid Barkripper (static `Condition$`)
 *   delirium    Angel of Deliverance (trigger `Delirium$ True`)
 *   hellbent    Gathan Raiders (static `Condition$`) — on for seat 1, off for seat 0
 *   spell mastery  Calculated Dismissal in hand (sub-ability `ConditionPresent$`), Fiery Impulse in hand
 *                  (sub-ability `ConditionCheckSVar$ … GE2` beside its default branch's `LT2`)
 *
 * and never: Grizzly Bears and Lightning Bolt (no condition), Tarmogoyf (a count, not a condition),
 * Arrow Storm with no attack (its "otherwise" branch is always met, and must not light it), Voice
 * of Victory on seat 0's own turn ("during your turn" is timing, not a count) and Starting Town
 * (its "enters tapped unless" count is a drawback, not a bonus).
 * Pulse of the Forge's "if that player has more life than you" names its target, which a card in
 * hand has none of, and Forge's check throws there: that card stays dark and every other card is
 * still read.
 * Seat 1 must not be told about a card in seat 0's hand.
 *
 * The operator, 2026-10-16: "why is the spell mastery condition highlighted here? there are no cards
 * in my gy" — Fiery Impulse in an opening hand. A second game holds it, with Arrow Storm, at turn 1
 * with both graveyards empty: an "instead"'s default branch ("LT2", "EQ0") is met there, and must not
 * light the card; nor must Curious Obsession's "if you didn't attack" (a trigger's `SVarCompare$ EQ0`,
 * which Forge reads from the trigger's own parameters rather than the map it is handed), nor Jeweled
 * Amulet's "activate only if there are no charge counters" (an activation's `SVarCompare$ EQ0`), nor
 * Mythos of Illuna's plain copy (`ConditionManaNotSpent$`, beside its "if {R}{G} was spent"). A lone
 * comparison met at 0 is no default: Bloodghast's haste with the opponent at 10 life (`LE10`) lights.
 *
 * The operator, 2026-10-20: "why is 'Kappa Cannoneer' highlighted in orange? what conditional effect
 * is relevant here that would make it highlight?" — none. Its trigger carries `IsPresent$ Card.Self`,
 * Forge's "only while this card is here", which the card's own presence always meets. A third game
 * holds the cards whose only presence check is the card itself — a trigger's (Kappa Cannoneer,
 * Steelfin Whale), a sub-ability's (Oubliette's `ConditionPresent$ Card.Self`), an activation's
 * (Durkwood Tracker), and Edgar Markov's `Card.StrictlySelf` ("this object, not a new one") — beside a metalcraft card with three artifacts and Guardian Beast, whose
 * "as long as it is untapped" (`Card.Self+untapped`) is a condition the card itself can turn off.
 *
 * The operator, 2026-10-20: "yes do the anger and name sticker glows." A card shows its condition
 * where the condition works. Anger's haste works from the graveyard (`EffectZone$ Graveyard`), so on
 * the battlefield or in hand beside a Mountain it stays dark. A trigger whose event can no longer happen for the card
 * is spent: Name Sticker Goblin's "when this enters, if …" (`LE9`), Acclaimed Contender's and Blizzard
 * Strix's "when this enters, if you control another …", Kozilek's "when you cast this spell, if …" —
 * all met, all on the battlefield, all dark. In hand an "enters" condition still lights, as what the
 * card would do when cast (Acclaimed Contender beside two Knights), and Carapace Forger's metalcraft
 * still lights on the battlefield.
 *
 * The operator, 2026-10-21: "yeah show the anger glow in the gy". The frame reads every zone the
 * board draws a card in — graveyard and exile beside hand and battlefield — and the same rule decides
 * there: Anger, Brawn, Wonder and Filth (`EffectZone$ Graveyard` + `IsPresent$` a basic land type)
 * light in seat 0's graveyard beside a Mountain, Forest, Island and Swamp, and stay dark in seat 1's
 * beside only Plains. Anger exiled beside a Mountain stays dark (its haste does not work from exile),
 * and a spell is asked only where it is cast from: Calculated Dismissal and Fiery Impulse in a
 * graveyard of three instants stay dark although their spell mastery is met.
 *
 * The operator, 2026-10-21: "just static abilities like anger is fine. castable cards like gravecrawler
 * can just use the normal 'castable' glow logic". A static whose only effect is a permission to play
 * the card (`MayPlay$`, `Mode$ CastWithFlash`) is not a condition: Gravecrawler in the graveyard beside
 * a Zombie and Bard's Company in hand beside a Human stay dark, and Gravecrawler is in Forge's
 * actionable set instead. Anger beside it still lights.
 *
 * The operator, 2026-10-21: "why is crush of tentacles orange here? i haven't cast any other spells
 * that would activate surge". Forge makes an alternative cost its own copy of the spell, paid that
 * way by construction, so its "if the surge cost was paid" (`Condition$ Surge`) always holds there;
 * what decides it is whether the spell can be cast that way now, Forge's own restriction for that
 * copy ("you or a teammate cast another spell this turn"). Crush of Tentacles in an opening hand
 * stays dark, lights once Ornithopter is cast, and is dark again on the next turn. Rix Maadi Reveler
 * (spectacle, no opponent has lost life) and Monastery Raid (freerunning, no combat damage) stay dark.
 *
 * The operator, 2026-10-21: "i would have expected to see crush of tentacles change to 3UU in my
 * hand", ruling "only conditional costs": the hand shows an alternative cost only while a condition
 * that can change in the game unlocks it — Forge's own `SpellAbilityRestriction.alternativeCostMet`
 * — and only when it is cheaper. Crush of Tentacles shows {4}{U}{U}, then {3}{U}{U} after Ornithopter,
 * then {4}{U}{U} on turn 2. Skewer the Critics (no "spectacle paid" bonus) lights and shows {R} once
 * Flame Rift made an opponent lose life; Rix Maadi Reveler lights then but keeps its cheaper printed
 * cost. Mulldrifter's evoke is unconditional, so it shows {4}{U} and stays dark; Etherium Sculptor
 * still takes {1} off Chief of the Foundry.
 *
 * The operator, 2026-10-22: "why does spell queller have an orange outline? this doesn't have a
 * conditional effect that i would consider relevant." Spell Queller's "the exiled card's owner may
 * cast it" is scripted with `ConditionCheckSVar$ X` on `Remembered$Amount`, a guard that "the exiled
 * card" still exists, on the very ability that acts on it (`Defined$ Remembered.ExiledWithSource`):
 * met for as long as Queller holds a spell. A check on what an ability itself acts on is its
 * referent, not a condition. A sixth game holds Spell Queller with a Lightning Bolt it exiled, dark;
 * beside it Veteran Survivor with three cards exiled with it (`ExiledWith$Amount GE3`, a count the
 * player builds) and Cobra Trap in hand with a destroyed permanent remembered (`Remembered$Amount`
 * that only counts), both lit.
 *
 * The operator, 2026-10-22: "preacher of the schism doesn't need an orange border. i get that it has
 * conditional effects, but at least one of them is always active. cards like that don't need orange
 * border." Preacher's two attack triggers ask the same "most life or tied" (`withMostLife`) of the
 * two seats — the draw's `CheckDefinedPlayer$ You.withMostLife`, the token's `Attacked$
 * Player.withMostLife` — and in a two-seat game one of the two always has it. A seventh game holds
 * Preacher with seat 0 ahead on life, dark, beside Carapace Forger's metalcraft, lit.
 *
 * The playtest of 2026-10-26: Infernal Tutor's hellbent clause lit the orange rim with a full
 * hand. Its script pairs the printed Hellbent branch
 * (`SVar:DBChangeZone2`, `ConditionCheckSVar$ X | ConditionSVarCompare$ LT1`) against the ordinary
 * branch, which has no `ConditionSVarCompare` of its own and so defaults to `GE1` — and `X` is
 * `Count$ValidHand Card.YouOwn`, a hand, which starts full and empties over the game rather than
 * starting empty and filling up. `quiet()`'s general rule ("the branch met when nothing has been
 * counted is the default") assumed every such pair's floor is the common state, true for Arrow
 * Storm's Raid and Gruesome Discovery's Morbid (both proven above and both still proven here) but
 * backwards for a hand: 0 cards is Hellbent, the NAMED, rare state, and GE1 ("at least one card") is
 * the default that should stay dark. An eighth game holds Infernal Tutor in a seven-card hand, dark.
 *
 * The operator, 2026-10-28: "frontline medic is showing orange on the battle field while not
 * attacking. … i dont think it should have an orange glow at all since it's not really a passive
 * effect, it triggers when attacking." Battalion is scripted on the attack trigger itself
 * (`Mode$ Attacks | ValidCard$ Card.Self | IsPresent$ Creature.attacking+Other | PresentCompare$
 * GE2`): a count of the creatures the declaration it triggers on made attackers, anyone's, so the
 * rim lit the AI's Medic while the human attacked with two creatures (prod match m-b7b9edfcefd6).
 * A ninth game has seat 0 attack with two Grizzly Bears and one of its two Frontline Medics, beside
 * the AI's Medic: no Medic lights before, during or after the declaration — the one that stayed
 * home, the one whose battalion fired, the opponent's. Courageous Goblin's attack trigger, whose
 * `IsPresent$ Creature.YouCtrl+powerGE4` is a board it stands on (Craw Wurm), lights throughout.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/condition-met \
 *   pnpm exec vitest run apps/server/src/play/condition-met.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, castNamed, deck, finishMulligan, inOwnMain, passUntil, startScenario, toDeclareAttackers, waitUntil, type Card, type Scenario } from './scenario.js';

const title = available.ok
	? 'condition-met: the frame names the cards whose condition is on, against real Forge'
	: `condition-met: the frame names the cards whose condition is on, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Swamps', ['40 Swamp']), deck('Plains', ['40 Plains'])];

const CONDITIONAL = 'Carapace Forger;Anurid Barkripper;Angel of Deliverance;Gathan Raiders';

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Galvanic Blast;Calculated Dismissal;Fiery Impulse;Pulse of the Forge;Arrow Storm;Lightning Bolt;Voice of Victory;Starting Town',
	`humanbattlefield=Ornithopter;Ornithopter;Ornithopter;${CONDITIONAL};Grizzly Bears;Tarmogoyf;Swamp`,
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=Swamp;Grizzly Bears;Lightning Bolt;Divination;Ornithopter;Swamp;Swamp',
	'aihand=',
	`aibattlefield=Ornithopter;Ornithopter;${CONDITIONAL};Plains`,
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=Plains;Plains;Plains;Plains;Plains;Plains',
].join('\n');

const EMPTY_GRAVEYARDS = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=10',
	'humanhand=Fiery Impulse;Arrow Storm;Curious Obsession;Jeweled Amulet;Mythos of Illuna;Bloodghast;Mountain',
	'humanbattlefield=',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

const SELF_PRESENCE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Ornithopter;Ornithopter;Kappa Cannoneer;Carapace Forger;Steelfin Whale;Oubliette;Durkwood Tracker;Edgar Markov;Guardian Beast;Swamp',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

const WHERE_IT_WORKS = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Anger;Acclaimed Contender',
	'humanbattlefield=Ornithopter;Ornithopter;Ornithopter;Carapace Forger;Anger;"Name Sticker" Goblin;Acclaimed Contender;Acclaimed Contender;Blizzard Strix;Snow-Covered Mountain;Kozilek, the Great Distortion;Mountain;Forest;Island;Swamp',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=Anger;Brawn;Wonder;Filth;Calculated Dismissal;Fiery Impulse;Lightning Bolt',
	'humanexile=Anger',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=Anger;Brawn;Wonder;Filth',
].join('\n');

const PERMISSIONS = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	"humanhand=Bard's Company",
	'humanbattlefield=Diregraf Ghoul;Elite Vanguard;Swamp;Mountain',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=Gravecrawler;Anger',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

const ALTERNATIVE_COSTS = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Crush of Tentacles;Crush of Tentacles;Ornithopter;Rix Maadi Reveler;Monastery Raid;Skewer the Critics;Flame Rift;Mulldrifter;Chief of the Foundry',
	'humanbattlefield=Island;Island;Island;Mountain;Mountain;Etherium Sculptor',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

const MEMORY = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Cobra Trap|RememberedCards:311',
	'humanbattlefield=Spell Queller|Id:301|RememberedCards:302;Veteran Survivor|Id:303;Island;Plains',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'humanexile=Grizzly Bears|ExiledWith:303;Grizzly Bears|ExiledWith:303;Grizzly Bears|ExiledWith:303',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=Ornithopter|Id:311',
	'aiexile=Lightning Bolt|Id:302|ExiledWith:301',
].join('\n');

const EITHER_OR = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=15',
	'humanhand=',
	'humanbattlefield=Preacher of the Schism;Carapace Forger;Ornithopter;Ornithopter;Ornithopter;Swamp',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

/** Infernal Tutor's printed Hellbent branch (`Count$ValidHand`) beside Arrow Storm's Raid and Gruesome Discovery's Morbid, which count a per-turn event instead and must stay proven unchanged. */
const HELLBENT_HAND = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Infernal Tutor;Arrow Storm;Gruesome Discovery;Swamp;Swamp;Swamp;Swamp',
	'humanbattlefield=',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

/** Two Frontline Medics and two Grizzly Bears that can attack, the AI's Medic, and Courageous Goblin beside Craw Wurm. */
const COMBAT_EVENT = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Frontline Medic;Frontline Medic;Grizzly Bears;Grizzly Bears;Courageous Goblin;Craw Wurm;Plains',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Frontline Medic;Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

/** The graveyard incarnations: each lights from its owner's graveyard while its owner controls its basic land type. */
const INCARNATIONS = ['Anger', 'Brawn', 'Wonder', 'Filth'];

/** The latest `conditionMet` snapshot `seat` was sent, or null when none has been. */
function latestConditionMet(s: Scenario, seat: number, from = 0): number[] | null {
	const snapshots = s.sent
		.slice(from)
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { conditionMet?: number[] } }).payload?.conditionMet)
		.filter((p): p is number[] => Array.isArray(p));
	return snapshots.at(-1) ?? null;
}

/** The first `conditionMet` snapshot `seat` was sent from `from` on, or null when none has been. */
function firstConditionMet(s: Scenario, seat: number, from: number): number[] | null {
	for (const x of s.sent.slice(from)) {
		const met = x.seat === seat && x.envelope.frame.kind === 'notify' ? (x.envelope.frame as unknown as { payload?: { conditionMet?: number[] } }).payload?.conditionMet : undefined;
		if (Array.isArray(met)) return met;
	}
	return null;
}

/** A cost as `ManaCost.serialize` writes it: the generic amount, then each shard's name, joined by \u0006. */
const mana = (generic: number, ...shards: string[]): string => [String(generic), ...shards].join('\u0006');

type Held = { cost?: string; printed?: string; costBy?: string[] };

/** The latest `heldChanges` `seat` was sent from `from` on, by card id, or null when none has been. */
function latestHeld(s: Scenario, seat: number, from = 0): Map<number, Held> | null {
	const lists = s.sent
		.slice(from)
		.filter((x) => x.seat === seat)
		.map((x) => (x.envelope.frame as unknown as { heldChanges?: (Held & { card: { id: number } })[] }).heldChanges)
		.filter((h): h is (Held & { card: { id: number } })[] => Array.isArray(h));
	const last = lists.at(-1);
	return last === undefined ? null : new Map(last.map((h) => [h.card.id, { cost: h.cost, printed: h.printed, costBy: h.costBy }]));
}

/** The cost the hand shows for `c`: the changed cost when `held` lists one, else the printed cost (absent). */
function shown(held: Map<number, Held> | null, c: Card): Held | undefined {
	return held?.get(c.id);
}

/** Every `conditionMet` snapshot `seat` was sent from `from` on. */
function conditionMetFrom(s: Scenario, seat: number, from: number): number[][] {
	return s.sent
		.slice(from)
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { conditionMet?: number[] } }).payload?.conditionMet)
		.filter((p): p is number[] => Array.isArray(p));
}

/** Whether seat 0's wire state marks the card attacking. */
function attackingOnWire(s: Scenario, id: number): boolean {
	const view = [...s.state(0).values()].find((o) => o._type === 0 && o._id === id);
	return (view?.Attacking as { v?: boolean } | undefined)?.v === true;
}

function named(cards: readonly Card[], name: string): Card {
	const c = cards.find((x) => x.name === name);
	if (c === undefined) throw new Error(`no ${name} among ${cards.map((x) => x.name).join(', ')}`);
	return c;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'metalcraft, threshold, delirium, hellbent and spell mastery light where they are met and nowhere else; an unconditional card never does',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 82, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Carapace Forger') && s.zone(1, 'Battlefield').some((c) => c.name === 'Gathan Raiders');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const mine = [...s.zone(0, 'Battlefield'), ...s.zone(0, 'Hand')];
				const theirs = s.zone(1, 'Battlefield');
				const on = [
					named(mine, 'Carapace Forger'),
					named(mine, 'Galvanic Blast'),
					named(mine, 'Anurid Barkripper'),
					named(mine, 'Angel of Deliverance'),
					named(mine, 'Calculated Dismissal'),
					named(mine, 'Fiery Impulse'),
					named(theirs, 'Gathan Raiders'),
				];
				const off = [
					named(theirs, 'Carapace Forger'),
					named(theirs, 'Anurid Barkripper'),
					named(theirs, 'Angel of Deliverance'),
					named(mine, 'Gathan Raiders'),
					named(mine, 'Grizzly Bears'),
					named(mine, 'Tarmogoyf'),
					named(mine, 'Lightning Bolt'),
					named(mine, 'Arrow Storm'),
					named(mine, 'Voice of Victory'),
					named(mine, 'Starting Town'),
					named(mine, 'Pulse of the Forge'),
					named(mine, 'Ornithopter'),
				];
				const failures = s.stderr().split('\n').filter((l) => l.includes('conditionMet'));
				console.log(`[ca-condition-met.jvm] bridge conditionMet failures: ${failures.length} ${JSON.stringify(failures.slice(0, 3))}`);
				expect(failures, 'the bridge read every frame’s cards').toEqual([]);
				const seat0 = latestConditionMet(s, 0);
				const lit = [...mine, ...theirs].filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[ca-condition-met.jvm] seat 0: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const c of on) expect(seat0, `${c.name}#${c.id} is on`).toContain(c.id);
				for (const c of off) expect(seat0, `${c.name}#${c.id} is off`).not.toContain(c.id);

				const seat1 = latestConditionMet(s, 1);
				console.log(`[ca-condition-met.jvm] seat 1: conditionMet=${JSON.stringify(seat1)}`);
				expect(seat1, 'seat 1 was sent a conditionMet snapshot').not.toBeNull();
				for (const c of on.filter((x) => !s.zone(0, 'Hand').some((h) => h.id === x.id))) expect(seat1, `seat 1 sees ${c.name}#${c.id} on`).toContain(c.id);
				for (const c of s.zone(0, 'Hand')) expect(seat1, `seat 1 is told nothing of ${c.name}#${c.id} in seat 0's hand`).not.toContain(c.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'an "instead" whose bonus is off does not light from its default branch: Fiery Impulse with an empty graveyard',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 84, decks: DECKS, scenario: EMPTY_GRAVEYARDS });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Fiery Impulse');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const hand = s.zone(0, 'Hand');
				const seat0 = latestConditionMet(s, 0);
				const lit = hand.filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[cf-condition-met.jvm] empty graveyards: graveyard=${s.zone(0, 'Graveyard').length} conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(s.zone(0, 'Graveyard'), 'seat 0’s graveyard is empty').toEqual([]);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const name of ['Fiery Impulse', 'Arrow Storm', 'Curious Obsession', 'Jeweled Amulet', 'Mythos of Illuna']) {
					const c = named(hand, name);
					expect(seat0, `${c.name}#${c.id} is off`).not.toContain(c.id);
				}
				const bloodghast = named(hand, 'Bloodghast');
				expect(seat0, `Bloodghast#${bloodghast.id} is on with the opponent at 10 life`).toContain(bloodghast.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'a presence check whose only subject is the card itself is not a condition: Kappa Cannoneer on the battlefield stays dark',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 85, decks: DECKS, scenario: SELF_PRESENCE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Kappa Cannoneer');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const board = s.zone(0, 'Battlefield');
				const seat0 = latestConditionMet(s, 0);
				const lit = board.filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[cm-condition-met.jvm] self presence: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const name of ['Kappa Cannoneer', 'Steelfin Whale', 'Oubliette', 'Durkwood Tracker', 'Edgar Markov']) {
					const c = named(board, name);
					expect(seat0, `${c.name}#${c.id} is off`).not.toContain(c.id);
				}
				for (const name of ['Carapace Forger', 'Guardian Beast']) {
					const c = named(board, name);
					expect(seat0, `${c.name}#${c.id} is on`).toContain(c.id);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'a card shows its condition where it works: Anger lights in the graveyard beside a Mountain, and stays dark on the battlefield, in exile and without one; a spent "when this enters, if …" stays dark',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 86, decks: DECKS, scenario: WHERE_IT_WORKS });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return (
						inOwnMain(s, 0, 1) &&
						s.zone(0, 'Battlefield').some((c) => c.name === '"Name Sticker" Goblin') &&
						s.zone(0, 'Graveyard').some((c) => c.name === 'Brawn') &&
						s.zone(0, 'Exile').some((c) => c.name === 'Anger') &&
						s.zone(1, 'Graveyard').some((c) => c.name === 'Filth')
					);
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const board = s.zone(0, 'Battlefield');
				const hand = s.zone(0, 'Hand');
				const graveyard = s.zone(0, 'Graveyard');
				const exile = s.zone(0, 'Exile');
				const theirGraveyard = s.zone(1, 'Graveyard');
				const seat0 = latestConditionMet(s, 0);
				const lit = [...board, ...hand, ...graveyard, ...exile, ...theirGraveyard].filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[cg-condition-met.jvm] where it works: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				const off = [
					named(board, 'Anger'),
					named(hand, 'Anger'),
					named(board, '"Name Sticker" Goblin'),
					...board.filter((c) => c.name === 'Acclaimed Contender'),
					named(board, 'Blizzard Strix'),
					named(board, 'Kozilek, the Great Distortion'),
					named(exile, 'Anger'),
					named(graveyard, 'Calculated Dismissal'),
					named(graveyard, 'Fiery Impulse'),
					named(graveyard, 'Lightning Bolt'),
					...INCARNATIONS.map((name) => named(theirGraveyard, name)),
				];
				for (const c of off) expect(seat0, `${c.name}#${c.id} is off`).not.toContain(c.id);
				const on = [named(board, 'Carapace Forger'), named(hand, 'Acclaimed Contender'), ...INCARNATIONS.map((name) => named(graveyard, name))];
				for (const c of on) expect(seat0, `${c.name}#${c.id} is on`).toContain(c.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'a permission to play the card is not a condition: Gravecrawler in the graveyard beside a Zombie stays dark and is offered instead; Anger beside it lights',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 87, decks: DECKS, scenario: PERMISSIONS });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Graveyard').some((c) => c.name === 'Gravecrawler') && s.zone(0, 'Battlefield').some((c) => c.name === 'Diregraf Ghoul');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const graveyard = s.zone(0, 'Graveyard');
				const hand = s.zone(0, 'Hand');
				const gravecrawler = named(graveyard, 'Gravecrawler');
				const offered = (): number[] =>
					s.sent
						.filter((x) => x.seat === 0 && x.envelope.frame.method === 'setWeaklySelectable')
						.map((x) => (x.envelope.frame as unknown as { cards: { id: number }[] }).cards.map((c) => c.id))
						.at(-1) ?? [];
				await waitUntil(
					() => {
						s.answerAsks();
						return offered().includes(gravecrawler.id);
					},
					'Gravecrawler to be offered as actionable to seat 0 from its graveyard',
					15_000,
					s,
				);
				const seat0 = latestConditionMet(s, 0);
				const lit = [...graveyard, ...hand, ...s.zone(0, 'Battlefield')].filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[gz-condition-met.jvm] permissions: offered=${JSON.stringify(offered())} conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				expect(seat0, `Gravecrawler#${gravecrawler.id} is off`).not.toContain(gravecrawler.id);
				const company = named(hand, "Bard's Company");
				expect(seat0, `Bard's Company#${company.id} is off`).not.toContain(company.id);
				const anger = named(graveyard, 'Anger');
				expect(seat0, `Anger#${anger.id} is on`).toContain(anger.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
	it(
		'a conditional alternative cost lights and sets the hand cost only while it can be cast that way: Crush of Tentacles 4UU and dark in an opening hand, 3UU and lit after another spell, 4UU and dark next turn; Skewer the Critics at R once an opponent lost life; Mulldrifter keeps its printed cost; a reducer still reduces',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 88, decks: DECKS, scenario: ALTERNATIVE_COSTS });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Monastery Raid');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const hand = s.zone(0, 'Hand');
				const crushes = hand.filter((c) => c.name === 'Crush of Tentacles');
				const reveler = named(hand, 'Rix Maadi Reveler');
				const raid = named(hand, 'Monastery Raid');
				const skewer = named(hand, 'Skewer the Critics');
				const mulldrifter = named(hand, 'Mulldrifter');
				const chief = named(hand, 'Chief of the Foundry');
				const others = [reveler, raid, skewer, mulldrifter];
				const lit = (met: number[] | null): string => JSON.stringify(hand.filter((c) => met?.includes(c.id)).map((c) => `${c.name}#${c.id}`));
				const before = latestConditionMet(s, 0);
				console.log(`[cs-condition-met.jvm] no spell cast: conditionMet=${JSON.stringify(before)} → ${lit(before)}`);
				expect(before, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const c of [...crushes, ...others]) expect(before, `${c.name}#${c.id} is off before any spell`).not.toContain(c.id);
				const heldBefore = latestHeld(s, 0);
				console.log(`[cs-condition-met.jvm] no spell cast: heldChanges=${JSON.stringify([...(heldBefore ?? [])])}`);
				expect(heldBefore, 'seat 0 was sent heldChanges').not.toBeNull();
				for (const c of [...crushes, ...others]) expect(shown(heldBefore, c), `${c.name}#${c.id} shows its printed cost`).toBeUndefined();
				expect(shown(heldBefore, chief), 'Etherium Sculptor reduces Chief of the Foundry').toEqual({ cost: mana(2), printed: mana(3), costBy: ['Etherium Sculptor'] });

				const cast = s.sent.length;
				await castNamed(s, 0, 'Ornithopter');
				await waitUntil(() => {
					s.answerAsks();
					return latestConditionMet(s, 0, cast) !== null;
				}, 'a conditionMet snapshot after Ornithopter resolved', 15_000, s);
				const after = latestConditionMet(s, 0, cast);
				console.log(`[cs-condition-met.jvm] after Ornithopter: conditionMet=${JSON.stringify(after)} → ${lit(after)}`);
				for (const c of crushes) expect(after, `${c.name}#${c.id} is on once another spell was cast`).toContain(c.id);
				for (const c of others) expect(after, `${c.name}#${c.id} is off`).not.toContain(c.id);
				const heldAfter = latestHeld(s, 0, cast);
				console.log(`[cs-condition-met.jvm] after Ornithopter: heldChanges=${JSON.stringify([...(heldAfter ?? [])])}`);
				for (const c of crushes) expect(shown(heldAfter, c), `${c.name}#${c.id} shows its surge cost`).toEqual({ cost: mana(3, 'BLUE', 'BLUE'), printed: mana(4, 'BLUE', 'BLUE'), costBy: ['Surge'] });
				for (const c of others) expect(shown(heldAfter, c), `${c.name}#${c.id} shows its printed cost`).toBeUndefined();

				const rift = s.sent.length;
				await castNamed(s, 0, 'Flame Rift');
				await waitUntil(() => {
					s.answerAsks();
					return latestConditionMet(s, 0, rift) !== null && latestHeld(s, 0, rift) !== null;
				}, 'a conditionMet snapshot and heldChanges after Flame Rift resolved', 15_000, s);
				const lost = latestConditionMet(s, 0, rift);
				const heldLost = latestHeld(s, 0, rift);
				console.log(`[cs-condition-met.jvm] after Flame Rift: conditionMet=${JSON.stringify(lost)} → ${lit(lost)} heldChanges=${JSON.stringify([...(heldLost ?? [])])}`);
				for (const c of [skewer, reveler]) expect(lost, `${c.name}#${c.id} is on once an opponent lost life`).toContain(c.id);
				expect(shown(heldLost, skewer), 'Skewer the Critics shows its spectacle cost').toEqual({ cost: mana(0, 'RED'), printed: mana(2, 'RED'), costBy: ['Spectacle'] });
				expect(shown(heldLost, reveler), 'Rix Maadi Reveler keeps its cheaper printed cost').toBeUndefined();
				for (const c of [raid, mulldrifter]) {
					expect(lost, `${c.name}#${c.id} is off`).not.toContain(c.id);
					expect(shown(heldLost, c), `${c.name}#${c.id} shows its printed cost`).toBeUndefined();
				}

				/* Both seats pass every stop, so turns fly by: read the first snapshot after turn 2 began. */
				const turnTwo = (): number => s.sent.findIndex((x) => x.seat === 0 && x.envelope.frame.method === 'message' && /^Turn 2\b/.test((x.envelope.frame as unknown as { message: string }).message));
				await passUntil(s, () => turnTwo() >= 0 && firstConditionMet(s, 0, turnTwo()) !== null && latestHeld(s, 0, turnTwo()) !== null, 'a conditionMet snapshot and heldChanges on turn 2');
				const next = firstConditionMet(s, 0, turnTwo());
				console.log(`[cs-condition-met.jvm] turn 2: conditionMet=${JSON.stringify(next)} → ${lit(next)}`);
				for (const c of crushes) expect(next, `${c.name}#${c.id} is off again on the next turn`).not.toContain(c.id);
				const heldNext = latestHeld(s, 0, turnTwo());
				console.log(`[cs-condition-met.jvm] turn 2: heldChanges=${JSON.stringify([...(heldNext ?? [])])}`);
				expect(heldNext, 'seat 0 was sent heldChanges on turn 2').not.toBeNull();
				for (const c of [...crushes, skewer]) expect(shown(heldNext, c), `${c.name}#${c.id} shows its printed cost again`).toBeUndefined();
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		"a check on what the ability itself acts on is not a condition: Spell Queller holding the spell it exiled stays dark; Veteran Survivor's three exiled cards and Cobra Trap's remembered permanent light",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 89, decks: DECKS, scenario: MEMORY });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Spell Queller') && s.zone(0, 'Hand').some((c) => c.name === 'Cobra Trap');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const board = s.zone(0, 'Battlefield');
				const hand = s.zone(0, 'Hand');
				const seat0 = latestConditionMet(s, 0);
				const lit = [...board, ...hand].filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[queller-condition-met.jvm] memory: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				const queller = named(board, 'Spell Queller');
				expect(seat0, `Spell Queller#${queller.id} is off`).not.toContain(queller.id);
				for (const c of [named(board, 'Veteran Survivor'), named(hand, 'Cobra Trap')]) expect(seat0, `${c.name}#${c.id} is on`).toContain(c.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'conditions one of which always holds are not a condition: Preacher of the Schism ahead on life stays dark; Carapace Forger beside three artifacts lights',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 90, decks: DECKS, scenario: EITHER_OR });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Preacher of the Schism');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const board = s.zone(0, 'Battlefield');
				const seat0 = latestConditionMet(s, 0);
				const lit = board.filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[preacher-condition-met.jvm] either-or: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				const preacher = named(board, 'Preacher of the Schism');
				expect(seat0, `Preacher of the Schism#${preacher.id} is off`).not.toContain(preacher.id);
				const forger = named(board, 'Carapace Forger');
				expect(seat0, `Carapace Forger#${forger.id} is on`).toContain(forger.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'a hand that empties toward Hellbent lights its floor, not its default — Infernal Tutor stays dark in a full hand, unlike Arrow Storm’s Raid and Gruesome Discovery’s Morbid, which count a per-turn event and stay dark for the opposite reason',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 91, decks: DECKS, scenario: HELLBENT_HAND });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Infernal Tutor');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const hand = s.zone(0, 'Hand');
				expect(hand.length, 'the hand is full, not Hellbent').toBeGreaterThan(1);
				const seat0 = latestConditionMet(s, 0);
				const lit = hand.filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[af401-condition-met.jvm] full hand: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const name of ['Infernal Tutor', 'Arrow Storm', 'Gruesome Discovery']) {
					const c = named(hand, name);
					expect(seat0, `${c.name}#${c.id} is off with a full hand and an empty graveyard`).not.toContain(c.id);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		"a count of the creatures a combat trigger's own declaration made attackers is not a condition: no Frontline Medic lights while two creatures attack, whether it attacks, stays home or is the opponent's; Courageous Goblin beside Craw Wurm lights throughout",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 92, decks: DECKS, scenario: COMBAT_EVENT });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Frontline Medic') && s.zone(1, 'Battlefield').some((c) => c.name === 'Frontline Medic');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const board = s.zone(0, 'Battlefield');
				const medics = [...board.filter((c) => c.name === 'Frontline Medic'), named(s.zone(1, 'Battlefield'), 'Frontline Medic')];
				const [attacking, home] = board.filter((c) => c.name === 'Frontline Medic');
				const bears = board.filter((c) => c.name === 'Grizzly Bears');
				const goblin = named(board, 'Courageous Goblin');
				const lit = (met: number[] | null | undefined): string =>
					`[${[...board, ...s.zone(1, 'Battlefield')].filter((c) => met?.includes(c.id)).map((c) => `${c.name}#${c.id}`).join(', ')}]`;
				const main = latestConditionMet(s, 0);
				console.log(`[w80b-condition-met.jvm] main 1: conditionMet=${JSON.stringify(main)} → ${lit(main)}`);
				expect(main, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				expect(main, `Courageous Goblin#${goblin.id} is on beside Craw Wurm`).toContain(goblin.id);
				for (const m of medics) expect(main, `Frontline Medic#${m.id} is off before combat`).not.toContain(m.id);

				await toDeclareAttackers(s, 0);
				const from = s.sent.length;
				for (const c of [...bears, attacking!]) s.select(0, c.id);
				await waitUntil(() => [...bears, attacking!].every((c) => attackingOnWire(s, c.id)), 'two Grizzly Bears and one Frontline Medic to be declared', 15_000, s);
				expect(attackingOnWire(s, home!.id), `Frontline Medic#${home!.id} stays home`).toBe(false);
				s.ok(0);
				await passUntil(s, () => /^Phase: Main phase, postcombat$/m.test(s.prompt(0)) || (s.turn(0)?.n ?? 1) > 1, "seat 0's combat to end");
				const during = conditionMetFrom(s, 0, from);
				for (const met of during) console.log(`[w80b-condition-met.jvm] combat: conditionMet=${JSON.stringify(met)} → ${lit(met)}`);
				expect(during.length, 'seat 0 was sent conditionMet snapshots during combat').toBeGreaterThan(0);
				for (const met of during) {
					for (const m of medics) expect(met, `Frontline Medic#${m.id} is off during combat`).not.toContain(m.id);
				}
				expect(during.at(-1), `Courageous Goblin#${goblin.id} is still on`).toContain(goblin.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
