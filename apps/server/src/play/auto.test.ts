/**
 * Wave 19, lane C: questions with one answer, stops with nothing to do.
 *
 * The rules in `auto.ts` are exercised against the **committed prompt
 * fixtures** — `apps/ui/src/play/prompts/fixtures/*.json`, the same frames lane
 * B's components are rendered from — read off disk rather than re-typed here,
 * so a fixture that changes shape is caught by this suite too.
 *
 * Then the same rules through a whole `Match` over the replay host: a bounds
 * question answered without a modal, a stop that passes itself and says so, a
 * cast that says what it paid, and `fullControl` turning all of it off.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPLY_SCHEMAS, parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';

import { autoPassReason, autoPayReason, isOwnMainPhaseEntry, onlyAnswer, paymentCost, paymentLine, plainCost } from './auto.js';
import { FORGE_PREFERENCES } from './host.js';
import { createMatchRegistry, type Match } from './match.js';
import type { ServerEnvelope } from './transport.js';
import { loadTranscript, replayFactory, type ReplayHost } from './fixtures/transcript.js';

/* ── The real prompt fixtures ────────────────────────────────────────── */

const FIXTURE_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../ui/src/play/prompts/fixtures',
);

function fixture(file: string): ServerFrame {
	return parseServerFrame(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')));
}

const FIXTURE_FILES = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();

/**
 * What each committed fixture must do. **Every one of them is a real question**
 * — that is what a fixture is for — so every one must be asked, and this table
 * is the guard that a rule never quietly swallows one.
 */
describe('onlyAnswer, over every committed prompt fixture', () => {
	it('knows all of them (a new fixture is a new case here)', () => {
		expect(FIXTURE_FILES).toEqual([
			'assignCombatDamage.json',
			'assignGenericAmount-mana.json',
			'assignGenericAmount.json',
			'chooseEntitiesForEffect.json',
			'chooseSingleEntityForEffect.json',
			'confirm-ok-only.json',
			'confirm.json',
			'getAbilityToPlay.json',
			'getChoices-reveal.json',
			'getChoices.json',
			'manipulateCardList.json',
			'openZones.json',
			'order.json',
			'showInputDialog.json',
			'showOptionDialog.json',
			'sideboard.json',
			'tempShowZones.json',
		]);
	});

	it.each(FIXTURE_FILES)('%s is a real choice and is asked', (file) => {
		expect(onlyAnswer(fixture(file))).toBeNull();
	});

	it('leaves a REVEAL alone even though it has exactly one legal answer', () => {
		// getChoices-reveal is min -1 / max -1: `choiceBounds` makes that 0..0, so
		// `[]` is the only answer the component could send. Answering it would
		// take the reveal off the screen before the player read it.
		const reveal = fixture('getChoices-reveal.json');
		expect(reveal.method).toBe('getChoices');
		expect(onlyAnswer(reveal)).toBeNull();
	});
});

/** The same fixtures, narrowed to the shape Forge sends when it has left one possibility. */
describe('onlyAnswer, where Forge left exactly one possibility', () => {
	function narrowed(file: string, patch: Record<string, unknown>): ServerFrame {
		return parseServerFrame({ ...(fixture(file) as unknown as Record<string, unknown>), ...patch });
	}

	it('getAbilityToPlay is never auto-answered HERE, one ability or many', () => {
		// Wave 20 reversed the exclusion for the single-option case — but on the
		// BROWSER side, in `apps/ui/src/play/prompts/rules.ts`'s `autoAnswer`, the
		// only place that can name the ability it played (labels are resolved
		// there, over the offer's own `label`). Two statements of one policy is
		// what this assertion keeps out of this file. See `auto.ts`'s header.
		const ask = fixture('getAbilityToPlay.json') as Extract<ServerFrame, { method: 'getAbilityToPlay' }>;
		const one = narrowed('getAbilityToPlay.json', { abilities: [ask.abilities[0]] });
		expect(onlyAnswer(one)).toBeNull();
		expect(onlyAnswer(ask)).toBeNull();
	});

	it('getChoices with one option and a floor of one answers it', () => {
		const ask = fixture('getChoices.json') as Extract<ServerFrame, { method: 'getChoices' }>;
		const one = narrowed('getChoices.json', { choices: [ask.choices[0]], min: 1, max: 1 });
		expect(onlyAnswer(one)).toMatchObject({ result: [ask.choices[0]?.key] });
	});

	it('getChoices that must take everything answers with everything, in Forge’s order', () => {
		const ask = fixture('getChoices.json') as Extract<ServerFrame, { method: 'getChoices' }>;
		const all = narrowed('getChoices.json', { min: ask.choices.length, max: ask.choices.length });
		expect(onlyAnswer(all)).toMatchObject({ result: ask.choices.map((c) => c.key) });
	});

	it('chooseSingleEntityForEffect with one option answers it — unless declining is allowed', () => {
		const ask = fixture('chooseSingleEntityForEffect.json') as Extract<
			ServerFrame,
			{ method: 'chooseSingleEntityForEffect' }
		>;
		const one = narrowed('chooseSingleEntityForEffect.json', { optionList: [ask.optionList[0]] });
		expect(onlyAnswer(one)).toMatchObject({ result: ask.optionList[0] });
		const optional = narrowed('chooseSingleEntityForEffect.json', {
			optionList: [ask.optionList[0]],
			isOptional: true,
		});
		expect(onlyAnswer(optional)).toBeNull();
	});

	it('chooseEntitiesForEffect that must take everything answers with everything', () => {
		const ask = fixture('chooseEntitiesForEffect.json') as Extract<
			ServerFrame,
			{ method: 'chooseEntitiesForEffect' }
		>;
		const all = narrowed('chooseEntitiesForEffect.json', { min: ask.optionList.length, max: ask.optionList.length });
		expect(onlyAnswer(all)).toMatchObject({ result: ask.optionList });
		// A reveal (max 0) is not answered, however few options it has.
		expect(onlyAnswer(narrowed('chooseEntitiesForEffect.json', { min: 0, max: 0 }))).toBeNull();
	});

	it('showOptionDialog with one button presses it', () => {
		const one = narrowed('showOptionDialog.json', { options: ['OK'], defaultOption: 0 });
		expect(onlyAnswer(one)).toMatchObject({ result: 0 });
	});

	it('order with one item and no slack has one arrangement; with slack it is a question', () => {
		const ask = fixture('order.json') as Extract<ServerFrame, { method: 'order' }>;
		const one = narrowed('order.json', {
			sourceChoices: [ask.sourceChoices[0]],
			remainingObjectsMin: 0,
			remainingObjectsMax: 0,
		});
		expect(onlyAnswer(one)).toMatchObject({ result: { ordered: [ask.sourceChoices[0]?.key], rememberDecision: false } });
		const slack = narrowed('order.json', {
			sourceChoices: [ask.sourceChoices[0]],
			remainingObjectsMin: 0,
			remainingObjectsMax: 1,
		});
		expect(onlyAnswer(slack)).toBeNull();
	});

	it('never produces an answer its own wire schema would refuse', () => {
		const candidates = [
			narrowed('getChoices.json', { min: 5, max: 5 }),
			narrowed('showOptionDialog.json', { options: ['OK'], defaultOption: 0 }),
		];
		for (const ask of candidates) {
			const auto = onlyAnswer(ask);
			expect(auto).not.toBeNull();
			const schema = REPLY_SCHEMAS[auto!.method as keyof typeof REPLY_SCHEMAS];
			expect(schema.safeParse(auto!.result).success).toBe(true);
		}
	});

	it('never answers a question: confirm, the assignments, the input dialog and sideboard all stay', () => {
		for (const file of ['confirm.json', 'confirm-ok-only.json', 'assignCombatDamage.json', 'assignGenericAmount.json', 'showInputDialog.json', 'sideboard.json']) {
			expect(onlyAnswer(fixture(file)), file).toBeNull();
		}
	});
});

/* ── The same rules over REAL frames off a real match ─────────────────── */

/**
 * `fixtures/w20-turn-flow.json` — the distilled evidence for wave 20 §B. Its
 * own header says how it was cut and how to re-cut it; the point of reading it
 * here is that every rule above is checked against frames Forge actually sent,
 * not only against frames this file typed.
 */
interface FlowWindow {
	label: string;
	seat: number;
	playerId: number;
	prompt: Record<string, unknown>;
	buttons: Record<string, unknown>;
	actionable: number[] | null;
}

const FLOW = JSON.parse(
	readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/w20-turn-flow.json'), 'utf8'),
) as { windows: FlowWindow[]; abilityOffers: Record<string, unknown>[] };

/** What each captured window must decide. A new row in the fixture is a new row here. */
const FLOW_EXPECTED: Readonly<Record<string, { pass: string | null; pay: string | null }>> = {
	// Its own main phase, with three things Forge says it can do: a stop either way.
	'own-main-with-actions': { pass: null, pay: null },
	// The one the operator asked for (#7): its own main phase, NOTHING to do, and
	// still a stop. This is the row a revert of the item-7 rule turns red.
	'own-main-idle': { pass: null, pay: null },
	// The same phase with the creature ON the stack — a stack window, passed (#5).
	'own-main-stack-not-empty': { pass: 'Main phase, precombat', pay: null },
	// The opponent's main phase is not this seat's turn, so it is passed as ever.
	'opponent-main-idle': { pass: 'Main phase, precombat', pay: null },
	// The other seat's window while the creature resolves: the other half of #5.
	'opponent-window-stack-not-empty': { pass: 'Main phase, precombat', pay: null },
	// One land, {U} to pay, Forge's own Auto live (#6).
	'payment-one-source': { pass: null, pay: '{U}' },
	'step-idle': { pass: 'Beginning of Combat Step', pay: null },
	// Not a priority window and not a payment: neither rule touches it.
	mulligan: { pass: null, pay: null },
};

describe('the captured turn flow — every rule against frames Forge really sent', () => {
	it('the fixture and this table name the same windows', () => {
		expect(FLOW.windows.map((w) => w.label).sort()).toEqual(Object.keys(FLOW_EXPECTED).sort());
	});

	it.each(FLOW.windows.map((w) => [w.label, w] as const))('%s', (label, w) => {
		const notes = {
			playerId: w.playerId,
			prompt: parseServerFrame(w.prompt),
			buttons: parseServerFrame(w.buttons),
			actionable: w.actionable,
			openAsks: 0,
		};
		const want = FLOW_EXPECTED[label]!;
		expect(autoPassReason(notes), `${label}: auto-pass`).toBe(want.pass);
		expect(autoPayReason(notes), `${label}: auto-pay`).toBe(want.pay);
	});

	it('every ability offer the run produced carried exactly one ability, and its label', () => {
		expect(FLOW.abilityOffers.length).toBeGreaterThan(0);
		for (const offer of FLOW.abilityOffers) {
			const ask = parseServerFrame(offer);
			expect(ask.method).toBe('getAbilityToPlay');
			if (ask.method !== 'getAbilityToPlay') continue;
			expect(ask.abilities, JSON.stringify(ask.abilities)).toHaveLength(1);
			expect(typeof ask.abilities[0]?.label).toBe('string');
			// And the server leaves every one of them alone — `rules.ts` answers them.
			expect(onlyAnswer(ask)).toBeNull();
		}
	});

	/*
	 * Item 9, from the capture: two of the four offers are the SAME card and the
	 * SAME ability, back to back, for ONE `selectCard`. Forge has two
	 * `getAbilityToPlay` call sites and this pair carries the SPELL's ability, so
	 * both came from `InputPassPriority.java:340` — one click, asked twice. The
	 * live suite pins the click count; this pins the shape, off disk.
	 */
	it('holds the repeated offer item 9 is: the same ability asked twice', () => {
		const keys = FLOW.abilityOffers.map((o) => {
			const ask = o as { hostCard: { id: number }; abilities: { id: number }[] };
			return `${ask.hostCard.id}:${ask.abilities.map((a) => a.id).join(',')}`;
		});
		const repeated = keys.filter((k, i) => i > 0 && keys[i - 1] === k);
		expect(repeated, JSON.stringify(keys)).not.toEqual([]);
	});
});

/* ── Stops with nothing to do ────────────────────────────────────────── */

const PRIORITY_MESSAGE = 'Priority: B\nTurn: 4 (A)\nPhase: End of Combat Step\nStack: Empty';

function prompt(message: string, playerId = 1): ServerFrame {
	return parseServerFrame({
		kind: 'notify',
		method: 'showPromptMessage',
		player: { kind: 'player', id: playerId },
		message,
		card: null,
	});
}

function buttons(enable1: boolean, playerId = 1): ServerFrame {
	return parseServerFrame({
		kind: 'notify',
		method: 'updateButtons',
		owner: { kind: 'player', id: playerId },
		label1: 'OK',
		label2: 'End Turn',
		enable1,
		enable2: true,
		focus1: true,
	});
}

const IDLE = {
	playerId: 1,
	prompt: prompt(PRIORITY_MESSAGE),
	buttons: buttons(true),
	actionable: [] as number[],
	openAsks: 0,
};

describe('autoPassReason', () => {
	it('passes a priority stop where Forge says the seat can do nothing, and names the phase', () => {
		expect(autoPassReason(IDLE)).toBe('End of Combat Step');
	});

	it('never passes a stop where Forge named something actionable', () => {
		expect(autoPassReason({ ...IDLE, actionable: [67] })).toBeNull();
	});

	it('never passes on silence: a cleared set is "Forge has not said", not "nothing"', () => {
		expect(autoPassReason({ ...IDLE, actionable: null })).toBeNull();
	});

	// Wave 20, #5: this used to be "never passes with something on the stack".
	// That requirement is what made a creature need two humans to press OK.
	it('PASSES a priority window with something on the stack — that is what resolves it', () => {
		const onStack = prompt('Priority: B\nTurn: 4 (A)\nPhase: End step\nStack: 1 to Resolve.');
		expect(autoPassReason({ ...IDLE, prompt: onStack })).toBe('End step');
	});

	// Wave 20, #7: "dont auto-pass peoples turns".
	it('never passes the seat’s OWN main phase with an empty stack, even with nothing to do', () => {
		for (const phase of ['Main phase, precombat', 'Main phase, postcombat']) {
			const own = prompt(`Priority: B\nTurn: 4 (B)\nPhase: ${phase}\nStack: Empty`);
			expect(autoPassReason({ ...IDLE, prompt: own }), phase).toBeNull();
		}
	});

	it('still passes the OTHER seat’s main phase, and its own main phase with a stack', () => {
		const theirs = prompt('Priority: B\nTurn: 4 (A)\nPhase: Main phase, precombat\nStack: Empty');
		expect(autoPassReason({ ...IDLE, prompt: theirs })).toBe('Main phase, precombat');
		const mineWithStack = prompt('Priority: B\nTurn: 4 (B)\nPhase: Main phase, precombat\nStack: 1 to Resolve.');
		expect(autoPassReason({ ...IDLE, prompt: mineWithStack })).toBe('Main phase, precombat');
	});

	it('never passes a prompt that is not priority (a mulligan, a payment, a declare step)', () => {
		for (const message of [
			'B, you are going first!\n\nDo you want to keep your hand?',
			'Preordain (70) - B scribes 2.\n\nPay Mana Cost: {U}',
			'Select creatures to attack with',
		]) {
			expect(autoPassReason({ ...IDLE, prompt: prompt(message) }), message).toBeNull();
		}
	});

	it('never passes while the seat has a question open', () => {
		expect(autoPassReason({ ...IDLE, openAsks: 1 })).toBeNull();
	});

	it('never passes when OK is not live, or the prompt belongs to the other seat', () => {
		expect(autoPassReason({ ...IDLE, buttons: buttons(false) })).toBeNull();
		expect(autoPassReason({ ...IDLE, prompt: prompt(PRIORITY_MESSAGE, 0) })).toBeNull();
		expect(autoPassReason({ ...IDLE, buttons: buttons(true, 0) })).toBeNull();
	});

	it('never passes before openView has named the seat, or with nothing said yet', () => {
		expect(autoPassReason({ ...IDLE, playerId: null })).toBeNull();
		expect(autoPassReason({ ...IDLE, prompt: null })).toBeNull();
		expect(autoPassReason({ ...IDLE, buttons: null })).toBeNull();
	});
});

describe('isOwnMainPhaseEntry — "your turn, your main phase, nothing on the stack"', () => {
	it('reads Forge’s own two names out of one message', () => {
		expect(isOwnMainPhaseEntry('Priority: A\nTurn: 2 (A)\nPhase: Main phase, precombat\nStack: Empty')).toBe(true);
		expect(isOwnMainPhaseEntry('Priority: A\nTurn: 2 (B)\nPhase: Main phase, precombat\nStack: Empty')).toBe(false);
		expect(isOwnMainPhaseEntry('Priority: A\nTurn: 2 (A)\nPhase: End step\nStack: Empty')).toBe(false);
		expect(isOwnMainPhaseEntry('Priority: A\nTurn: 2 (A)\nPhase: Main phase, precombat\nStack: 1 to Resolve.')).toBe(false);
	});

	it('survives the day/night marker Forge appends to the turn line', () => {
		expect(isOwnMainPhaseEntry('Priority: A\nTurn: 2 (A)  [Day]\nPhase: Main phase, postcombat\nStack: Empty')).toBe(true);
	});

	it('is not fooled by two seats sharing a name — it over-stops, which is the safe way to be wrong', () => {
		expect(isOwnMainPhaseEntry('Priority: A\nTurn: 2 (A)\nPhase: Main phase, precombat\nStack: Empty')).toBe(true);
	});
});

/* ── A payment with one source ───────────────────────────────────────── */

/** The payment input's bar: Forge's own "Auto" (`InputPayMana.updateButtons`). */
function autoBar(enable1: boolean, playerId = 1): ServerFrame {
	return parseServerFrame({
		kind: 'notify',
		method: 'updateButtons',
		owner: { kind: 'player', id: playerId },
		label1: 'Auto',
		label2: 'Cancel',
		enable1,
		enable2: true,
		focus1: false,
	});
}

const PAYING = {
	playerId: 1,
	prompt: prompt('Preordain - B scribes 2.\n\nPay Mana Cost: {U}'),
	buttons: autoBar(true),
	actionable: [67] as number[],
	openAsks: 0,
};

describe('autoPayReason', () => {
	it('presses Forge’s Auto for a payment with exactly one source, and names the cost', () => {
		expect(autoPayReason(PAYING)).toBe('{U}');
	});

	it('asks when there is more than one source — which land to tap is a real choice', () => {
		expect(autoPayReason({ ...PAYING, actionable: [67, 68] })).toBeNull();
	});

	it('asks when Forge named no source, or has not said at all', () => {
		expect(autoPayReason({ ...PAYING, actionable: [] })).toBeNull();
		expect(autoPayReason({ ...PAYING, actionable: null })).toBeNull();
	});

	it('never presses a bar that is not the payment input’s own Auto', () => {
		expect(autoPayReason({ ...PAYING, buttons: autoBar(false) })).toBeNull();
		// A priority window's button 1 is "OK" — pressing it there is the
		// auto-pass's business, under its own rules.
		expect(autoPayReason({ ...PAYING, buttons: buttons(true) })).toBeNull();
	});

	it('never presses a prompt that is not a payment', () => {
		expect(autoPayReason({ ...PAYING, prompt: prompt(PRIORITY_MESSAGE) })).toBeNull();
	});

	it('leaves life alone: paying life instead of mana is a second payment', () => {
		const phyrexian = prompt('Pay Mana Cost: {U/P}\nClick on your life total to pay life for phyrexian mana.');
		expect(autoPayReason({ ...PAYING, prompt: phyrexian })).toBeNull();
	});

	it('never presses while a question is open, before the seat is named, or for the other seat', () => {
		expect(autoPayReason({ ...PAYING, openAsks: 1 })).toBeNull();
		expect(autoPayReason({ ...PAYING, playerId: null })).toBeNull();
		expect(autoPayReason({ ...PAYING, buttons: autoBar(true, 0) })).toBeNull();
	});
});

/* ── What a cast paid ────────────────────────────────────────────────── */

describe('the payment line', () => {
	it('reads Forge’s own payment prompt, and nothing else', () => {
		expect(paymentCost('Preordain (70) - B scribes 2. B draws a card.\n\nPay Mana Cost: {U}')).toBe('{U}');
		expect(paymentCost(PRIORITY_MESSAGE)).toBeNull();
	});

	it('says the cost in letters, never in WotC’s symbols', () => {
		expect(plainCost('{2}{U}{R}')).toBe('2UR');
		expect(plainCost('{T}: Add {R}')).toBe('Tap: Add R');
	});

	it('names the cards that paid, and says only the cost when nothing tapped', () => {
		expect(paymentLine({ cost: '{U}', tapped: [{ id: 113, name: 'Volcanic Island' }] })).toBe('paid U — Volcanic Island');
		expect(
			paymentLine({
				cost: '{1}{R}',
				tapped: [
					{ id: 1, name: 'Mountain' },
					{ id: 2, name: 'Steam Vents' },
				],
			}),
		).toBe('paid 1R — Mountain, Steam Vents');
		expect(paymentLine({ cost: '{0}', tapped: [] })).toBe('paid 0');
	});
});

/* ── The whole thing, through a Match ────────────────────────────────── */

const TRANSCRIPT = loadTranscript();
const OPENING = TRANSCRIPT.slice(0, TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask'));

interface Harness {
	match: Match;
	host: ReplayHost;
	sent: { seat: number; envelope: ServerEnvelope }[];
	logs: Record<string, unknown>[];
}

function harness(): Harness {
	const { factory, hosts } = replayFactory();
	const sent: Harness['sent'] = [];
	const logs: Record<string, unknown>[] = [];
	const registry = createMatchRegistry({
		host: factory,
		log: (e) => logs.push(e),
		askTimeoutMs: 60_000,
		overGraceMs: 60_000,
		emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
	});
	const match = registry.create({
		seats: [
			{ name: 'Seat 1', ai: false, deck: null },
			{ name: 'Seat 2', ai: false, deck: null },
		],
	});
	const h: Harness = { match, host: hosts[0] as ReplayHost, sent, logs };
	h.host.push(...OPENING);
	return h;
}

function frames(h: Harness, seat: number): ServerFrame[] {
	return h.sent.filter((s) => s.seat === seat).map((s) => s.envelope.frame);
}

function says(h: Harness, seat: number): string[] {
	return frames(h, seat)
		.filter((f) => f.method === 'message')
		.map((f) => (f as Extract<ServerFrame, { method: 'message' }>).message);
}

/** The seat's Forge player id, as its own `openView` named it. */
function playerOf(h: Harness, seat: number): number {
	const id = h.match.seats[seat]?.playerId;
	if (id === null || id === undefined) throw new Error(`seat ${seat} has no player`);
	return id;
}

function push(h: Harness, seat: number, frame: ServerFrame | Record<string, unknown>): void {
	h.host.push({ t: 'frame', seat, frame } as never);
}

function oneAbilityAsk(callId: string): Record<string, unknown> {
	return {
		kind: 'ask',
		callId,
		method: 'getAbilityToPlay',
		hostCard: { kind: 'card', id: 67 },
		abilities: [{ kind: 'spellAbility', id: 9001 }],
		triggerEvent: null,
	};
}

/** A `getChoices` where every option must be taken: exactly one legal reply. */
function allMustBeChosen(callId: string): ServerFrame {
	return parseServerFrame({
		kind: 'ask',
		callId,
		method: 'getChoices',
		message: 'Choose',
		min: 5,
		max: 5,
		choices: [1, 2, 3, 4, 5].map((i) => ({ key: `k${i}`, label: `option ${i}`, ref: null })),
		selected: [],
	});
}

describe('a Match with the shortcuts on (the default)', () => {
	it('gives a one-ability ask to the player, and answers a bounds question for them', () => {
		const h = harness();
		// Payment open or not, the ability ask is the player’s (see `auto.ts`).
		push(h, 0, prompt('Preordain.\n\nPay Mana Cost: {U}', playerOf(h, 0)));
		push(h, 0, oneAbilityAsk('a-1'));
		expect(frames(h, 0).filter((f) => f.kind === 'ask' && f.callId === 'a-1')).toHaveLength(1);
		expect(h.host.commands.filter((c) => c.t === 'reply')).toEqual([]);
		expect(h.match.seats[0]?.autoAnswered).toBe(0);

		// A bounds question with one answer never becomes a modal.
		const seen = frames(h, 1).length;
		push(h, 1, allMustBeChosen('a-2'));
		expect(frames(h, 1).slice(seen).filter((f) => f.kind === 'ask')).toEqual([]);
		expect(h.host.commands).toContainEqual({
			t: 'reply',
			seat: 1,
			callId: 'a-2',
			result: ['k1', 'k2', 'k3', 'k4', 'k5'],
		});
		expect(h.logs.some((l) => l.evt === 'ask-auto-answered' && l.callId === 'a-2')).toBe(true);
		expect(h.match.seats[1]?.autoAnswered).toBe(1);
	});

	it('passes a stop with nothing to do, says which one, and presses OK exactly once', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
		expect(says(h, 0)).toEqual(['auto-passed End of Combat Step']);
		expect(h.match.seats[0]?.autoPassed).toBe(1);
	});

	it('does NOT pass a stop where Forge named something the seat can do', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(says(h, 0)).toEqual([]);
	});

	it('does NOT pass on a cleared set — Forge has not answered, so neither do we', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, { kind: 'notify', method: 'clearWeaklySelectable' });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});

	it('presses Forge’s Auto for a one-source payment, exactly once for that cost', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Preordain - A scribes 2.\n\nPay Mana Cost: {U}', me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
		// Forge re-shows the payment prompt after every tap; a second press would
		// answer whatever it asks next.
		push(h, 0, prompt('Preordain - A scribes 2.\n\nPay Mana Cost: {U}', me));
		push(h, 0, autoBar(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);
		expect(h.logs.filter((l) => l.evt === 'auto-paid')).toHaveLength(1);
	});

	it('does NOT press Auto when Forge offered two sources to tap', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {1}{U}', me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});

	it('says what a cast paid, naming the lands that tapped, once the payment prompt ends', () => {
		const h = harness();
		// The rest of the real transcript, so the seat holds named cards of its own.
		h.host.push(...TRANSCRIPT.slice(OPENING.length));
		const me = playerOf(h, 0);
		// A card this seat already holds, from the real transcript's own state.
		const tapped = firstOwnCard(h, 0);
		push(h, 0, prompt('Preordain - scribes 2.\n\nPay Mana Cost: {U}', me));
		push(h, 0, {
			kind: 'notify',
			method: 'applyDelta',
			payload: {
				packet: {
					seq: 9001,
					checksum: 0,
					checksumProperties: [],
					newObjects: {},
					objectDeltas: { [String(tapped.key)]: { _type: 0, _id: tapped.id, Tapped: { t: 'bool', v: true } } },
					events: [],
				},
			},
		});
		expect(says(h, 0).filter((l) => l.startsWith('paid'))).toEqual([]);
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		expect(says(h, 0).filter((l) => l.startsWith('paid'))).toEqual([`paid U — ${tapped.name}`]);
	});

	it('keeps its lines across a refresh: a snapshot re-sends them before the prompt', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		const before = frames(h, 0).length;
		h.match.resendAfterSnapshot(0);
		expect(frames(h, 0).slice(before).filter((f) => f.method === 'message')).toHaveLength(1);
	});
});

describe('full control — the escape hatch, off by default', () => {
	it('is off until the seat asks for it', () => {
		const h = harness();
		expect(h.match.fullControl(0)).toBe(false);
		expect(h.match.setFullControl(0, true)).toEqual({ ok: true });
		expect(h.match.fullControl(0)).toBe(true);
		expect(h.match.setFullControl(9, true)).toEqual({ ok: false, error: 'no-such-seat' });
	});

	it('turns the bounds shortcut off too, not just the passing', () => {
		const h = harness();
		h.match.setFullControl(0, true);
		push(h, 0, allMustBeChosen('a-4'));
		expect(frames(h, 0).filter((f) => f.kind === 'ask' && f.callId === 'a-4')).toHaveLength(1);
		expect(h.host.commands.filter((c) => c.t === 'reply')).toEqual([]);
	});

	it('stops at a phase with nothing to do instead of passing it', () => {
		const h = harness();
		const me = playerOf(h, 0);
		h.match.setFullControl(0, true);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});

	it('pays nothing for the seat either: Auto is a stop like any other', () => {
		const h = harness();
		const me = playerOf(h, 0);
		h.match.setFullControl(0, true);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {U}', me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});

	it('is per seat: the other seat keeps its shortcuts', () => {
		const h = harness();
		h.match.setFullControl(0, true);
		push(h, 1, allMustBeChosen('a-3'));
		expect(h.host.commands).toContainEqual({
			t: 'reply',
			seat: 1,
			callId: 'a-3',
			result: ['k1', 'k2', 'k3', 'k4', 'k5'],
		});
	});
});

/* ── The Forge preference that stops a scry sending the library ──────── */

describe('the per-run Forge preferences', () => {
	it('turns off the desktop-only "select from card displays" behaviour', () => {
		// See FORGE_PREFERENCES for the derivation; `auto.jvm.test.ts` proves the
		// effect against a real Forge (a scry asks about the scried cards, never
		// the library).
		expect(FORGE_PREFERENCES.UI_SELECT_FROM_CARD_DISPLAYS).toBe('false');
	});
});

/** A card the seat's own projected state names — so the payment line can name it too. */
function firstOwnCard(h: Harness, seat: number): { id: number; key: number; name: string } {
	const snapshot = h.match.snapshot(seat);
	if (!('frames' in snapshot)) throw new Error(snapshot.error);
	for (const frame of snapshot.frames) {
		const tables =
			frame.method === 'setGameView'
				? [frame.payload.gameView]
				: frame.method === 'applyDelta'
					? [frame.payload.packet.newObjects, frame.payload.packet.objectDeltas]
					: [];
		for (const table of tables) {
			for (const [, obj] of Object.entries(table as Record<string, Record<string, unknown>>)) {
				if (obj._type !== 4) continue;
				const name = obj.Name as { t?: string; v?: unknown } | undefined;
				if (name?.t !== 'str' || typeof name.v !== 'string' || name.v === '') continue;
				const cardId = Math.floor((obj._id as number) / 16);
				return { id: cardId, key: ((0 << 28) | (cardId & 0x0fffffff)) >>> 0, name: name.v };
			}
		}
	}
	throw new Error(`seat ${seat} was sent no named card`);
}
