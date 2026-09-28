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
import { ClientFrameSchema, PHASE_TYPES, REPLY_SCHEMAS, YieldUpdateSchema, parseServerFrame, type PhaseType, type ServerFrame } from '@hadoku/forge-wire';

import {
	ARENA_STOP_POLICY,
	DEFAULT_STOP_POLICY,
	FULL_CONTROL_POLICY,
	PHASE_BY_UI_NAME,
	autoCancelReason,
	autoPassReason,
	autoPayReason,
	decideCancel,
	decidePay,
	decideStop,
	isOwnMainPhaseEntry,
	isStopPhase,
	onlyAnswer,
	paymentCost,
	paymentLine,
	plainCost,
	readPromptFacts,
	toYieldUpdates,
	type SeatNotes,
	type StopPolicy,
} from './auto.js';
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

	it('passes a stop with nothing to do, presses OK exactly once, and says NOTHING (item 3)', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
		// Item 3, wave 25 §D: the pass is SILENT. The log keeps it; the seat does
		// not, because the phase it named is on the turn bar and the phase rail.
		expect(says(h, 0)).toEqual([]);
		expect(h.logs.filter((l) => l.evt === 'auto-passed')).toEqual([
			{ evt: 'auto-passed', matchId: h.match.id, seat: 0, phase: 'End of Combat Step' },
		]);
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
		// The payment line is the one that MUST survive a refresh — it is the only
		// record that a cost was paid (#8). The auto-pass no longer says anything.
		push(h, 0, prompt('Preordain.\n\nPay Mana Cost: {U}', me));
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		expect(says(h, 0)).toEqual(['paid U']);
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

/* ── Wave 24 §E: the model, and the three things it must never shortcut ── */

/*
 * The policy is the model, and these are the assertions that keep it one.
 *
 * Everything above this line exercised `DEFAULT_STOP_POLICY` through
 * `autoPassReason` / `autoPayReason`, which is the behaviour waves 19-22 shipped
 * and which wave 24 preserved exactly — 76 tests of it, unchanged. What follows
 * is what the MODEL adds: that a different stop preference is a different VALUE,
 * that the decision layer reads no prose, that the policy is expressible as
 * Forge's own frames, and that three specific things are never shortcut whatever
 * the policy says.
 */

/** A window, as facts, without going through a prompt at all. */
function facts(over: Partial<ReturnType<typeof readPromptFacts>> = {}): ReturnType<typeof readPromptFacts> {
	return {
		window: 'priority',
		phase: 'END_OF_TURN',
		phaseLabel: 'End step',
		myTurn: false,
		stackEmpty: true,
		mine: true,
		confirmLive: true,
		cost: null,
		alternativePayment: false,
		noWayToPay: false,
		sources: [],
		plannedSources: [],
		openAsks: 0,
		...over,
	};
}

/** Notes for a seat sitting in one window, for the adapter's own tests. */
function notesFor(message: string, bar: ServerFrame, actionable: readonly number[] | null = null): SeatNotes {
	return { playerId: 1, prompt: prompt(message, 1), buttons: bar, actionable, openAsks: 0 };
}

describe('the adapter is the ONLY prose reader, and it is named', () => {
	const SOURCE = readFileSync(new URL('./auto.ts', import.meta.url), 'utf8');
	const ADAPTER_START = SOURCE.indexOf('/* ── THE ONE ADAPTER ');
	const ADAPTER_END = SOURCE.indexOf('/* ── The decisions: pure over facts');

	it('has an adapter section, and the decisions come after it', () => {
		expect(ADAPTER_START).toBeGreaterThan(0);
		expect(ADAPTER_END).toBeGreaterThan(ADAPTER_START);
	});

	/*
	 * The guard §0b asks for, mechanically: every ANCHORED pattern — the shape
	 * that reads one of Forge's prompt lines — lives inside the adapter. A lane
	 * that adds "one more case" to a decision has to add it where this test can
	 * see it. `plainCost`'s three patterns are not anchored and are not
	 * decisions: they rewrite WotC's braces for a line the seat is shown.
	 */
	it('every anchored pattern in the file is inside the adapter', () => {
		const anchored = [...SOURCE.matchAll(/^const (\w+) = \/\^/gm)];
		expect(anchored.length).toBeGreaterThan(0);
		const outside = anchored.filter((m) => m.index! < ADAPTER_START || m.index! > ADAPTER_END).map((m) => m[1]);
		expect(outside, `anchored patterns outside the adapter: ${JSON.stringify(outside)}`).toEqual([]);
		// And the names, so a rename is a deliberate edit to this list.
		expect(anchored.map((m) => m[1])).toEqual(['PRIORITY', 'TURN_OWNER', 'STACK_EMPTY', 'PHASE_LINE', 'PAY_MANA', 'LIFE_INSTEAD']);
	});

	it('the decision layer contains no pattern literal at all', () => {
		const decisions = SOURCE.slice(ADAPTER_END, SOURCE.indexOf('/* ── What a cast paid'));
		expect(decisions.length).toBeGreaterThan(500);
		expect(decisions).not.toMatch(/\/\^/);
		expect(decisions).not.toMatch(/RegExp/);
		// Nor a phase SPELLING, nor Forge's button word: those are the adapter's.
		expect(decisions).not.toContain('Main phase');
		expect(decisions).not.toContain("'Auto'");
	});

	it('maps all thirteen of Forge’s PhaseTypes out of their UI spellings, and only those', () => {
		expect(Object.keys(PHASE_BY_UI_NAME)).toHaveLength(PHASE_TYPES.length);
		expect([...new Set(Object.values(PHASE_BY_UI_NAME))].sort()).toEqual([...PHASE_TYPES].sort());
	});

	it('produces a PhaseType, never a spelling, from a real priority prompt', () => {
		const read = readPromptFacts(notesFor('Priority: B\nTurn: 4 (B)\nPhase: Main phase, precombat\nStack: Empty', buttons(true), []));
		expect(read.phase).toBe('MAIN1');
		expect(read.phaseLabel).toBe('Main phase, precombat');
		expect(read.myTurn).toBe(true);
		expect(read.stackEmpty).toBe(true);
		expect(read.window).toBe('priority');
	});

	it('gives every field its "ask the player" value when it cannot tell', () => {
		const blank = readPromptFacts({ playerId: null, prompt: null, buttons: null, actionable: [1], openAsks: 2 });
		expect(blank).toMatchObject({ window: 'other', phase: null, mine: false, confirmLive: false, sources: null });
		// The open asks survive, because "a seat with a question is not idle".
		expect(blank.openAsks).toBe(2);
		expect(decideStop(blank, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decidePay(blank, DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('reads Forge’s weighting as the auto-tap plan, not as a set', () => {
		// `pushActionableCards` sends a planned card twice (PCH.java:1580-1589).
		const read = readPromptFacts(notesFor('Pay Mana Cost: {1}{W}', autoBar(true), [61, 62, 61]));
		expect(read.sources).toEqual([61, 62]);
		expect(read.plannedSources).toEqual([61]);
	});
});

describe('a stop preference is a VALUE — the next request is not a branch', () => {
	/** The opponent's upkeep, with something this seat could do. */
	const busyOnTheirUpkeep = facts({ phase: 'UPKEEP', phaseLabel: 'Upkeep step', myTurn: false, sources: [61] });

	it('#20 — the default asks, and ARENA passes it, with no code between them', () => {
		expect(decideStop(busyOnTheirUpkeep, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(busyOnTheirUpkeep, ARENA_STOP_POLICY)).toBe('Upkeep step');
	});

	it('#20 — the phases the player DID ask for still stop, with something to do or not', () => {
		for (const sources of [[], [61]]) {
			const blockers = facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', myTurn: false, sources });
			expect(decideStop(blockers, ARENA_STOP_POLICY), JSON.stringify(sources)).toBeNull();
			const myMain = facts({ phase: 'MAIN1', phaseLabel: 'Main phase, precombat', myTurn: true, sources });
			expect(decideStop(myMain, ARENA_STOP_POLICY), JSON.stringify(sources)).toBeNull();
		}
	});

	it('the scope of a skip is a value too: theirTurn leaves the player’s own turn alone', () => {
		const theirTurnOnly: StopPolicy = { ...ARENA_STOP_POLICY, skipNonStopPhases: 'theirTurn' };
		expect(decideStop(busyOnTheirUpkeep, theirTurnOnly)).toBe('Upkeep step');
		const myBusyUpkeep = facts({ phase: 'UPKEEP', phaseLabel: 'Upkeep step', myTurn: true, sources: [61] });
		expect(decideStop(myBusyUpkeep, theirTurnOnly)).toBeNull();
		expect(decideStop(myBusyUpkeep, ARENA_STOP_POLICY)).toBe('Upkeep step');
	});

	it('an unknown phase is never skipped — a spelling we do not know is a stop', () => {
		const unknown = facts({ phase: null, phaseLabel: 'Fourth main phase', sources: [61] });
		expect(isStopPhase(ARENA_STOP_POLICY, unknown)).toBe(false);
		// `skipNonStopPhases: 'always'` would pass it; that is deliberate and it is
		// what the label fallback is for. With actions and the default, it stops.
		expect(decideStop(unknown, DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('the default policy is wave 20’s behaviour, field by field', () => {
		expect(DEFAULT_STOP_POLICY).toEqual({
			stopOnMyTurn: ['MAIN1', 'MAIN2'],
			stopOnTheirTurn: [],
			skipNonStopPhases: 'never',
			passWhenNothingToDo: true,
			interruptsRestoreStops: true,
			passStackWindows: true,
			unambiguousPayment: 'auto',
			unpayableCost: 'cancel',
			costConfirm: 'ask',
			answerOneAnswerAsks: true,
		});
	});
});

/*
 * Item 6, the three things that must NOT be shortcut. Each one is a mutation
 * target: revert the guard in `auto.ts` and the matching test must go red.
 */

describe('NEVER shortcut (1): a stop with a legal action and something at stake', () => {
	it('is not passed when Forge named anything actionable', () => {
		expect(decideStop(facts({ sources: [61] }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(facts({ sources: [61, 62] }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('is not passed on Forge’s silence either — a cleared set is "no answer"', () => {
		expect(decideStop(facts({ sources: null }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('is not passed while the seat has a question open', () => {
		expect(decideStop(facts({ openAsks: 1 }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('is not passed when the window is not this seat’s, or its button is dead', () => {
		expect(decideStop(facts({ mine: false }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(facts({ confirmLive: false }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('is not passed in a window the adapter could not classify', () => {
		expect(decideStop(facts({ window: 'other' }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(facts({ window: 'payment' }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('holds under ARENA too: a skipped phase with actions is passed, a stop phase is not', () => {
		// The one place the policy DOES pass a window with something to do is a
		// phase the player asked to skip — which is #20, and is a preference.
		expect(decideStop(facts({ phase: 'UPKEEP', phaseLabel: 'Upkeep step', sources: [61] }), ARENA_STOP_POLICY)).toBe('Upkeep step');
		expect(
			decideStop(facts({ phase: 'END_OF_TURN', phaseLabel: 'End step', sources: [61] }), ARENA_STOP_POLICY),
		).toBeNull();
	});
});

describe('NEVER shortcut (2): a cost whose payment is a genuine choice', () => {
	/** Two lands, and Forge’s auto-tap plan naming neither: which to tap is the player’s. */
	const twoSourcesNoPlan = facts({ window: 'payment', cost: '{1}{W}', sources: [61, 62], plannedSources: [] });

	it('two sources with no plan on the wire is a choice, and stays a stop', () => {
		expect(decidePay(twoSourcesNoPlan, DEFAULT_STOP_POLICY)).toBeNull();
	});

	/*
	 * #22, *"Stoneforge Mystic waited for a click on Plains when there was only
	 * one way to pay"*. Stoneforge's ability costs `{1}{W}, {T}`
	 * (`cardsfolder/s/stoneforge_mystic.txt`), so it is TWO mana off two lands —
	 * two sources, one assignment. What settles it is Forge's own auto-tap plan,
	 * which reaches us as a repeat in `setWeaklySelectable`'s multiset once
	 * `UI_SHOW_AUTOTAP_PREVIEW` is on (`PlayerControllerHuman.java:1580-1589`).
	 */
	it('#22 — every source Forge offered being in its own plan is ONE payment', () => {
		const planned = { ...twoSourcesNoPlan, plannedSources: [61, 62] };
		expect(decidePay(planned, DEFAULT_STOP_POLICY)).toBe('{1}{W}');
	});

	it('#22 — a source LEFT OUT of the plan means the plan had a choice, and it is the player’s', () => {
		const partly = { ...twoSourcesNoPlan, sources: [61, 62, 63], plannedSources: [61, 62] };
		expect(decidePay(partly, DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('one source is still one payment (#6), plan or no plan', () => {
		expect(decidePay({ ...twoSourcesNoPlan, sources: [61] }, DEFAULT_STOP_POLICY)).toBe('{1}{W}');
	});

	it('life instead of mana is a second payment, however few lands are out', () => {
		expect(decidePay({ ...twoSourcesNoPlan, sources: [61], alternativePayment: true }, DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('a dead or absent Auto button is never pressed', () => {
		expect(decidePay({ ...twoSourcesNoPlan, sources: [61], confirmLive: false }, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decidePay({ ...twoSourcesNoPlan, sources: [61], window: 'priority' }, DEFAULT_STOP_POLICY)).toBeNull();
	});

	/*
	 * #16, *"tapping Evolving Wilds asks whether to sacrifice — ridiculous
	 * question"*. Forge asks through `InputConfirm`, so the frames that reach us
	 * are a prose prompt with NO card ref plus a Yes/No bar
	 * (`HumanCostDecision.java:1295-1301` → `PlayerControllerHuman.confirmPayment`
	 * → `InputConfirm.confirm`; the message is `lblSacrificeCardConfirm`,
	 * `en-US.properties:2821`). Declining returns null from the cost decision,
	 * which ABORTS the activation — so Forge does offer a real decline, and
	 * nothing on our wire tells this window apart from an optional-trigger
	 * confirm, which is a real game choice. It stays a stop, and the evidence doc
	 * names what would change that.
	 */
	it('#16 — Evolving Wilds’ sacrifice confirm is asked, and stays asked', () => {
		const yesNo = parseServerFrame({
			kind: 'notify',
			method: 'updateButtons',
			owner: { kind: 'player', id: 1 },
			label1: 'Yes',
			label2: 'No',
			enable1: true,
			enable2: true,
			focus1: true,
		});
		const notes = notesFor('Sacrifice Evolving Wilds?', yesNo, []);
		const read = readPromptFacts(notes);
		expect(read.window).toBe('other');
		expect(read.cost).toBeNull();
		for (const policy of [DEFAULT_STOP_POLICY, { ...DEFAULT_STOP_POLICY, costConfirm: 'accept' as const }, ARENA_STOP_POLICY]) {
			expect(decideStop(read, policy)).toBeNull();
			expect(decidePay(read, policy)).toBeNull();
		}
		// And through the whole `match.ts` entry points, which is what runs live.
		expect(autoPassReason(notes)).toBeNull();
		expect(autoPayReason(notes)).toBeNull();
	});
});

describe('NEVER shortcut (3): anything at all while full control is on', () => {
	/** Every window the real captured turn flow produced, under full control. */
	it('passes and pays NOTHING over every window Forge really sent', () => {
		expect(FLOW.windows.length).toBeGreaterThan(4);
		for (const w of FLOW.windows) {
			const notes: SeatNotes = {
				playerId: w.playerId,
				prompt: parseServerFrame(w.prompt),
				buttons: parseServerFrame(w.buttons),
				actionable: w.actionable,
				openAsks: 0,
			};
			expect(autoPassReason(notes, FULL_CONTROL_POLICY), `${w.label}: pass`).toBeNull();
			expect(autoPayReason(notes, FULL_CONTROL_POLICY), `${w.label}: pay`).toBeNull();
		}
	});

	it('stops every phase on every turn, with nothing to do and with something', () => {
		for (const phase of PHASE_TYPES) {
			for (const myTurn of [true, false]) {
				for (const sources of [[], [61], null]) {
					const w = facts({ phase, phaseLabel: null, myTurn, sources });
					expect(decideStop(w, FULL_CONTROL_POLICY), `${phase} ${String(myTurn)}`).toBeNull();
				}
			}
		}
	});

	it('stops a stack window too — the one wave 20 taught the default to pass', () => {
		const onStack = facts({ stackEmpty: false, sources: [] });
		expect(decideStop(onStack, DEFAULT_STOP_POLICY)).toBe('End step');
		expect(decideStop(onStack, FULL_CONTROL_POLICY)).toBeNull();
	});

	it('presses no payment, however unambiguous', () => {
		const one = facts({ window: 'payment', cost: '{U}', sources: [61] });
		expect(decidePay(one, DEFAULT_STOP_POLICY)).toBe('{U}');
		expect(decidePay(one, FULL_CONTROL_POLICY)).toBeNull();
	});

	it('answers no bounds ask either — the shortcut is off, not narrowed', () => {
		const ask = allMustBeChosen('fc-1');
		expect(onlyAnswer(ask, DEFAULT_STOP_POLICY)).not.toBeNull();
		expect(onlyAnswer(ask, FULL_CONTROL_POLICY)).toBeNull();
	});
});

/* ── The policy as Forge's own frames ────────────────────────────────── */

const SEAT = { me: { kind: 'player' as const, id: 1 }, others: [{ kind: 'player' as const, id: 2 }] };

describe('toYieldUpdates — the policy as Forge’s own YieldUpdate arms', () => {
	it('emits nothing Forge’s sealed interface does not permit', () => {
		for (const policy of [DEFAULT_STOP_POLICY, ARENA_STOP_POLICY, FULL_CONTROL_POLICY]) {
			const frames = toYieldUpdates(policy, SEAT);
			expect(frames.length).toBeGreaterThan(0);
			for (const frame of frames) {
				const parsed = YieldUpdateSchema.safeParse(frame);
				expect(parsed.success ? null : parsed.error.issues, JSON.stringify(frame)).toBeNull();
			}
		}
	});

	it('carries one skipPhase per (turn player, phase) — 13 phases, every player', () => {
		const frames = toYieldUpdates(DEFAULT_STOP_POLICY, SEAT);
		const skips = frames.filter((f) => f.update === 'skipPhase');
		expect(skips).toHaveLength(PHASE_TYPES.length * 2);
		// The default skips nothing: every stop is still Forge's own to decide.
		expect(skips.every((f) => f.update === 'skipPhase' && f.skip === false)).toBe(true);
	});

	it('ARENA’s skip set is exactly the complement of its stop set, per side', () => {
		const frames = toYieldUpdates(ARENA_STOP_POLICY, SEAT);
		const skipped = (id: number): PhaseType[] =>
			frames
				.filter((f) => f.update === 'skipPhase' && f.turnPlayer.id === id && f.skip)
				.map((f) => (f as Extract<typeof f, { update: 'skipPhase' }>).phase);
		expect(skipped(1).sort()).toEqual(PHASE_TYPES.filter((p) => !ARENA_STOP_POLICY.stopOnMyTurn.includes(p)).sort());
		expect(skipped(2).sort()).toEqual(PHASE_TYPES.filter((p) => !ARENA_STOP_POLICY.stopOnTheirTurn.includes(p)).sort());
	});

	it('carries APINA, the interrupt rule and #22’s enabler as Forge’s own prefs', () => {
		const prefs = (policy: StopPolicy): Record<string, string> =>
			Object.fromEntries(
				toYieldUpdates(policy, SEAT)
					.filter((f) => f.update === 'setYieldPref')
					.map((f) => [(f as Extract<typeof f, { update: 'setYieldPref' }>).pref, (f as Extract<typeof f, { update: 'setYieldPref' }>).value]),
			);
		expect(prefs(DEFAULT_STOP_POLICY)).toEqual({
			YIELD_AUTO_PASS_NO_ACTIONS: 'true',
			YIELD_AUTO_PASS_RESPECTS_INTERRUPTS: 'true',
			UI_SHOW_AUTOTAP_PREVIEW: 'true',
		});
		expect(prefs(FULL_CONTROL_POLICY)).toEqual({
			YIELD_AUTO_PASS_NO_ACTIONS: 'false',
			YIELD_AUTO_PASS_RESPECTS_INTERRUPTS: 'true',
			UI_SHOW_AUTOTAP_PREVIEW: 'false',
		});
		// Every pref named is one YieldController actually syncs (YieldController.java:46-65).
		const SYNCED = new Set(['YIELD_AUTO_PASS_NO_ACTIONS', 'YIELD_AUTO_PASS_RESPECTS_INTERRUPTS', 'UI_SHOW_AUTOTAP_PREVIEW']);
		for (const key of Object.keys(prefs(ARENA_STOP_POLICY))) expect(SYNCED.has(key), key).toBe(true);
	});

	/*
	 * Item 5: full control CLEARS the yields, so every stop comes back. These are
	 * the four frames `YieldController.clearActiveYieldAndDispatch` (:406-428)
	 * sends for itself, plus the per-ability store, plus every phase un-skipped.
	 */
	it('item 5 — full control clears every yield Forge can be holding', () => {
		const frames = toYieldUpdates(FULL_CONTROL_POLICY, SEAT);
		expect(frames).toContainEqual({ update: 'clearMarker', player: SEAT.me });
		expect(frames).toContainEqual({ update: 'stackYield', player: SEAT.me, active: false, respectsInterrupts: false });
		expect(frames).toContainEqual({ update: 'setAutoPassUntilEndOfTurn', player: SEAT.me, active: false });
		expect(frames).toContainEqual({ update: 'setDisableYields', disabled: true });
		// Not one phase is skipped: every stop comes back.
		expect(frames.filter((f) => f.update === 'skipPhase' && f.skip)).toEqual([]);
		// And nothing in it ACTIVATES a yield — that is what "clears" means.
		expect(frames.filter((f) => f.update === 'stackYield' && f.active)).toEqual([]);
		expect(frames.filter((f) => f.update === 'setAutoPassUntilEndOfTurn' && f.active)).toEqual([]);
		expect(frames.filter((f) => f.update === 'setMarker')).toEqual([]);
	});

	it('every policy push is a full reset: the transient yields are cleared first', () => {
		for (const policy of [DEFAULT_STOP_POLICY, ARENA_STOP_POLICY, FULL_CONTROL_POLICY]) {
			const frames = toYieldUpdates(policy, SEAT);
			expect(frames[0]).toEqual({ update: 'clearMarker', player: SEAT.me });
			const firstPref = frames.findIndex((f) => f.update === 'setYieldPref');
			const firstSkip = frames.findIndex((f) => f.update === 'skipPhase');
			expect(firstPref).toBeLessThan(firstSkip);
		}
	});
});

/* ── Wave 25 §D: items 3, 6 and 7 ────────────────────────────────────── */

/**
 * Item 6, pinned as the MEASUREMENT it is.
 *
 * `auto.jvm.test.ts`'s third scenario casts Galvanic Blast for `{R}` off a board
 * holding one Mountain and one Island, and `readPromptFacts` read that window as
 *
 * ```json
 * {"window":"payment","confirmLive":true,"cost":"{R}","alternativePayment":false,
 *  "sources":[16,57],"plannedSources":[],"openAsks":0,"mine":true}
 * ```
 *
 * So the guard that returned null is the SOURCE COUNT: `sources` had two entries,
 * `decidePay`'s one-source arm did not fire, and with no auto-tap plan on the wire
 * the #22 arm returned null. The cause is not the arithmetic — it is that Forge's
 * payment-mode actionable set is every card in five zones with a playable mana
 * ability (`PlayerControllerHuman.java:1533-1535`, `:1565-1573`, `:1594-1599`),
 * so the Island is in it while `{R}` is being paid.
 *
 * Nothing on this wire tells "one Mountain and one Island for `{R}`" (one payment)
 * apart from "two Mountains for `{R}`" (two): both arrive as two sources and, with
 * the auto-tap preview on, a one-card plan. Deciding that an Island cannot pay red
 * is a rule. So the shortcut is a POLICY VALUE — `'forgeAuto'` — and not a branch.
 */
describe('item 6 — the guard that asked, and the policy value that stops asking', () => {
	/** Galvanic Blast's window, as the real Forge run recorded it. */
	const galvanicBlast = facts({
		window: 'payment',
		phase: null,
		phaseLabel: null,
		stackEmpty: false,
		cost: '{R}',
		sources: [16, 57],
		plannedSources: [],
	});

	it('is the source COUNT that asks, and every other guard passed', () => {
		expect(galvanicBlast.window).toBe('payment');
		expect(galvanicBlast.confirmLive).toBe(true);
		expect(galvanicBlast.mine).toBe(true);
		expect(galvanicBlast.openAsks).toBe(0);
		expect(galvanicBlast.alternativePayment).toBe(false);
		expect(galvanicBlast.cost).toBe('{R}');
		// Two sources, no plan: that is the pair `decidePay` cannot settle.
		expect(galvanicBlast.sources).toHaveLength(2);
		expect(galvanicBlast.plannedSources).toEqual([]);
		expect(decidePay(galvanicBlast, DEFAULT_STOP_POLICY)).toBeNull();
		// And with one source it always did fire — the arm was never broken.
		expect(decidePay({ ...galvanicBlast, sources: [16] }, DEFAULT_STOP_POLICY)).toBe('{R}');
	});

	it('the value that closes it is one word, and it presses Forge’s own Auto', () => {
		const forgeAuto: StopPolicy = { ...DEFAULT_STOP_POLICY, unambiguousPayment: 'forgeAuto' };
		expect(decidePay(galvanicBlast, forgeAuto)).toBe('{R}');
		// It rests on the live Auto and nothing else: Forge saying it found a
		// payment (`InputPayMana.java:402-407`). A dead one is never pressed.
		expect(decidePay({ ...galvanicBlast, confirmLive: false }, forgeAuto)).toBeNull();
		// And it keeps every guard that is not about counting sources.
		expect(decidePay({ ...galvanicBlast, alternativePayment: true }, forgeAuto)).toBeNull();
		expect(decidePay({ ...galvanicBlast, openAsks: 1 }, forgeAuto)).toBeNull();
		expect(decidePay({ ...galvanicBlast, mine: false }, forgeAuto)).toBeNull();
		expect(decidePay({ ...galvanicBlast, window: 'priority' }, forgeAuto)).toBeNull();
	});

	it('is NOT the default, and the two-Mountain window is why', () => {
		// The same facts a genuinely ambiguous payment produces — two sources that
		// can BOTH pay — are these exact facts. `board-play.jvm.test.ts` step 3
		// asserts the strict behaviour over a real match, so the default stays
		// strict and `'forgeAuto'` is opt-in.
		expect(DEFAULT_STOP_POLICY.unambiguousPayment).toBe('auto');
		expect(ARENA_STOP_POLICY.unambiguousPayment).toBe('auto');
	});

	it('full control asks anyway, whatever the payment preference is', () => {
		expect(FULL_CONTROL_POLICY.unambiguousPayment).toBe('ask');
		expect(decidePay(galvanicBlast, FULL_CONTROL_POLICY)).toBeNull();
		expect(decidePay({ ...galvanicBlast, sources: [16] }, FULL_CONTROL_POLICY)).toBeNull();
	});
});

/**
 * Item 7 — the cost Forge itself says cannot be paid. Operator, 2026-09-27:
 * *"it's confusing i have to click 'cancel' to not pay manaleak when i dont even
 * have enough mana."*
 */
describe('item 7 — a payment Forge left only Cancel for', () => {
	/** Forge's payment bar with its own Auto DEAD: `ensureAutoPayManaSources` found nothing. */
	const deadAuto = autoBar(false);

	it('the adapter reads Forge’s dead Auto plus an empty set as "no way to pay"', () => {
		const read = readPromptFacts(notesFor('Mana Leak - counter target spell.\n\nPay Mana Cost: {1}{U}', deadAuto, []));
		expect(read.window).toBe('payment');
		expect(read.cost).toBe('{1}{U}');
		expect(read.confirmLive).toBe(false);
		expect(read.noWayToPay).toBe(true);
	});

	it('never reads it off a window that is not Forge’s payment input', () => {
		// A priority bar with a dead OK is a window that is simply not ours to press.
		expect(readPromptFacts(notesFor(PRIORITY_MESSAGE, buttons(false), [])).noWayToPay).toBe(false);
		// A LIVE Auto is Forge saying the cost CAN be paid.
		expect(readPromptFacts(notesFor('Pay Mana Cost: {U}', autoBar(true), [])).noWayToPay).toBe(false);
		// Forge naming something clickable means the window still holds an act.
		expect(readPromptFacts(notesFor('Pay Mana Cost: {1}{U}', deadAuto, [61])).noWayToPay).toBe(false);
		// And a CLEARED set is "Forge has not said", never "nothing".
		expect(readPromptFacts(notesFor('Pay Mana Cost: {1}{U}', deadAuto, null)).noWayToPay).toBe(false);
	});

	it('cancels it, and names the cost it abandoned', () => {
		const unpayable = facts({ window: 'payment', cost: '{1}{U}', confirmLive: false, noWayToPay: true, stackEmpty: false });
		expect(decideCancel(unpayable, DEFAULT_STOP_POLICY)).toBe('{1}{U}');
		// Through the entry point `match.ts` calls, over Forge's own frames.
		expect(autoCancelReason(notesFor('Mana Leak.\n\nPay Mana Cost: {1}{U}', deadAuto, []))).toBe('{1}{U}');
	});

	it('leaves LIFE alone: alternativePayment stays in front of it', () => {
		// A phyrexian cost has a second answer however few lands are out, and
		// Forge's Auto is dead for that one too.
		const phyrexian = notesFor(
			'Pay Mana Cost: {U/P}\nClick on your life total to pay life for phyrexian mana.',
			deadAuto,
			[],
		);
		expect(readPromptFacts(phyrexian).noWayToPay).toBe(true);
		expect(readPromptFacts(phyrexian).alternativePayment).toBe(true);
		expect(autoCancelReason(phyrexian)).toBeNull();
	});

	it('never cancels a payment Forge can settle, or a window that is not one', () => {
		const payable = facts({ window: 'payment', cost: '{U}', sources: [61], noWayToPay: false });
		expect(decideCancel(payable, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideCancel(facts({ window: 'priority', noWayToPay: true }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideCancel(facts({ window: 'other', noWayToPay: true }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideCancel(facts({ window: 'payment', cost: null, noWayToPay: true }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('never cancels while a question is open, or for the other seat', () => {
		const unpayable = facts({ window: 'payment', cost: '{1}{U}', confirmLive: false, noWayToPay: true });
		expect(decideCancel({ ...unpayable, openAsks: 1 }, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideCancel({ ...unpayable, mine: false }, DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('is a POLICY: full control leaves the Cancel to the player', () => {
		const unpayable = facts({ window: 'payment', cost: '{1}{U}', confirmLive: false, noWayToPay: true });
		expect(FULL_CONTROL_POLICY.unpayableCost).toBe('ask');
		expect(decideCancel(unpayable, FULL_CONTROL_POLICY)).toBeNull();
		expect(decideCancel(unpayable, { ...DEFAULT_STOP_POLICY, unpayableCost: 'ask' })).toBeNull();
		expect(autoCancelReason(notesFor('Pay Mana Cost: {1}{U}', deadAuto, []), FULL_CONTROL_POLICY)).toBeNull();
	});

	it('answers no stop and no payment either — Cancel is the only arm it is', () => {
		const unpayable = facts({ window: 'payment', cost: '{1}{U}', confirmLive: false, noWayToPay: true });
		expect(decideStop(unpayable, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decidePay(unpayable, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decidePay(unpayable, { ...DEFAULT_STOP_POLICY, unambiguousPayment: 'forgeAuto' })).toBeNull();
	});
});

describe('a Match with an unpayable cost in front of it (item 7)', () => {
	/** Forge's payment input with its own Auto dead and nothing to click. */
	function unpayable(h: Harness, seat: number): void {
		const me = playerOf(h, seat);
		push(h, seat, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, seat, autoBar(false, me));
		push(h, seat, prompt('Mana Leak - counter target spell.\n\nPay Mana Cost: {1}{U}', me));
	}

	it('presses Forge’s own Cancel, exactly once for that cost, and says nothing', () => {
		const h = harness();
		unpayable(h, 0);
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonCancel' } },
		]);
		expect(h.logs.filter((l) => l.evt === 'auto-cancelled')).toEqual([
			{ evt: 'auto-cancelled', matchId: h.match.id, seat: 0, cost: '{1}{U}' },
		]);
		// Forge re-shows the payment prompt after every refresh; a second press
		// would answer whatever it asks next.
		push(h, 0, autoBar(false, playerOf(h, 0)));
		push(h, 0, prompt('Mana Leak - counter target spell.\n\nPay Mana Cost: {1}{U}', playerOf(h, 0)));
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);
		// The cast never happened, so there is nothing to account for: no line.
		expect(says(h, 0)).toEqual([]);
	});

	it('never presses it when Forge’s Auto is live — that is the payment’s business', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {1}{U}', me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(h.logs.filter((l) => l.evt === 'auto-cancelled')).toEqual([]);
	});

	it('full control leaves the Cancel to the player', () => {
		const h = harness();
		h.match.setFullControl(0, true);
		unpayable(h, 0);
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(h.logs.filter((l) => l.evt === 'auto-cancelled')).toEqual([]);
	});

	it('is per seat, like every other shortcut', () => {
		const h = harness();
		h.match.setFullControl(0, true);
		unpayable(h, 0);
		unpayable(h, 1);
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 1, frame: { kind: 'act', method: 'selectButtonCancel' } },
		]);
	});

	/*
	 * A cancelled cast paid nothing, and `paid 1U` for it would be the exact
	 * opposite of the rule that line exists for (#8: a cast must never look free).
	 */
	it('leaves no "paid" line behind: a rollback is not a payment', () => {
		const h = harness();
		unpayable(h, 0);
		// Forge rolls the cast back and the seat is at priority again.
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), playerOf(h, 0)));
		expect(says(h, 0)).toEqual([]);
	});

	it('and the same for the player’s OWN Cancel, which is the same rollback', () => {
		const h = harness();
		const me = playerOf(h, 0);
		const cancel = ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' });
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Mana Leak.\n\nPay Mana Cost: {1}{U}', me));
		expect(h.match.fromClient(0, cancel)).toEqual({ ok: true });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		expect(says(h, 0)).toEqual([]);
	});

	it('still says what a payment that FINISHED paid', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Preordain.\n\nPay Mana Cost: {U}', me));
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		expect(says(h, 0)).toEqual(['paid U']);
	});
});
