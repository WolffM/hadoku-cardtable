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
import { describe, expect, it, vi } from 'vitest';
import { ClientFrameSchema, PHASE_TYPES, REPLY_SCHEMAS, parseServerFrame, type PhaseType, type ServerFrame } from '@hadoku/forge-wire';

import {
	DEFAULT_STOP_POLICY,
	EVERY_PRIORITY_POLICY,
	FULL_CONTROL_POLICY,
	STOP_POLICY_NAMES,
	STRICT_PAYMENT_POLICY,
	PHASE_BY_UI_NAME,
	namedStopPolicy,
	chosenCostConfirm,
	freeSearchConfirm,
	decideCancel,
	decidePay,
	decideStop,
	isOwnMainPhaseEntry,
	isStopPhase,
	judgeStop,
	onlyAnswer,
	paymentCost,
	readPromptFacts,
	withEndStepStop,
	type SeatNotes,
	type StopPolicy,
} from './auto.js';
import { FORGE_PREFERENCES } from './host.js';
import { copyTargets, parseCardScript, type SpellCopy } from './spell-copiers.js';
import { createMatchRegistry, type Match } from './match.js';
import type { ServerEnvelope } from './transport.js';
import { loadTranscript, replayFactory, type ReplayHost } from './fixtures/transcript.js';

/* ── The real prompt fixtures ────────────────────────────────────────── */

// @reads apps/ui/src/play/prompts/fixtures/ apps/server/src/play/fixtures/w20-turn-flow.json
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

	// `order.json` is the one fixture that is NOT here: "Select order for simultaneous
	// abilities" is answered with Forge's own order unless the seat is in full control
	// (wave 32, Q8) — its own cases follow below.
	it.each(FIXTURE_FILES.filter((f) => f !== 'order.json'))('%s is a real choice and is asked', (file) => {
		expect(onlyAnswer(fixture(file))).toBeNull();
	});

	/*
	 * Wave 32, Q8 — *"Select order for simultaneous abilities"* is Forge's
	 * `getGui().order(...)` (`PlayerControllerHuman.java:2309-2313`), and the operator
	 * wants it to be a full-control thing. The list Forge hands over is already in its
	 * own order, and answering with it unchanged is what Forge does when it gets no
	 * choice (`chosen == null` → the same list).
	 */
	describe('Q8: the order of simultaneous abilities', () => {
		const KEYS = ['sa-9101', 'sa-9102', 'sa-9103'];

		it('is answered with the order Forge itself offered, unremembered, by default', () => {
			const answer = onlyAnswer(fixture('order.json'));
			expect(answer?.result).toEqual({ ordered: KEYS, rememberDecision: false });
			expect(answer?.why).toBe("Forge's own order");
		});

		it('is a question for a policy that asks, and for full control', () => {
			expect(onlyAnswer(fixture('order.json'), { ...DEFAULT_STOP_POLICY, orderSimultaneous: 'ask' })).toBeNull();
			expect(onlyAnswer(fixture('order.json'), FULL_CONTROL_POLICY)).toBeNull();
			expect(FULL_CONTROL_POLICY.orderSimultaneous).toBe('ask');
		});

		it('does not touch an ordering that has no remember checkbox — a library or damage order is the player’s', () => {
			const library = { ...fixture('order.json'), showRememberCheckbox: false } as unknown as ServerFrame;
			expect(onlyAnswer(library)).toBeNull();
		});

		it('takes the re-order ask’s items from the destination side, and nothing when both sides hold some', () => {
			const base = fixture('order.json') as unknown as { sourceChoices: unknown[]; destChoices: unknown[] };
			const reorder = { ...base, sourceChoices: [], destChoices: base.sourceChoices } as unknown as ServerFrame;
			expect(onlyAnswer(reorder)?.result).toEqual({ ordered: KEYS, rememberDecision: false });
			const both = { ...base, destChoices: base.sourceChoices.slice(0, 1) } as unknown as ServerFrame;
			expect(onlyAnswer(both)).toBeNull();
		});

		it('a seat in full control is still asked, end to end through the match', () => {
			const h = harness();
			const ask = { ...(fixture('order.json') as unknown as Record<string, unknown>), callId: 'o-1' };
			h.match.setFullControl(0, true);
			push(h, 0, ask);
			expect(frames(h, 0).filter((f) => f.kind === 'ask' && f.callId === 'o-1')).toHaveLength(1);
			expect(h.host.commands.filter((c) => c.t === 'reply')).toEqual([]);
			// And without full control the same ask never reaches the browser.
			push(h, 1, { ...ask, callId: 'o-2' });
			expect(frames(h, 1).filter((f) => f.kind === 'ask' && f.callId === 'o-2')).toEqual([]);
			expect(h.host.commands).toContainEqual({ t: 'reply', seat: 1, callId: 'o-2', result: { ordered: KEYS, rememberDecision: false } });
		});
	});
});

/** The same fixtures, narrowed to the shape Forge sends when it has left one possibility. */
describe('onlyAnswer, where Forge left exactly one possibility', () => {
	function narrowed(file: string, patch: Record<string, unknown>): ServerFrame {
		return parseServerFrame({ ...(fixture(file) as unknown as Record<string, unknown>), ...patch });
	}

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
	});

	it('getAbilityToPlay with one ability plays it; with two it is a question', () => {
		const ask = fixture('getAbilityToPlay.json') as Extract<ServerFrame, { method: 'getAbilityToPlay' }>;
		expect(ask.abilities.length).toBeGreaterThan(1);
		expect(onlyAnswer(ask)).toBeNull();
		const one = narrowed('getAbilityToPlay.json', { abilities: [ask.abilities[0]] });
		expect(onlyAnswer(one)).toMatchObject({ result: ask.abilities[0], why: 'one ability' });
		expect(onlyAnswer(one, FULL_CONTROL_POLICY)).toMatchObject({ result: ask.abilities[0], why: 'one ability' });
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
		// An ordering with no remember checkbox (a library or damage order); the
		// one WITH it is Forge's own simultaneous-ability order, answered since Q8.
		const slack = narrowed('order.json', {
			sourceChoices: [ask.sourceChoices[0]],
			remainingObjectsMin: 0,
			remainingObjectsMax: 1,
			showRememberCheckbox: false,
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
		expect(decideStop(readPromptFacts(notes), DEFAULT_STOP_POLICY), `${label}: auto-pass`).toBe(want.pass);
		expect(decidePay(readPromptFacts(notes), DEFAULT_STOP_POLICY), `${label}: auto-pay`).toBe(want.pay);
	});

	it('every ability offer the run produced carried exactly one ability, and its label', () => {
		expect(FLOW.abilityOffers.length).toBeGreaterThan(0);
		for (const offer of FLOW.abilityOffers) {
			const ask = parseServerFrame(offer);
			expect(ask.method).toBe('getAbilityToPlay');
			if (ask.method !== 'getAbilityToPlay') continue;
			expect(ask.abilities, JSON.stringify(ask.abilities)).toHaveLength(1);
			expect(typeof ask.abilities[0]?.label).toBe('string');
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

/*
 * Two windows in phases the default policy DOES stop in — wave 28, item 5.
 *
 * `PRIORITY_MESSAGE` is the End of Combat step, which is not in either stop set,
 * so the default now passes it whether or not the seat could act there. That is
 * the change, so every case below whose claim is "this window is the PLAYER's"
 * has to name a phase the player actually asked for: their declare-blockers
 * step, or the seat's own precombat main.
 *
 * `THEIR_STOP_MESSAGE` named the END step until wave 30 item 2 took it out of
 * `stopOnTheirTurn` (*"it always waits on opponent at endstep now… not a
 * desired behavior"*) — declare-blockers is the phase that stayed. The end
 * step now stops only for a play (`stopWithPlayOnTheirTurn`); its dedicated
 * test is "the opponent’s End step stops only for a real play".
 */
const THEIR_STOP_MESSAGE = 'Priority: B\nTurn: 4 (A)\nPhase: Declare Blockers Step\nStack: Empty';
const MY_STOP_MESSAGE = 'Priority: A\nTurn: 4 (A)\nPhase: Main phase, precombat\nStack: Empty';

function prompt(message: string, playerId = 1, card: number | null = null): ServerFrame {
	return parseServerFrame({
		kind: 'notify',
		method: 'showPromptMessage',
		player: { kind: 'player', id: playerId },
		message,
		card: card === null ? null : { kind: 'card', id: card },
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

describe('decideStop, through readPromptFacts (formerly autoPassReason)', () => {
	it('passes a priority stop where Forge says the seat can do nothing, and names the phase', () => {
		expect(decideStop(readPromptFacts(IDLE), DEFAULT_STOP_POLICY)).toBe('End of Combat Step');
	});

	it('never passes a phase the player ASKED to stop in, with something to do or nothing', () => {
		// Their end step and the seat's own precombat main are both stop phases under
		// the default (wave 28). Nothing about what Forge named changes that.
		for (const message of [THEIR_STOP_MESSAGE, MY_STOP_MESSAGE]) {
			for (const actionable of [[] as number[], [67], null]) {
				expect(decideStop(readPromptFacts({ ...IDLE, prompt: prompt(message), actionable }), DEFAULT_STOP_POLICY), `${message} ${String(actionable)}`).toBeNull();
			}
		}
	});

	/*
	 * Wave 28, item 5, and the reason it is a leak fix rather than a convenience:
	 * this window used to be a stop whenever Forge named anything the seat could
	 * do, and Forge names a held instant. So the seat stopping told the table the
	 * seat was holding one. A phase outside the stop set is now passed on the
	 * PHASE, which is the same whatever the hand is.
	 */
	it('PASSES a phase outside the stop sets whether Forge named something, nothing, or nothing at all', () => {
		for (const actionable of [[] as number[], [67], null]) {
			expect(decideStop(readPromptFacts({ ...IDLE, actionable }), DEFAULT_STOP_POLICY), String(actionable)).toBe('End of Combat Step');
		}
	});

	it('never passes on silence where the policy still asks "was there anything to do"', () => {
		// A cleared set is "Forge has not said", not "nothing". Two places still
		// judge a window that way: every priority window under the superseded
		// default, and a STACK window under the current one, in any phase.
		expect(decideStop(readPromptFacts({ ...IDLE, actionable: null }), EVERY_PRIORITY_POLICY)).toBeNull();
		expect(decideStop(readPromptFacts({ ...IDLE, actionable: [67] }), EVERY_PRIORITY_POLICY)).toBeNull();
		const onStack = prompt('Priority: B\nTurn: 4 (A)\nPhase: End of Combat Step\nStack: 1 to Resolve.');
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: onStack, actionable: null }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: onStack, actionable: [67] }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('never passes a phase spelling it could not identify, now that "always" is the default', () => {
		// All thirteen spellings are mapped, so an unknown one is Forge saying
		// something new — "when in doubt the player is asked", not "skip it".
		const odd = prompt('Priority: A\nTurn: 4 (A)\nPhase: Fourth main phase\nStack: Empty');
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: odd, actionable: [67] }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: odd, actionable: null }), DEFAULT_STOP_POLICY)).toBeNull();
		// Forge's own "nothing here" still passes it: the guard removes the SKIP,
		// not `passWhenNothingToDo`.
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: odd, actionable: [] }), DEFAULT_STOP_POLICY)).toBe('Fourth main phase');
	});

	// Wave 20, #5: this used to be "never passes with something on the stack".
	// That requirement is what made a creature need two humans to press OK.
	it('PASSES a priority window with something on the stack — that is what resolves it', () => {
		const onStack = prompt('Priority: B\nTurn: 4 (A)\nPhase: End step\nStack: 1 to Resolve.');
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: onStack }), DEFAULT_STOP_POLICY)).toBe('End step');
	});

	// Wave 20, #7: "dont auto-pass peoples turns".
	it('never passes the seat’s OWN main phase with an empty stack, even with nothing to do', () => {
		for (const phase of ['Main phase, precombat', 'Main phase, postcombat']) {
			const own = prompt(`Priority: B\nTurn: 4 (B)\nPhase: ${phase}\nStack: Empty`);
			expect(decideStop(readPromptFacts({ ...IDLE, prompt: own }), DEFAULT_STOP_POLICY), phase).toBeNull();
		}
	});

	it('still passes the OTHER seat’s main phase, and its own main phase with a stack', () => {
		const theirs = prompt('Priority: B\nTurn: 4 (A)\nPhase: Main phase, precombat\nStack: Empty');
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: theirs }), DEFAULT_STOP_POLICY)).toBe('Main phase, precombat');
		const mineWithStack = prompt('Priority: B\nTurn: 4 (B)\nPhase: Main phase, precombat\nStack: 1 to Resolve.');
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: mineWithStack }), DEFAULT_STOP_POLICY)).toBe('Main phase, precombat');
	});

	it('never passes a prompt that is not priority (a mulligan, a payment, a declare step)', () => {
		for (const message of [
			'B, you are going first!\n\nDo you want to keep your hand?',
			'Preordain (70) - B scribes 2.\n\nPay Mana Cost: {U}',
			'Select creatures to attack with',
		]) {
			expect(decideStop(readPromptFacts({ ...IDLE, prompt: prompt(message) }), DEFAULT_STOP_POLICY), message).toBeNull();
		}
	});

	it('never passes while the seat has a question open', () => {
		expect(decideStop(readPromptFacts({ ...IDLE, openAsks: 1 }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('never passes when OK is not live, or the prompt belongs to the other seat', () => {
		expect(decideStop(readPromptFacts({ ...IDLE, buttons: buttons(false) }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: prompt(PRIORITY_MESSAGE, 0) }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(readPromptFacts({ ...IDLE, buttons: buttons(true, 0) }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('never passes before openView has named the seat, or with nothing said yet', () => {
		expect(decideStop(readPromptFacts({ ...IDLE, playerId: null }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(readPromptFacts({ ...IDLE, prompt: null }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(readPromptFacts({ ...IDLE, buttons: null }), DEFAULT_STOP_POLICY)).toBeNull();
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

/*
 * The strict payment policy is a NAMED EXPORT of `auto.ts` now
 * (`STRICT_PAYMENT_POLICY`), because two callers need exactly it: every case
 * below that used to ride on the default, and `board-play.jvm.test.ts`, whose
 * seats run it so that clicking a land to pay is still a thing that happens.
 * `DEFAULT_STOP_POLICY.unambiguousPayment` became `'forgeAuto'` on 2026-09-27
 * (the operator, on item 6); the strict semantics did not go away.
 */

describe('decidePay, through readPromptFacts (formerly autoPayReason)', () => {
	it('presses Forge’s Auto for a payment with exactly one source, and names the cost', () => {
		expect(decidePay(readPromptFacts(PAYING), DEFAULT_STOP_POLICY)).toBe('{U}');
	});

	it('asks when there is more than one source, UNDER THE STRICT VALUE — which land to tap is a real choice', () => {
		expect(decidePay(readPromptFacts({ ...PAYING, actionable: [67, 68] }), STRICT_PAYMENT_POLICY)).toBeNull();
	});

	it('settles the same window under the default, because the operator chose Forge’s auto-tap', () => {
		expect(decidePay(readPromptFacts({ ...PAYING, actionable: [67, 68] }), DEFAULT_STOP_POLICY)).not.toBeNull();
	});

	it('asks when Forge named no source, or has not said at all, UNDER THE STRICT VALUE', () => {
		expect(decidePay(readPromptFacts({ ...PAYING, actionable: [] }), STRICT_PAYMENT_POLICY)).toBeNull();
		expect(decidePay(readPromptFacts({ ...PAYING, actionable: null }), STRICT_PAYMENT_POLICY)).toBeNull();
	});

	/*
	 * Under `'forgeAuto'` these settle, and that is the PRE-TAP case rather than a
	 * hole. Forge's Auto is live here (`confirmLive`, checked before any of this),
	 * which is Forge saying it found a payment; naming no clickable source while
	 * saying so is what a cost already covered by floating mana looks like. Mana
	 * tapped before a cast is in Forge's pool when the payment input opens, Forge
	 * applies the pool first, and Auto covers only the remainder. An unpayable cost
	 * is the opposite shape — Auto DEAD — and `decideCancel` owns it.
	 */
	it('settles a window with no source offered under the default — Forge’s Auto live is Forge’s answer', () => {
		expect(decidePay(readPromptFacts({ ...PAYING, actionable: [] }), DEFAULT_STOP_POLICY)).not.toBeNull();
		expect(decidePay(readPromptFacts({ ...PAYING, actionable: null }), DEFAULT_STOP_POLICY)).not.toBeNull();
	});

	it('never presses a bar that is not the payment input’s own Auto', () => {
		expect(decidePay(readPromptFacts({ ...PAYING, buttons: autoBar(false) }), DEFAULT_STOP_POLICY)).toBeNull();
		// A priority window's button 1 is "OK" — pressing it there is the
		// auto-pass's business, under its own rules.
		expect(decidePay(readPromptFacts({ ...PAYING, buttons: buttons(true) }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('never presses a prompt that is not a payment', () => {
		expect(decidePay(readPromptFacts({ ...PAYING, prompt: prompt(PRIORITY_MESSAGE) }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('leaves life alone: paying life instead of mana is a second payment', () => {
		const phyrexian = prompt('Pay Mana Cost: {U/P}\nClick on your life total to pay life for phyrexian mana.');
		expect(decidePay(readPromptFacts({ ...PAYING, prompt: phyrexian }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('leaves life alone in Forge’s real, parenthesised wording too', () => {
		const phyrexian = prompt('Pay Mana Cost: {U/P}\n(Click on your life total to pay life for phyrexian mana.)');
		expect(decidePay(readPromptFacts({ ...PAYING, prompt: phyrexian }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('never presses while a question is open, before the seat is named, or for the other seat', () => {
		expect(decidePay(readPromptFacts({ ...PAYING, openAsks: 1 }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decidePay(readPromptFacts({ ...PAYING, playerId: null }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decidePay(readPromptFacts({ ...PAYING, buttons: autoBar(true, 0) }), DEFAULT_STOP_POLICY)).toBeNull();
	});
});

/* ── What a cast paid ────────────────────────────────────────────────── */

describe('the payment prompt', () => {
	it('reads Forge’s own payment prompt, and nothing else', () => {
		expect(paymentCost('Preordain (70) - B scribes 2. B draws a card.\n\nPay Mana Cost: {U}')).toBe('{U}');
		expect(paymentCost(PRIORITY_MESSAGE)).toBeNull();
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

/**
 * @param stopPolicy what a NEW match's seats start on (`MatchDeps.stopPolicy`,
 *   wave 27 §C). Omitted is production: `DEFAULT_STOP_POLICY`.
 */
function harness(stopPolicy?: StopPolicy, spellCopiers?: (name: string) => readonly SpellCopy[] | undefined): Harness {
	const { factory, hosts } = replayFactory();
	const sent: Harness['sent'] = [];
	const logs: Record<string, unknown>[] = [];
	const registry = createMatchRegistry({
		host: factory,
		log: (e) => logs.push(e),
		overGraceMs: 60_000,
		...(stopPolicy === undefined ? {} : { stopPolicy }),
		...(spellCopiers === undefined ? {} : { spellCopiers }),
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

/** The card {@link castOwn} casts, which its payment prompt names. */
const OWN_CARD = 67;

/**
 * The seat's own cast: Forge offers card {@link OWN_CARD}'s abilities and the
 * seat's browser answers. A payment that names the card after this is the
 * seat's own.
 */
function castOwn(h: Harness, seat: number): void {
	const before = frames(h, seat).length;
	push(h, seat, {
		kind: 'ask',
		callId: `cast-${seat}`,
		method: 'getAbilityToPlay',
		hostCard: { kind: 'card', id: OWN_CARD },
		abilities: [
			{ kind: 'spellAbility', id: 9001 },
			{ kind: 'spellAbility', id: 9002 },
		],
		triggerEvent: null,
	});
	const ask = frames(h, seat)
		.slice(before)
		.find((f) => f.kind === 'ask' && f.method === 'getAbilityToPlay');
	if (ask === undefined || ask.kind !== 'ask') throw new Error('the ability ask never reached the seat');
	const reply = ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9001 } });
	expect(h.match.fromClient(seat, reply)).toEqual({ ok: true });
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

/** Give a seat one creature on its own battlefield, through the same state channel Forge uses. */
function putCreature(h: Harness, seat: number, cardId: number, core: string[] = ['Creature']): void {
	const me = playerOf(h, seat);
	const faceKey = String(((4 << 28) | ((cardId * 16) & 0x0fffffff)) >>> 0);
	push(h, seat, {
		kind: 'notify',
		method: 'applyDelta',
		payload: {
			packet: {
				seq: 900 + cardId,
				checksum: 0,
				checksumProperties: [],
				newObjects: {
					[String(((0 << 28) | cardId) >>> 0)]: {
						_type: 0,
						_id: cardId,
						Zone: { t: 'enum', c: 'forge.game.zone.ZoneType', v: 'Battlefield' },
						CurrentState: { t: 'int', v: 0 },
						Sickness: { t: 'bool', v: true },
					},
					[faceKey]: { _type: 4, _id: cardId * 16, Type: { t: 'cardtype', sup: [], core, sub: [], all: false, exc: [] } },
				},
				objectDeltas: {
					[String(((1 << 28) | me) >>> 0)]: { _type: 1, _id: me, Battlefield: { t: 'list', v: [{ t: 'int', v: cardId }] } },
				},
				events: [],
			},
		},
	});
}

/*
 * Wave 32, Q12 — **the operator's bug: "i was not able to assign blockers at all."**
 *
 * `InputBlock` says its BUTTONS first and its prompt after, so a pass decided on the
 * buttons alone read the PREVIOUS window's prompt and pressed OK on the block input.
 * Reproduced against a real Forge in `blockers.jvm.test.ts`; this is the same two
 * frames through `match.ts`.
 */
describe('Q12: the block input is never passed on the prompt of the window before it', () => {
	const BEFORE = 'Priority: A\nTurn: 4 (B)\nPhase: Declare Attackers Step\nStack: Empty';
	const BLOCK = 'Select creatures to block Memnite (40) or select another attacker to declare blockers for.';

	it('passes the Declare Attackers window, and then leaves the block input that follows alone', () => {
		const h = harness();
		const me = playerOf(h, 0);
		// The window before: prompt, then buttons — passed, as the default always did.
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(BEFORE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);

		// `InputBlock`: Forge offers the defender's creature, says its BUTTONS, then its prompt.
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 105 }] });
		push(h, 0, buttons(true, me));
		push(h, 0, prompt(BLOCK, me));
		// Still one press: the block input was not passed.
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);
		expect(h.logs.filter((l) => l.evt === 'auto-passed')).toHaveLength(1);
		// And a later window that IS prompt-then-buttons still passes: nothing was latched off.
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(BEFORE.replace('Declare Attackers', 'End of Combat'), me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(2);
	});
});

/*
 * Wave 32, Q10 — *"no creatures, no block."*
 */
describe('Q10: the Declare Blockers stop is skipped when the seat controls no creature', () => {
	it('decideStop: zero creatures skips it; one PASSES when nothing is left to do (wave 46 §C) and stops when something is castable; unknown keeps it — a summoning-sick creature counts', () => {
		const at = (creatures: number | null) => facts({ creatures });
		expect(decideStop(at(0), DEFAULT_STOP_POLICY)).toBe('Declare Blockers Step');
		// wave 46 §C: this window is the ordinary priority round AFTER the block is
		// declared (the declaration itself is never a `priority` window at all —
		// see {@link blockStopIsDone}), so with nothing left to do it now passes,
		// same as every other `passWhenNothingToDo` window.
		expect(decideStop(at(1), DEFAULT_STOP_POLICY)).toBe('Declare Blockers Step');
		expect(decideStop({ ...at(1), sources: [61, 62], nonManaSources: [61] }, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(at(null), DEFAULT_STOP_POLICY)).toBeNull();
		// Only THIS stop: a main phase is not a block stop and is held whatever the count.
		expect(decideStop(facts({ phase: 'MAIN1', phaseLabel: 'Main phase, precombat', myTurn: true, creatures: 0 }), DEFAULT_STOP_POLICY)).toBeNull();
		// A policy that does not skip it, and full control, keep it.
		expect(decideStop(at(0), { ...DEFAULT_STOP_POLICY, skipEmptyBlockStop: false })).toBeNull();
		expect(decideStop(at(0), FULL_CONTROL_POLICY)).toBeNull();
		// No block to make, but a real play: held for the play (`stopWithPlayOnTheirTurn`), not for a block.
		expect(judgeStop(facts({ creatures: 0, sources: [67, 68] }), DEFAULT_STOP_POLICY)).toEqual({ pass: null, rule: 'play-stop', plays: [67, 68] });
	});

	it('through the match: a seat with no creature passes its Declare Blockers step; one with a creature is stopped', () => {
		const h = harness();
		const me = playerOf(h, 0);
		// The recorded opening has nothing on either battlefield; card 67 is offered for its mana alone.
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }], manaOnly: [{ kind: 'card', id: 67 }], phaseRestricted: [], attackers: 1 });
		push(h, 0, prompt(THEIR_STOP_MESSAGE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
		expect(h.logs.filter((l) => l.evt === 'auto-passed')).toEqual([
			{ evt: 'auto-passed', matchId: h.match.id, seat: 0, phase: 'Declare Blockers Step', rule: 'nothing-to-do' },
		]);

		// Now the seat controls a creature — still summoning sick, which does not stop it blocking.
		putCreature(h, 0, 900);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, prompt(THEIR_STOP_MESSAGE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);
	});

	it('a seat in full control is stopped with no creature, as it is stopped everywhere', () => {
		const h = harness();
		h.match.setFullControl(0, true);
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(THEIR_STOP_MESSAGE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});
});

/** Put one item on the stack, activated by `activator`, through the same state channel Forge uses. */
/*
 * T3 (2026-10-03) — *"theres an extra ok after declare attackers which doesn't make
 * sense."* The attack input is the stop; the priority window Forge opens for the
 * same seat right after it, in the same step, passes when nothing is left to do.
 */
describe('T3: the Declare Attackers stop is the declaration — the priority window after it passes when nothing is left to do', () => {
	const MY_ATTACK_MESSAGE = 'Priority: A\nTurn: 4 (A)\nPhase: Declare Attackers Step\nStack: Empty';
	const after = (over: Partial<ReturnType<typeof readPromptFacts>> = {}) =>
		facts({ phase: 'COMBAT_DECLARE_ATTACKERS', phaseLabel: 'Declare Attackers Step', myTurn: true, ...over });

	it('decideStop: nothing actionable passes; a castable spell stops; an unknown set stops; full control stops; Main 1 is untouched', () => {
		expect(decideStop(after(), DEFAULT_STOP_POLICY)).toBe('Declare Attackers Step');
		expect(decideStop(after({ sources: [67] }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(after({ sources: null, nonManaSources: null }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(after(), FULL_CONTROL_POLICY)).toBeNull();
		expect(decideStop(after(), { ...DEFAULT_STOP_POLICY, attackStopIsTheDeclaration: false })).toBeNull();
		// The OPPONENT's attack step is not a stop of ours at all and stays as it was.
		expect(decideStop(after({ myTurn: false }), DEFAULT_STOP_POLICY)).toBe('Declare Attackers Step');
		// Main 1 with nothing to do is still a stop: this rule is the attack step's alone.
		expect(decideStop(facts({ phase: 'MAIN1', phaseLabel: 'Main phase, precombat', myTurn: true }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('through the match: the attack input is never pressed for; the empty priority window after it is passed', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt('Select creatures to attack B or select player/card you wish to attack.', me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act'), 'the declaration itself is the player’s').toEqual([]);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(MY_ATTACK_MESSAGE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
		expect(h.logs.filter((l) => l.evt === 'auto-passed')).toEqual([
			{ evt: 'auto-passed', matchId: h.match.id, seat: 0, phase: 'Declare Attackers Step', rule: 'nothing-to-do' },
		]);
	});

	it('through the match: a castable spell after the declaration keeps the stop, and the log names the rule and the play', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, prompt(MY_ATTACK_MESSAGE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(h.logs.filter((l) => l.evt === 'prompt-forwarded')).toEqual([
			{ evt: 'prompt-forwarded', matchId: h.match.id, seat: 0, kind: 'priority', why: 'kept', rule: 'has-play', plays: [{ id: 67, name: null }] },
		]);
	});

	/*
	 * The operator, 2026-10-12: *"theres ALWAYS a second 'next phase' click
	 * required."* Forge offers a land for its mana tap; a Celestial Colonnade
	 * whose animation the seat cannot pay for is offered for nothing else, and the
	 * bridge's `manaOnly` says so. No play there, so the window passes.
	 */
	it('through the match: cards offered for nothing but their mana pass the window after the declaration', () => {
		const h = harness();
		const me = playerOf(h, 0);
		const lands = [{ kind: 'card' as const, id: 70 }, { kind: 'card' as const, id: 71 }];
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: lands, manaOnly: lands });
		push(h, 0, prompt(MY_ATTACK_MESSAGE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } }]);
	});

	it('judgeStop names the rule: the attacker’s window and the defender’s window after blocks are one rule', () => {
		const afterBlock = (over: Partial<ReturnType<typeof readPromptFacts>> = {}) =>
			facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', myTurn: false, creatures: 1, ...over });
		for (const window of [after, afterBlock]) {
			expect(judgeStop(window({ sources: [70], nonManaSources: [] }), DEFAULT_STOP_POLICY).rule).toBe('nothing-to-do');
			// The defender's Declare Blockers is a play-stop phase too, so its kept window says so.
			expect(judgeStop(window({ sources: [70, 67], nonManaSources: [67] }), DEFAULT_STOP_POLICY)).toEqual({
				pass: null,
				rule: window === after ? 'has-play' : 'play-stop',
				plays: [67],
			});
			expect(judgeStop(window({ sources: null, nonManaSources: null }), DEFAULT_STOP_POLICY)).toEqual({ pass: null, rule: 'no-answer' });
			expect(judgeStop(window(), FULL_CONTROL_POLICY)).toEqual({ pass: null, rule: 'stop-phase' });
		}
		expect(judgeStop(facts({ phase: 'MAIN1', phaseLabel: 'Main phase, precombat', myTurn: true }), DEFAULT_STOP_POLICY).rule).toBe('stop-phase');
		// The opponent's Declare Attackers is judged by the play test once something attacks, and skipped when nothing does.
		expect(judgeStop(after({ myTurn: false }), DEFAULT_STOP_POLICY).rule).toBe('nothing-to-do');
		expect(judgeStop(after({ myTurn: false, attackers: 0, sources: [67] }), DEFAULT_STOP_POLICY).rule).toBe('skip-phase');
		expect(judgeStop(after({ window: 'other' }), DEFAULT_STOP_POLICY).rule).toBe('not-priority');
		expect(judgeStop(after({ openAsks: 1 }), DEFAULT_STOP_POLICY).rule).toBe('open-ask');
		expect(judgeStop(after({ confirmLive: false }), DEFAULT_STOP_POLICY).rule).toBe('dead-bar');
	});
});

function putOnStack(h: Harness, seat: number, itemId: number, activator: number): void {
	const gameKey = String(((3 << 28) | 1) >>> 0);
	push(h, seat, {
		kind: 'notify',
		method: 'applyDelta',
		payload: {
			packet: {
				seq: 1900 + itemId,
				checksum: 0,
				checksumProperties: [],
				newObjects: {
					[String(((2 << 28) | itemId) >>> 0)]: {
						_type: 2,
						_id: itemId,
						Description: { t: 'str', v: 'a spell' },
						ActivatingPlayer: { t: 'int', v: activator },
					},
				},
				objectDeltas: { [gameKey]: { _type: 3, _id: 1, Stack: { t: 'list', v: [{ t: 'int', v: itemId }] } } },
				events: [],
			},
		},
	});
}

/*
 * Wave 32, Q17 — *"holding priority on my own spells is weird, why is that still
 * happening?"* Forge hands the caster priority back; the stack window was passed only
 * when Forge named nothing castable, so a caster with a second instant in hand sat at
 * its own spell until it clicked OK. Reproduced against a real Forge in
 * `priority.jvm.test.ts`.
 */
describe('Q17: a seat does not hold priority on its own spell', () => {
	const OWN = 'Priority: A\nTurn: 4 (A)\nPhase: Main phase, precombat\nStack: 1 to Resolve.';
	const castable = { sources: [67, 68] };

	it('decideStop: its own spell on top passes whatever else is castable; somebody else’s does not', () => {
		const stack = { stackEmpty: false, phase: 'MAIN1' as const, phaseLabel: 'Main phase, precombat', myTurn: true, ...castable };
		expect(decideStop(facts({ ...stack, stackTopMine: true }), DEFAULT_STOP_POLICY)).toBe('Main phase, precombat');
		// The opponent's spell, with a response in hand: that is what a held instant is FOR.
		expect(decideStop(facts({ ...stack, stackTopMine: false }), DEFAULT_STOP_POLICY)).toBeNull();
		// Full control, and a policy that holds, keep the stop.
		expect(decideStop(facts({ ...stack, stackTopMine: true }), FULL_CONTROL_POLICY)).toBeNull();
		expect(decideStop(facts({ ...stack, stackTopMine: true }), { ...DEFAULT_STOP_POLICY, passOwnSpell: false })).toBeNull();
		// A policy that does not pass stack windows at all does not pass this one either.
		expect(decideStop(facts({ ...stack, stackTopMine: true }), { ...DEFAULT_STOP_POLICY, passStackWindows: false })).toBeNull();
		// Not a window of its own: an empty stack in a stop phase is still held.
		expect(decideStop(facts({ ...stack, stackEmpty: true, stackTopMine: true }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('through the match: the caster’s priority is passed on with a second response in hand; the opponent’s spell is not passed', () => {
		const mine = harness();
		const me = playerOf(mine, 0);
		putOnStack(mine, 0, 5, me);
		push(mine, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(mine, 0, prompt(OWN, me));
		push(mine, 0, buttons(true, me));
		expect(mine.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);

		const theirs = harness();
		const me2 = playerOf(theirs, 0);
		putOnStack(theirs, 0, 5, playerOf(theirs, 1));
		push(theirs, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(theirs, 0, prompt(OWN, me2));
		push(theirs, 0, buttons(true, me2));
		expect(theirs.host.commands.filter((c) => c.t === 'act')).toEqual([]);

		// And full control holds its own spell too.
		const held = harness();
		held.match.setFullControl(0, true);
		putOnStack(held, 0, 5, playerOf(held, 0));
		push(held, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(held, 0, prompt(OWN, playerOf(held, 0)));
		push(held, 0, buttons(true, playerOf(held, 0)));
		expect(held.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});
});

/*
 * The operator, 2026-10-19: *"for instant cards that copy spells like lutri … can we default
 * to having the player hold priority after casting any spell that is a valid target for
 * those? (assuming the copy spell is playable)"* — `StopPolicy.holdForSpellCopy`.
 */
describe('copy-available: the seat’s own spell is held while it can play a copier the spell is a target for', () => {
	const SCRIPTS = {
		twincast: 'Name:Twincast\nManaCost:U U\nTypes:Instant\nA:SP$ CopySpellAbility | ValidTgts$ Instant,Sorcery | TargetType$ Spell | MayChooseTarget$ True | SpellDescription$ Copy target instant or sorcery spell.',
		lutri:
			'Name:Lutri, the Spellchaser\nTypes:Legendary Creature Elemental Otter\nK:Flash\nT:Mode$ ChangesZone | ValidCard$ Card.Self+wasCastByYou | Origin$ Any | Destination$ Battlefield | Execute$ TrigCopy | TriggerDescription$ copy\nSVar:TrigCopy:DB$ CopySpellAbility | ValidTgts$ Instant.YouCtrl,Sorcery.YouCtrl | MayChooseTarget$ True',
		dualcaster:
			'Name:Dualcaster Mage\nTypes:Creature Human Wizard\nK:Flash\nT:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self | Execute$ TrigCopy | TriggerDescription$ copy\nSVar:TrigCopy:DB$ CopySpellAbility | ValidTgts$ Instant,Sorcery | TargetType$ Spell | MayChooseTarget$ True',
	};
	const copiesOf = (script: string): readonly SpellCopy[] => parseCardScript(script)[0]!.copies;
	const OWN_BOLT = { stackEmpty: false, phase: 'MAIN1' as const, phaseLabel: 'Main phase, precombat', myTurn: true, stackTopMine: true, stackTopTypes: ['Instant'] };
	const COPIER = 67;
	const OTHER = 68;

	for (const [name, script] of Object.entries(SCRIPTS)) {
		it(`keeps the window with ${name} playable and an instant of the seat’s own on top`, () => {
			const judged = judgeStop(facts({ ...OWN_BOLT, sources: [COPIER, OTHER], spellCopiers: new Map([[COPIER, copiesOf(script)]]) }), DEFAULT_STOP_POLICY);
			expect(judged).toEqual({ pass: null, rule: 'copy-available', plays: [COPIER] });
		});
	}

	it('passes as own-spell when only a non-copy instant is playable', () => {
		expect(judgeStop(facts({ ...OWN_BOLT, sources: [OTHER] }), DEFAULT_STOP_POLICY).rule).toBe('own-spell');
	});

	it('passes as own-spell when the copier is held but Forge does not offer it', () => {
		const spellCopiers = new Map([[COPIER, copiesOf(SCRIPTS.twincast)]]);
		expect(judgeStop(facts({ ...OWN_BOLT, sources: [OTHER], spellCopiers }), DEFAULT_STOP_POLICY).rule).toBe('own-spell');
		expect(judgeStop(facts({ ...OWN_BOLT, sources: [COPIER], nonManaSources: [], spellCopiers }), DEFAULT_STOP_POLICY).rule).toBe('own-spell');
	});

	it('passes as own-spell when the spell on top is a creature, or an ability', () => {
		const spellCopiers = new Map([[COPIER, copiesOf(SCRIPTS.twincast)]]);
		expect(judgeStop(facts({ ...OWN_BOLT, stackTopTypes: ['Creature'], sources: [COPIER], spellCopiers }), DEFAULT_STOP_POLICY).rule).toBe('own-spell');
		expect(judgeStop(facts({ ...OWN_BOLT, stackTopTypes: null, sources: [COPIER], spellCopiers }), DEFAULT_STOP_POLICY).rule).toBe('own-spell');
	});

	it('passes as own-spell with the policy field off', () => {
		const spellCopiers = new Map([[COPIER, copiesOf(SCRIPTS.twincast)]]);
		expect(judgeStop(facts({ ...OWN_BOLT, sources: [COPIER], spellCopiers }), { ...DEFAULT_STOP_POLICY, holdForSpellCopy: false }).rule).toBe('own-spell');
	});

	it('the matcher: Lutri’s YouCtrl takes only the seat’s own spell; Twincast takes either', () => {
		const [lutri] = copiesOf(SCRIPTS.lutri);
		const [twincast] = copiesOf(SCRIPTS.twincast);
		expect(copyTargets(lutri!, { types: ['Instant'], mine: true })).toBe(true);
		expect(copyTargets(lutri!, { types: ['Instant'], mine: false })).toBe(false);
		expect(copyTargets(lutri!, { types: ['Sorcery'], mine: true })).toBe(true);
		expect(copyTargets(lutri!, { types: ['Creature'], mine: true })).toBe(false);
		expect(copyTargets(twincast!, { types: ['Instant'], mine: false })).toBe(true);
		expect(copyTargets(twincast!, { types: ['Artifact'], mine: true })).toBe(false);
	});

	it('the matcher keeps on a term it cannot read, and refuses an ability-only TargetType', () => {
		// Izzet Guildmage's mana-value bound is not a fact here: the type decides.
		expect(copyTargets({ validTgts: ['Instant.YouCtrl+cmcLE2'], targetType: ['Spell'] }, { types: ['Instant'], mine: true })).toBe(true);
		expect(copyTargets({ validTgts: ['Instant.YouCtrl+cmcLE2'], targetType: ['Spell'] }, { types: ['Sorcery'], mine: true })).toBe(false);
		expect(copyTargets({ validTgts: ['Card', 'Emblem'], targetType: ['Activated.YouCtrl', 'Triggered.YouCtrl'] }, { types: ['Instant'], mine: true })).toBe(false);
		expect(copyTargets({ validTgts: ['Permanent.YouCtrl'], targetType: ['Spell'] }, { types: ['Creature'], mine: true })).toBe(true);
		expect(copyTargets({ validTgts: ['Permanent.YouCtrl'], targetType: ['Spell'] }, { types: ['Instant'], mine: true })).toBe(false);
	});

	it('through the match: Twincast in hand holds the caster at its own Lightning Bolt; a creature on top does not', () => {
		const index = new Map(Object.values(SCRIPTS).flatMap((s) => parseCardScript(s).map((f) => [f.name, f.copies] as const)));
		const run = (topTypes: string[]): Harness => {
			const h = harness(undefined, (name) => index.get(name));
			const me = playerOf(h, 0);
			putCard(h, 0, COPIER, 'Hand', 'Twincast', ['Instant']);
			putCard(h, 0, 70, 'Stack', 'Lightning Bolt', topTypes);
			putSpellOnStack(h, 0, 5, me, 70);
			push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: COPIER }] });
			push(h, 0, prompt('Priority: A\nTurn: 4 (A)\nPhase: Main phase, precombat\nStack: 1 to Resolve.', me));
			push(h, 0, buttons(true, me));
			return h;
		};
		const held = run(['Instant']);
		expect(held.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(held.match.seats[0]!.lastStop).toEqual({ rule: 'copy-available', plays: [COPIER] });
		const passed = run(['Creature']);
		expect(passed.host.commands.filter((c) => c.t === 'act')).toEqual([{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } }]);
		expect(passed.logs.find((l) => l.evt === 'auto-passed')?.rule).toBe('own-spell');
	});
});

/** A card with a name and core types in one of a seat's zone lists, through Forge's state channel. */
function putCard(h: Harness, seat: number, cardId: number, zone: string, name: string, core: string[]): void {
	const me = playerOf(h, seat);
	const faceKey = String(((4 << 28) | ((cardId * 16) & 0x0fffffff)) >>> 0);
	push(h, seat, {
		kind: 'notify',
		method: 'applyDelta',
		payload: {
			packet: {
				seq: 2900 + cardId,
				checksum: 0,
				checksumProperties: [],
				newObjects: {
					[String(((0 << 28) | cardId) >>> 0)]: { _type: 0, _id: cardId, Zone: { t: 'enum', c: 'forge.game.zone.ZoneType', v: zone }, CurrentState: { t: 'int', v: 0 } },
					[faceKey]: { _type: 4, _id: cardId * 16, Name: { t: 'str', v: name }, Type: { t: 'cardtype', sup: [], core, sub: [], all: false, exc: [] } },
				},
				objectDeltas: zone === 'Stack' ? {} : { [String(((1 << 28) | me) >>> 0)]: { _type: 1, _id: me, [zone]: { t: 'list', v: [{ t: 'int', v: cardId }] } } },
				events: [],
			},
		},
	});
}

/** A SPELL on top of the stack: {@link putOnStack} with the card it was cast from. */
function putSpellOnStack(h: Harness, seat: number, itemId: number, activator: number, sourceCard: number): void {
	const gameKey = String(((3 << 28) | 1) >>> 0);
	push(h, seat, {
		kind: 'notify',
		method: 'applyDelta',
		payload: {
			packet: {
				seq: 3900 + itemId,
				checksum: 0,
				checksumProperties: [],
				newObjects: {
					[String(((2 << 28) | itemId) >>> 0)]: {
						_type: 2,
						_id: itemId,
						ActivatingPlayer: { t: 'int', v: activator },
						SourceCard: { t: 'int', v: sourceCard },
						Ability: { t: 'bool', v: false },
					},
				},
				objectDeltas: { [gameKey]: { _type: 3, _id: 1, Stack: { t: 'list', v: [{ t: 'int', v: itemId }] } } },
				events: [],
			},
		},
	});
}

describe('a Match with the shortcuts on (the default)', () => {
	it('gives the one-ability ask its own click opened to the player, and answers a bounds question for them', () => {
		const h = harness();
		// Payment open or not, the ability ask the seat's click opened is the player’s (see `auto.ts`).
		push(h, 0, prompt('Preordain.\n\nPay Mana Cost: {U}', playerOf(h, 0)));
		h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: 67 }, otherCardViewsToSelect: [], triggerEvent: null }));
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
			{ evt: 'auto-passed', matchId: h.match.id, seat: 0, phase: 'End of Combat Step', rule: 'skip-phase' },
		]);
		expect(h.match.seats[0]?.autoPassed).toBe(1);
	});

	it('does NOT pass a stop PHASE, whatever Forge named the seat could do there', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, prompt(MY_STOP_MESSAGE, me));
		push(h, 0, buttons(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(says(h, 0)).toEqual([]);
	});

	/*
	 * Item 5, wave 28, end to end through `match.ts`: **the operator's own bug.**
	 * Their upkeep, Tragic Slip in hand, Forge naming it actionable — which is
	 * what made the old default stop here, and what made the stop say the hand
	 * held an instant. The upkeep is not a stop phase, so it is passed on the
	 * PHASE, and the pass is identical with an empty hand.
	 */
	it('item 5 — passes the upkeep the operator was stopped on, and passes it identically with nothing in hand', () => {
		for (const actionable of [[{ kind: 'card' as const, id: 67 }], []]) {
			const h = harness();
			const me = playerOf(h, 0);
			push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: actionable });
			push(h, 0, prompt('Priority: A\nTurn: 4 (A)\nPhase: Upkeep step\nStack: Empty', me));
			push(h, 0, buttons(true, me));
			expect(h.host.commands.filter((c) => c.t === 'act'), JSON.stringify(actionable)).toEqual([
				{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
			]);
			expect(h.logs.filter((l) => l.evt === 'auto-passed')).toEqual([
				{ evt: 'auto-passed', matchId: h.match.id, seat: 0, phase: 'Upkeep step', rule: 'skip-phase' },
			]);
		}
	});

	it('does NOT pass on a cleared set where the policy still reads one — Forge has not answered, so neither do we', () => {
		const h = harness(EVERY_PRIORITY_POLICY);
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
		castOwn(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Preordain - A scribes 2.\n\nPay Mana Cost: {U}', me, OWN_CARD));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
		// Forge re-shows the payment prompt after every tap; a second press would
		// answer whatever it asks next.
		push(h, 0, prompt('Preordain - A scribes 2.\n\nPay Mana Cost: {U}', me, OWN_CARD));
		push(h, 0, autoBar(true, me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);
		expect(h.logs.filter((l) => l.evt === 'auto-paid')).toHaveLength(1);
	});

	it('presses Auto when Forge offered two sources to tap — the default is Forge’s plan now', () => {
		const h = harness();
		const me = playerOf(h, 0);
		castOwn(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {1}{U}', me, OWN_CARD));
		// One act, and it is the Auto press. Which land Forge taps is Forge's;
		// `decidePay`'s own tests keep the strict semantics under STRICT_PAYMENT_POLICY.
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);
	});

	/*
	 * The operator, 2026-10-11: *"i just had an izzet charm played against me and
	 * it auto-payed for it. i never said it should auto pay for it, that decision
	 * should have been surfaced to me."* A payment the seat did not open by
	 * choosing an ability is its decision: pay, or decline with Forge's Cancel.
	 */
	it('shows an unless-cost another player’s spell puts on the seat’s, with its pay and Cancel — never pays it', () => {
		const IZZET_CHARM = 99;
		const h = harness();
		const me = playerOf(h, 0);
		castOwn(h, 0);
		// The cast is over: the seat held priority since.
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		const passed = h.host.commands.filter((c) => c.t === 'act').length;
		const before = frames(h, 0).length;
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Izzet Charm - Counter target noncreature spell unless its controller pays {2}.\n\nPay Mana Cost: {2}', me, IZZET_CHARM));
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(passed);
		expect(h.logs.filter((l) => l.evt === 'auto-paid')).toEqual([]);
		const shown = frames(h, 0).slice(before);
		expect(shown.filter((f) => f.method === 'showPromptMessage')).toHaveLength(1);
		expect(shown.filter((f) => f.method === 'updateButtons').at(-1)).toMatchObject({ label1: 'Auto', enable1: true, label2: 'Cancel', enable2: true });

		// A land the seat taps by hand inside it is the seat paying, not a cast of its own:
		// what is left is still the seat's to pay or decline.
		const land = 68;
		h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: land }, otherCardViewsToSelect: [], triggerEvent: null }));
		const offered = frames(h, 0).length;
		push(h, 0, { kind: 'ask', callId: 'land-1', method: 'getAbilityToPlay', hostCard: { kind: 'card', id: land }, abilities: [{ kind: 'spellAbility', id: 7001 }], triggerEvent: null });
		const ask = frames(h, 0)
			.slice(offered)
			.find((f) => f.kind === 'ask');
		if (ask === undefined || ask.kind !== 'ask') throw new Error('the land’s mana ability was not offered to the seat');
		h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 7001 } }));
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Izzet Charm - Counter target noncreature spell unless its controller pays {2}.\n\nPay Mana Cost: {1}', me, IZZET_CHARM));
		expect(h.logs.filter((l) => l.evt === 'auto-paid')).toEqual([]);
	});

	it('shows the payment for an ability the server played for the seat (a trigger’s “you may pay”) — the seat never chose it', () => {
		const h = harness();
		const me = playerOf(h, 0);
		// One ability, no click of the seat's opened it: answered by the server.
		push(h, 0, oneAbilityAsk('trig-1'));
		expect(h.logs.filter((l) => l.evt === 'ask-auto-answered')).toHaveLength(1);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 68 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {1}', me, 67));
		expect(h.logs.filter((l) => l.evt === 'auto-paid')).toEqual([]);
		expect(h.logs.filter((l) => l.evt === 'prompt-forwarded' && l.kind === 'payment')).toHaveLength(1);
	});

	/*
	 * The log is Forge's own game log: the bridge words each entry once per player
	 * (`PlayBridge.GameLogForward`, which settles what each may see) and the match
	 * hands each seat the copy for its own player, nothing else.
	 */
	it("hands each seat Forge's log line in its own player's words, with the cards it may see", () => {
		const h = harness();
		const [p0, p1] = [playerOf(h, 0), playerOf(h, 1)];
		for (const seat of [0, 1]) putCreature(h, seat, 4070);
		putCreature(h, 0, 4071);
		h.host.push({
			t: 'log',
			type: 'STACK_ADD',
			players: [
				{ player: p0, text: 'Seat 1 cast Opt', cards: [{ id: 4070, name: 'Opt' }] },
				{ player: p1, text: 'Seat 1 cast Opt', cards: [{ id: 4070, name: 'Opt' }] },
			],
		} as never);
		h.host.push({
			t: 'log',
			type: 'DISCARD',
			players: [
				{ player: p0, text: 'Seat 1 discards Island.', cards: [{ id: 4071, name: 'Island' }] },
				{ player: p1, text: null, cards: [] },
			],
		} as never);
		expect(says(h, 0)).toEqual(['Seat 1 cast Opt', 'Seat 1 discards Island.']);
		expect(says(h, 1), 'a line the bridge could not word for this player is not sent').toEqual(['Seat 1 cast Opt']);
		const sent = frames(h, 0).filter((f) => f.method === 'message');
		expect(sent.map((f) => (f as { log?: unknown }).log)).toEqual([
			{ type: 'STACK_ADD', cards: [{ id: 4070, name: 'Opt' }] },
			{ type: 'DISCARD', cards: [{ id: 4071, name: 'Island' }] },
		]);
	});

	it("holds a line until this seat's board shows the card it names: the cast is never named before the delta that puts it on the stack", () => {
		const h = harness();
		const [p0, p1] = [playerOf(h, 0), playerOf(h, 1)];
		// Forge writes the cast's entry as the spell joins the stack; the delta that shows it comes after.
		h.host.push({ t: 'log', type: 'STACK_ADD', players: [p0, p1].map((player) => ({ player, text: 'Seat 1 cast Lightning Bolt', cards: [{ id: 4072, name: 'Lightning Bolt' }] })) } as never);
		h.host.push({ t: 'log', type: 'TURN', players: [p0, p1].map((player) => ({ player, text: 'Turn 2 (Seat 2)', cards: [] })) } as never);
		expect(says(h, 1), 'nothing after a held line overtakes it').toEqual([]);
		const before = frames(h, 1).length;
		putCreature(h, 1, 4072);
		const after = frames(h, 1).slice(before);
		expect(after.map((f) => f.method)).toEqual(['applyDelta', 'message', 'message']);
		expect(says(h, 1)).toEqual(['Seat 1 cast Lightning Bolt', 'Turn 2 (Seat 2)']);
		expect(says(h, 0), "the other seat's copy waits on its own board").toEqual([]);
	});

	it('sends a held line anyway once it has waited long enough: the wait is about order, the bridge already settled who may read it', () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const p1 = playerOf(h, 1);
			h.host.push({ t: 'log', type: 'REVEAL', players: [{ player: p1, text: 'Seat 1 reveals Opt', cards: [{ id: 4073, name: 'Opt' }] }] } as never);
			expect(says(h, 1)).toEqual([]);
			vi.advanceTimersByTime(1000);
			expect(says(h, 1)).toEqual(['Seat 1 reveals Opt']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps its lines across a refresh: a snapshot re-sends them', () => {
		const h = harness();
		const [p0, p1] = [playerOf(h, 0), playerOf(h, 1)];
		h.host.push({ t: 'log', type: 'TURN', players: [p0, p1].map((player) => ({ player, text: 'Turn 2 (Seat 2)', cards: [] })) } as never);
		expect(says(h, 0)).toEqual(['Turn 2 (Seat 2)']);
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

	it('keeps the bounds shortcut: an ask with one legal reply is no question in any mode', () => {
		const h = harness();
		h.match.setFullControl(0, true);
		push(h, 0, allMustBeChosen('a-4'));
		expect(frames(h, 0).filter((f) => f.kind === 'ask' && f.callId === 'a-4')).toEqual([]);
		expect(h.host.commands.filter((c) => c.t === 'reply')).toEqual([{ t: 'reply', seat: 0, callId: 'a-4', result: ['k1', 'k2', 'k3', 'k4', 'k5'] }]);
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

/*
 * ── A seat owns its stop policy (wave 26 §E) ──────────────────────────
 *
 * Every decision `match.ts` makes for a seat is asked of THAT seat's
 * `StopPolicy` rather than of `auto.ts`'s module default. That is what lets
 * `board-play.jvm.test.ts` run its seats strict — so a payment with two
 * untapped Mountains is still the player's to click — while the default stays
 * `'forgeAuto'` for everyone else (item 6).
 *
 * The distinction these cases have to hold is between the POLICY VALUE reaching
 * a decision and the default reaching it: the strict seat and the default seat
 * are handed the SAME frames in the same test, and only one of them is paid for.
 */
describe('a seat owns its stop policy', () => {
	it('starts every seat on the default, and says so', () => {
		const h = harness();
		expect(h.match.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
		expect(h.match.stopPolicy(1).unambiguousPayment).toBe('forgeAuto');
		expect(h.match.setStopPolicy(9, STRICT_PAYMENT_POLICY)).toEqual({ ok: false, error: 'no-such-seat' });
		expect(h.logs.filter((l) => l.evt === 'stop-policy')).toEqual([]);
	});

	it('leaves a strict seat’s two-source payment alone, and presses the default seat’s', () => {
		const h = harness();
		expect(h.match.setStopPolicy(0, STRICT_PAYMENT_POLICY)).toEqual({ ok: true });
		expect(h.match.stopPolicy(0).unambiguousPayment).toBe('auto');
		expect(h.logs.filter((l) => l.evt === 'stop-policy')).toEqual([
			{
				evt: 'stop-policy',
				matchId: h.match.id,
				seat: 0,
				unambiguousPayment: 'auto',
				unpayableCost: 'cancel',
				// Wave 28: STRICT_PAYMENT_POLICY spreads the default, and the default
				// skips every phase outside the stop sets now.
				skipNonStopPhases: 'always',
			},
		]);

		// The same window, twice: two sources offered, Forge's Auto live, one cost.
		// Which of the two to tap is a choice the wire cannot prove away.
		for (const seat of [0, 1]) {
			const me = playerOf(h, seat);
			castOwn(h, seat);
			push(h, seat, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
			push(h, seat, autoBar(true, me));
			push(h, seat, prompt('Pay Mana Cost: {1}{U}', me, OWN_CARD));
		}
		// The strict seat was not paid for; the default seat was, once.
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 0)).toEqual([]);
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 1)).toEqual([
			{ t: 'act', seat: 1, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
		expect(h.logs.filter((l) => l.evt === 'auto-paid')).toEqual([
			{ evt: 'auto-paid', matchId: h.match.id, seat: 1, cost: '{1}{U}' },
		]);
	});

	it('still presses a strict seat’s ONE-source payment — the value, not a bypass', () => {
		const h = harness();
		h.match.setStopPolicy(0, STRICT_PAYMENT_POLICY);
		const me = playerOf(h, 0);
		castOwn(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {U}', me, OWN_CARD));
		// This is step 1 of `board-play.jvm.test.ts` against a real jar: one
		// Mountain, one way to pay, settled with no click.
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 0)).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
	});

	it('reaches the STOP decisions too, not only the payment', () => {
		const h = harness();
		// Full control as a POLICY VALUE, without the flag: the same escape, by
		// the long road, which is what proves the seat's policy is what is read.
		h.match.setStopPolicy(0, FULL_CONTROL_POLICY);
		expect(h.match.fullControl(0)).toBe(false);
		for (const seat of [0, 1]) {
			const me = playerOf(h, seat);
			push(h, seat, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
			push(h, seat, prompt(PRIORITY_MESSAGE.replace('Priority: B', `Priority: ${seat === 0 ? 'A' : 'B'}`), me));
			push(h, seat, buttons(true, me));
		}
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 0)).toEqual([]);
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 1)).toEqual([
			{ t: 'act', seat: 1, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
	});

	it('keeps the flag as the escape hatch it was: full control still short-circuits a default policy', () => {
		const h = harness();
		h.match.setFullControl(0, true);
		expect(h.match.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {U}', me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});
});

/*
 * ── And something can now SELECT one (wave 27 §C) ─────────────────────
 *
 * Wave 26 §E's policy was per-seat and unreachable: the values above are module
 * constants, so `setStopPolicy(0, STRICT_PAYMENT_POLICY)` is a line only a unit
 * test can write. `NAMED_STOP_POLICIES` puts a NAME on each, and
 * `MatchDeps.stopPolicy` is where a named one lands — which is what
 * `socket.ts`'s `CARDTABLE_PLAY_STOP_POLICY` fills in.
 *
 * Nothing about the mechanism moved. These cases hold two things apart: the name
 * resolving to the right VALUE, and that value being what a new match's seats
 * actually decide against.
 */
describe('a stop policy can be named from outside', () => {
	it('resolves each name to the value it names, and nothing else', () => {
		expect(namedStopPolicy('default')).toEqual(DEFAULT_STOP_POLICY);
		expect(namedStopPolicy('strictPayment')).toEqual(STRICT_PAYMENT_POLICY);
		// `arena` still answers, and it now names the default (S1, wave 64) — wave 28
		// adopted the value, and a hatch that stops answering to a name it once
		// answered to is worse than an alias. No separate `ARENA_STOP_POLICY` export
		// exists any more: the map's `'arena'` entry points at `DEFAULT_STOP_POLICY`
		// directly.
		expect(namedStopPolicy('arena')).toEqual(DEFAULT_STOP_POLICY);
		// The names it advertises are exactly the names it answers to — a refusal
		// that lists `known` must not list one that then resolves to null.
		expect([...STOP_POLICY_NAMES].sort()).toEqual(['arena', 'default', 'strictPayment']);
		for (const name of STOP_POLICY_NAMES) expect(namedStopPolicy(name)).not.toBeNull();
	});

	it('S3, wave 64: the env hatch no longer answers to `everyPriority` or `fullControl` — neither had a documented reason to be chosen from an environment rather than imported, and `fullControl` duplicates the wire flag', () => {
		expect(namedStopPolicy('everyPriority')).toBeNull();
		expect(namedStopPolicy('fullControl')).toBeNull();
		// The values themselves are untouched and still directly importable — only
		// the env NAME is gone.
		expect(EVERY_PRIORITY_POLICY.skipNonStopPhases).toBe('never');
		expect(FULL_CONTROL_POLICY.stopOnMyTurn).toEqual(PHASE_TYPES);
	});

	it('names nothing for a name it does not have, including a prototype one', () => {
		expect(namedStopPolicy('strict-payment')).toBeNull();
		expect(namedStopPolicy('STRICTPAYMENT')).toBeNull();
		expect(namedStopPolicy('')).toBeNull();
		expect(namedStopPolicy(undefined)).toBeNull();
		expect(namedStopPolicy(null)).toBeNull();
		// The registry is looked up by key, so `Object.prototype`'s own names must
		// not answer as policies.
		expect(namedStopPolicy('toString')).toBeNull();
		expect(namedStopPolicy('constructor')).toBeNull();
	});

	/*
	 * The behavioural half, and the one §B needs: the SAME two-source payment
	 * window that the default seat has Forge's Auto pressed for is left alone on
	 * every seat of a match started strict — with nobody having called
	 * `setStopPolicy`. That is the ask reaching a browser.
	 */
	it('starts every seat of a new match on the named policy, so the payment is still the player’s', () => {
		const h = harness(STRICT_PAYMENT_POLICY);
		expect(h.match.stopPolicy(0)).toEqual(STRICT_PAYMENT_POLICY);
		expect(h.match.stopPolicy(1)).toEqual(STRICT_PAYMENT_POLICY);
		// Nobody moved a seat, so nothing logged a move.
		expect(h.logs.filter((l) => l.evt === 'stop-policy')).toEqual([]);

		for (const seat of [0, 1]) {
			const me = playerOf(h, seat);
			castOwn(h, seat);
			push(h, seat, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
			push(h, seat, autoBar(true, me));
			push(h, seat, prompt('Pay Mana Cost: {1}{U}', me, OWN_CARD));
		}
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(h.logs.filter((l) => l.evt === 'auto-paid')).toEqual([]);
		// And the window did reach both seats, which is what a browser draws — the
		// assertion above would also pass if nothing had happened at all.
		for (const seat of [0, 1]) {
			const prompts = frames(h, seat).filter(
				(f) => f.method === 'showPromptMessage' && f.message === 'Pay Mana Cost: {1}{U}',
			);
			expect(prompts, `seat ${seat} must be SHOWN the payment`).toHaveLength(1);
		}
	});

	it('leaves production on DEFAULT_STOP_POLICY when nothing names one', () => {
		const h = harness();
		expect(h.match.stopPolicy(0)).toEqual(DEFAULT_STOP_POLICY);
		expect(h.match.stopPolicy(1)).toEqual(DEFAULT_STOP_POLICY);
		// The same window, and the default presses Forge's Auto on both seats —
		// which is the behaviour §B could not screenshot and must stay the default.
		for (const seat of [0, 1]) {
			const me = playerOf(h, seat);
			castOwn(h, seat);
			push(h, seat, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
			push(h, seat, autoBar(true, me));
			push(h, seat, prompt('Pay Mana Cost: {1}{U}', me, OWN_CARD));
		}
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([
			{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } },
			{ t: 'act', seat: 1, frame: { kind: 'act', method: 'selectButtonOk' } },
		]);
	});

	it('is a STARTING value, not a second mechanism: one seat still moves alone', () => {
		const h = harness(STRICT_PAYMENT_POLICY);
		expect(h.match.setStopPolicy(1, DEFAULT_STOP_POLICY)).toEqual({ ok: true });
		expect(h.match.stopPolicy(0)).toEqual(STRICT_PAYMENT_POLICY);
		expect(h.match.stopPolicy(1)).toEqual(DEFAULT_STOP_POLICY);
		// …and the escape hatch is still ahead of whatever was named.
		h.match.setFullControl(0, true);
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {U}', me));
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 0)).toEqual([]);
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

/* ── Wave 24 §E: the model, and the three things it must never shortcut ── */

/*
 * The policy is the model, and these are the assertions that keep it one.
 *
 * Everything above this line exercised `DEFAULT_STOP_POLICY` through
 * `decideStop` / `decidePay` over `readPromptFacts`, which is the behaviour waves 19-22 shipped
 * and which wave 24 preserved exactly — 76 tests of it, unchanged. What follows
 * is what the MODEL adds: that a different stop preference is a different VALUE,
 * that the decision layer reads no prose, that the policy is expressible as
 * Forge's own frames, and that three specific things are never shortcut whatever
 * the policy says.
 */

/**
 * A window, as facts, without going through a prompt at all.
 *
 * The default phase is `COMBAT_DECLARE_BLOCKERS` — a genuine stop phase under
 * `DEFAULT_STOP_POLICY` on the opponent's turn — so a bare `facts({...})` used
 * by the "NEVER shortcut" guards below is not itself confounded by wave 30 item
 * 2 taking `END_OF_TURN` out of `stopOnTheirTurn`. It was `END_OF_TURN` until
 * that change; the dedicated test for the end step's new behaviour names its
 * own facts explicitly.
 */
function facts(over: Partial<ReturnType<typeof readPromptFacts>> = {}): ReturnType<typeof readPromptFacts> {
	// `nonManaSources` defaults to whatever `sources` ends up being: none of
	// these fixtures' ids are meant to represent a mana source (that exclusion
	// is tested on its own, below), so the two fields agree unless a case
	// overrides `nonManaSources` itself.
	const sources = over.sources ?? [];
	return {
		window: 'priority',
		phase: 'COMBAT_DECLARE_BLOCKERS',
		phaseLabel: 'Declare Blockers Step',
		myTurn: false,
		stackEmpty: true,
		mine: true,
		confirmLive: true,
		cost: null,
		alternativePayment: false,
		noWayToPay: false,
		sources,
		nonManaSources: sources,
		phaseRestricted: [],
		plannedSources: [],
		openAsks: 0,
		creatures: null,
		stackTopMine: false,
		stackTopTypes: null,
		spellCopiers: new Map(),
		attackers: null,
		...over,
	};
}

/** Notes for a seat sitting in one window, for the adapter's own tests. */
function notesFor(message: string, bar: ServerFrame, actionable: readonly number[] | null = null, manaOnlyIds?: ReadonlySet<number>): SeatNotes {
	return { playerId: 1, prompt: prompt(message, 1), buttons: bar, actionable, openAsks: 0, manaOnlyIds };
}

describe('the adapter is the ONLY prose reader', () => {
	/*
	 * The guard §0b asks for, as behaviour: the decisions are functions of the
	 * facts alone. `phaseLabel` is the one piece of Forge's prose a fact carries
	 * (for display); scrambling it, in every window, phase, turn and stack state,
	 * must not change whether any decision acts, under any named policy.
	 */
	it('no decision reads the prose a fact was read from', () => {
		let checked = 0;
		for (const window of ['priority', 'payment', 'other'] as const)
			for (const phase of [...PHASE_TYPES, null])
				for (const myTurn of [true, false])
					for (const stackEmpty of [true, false]) {
						const read = facts({ window, phase, myTurn, stackEmpty, cost: window === 'payment' ? '{U}' : null, sources: [67] });
						const scrambled = { ...read, phaseLabel: 'Main phase, precombat — Auto' };
						for (const name of STOP_POLICY_NAMES) {
							const policy = namedStopPolicy(name)!;
							for (const decide of [decideStop, decidePay, decideCancel]) {
								// Whether it acts; the reason it returns may quote the label back for display.
								expect(decide(scrambled, policy) === null, `${decide.name} ${window} ${phase} ${name}`).toBe(decide(read, policy) === null);
								checked += 1;
							}
						}
					}
		expect(checked).toBeGreaterThan(500);
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

	it('#20 — the superseded default asks, and the current one passes it, with no code between them', () => {
		// Wave 24 §E wrote this as "the default asks, and ARENA passes it". Wave 28
		// adopted ARENA, so the two values swapped sides and the sentence still has
		// to be true of a VALUE rather than of a branch: nothing in `auto.ts`
		// changed between these two lines.
		expect(decideStop(busyOnTheirUpkeep, EVERY_PRIORITY_POLICY)).toBeNull();
		expect(decideStop(busyOnTheirUpkeep, DEFAULT_STOP_POLICY)).toBe('Upkeep step');
	});

	it('#20 — the phases the player DID ask for still stop, with something to do or not', () => {
		for (const sources of [[], [61]]) {
			const blockers = facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', myTurn: false, sources });
			expect(decideStop(blockers, DEFAULT_STOP_POLICY), JSON.stringify(sources)).toBeNull();
			const myMain = facts({ phase: 'MAIN1', phaseLabel: 'Main phase, precombat', myTurn: true, sources });
			expect(decideStop(myMain, DEFAULT_STOP_POLICY), JSON.stringify(sources)).toBeNull();
		}
	});

	it('the scope of a skip is a value too: theirTurn leaves the player’s own turn alone', () => {
		const theirTurnOnly: StopPolicy = { ...DEFAULT_STOP_POLICY, skipNonStopPhases: 'theirTurn' };
		expect(decideStop(busyOnTheirUpkeep, theirTurnOnly)).toBe('Upkeep step');
		const myBusyUpkeep = facts({ phase: 'UPKEEP', phaseLabel: 'Upkeep step', myTurn: true, sources: [61] });
		expect(decideStop(myBusyUpkeep, theirTurnOnly)).toBeNull();
		expect(decideStop(myBusyUpkeep, DEFAULT_STOP_POLICY)).toBe('Upkeep step');
	});

	it('an unknown phase is never skipped — a spelling we do not know is a stop', () => {
		const unknown = facts({ phase: null, phaseLabel: 'Fourth main phase', sources: [61] });
		expect(isStopPhase(DEFAULT_STOP_POLICY, unknown)).toBe(false);
		// Wave 24 §E left this as "`'always'` would pass it; that is deliberate".
		// Wave 28 made `'always'` the DEFAULT, and an unidentified phase quietly
		// passing every window it appears in is not a thing to leave deliberate, so
		// `skipsThisTurn` now refuses a null phase. It holds under every policy.
		for (const policy of [DEFAULT_STOP_POLICY, EVERY_PRIORITY_POLICY, DEFAULT_STOP_POLICY, FULL_CONTROL_POLICY]) {
			expect(decideStop(unknown, policy)).toBeNull();
		}
		// Forge's own "nothing here" still passes it, label and all.
		expect(decideStop({ ...unknown, sources: [], nonManaSources: [] }, DEFAULT_STOP_POLICY)).toBe('Fourth main phase');
	});

	it('the default policy is Arena’s stop set, field by field — wave 28, item 5, with the End step held only for a play', () => {
		expect(DEFAULT_STOP_POLICY).toEqual({
			stopOnMyTurn: ['MAIN1', 'MAIN2', 'COMBAT_DECLARE_ATTACKERS'],
			stopOnTheirTurn: ['COMBAT_DECLARE_BLOCKERS'],
			stopWithPlayOnTheirTurn: ['COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS', 'END_OF_TURN'],
			stopWithPlayOnMyTurn: ['COMBAT_DECLARE_BLOCKERS'],
			skipNonStopPhases: 'always',
			passWhenNothingToDo: true,
			interruptsRestoreStops: true,
			passStackWindows: true,
			unambiguousPayment: 'forgeAuto',
			unpayableCost: 'cancel',
			skipEmptyBlockStop: true,
			stopForPhaseAbility: true,
			passOwnSpell: true,
			holdForSpellCopy: true,
			orderSimultaneous: 'forge',
			attackStopIsTheDeclaration: true,
			blockStopIsTheDeclaration: true,
		});
	});

	it('wave 20’s behaviour is still a value, so the change is reversible', () => {
		expect(EVERY_PRIORITY_POLICY).toEqual({
			...DEFAULT_STOP_POLICY,
			stopOnMyTurn: ['MAIN1', 'MAIN2'],
			stopOnTheirTurn: [],
			skipNonStopPhases: 'never',
		});
	});

	/*
	 * Item 5, as the operator described it, and the lane's mutation target: revert
	 * `DEFAULT_STOP_POLICY`'s three fields in `auto.ts` and this case goes red.
	 *
	 * *"the game auto-stopped on my upkeep because i have tragic slip avaliable
	 * and i could use it on my own minion … it reveals information about whats in
	 * my hand … upkeep stops like this should not happen unless in full control
	 * mode."*
	 */
	it('item 5 — an upkeep with a castable instant is PASSED by default and STOPPED under full control', () => {
		// Forge named the instant: one actionable card, the seat's own upkeep, an
		// empty stack. This is the whole of what the old default read.
		const upkeepHoldingSlip = facts({ phase: 'UPKEEP', phaseLabel: 'Upkeep step', myTurn: true, sources: [61] });
		expect(decideStop(upkeepHoldingSlip, DEFAULT_STOP_POLICY)).toBe('Upkeep step');
		// The operator's stated escape, and it is not weakened by any of this.
		expect(decideStop(upkeepHoldingSlip, FULL_CONTROL_POLICY)).toBeNull();
		// And the leak argument, as an assertion: the decision does not depend on
		// what the seat holds. An empty hand reaches the same answer, so the pass
		// says nothing about the hand.
		expect(decideStop({ ...upkeepHoldingSlip, sources: [], nonManaSources: [] }, DEFAULT_STOP_POLICY)).toBe('Upkeep step');
		expect(decideStop({ ...upkeepHoldingSlip, sources: [61, 62, 63], nonManaSources: [61, 62, 63] }, DEFAULT_STOP_POLICY)).toBe('Upkeep step');
		// The same window under the superseded default is the bug, in one line.
		expect(decideStop(upkeepHoldingSlip, EVERY_PRIORITY_POLICY)).toBeNull();
		// The opponent's upkeep too — *"it's stopping everywhere"*.
		const theirUpkeep = { ...upkeepHoldingSlip, myTurn: false };
		expect(decideStop(theirUpkeep, DEFAULT_STOP_POLICY)).toBe('Upkeep step');
		expect(decideStop(theirUpkeep, FULL_CONTROL_POLICY)).toBeNull();
	});

	/*
	 * The other half of the wholesale decision: `'always'` alone would have left
	 * the seat with nowhere to cast the instant it is holding. These are the
	 * windows the stop sets keep, and the reason they are not negotiable — minus
	 * `END_OF_TURN`, wave 30 item 2's whole point, covered on its own below.
	 */
	it('the windows a held instant is actually cast in are still stops', () => {
		const stops: [PhaseType, string, boolean][] = [
			['COMBAT_DECLARE_BLOCKERS', 'Declare Blockers Step', false],
			['MAIN1', 'Main phase, precombat', true],
			['MAIN2', 'Main phase, postcombat', true],
		];
		for (const [phase, phaseLabel, myTurn] of stops) {
			for (const sources of [[], [61]]) {
				expect(decideStop(facts({ phase, phaseLabel, myTurn, sources }), DEFAULT_STOP_POLICY), phase).toBeNull();
			}
		}
		// The seat's own Declare Attackers step is the one stop that is NOT a
		// priority window in its own right: the attack input was the stop (T3,
		// below). It stays a window only while there is something to cast in it.
		const myAttack = { phase: 'COMBAT_DECLARE_ATTACKERS' as const, phaseLabel: 'Declare Attackers Step', myTurn: true };
		expect(decideStop(facts({ ...myAttack, sources: [61], nonManaSources: [61] }), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop(facts({ ...myAttack, sources: [] }), DEFAULT_STOP_POLICY)).toBe('Declare Attackers Step');
	});

	/*
	 * Wave 46 §C — playtest 8, the operator: *"had to click twice for declaring
	 * blockers? probably not a bug but just make sure."* It WAS a bug: Forge's
	 * ordinary priority window right after a block is assigned
	 * (`COMBAT_DECLARE_BLOCKERS`, the non-active seat) was a hard stop whatever
	 * the seat could do there — `isStopPhase` names the phase, and nothing but
	 * {@link blockStopIsEmpty}'s DIFFERENT shape (no creature at all) ever let
	 * it go. Confirmed against a real Forge match holding nothing castable
	 * (`w46-block-stop.jvm.test.ts`'s idle variant — one click to declare the
	 * block, a second for no reason).
	 *
	 * `blockStopIsTheDeclaration` is the non-active seat's mirror of
	 * `attackStopIsTheDeclaration` (T3, above): the DECLARATION itself (a
	 * `getChoices`-shaped `other` window, never a `Priority:` one) is untouched
	 * by this field and was never passed — only the priority window that
	 * follows now falls through to {@link passWhenNothingToDo}, same as the
	 * active player's own post-declaration window.
	 *
	 * The DEFENDER's Declare Attackers Step priority (the window BEFORE blocks
	 * are even assigned) is a separate finding from the same investigation and
	 * is untouched by this field: it is simply outside `stopOnTheirTurn`, so
	 * `skipsThisTurn` skips it whatever the seat could do there — confirmed in
	 * both variants of the same real-Forge suite.
	 */
	it('wave 46 §C — the Declare Blockers priority AFTER a block passes when nothing is left to do; their Declare Attackers Step holds only for a play in an attack', () => {
		const theirAttackStep = { phase: 'COMBAT_DECLARE_ATTACKERS' as const, phaseLabel: 'Declare Attackers Step', myTurn: false, attackers: 1 };
		// Untouched by this field: passed with nothing to play, held for a real play once something attacks.
		expect(decideStop(facts({ ...theirAttackStep, sources: [] }), DEFAULT_STOP_POLICY)).toBe('Declare Attackers Step');
		expect(judgeStop(facts({ ...theirAttackStep, sources: [61, 62], nonManaSources: [61] }), DEFAULT_STOP_POLICY)).toEqual({ pass: null, rule: 'play-stop', plays: [61] });
		// A combat nobody attacked in: skipped whatever the seat holds.
		expect(judgeStop(facts({ ...theirAttackStep, attackers: 0, sources: [61, 62], nonManaSources: [61] }), DEFAULT_STOP_POLICY)).toEqual({
			pass: 'Declare Attackers Step',
			rule: 'skip-phase',
		});

		// The fix: the ordinary priority window right AFTER a block is assigned
		// (a known, non-zero creature count — the declaration already happened).
		const afterBlock = (over: Partial<ReturnType<typeof readPromptFacts>> = {}) =>
			facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', myTurn: false, creatures: 1, ...over });
		// Nothing castable: PASSED. This was the bug.
		expect(decideStop(afterBlock({ sources: [] }), DEFAULT_STOP_POLICY)).toBe('Declare Blockers Step');
		// A real instant AND its mana offered: still a stop — correct Magic, the
		// response window right after blocks are locked in.
		expect(decideStop(afterBlock({ sources: [61, 62], nonManaSources: [61] }), DEFAULT_STOP_POLICY)).toBeNull();
		// Forge has not said what this seat can do: never pass on silence.
		expect(decideStop(afterBlock({ sources: null, nonManaSources: null }), DEFAULT_STOP_POLICY)).toBeNull();
		// Full control keeps the stop, as it keeps every stop.
		expect(decideStop(afterBlock({ sources: [] }), FULL_CONTROL_POLICY)).toBeNull();

		// Q10: no creature at all is a DIFFERENT shape (no declaration ever happened):
		// no block stop, whatever `blockStopIsTheDeclaration` says — only a real play holds it.
		expect(
			decideStop(
				facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', myTurn: false, creatures: 0, sources: [61, 62], nonManaSources: [] }),
				DEFAULT_STOP_POLICY,
			),
		).toBe('Declare Blockers Step');
		// An unknown creature count keeps the stop — every doubt is a stop.
		expect(
			decideStop(
				facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', myTurn: false, creatures: null, sources: [] }),
				DEFAULT_STOP_POLICY,
			),
		).toBeNull();
	});

	/*
	 * AF28, the operator, 2026-10-13: *"End step always stop if something can be
	 * used. on by default it should be checked on in the settings, and it can be
	 * turned off."* Wave 30 item 2's complaint (*"i played a land and clicked 'end
	 * turn' and the phase counter stopped at endstep"*) still holds: a seat with
	 * nothing but mana is passed.
	 *
	 * The mutation target: empty `DEFAULT_STOP_POLICY.stopWithPlayOnTheirTurn` and
	 * the kept window goes red; put `END_OF_TURN` into `stopOnTheirTurn` and the
	 * idle one does.
	 */
	it('the opponent’s End step stops only for a real play, and the setting turns it off', () => {
		const theirEnd = (over: Partial<ReturnType<typeof readPromptFacts>> = {}) =>
			facts({ phase: 'END_OF_TURN', phaseLabel: 'End step', myTurn: false, ...over });
		// A Mountain offered for its mana alone: passed, judged by the play test.
		expect(judgeStop(theirEnd({ sources: [70], nonManaSources: [] }), DEFAULT_STOP_POLICY)).toEqual({ pass: 'End step', rule: 'nothing-to-do' });
		// An affordable instant: kept, and the rule and the play are named.
		expect(judgeStop(theirEnd({ sources: [70, 61], nonManaSources: [61] }), DEFAULT_STOP_POLICY)).toEqual({ pass: null, rule: 'play-stop', plays: [61] });
		// Forge has not said: never pass on silence.
		expect(judgeStop(theirEnd({ sources: null, nonManaSources: null }), DEFAULT_STOP_POLICY).rule).toBe('no-answer');
		// The seat's OWN End step is not this stop: skipped whatever it holds.
		expect(judgeStop(theirEnd({ myTurn: true, sources: [61], nonManaSources: [61] }), DEFAULT_STOP_POLICY).rule).toBe('skip-phase');
		// The setting off: the End step is skipped whatever the seat holds.
		const off = withEndStepStop(DEFAULT_STOP_POLICY, false);
		expect(off).toEqual({ ...DEFAULT_STOP_POLICY, stopWithPlayOnTheirTurn: ['COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS'] });
		expect(judgeStop(theirEnd({ sources: [70, 61], nonManaSources: [61] }), off)).toEqual({ pass: 'End step', rule: 'skip-phase' });
		expect(withEndStepStop(off, true)).toEqual(DEFAULT_STOP_POLICY);
		// Already agreeing: the same object, so the caller skips a no-op.
		expect(withEndStepStop(DEFAULT_STOP_POLICY, true)).toBe(DEFAULT_STOP_POLICY);
		// Blocking is a decision, not a wait: still a stop, play or none.
		const theirBlockers = facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', myTurn: false, sources: [], nonManaSources: [] });
		expect(decideStop(theirBlockers, DEFAULT_STOP_POLICY)).toBeNull();
		// Full control keeps it whatever the default or the setting say.
		expect(decideStop(theirEnd({ sources: [] }), FULL_CONTROL_POLICY)).toBeNull();
		expect(decideStop(theirEnd({ sources: [] }), withEndStepStop(FULL_CONTROL_POLICY, false))).toBeNull();
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
		expect(decideStop(facts({ phase: 'UPKEEP', phaseLabel: 'Upkeep step', sources: [61] }), DEFAULT_STOP_POLICY)).toBe('Upkeep step');
		// COMBAT_DECLARE_BLOCKERS, not END_OF_TURN (wave 30 item 2 moved the end
		// step out of ARENA's — i.e. DEFAULT_STOP_POLICY's — stop set; that change
		// has its own dedicated test above).
		expect(
			decideStop(facts({ phase: 'COMBAT_DECLARE_BLOCKERS', phaseLabel: 'Declare Blockers Step', sources: [61] }), DEFAULT_STOP_POLICY),
		).toBeNull();
	});
});

/*
 * Wave 35 §S, R2 follow-up — lane E's `play.spec.ts` ("a spell resolves
 * unattended") measured this failing 5 of 5 real-Forge runs after lane F's
 * land-tapping fix (R15): every untapped land with a mana ability is now in
 * the SAME actionable set `sources` reads, so "the set is non-empty" stopped
 * meaning "there is a real decision" — on an ordinary turn with any land
 * left untapped, the "pass when nothing to do" shortcut above could no
 * longer ever fire. `decideStop` now reads `nonManaSources` for this one
 * check (every other read above, and all of `decidePay`'s, are untouched and
 * still use the raw `sources` — a land IS a legitimate payment source).
 */
describe('mana sources do not count as "something to do"', () => {
	// Phase `null` (Forge's own spelling the adapter did not recognise) is what
	// reaches `decideStop`'s FINAL "nothing to do" check in this file's own
	// existing convention (see `unknown`, above): the default `facts()` phase,
	// `COMBAT_DECLARE_BLOCKERS` on the opponent's turn, is itself a mandatory
	// stop under `DEFAULT_STOP_POLICY.stopOnTheirTurn` and returns null before
	// `sources`/`nonManaSources` are ever read — the mana exclusion needs a
	// phase that is NOT already decided by an earlier branch.
	const unclassified = (over: Partial<ReturnType<typeof readPromptFacts>> = {}) =>
		facts({ phase: null, phaseLabel: 'Fourth main phase', myTurn: true, ...over });

	it('passes when the actionable set names ONLY mana sources', () => {
		expect(decideStop(unclassified({ sources: [67], nonManaSources: [] }), DEFAULT_STOP_POLICY)).toBe('Fourth main phase');
		expect(decideStop(unclassified({ sources: [67, 68], nonManaSources: [] }), DEFAULT_STOP_POLICY)).toBe('Fourth main phase');
	});

	it('is still NOT passed when anything else is also actionable — a mana source does not hide a real decision', () => {
		expect(decideStop(unclassified({ sources: [67, 90], nonManaSources: [90] }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('is still NOT passed on silence: `nonManaSources: null` is "Forge has not said", same as `sources: null`', () => {
		expect(decideStop(unclassified({ sources: null, nonManaSources: null }), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('payment decisions are UNCHANGED: a land is still a real, visible payment source', () => {
		const payment = facts({ window: 'payment', cost: '{R}', sources: [67], nonManaSources: [], plannedSources: [] });
		expect(decidePay(payment, DEFAULT_STOP_POLICY)).toBe('{R}');
	});

	it('readPromptFacts itself: nonManaSources is sources minus SeatNotes.manaOnlyIds, sources untouched', () => {
		const read = readPromptFacts(notesFor(PRIORITY_MESSAGE, buttons(true), [67, 90], new Set([67])));
		expect(read.sources).toEqual([67, 90]);
		expect(read.nonManaSources).toEqual([90]);
	});

	it('readPromptFacts: no `manaOnlyIds` at all (a frame the bridge did not describe) leaves nonManaSources equal to sources', () => {
		const read = readPromptFacts(notesFor(PRIORITY_MESSAGE, buttons(true), [67, 90]));
		expect(read.nonManaSources).toEqual(read.sources);
	});
});

describe('NEVER shortcut (2): a cost whose payment is a genuine choice', () => {
	/** Two lands, and Forge’s auto-tap plan naming neither: which to tap is the player’s. */
	const twoSourcesNoPlan = facts({ window: 'payment', cost: '{1}{W}', sources: [61, 62], plannedSources: [] });

	it('two sources with no plan on the wire is a choice, and stays a stop', () => {
		expect(decidePay(twoSourcesNoPlan, STRICT_PAYMENT_POLICY)).toBeNull();
		// And under the default the operator chose, Forge's plan settles it.
		expect(decidePay(twoSourcesNoPlan, DEFAULT_STOP_POLICY)).toBe('{1}{W}');
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
		expect(decidePay(partly, STRICT_PAYMENT_POLICY)).toBeNull();
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
		for (const policy of [DEFAULT_STOP_POLICY, FULL_CONTROL_POLICY]) {
			expect(decideStop(read, policy)).toBeNull();
			expect(decidePay(read, policy)).toBeNull();
		}
		// And through the whole `match.ts` entry points, which is what runs live.
		expect(decideStop(readPromptFacts(notes), DEFAULT_STOP_POLICY)).toBeNull();
		expect(decidePay(readPromptFacts(notes), DEFAULT_STOP_POLICY)).toBeNull();
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
			expect(decideStop(readPromptFacts(notes), FULL_CONTROL_POLICY), `${w.label}: pass`).toBeNull();
			expect(decidePay(readPromptFacts(notes), FULL_CONTROL_POLICY), `${w.label}: pay`).toBeNull();
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
		expect(decideStop(onStack, DEFAULT_STOP_POLICY)).toBe('Declare Blockers Step');
		expect(decideStop(onStack, FULL_CONTROL_POLICY)).toBeNull();
	});

	it('presses no payment, however unambiguous', () => {
		const one = facts({ window: 'payment', cost: '{U}', sources: [61] });
		expect(decidePay(one, DEFAULT_STOP_POLICY)).toBe('{U}');
		expect(decidePay(one, FULL_CONTROL_POLICY)).toBeNull();
	});

	it('still answers a bounds ask — one legal reply is no question in any mode', () => {
		const ask = allMustBeChosen('fc-1');
		expect(onlyAnswer(ask, FULL_CONTROL_POLICY)).toEqual(onlyAnswer(ask, DEFAULT_STOP_POLICY));
		expect(onlyAnswer(ask, FULL_CONTROL_POLICY)).not.toBeNull();
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
		expect(decidePay(galvanicBlast, STRICT_PAYMENT_POLICY)).toBeNull();
		// And with one source it always did fire — the arm was never broken.
		expect(decidePay({ ...galvanicBlast, sources: [16] }, STRICT_PAYMENT_POLICY)).toBe('{R}');
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

	it('IS the default as of 2026-09-27, and item 6 is what changed it', () => {
		// The same facts a genuinely ambiguous payment produces — two sources that
		// can BOTH pay — are these exact facts, and nothing on this wire tells the
		// two apart. So the question was never "be cleverer", it was whose auto-tap
		// decides; the operator's answer, shown the trade, was Forge's.
		expect(DEFAULT_STOP_POLICY.unambiguousPayment).toBe('forgeAuto');
		expect(DEFAULT_STOP_POLICY.unambiguousPayment).toBe('forgeAuto');
		expect(decidePay(galvanicBlast, DEFAULT_STOP_POLICY)).toBe('{R}');
		// The strict value still exists and still means what it meant.
		expect(STRICT_PAYMENT_POLICY.unambiguousPayment).toBe('auto');
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
		/*
		 * The shape `auto.jvm.test.ts`'s item-6 run actually recorded, and the one
		 * that would be a false Cancel if the window gate were ever loosened: Forge's
		 * TARGETING input reuses the bar it was handed, because
		 * `InputSelectTargets.showMessage` calls the three-argument `updateButtons`
		 * that changes only the enabled flags (`InputSelectTargets.java:135-149`). So
		 * a `label1: 'Auto'` with a dead button arrives over a prompt that is not a
		 * payment at all. What keeps it out is the cost line, which it has not got.
		 */
		const targeting = readPromptFacts(notesFor('Galvanic Blast (38) - Galvanic Blast deals 2 damage to any target.\n\nSelect any target', deadAuto, []));
		expect(targeting.cost).toBeNull();
		expect(targeting.window).toBe('other');
		expect(targeting.noWayToPay).toBe(false);
		expect(decideCancel(targeting, DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('cancels it, and names the cost it abandoned', () => {
		const unpayable = facts({ window: 'payment', cost: '{1}{U}', confirmLive: false, noWayToPay: true, stackEmpty: false });
		expect(decideCancel(unpayable, DEFAULT_STOP_POLICY)).toBe('{1}{U}');
		// Through the entry point `match.ts` calls, over Forge's own frames.
		expect(decideCancel(readPromptFacts(notesFor('Mana Leak.\n\nPay Mana Cost: {1}{U}', deadAuto, [])), DEFAULT_STOP_POLICY)).toBe('{1}{U}');
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
		expect(decideCancel(readPromptFacts(phyrexian), DEFAULT_STOP_POLICY)).toBeNull();
	});

	it('leaves LIFE alone in Forge’s real, parenthesised wording: it is an alternative payment, never cancelled', () => {
		const phyrexian = notesFor(
			'Pay Mana Cost: {U/P}\n(Click on your life total to pay life for phyrexian mana.)',
			deadAuto,
			[],
		);
		expect(readPromptFacts(phyrexian).noWayToPay).toBe(true);
		expect(readPromptFacts(phyrexian).alternativePayment).toBe(true);
		expect(decideCancel(readPromptFacts(phyrexian), DEFAULT_STOP_POLICY)).toBeNull();
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
		expect(decideCancel(readPromptFacts(notesFor('Pay Mana Cost: {1}{U}', deadAuto, [])), FULL_CONTROL_POLICY)).toBeNull();
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

	it('presses Forge’s own Cancel, exactly once for that cost, and says nothing — the seat sees the refusal', () => {
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
		// The window was answered, so it never reached the seat: Forge asks it nothing more
		// after the Cancel, and a forwarded one stayed on screen until the seat pressed Cancel too.
		expect(frames(h, 0).filter((f) => f.method === 'showPromptMessage' && /Pay Mana Cost/.test(f.message))).toEqual([]);
		expect(h.logs.filter((l) => l.evt === 'prompt-withheld' && l.seat === 0).map((l) => l.why)).toContain('auto-cancel');
		// The seat did not cancel it; it sees its play turned away, once, and the other seat sees nothing.
		expect(frames(h, 0).filter((f) => f.method === 'flashIncorrectAction')).toEqual([{ kind: 'notify', method: 'flashIncorrectAction' }]);
		expect(frames(h, 1).filter((f) => f.method === 'flashIncorrectAction')).toEqual([]);
	});

	it('never presses it when Forge’s Auto is live — that is the payment’s business', () => {
		const h = harness();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 67 }, { kind: 'card', id: 68 }] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {1}{U}', me));
		// The Auto press is the PAYMENT's business and is expected under the
		// default; what must never happen here is a CANCEL, because Forge said it
		// found a payment.
		expect(h.logs.filter((l) => l.evt === 'auto-cancelled')).toEqual([]);
		expect(h.host.commands.filter((c) => c.t === 'act' && c.frame.method === 'selectButtonCancel')).toEqual([]);
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
});

/*
 * Wave 52 §S. Three operator asks from match m-6ce49e226aef, 2026-10-06, each
 * through the whole `match.ts` fold the server runs live: a Signet is offered at
 * priority now (w52's fork commit) and must not hold priority any more than a land
 * does; an upkeep-only ability on the battlefield stops the upkeep; and the cost
 * confirm for an ability the seat just chose answers itself.
 */
describe('wave 52 §S — mana sources, the phase-restricted stop, the chosen cost', () => {
	const card = (id: number) => ({ kind: 'card' as const, id });
	/** Seat 0 watching seat 1's spell on the stack — a window only "nothing to do" can pass. */
	function stackWindow(cards: number[], manaOnly?: number[], land?: number): Harness {
		const h = harness();
		const me = playerOf(h, 0);
		if (land !== undefined) putCreature(h, 0, land, ['Land']);
		putOnStack(h, 0, 5, playerOf(h, 1));
		push(h, 0, {
			kind: 'notify',
			method: 'setWeaklySelectable',
			cards: cards.map(card),
			...(manaOnly === undefined ? {} : { manaOnly: manaOnly.map(card) }),
		});
		push(h, 0, prompt('Priority: A\nTurn: 4 (B)\nPhase: Main phase, precombat\nStack: 1 to Resolve', me));
		push(h, 0, buttons(true, me));
		return h;
	}
	const passed = (h: Harness) => h.host.commands.filter((c) => c.t === 'act').length;

	it('a seat holding only lands is passed, as before', () => {
		expect(passed(stackWindow([67, 68], [67, 68]))).toBe(1);
	});

	it('a seat holding lands and a Signet, nothing castable, is passed exactly where a land-only seat is', () => {
		expect(passed(stackWindow([67, 94], [67, 94]))).toBe(1);
	});

	it('a seat holding lands and something castable still stops', () => {
		expect(passed(stackWindow([67, 94, 90], [67, 94]))).toBe(0);
	});

	it('an offer the bridge did not describe (no manaOnly) keeps the stop: a doubt is never a pass', () => {
		expect(passed(stackWindow([94]))).toBe(0);
	});

	it('readPromptFacts: nonManaSources drops the manaOnly ids, sources untouched', () => {
		const read = readPromptFacts(notesFor(PRIORITY_MESSAGE, buttons(true), [67, 94, 90], new Set([67, 94])));
		expect(read.sources).toEqual([67, 94, 90]);
		expect(read.nonManaSources).toEqual([90]);
	});

	it('a land of the seat’s own offered for a non-mana ability (a Ghost Quarter) stops like an instant in hand', () => {
		expect(passed(stackWindow([67, 80], [67], 80))).toBe(0);
	});

	it('the same land offered only for its mana is passed', () => {
		expect(passed(stackWindow([67, 80], [67, 80], 80))).toBe(1);
	});

	const UPKEEP = 'Priority: A\nTurn: 4 (A)\nPhase: Upkeep step\nStack: Empty';
	function upkeep(phaseRestricted: number[] | undefined, policy?: StopPolicy): Harness {
		const h = harness(policy);
		const me = playerOf(h, 0);
		push(h, 0, {
			kind: 'notify',
			method: 'setWeaklySelectable',
			cards: [card(70), card(71)],
			manaOnly: [card(71)],
			...(phaseRestricted === undefined ? {} : { phaseRestricted: phaseRestricted.map(card) }),
		});
		push(h, 0, prompt(UPKEEP, me));
		push(h, 0, buttons(true, me));
		return h;
	}

	it('(A) the upkeep STOPS when a permanent the seat controls has an ability restricted to it, usable now', () => {
		const h = upkeep([70]);
		expect(passed(h)).toBe(0);
		expect(h.logs.filter((l) => l.evt === 'auto-passed')).toEqual([]);
	});

	it('(A) the upkeep is still passed with no such permanent — an instant in hand never stops a phase (wave 28)', () => {
		expect(passed(upkeep([]))).toBe(1);
		expect(passed(upkeep(undefined))).toBe(1);
	});

	it('(A) the stop is the policy’s: stopForPhaseAbility off passes the upkeep again', () => {
		expect(passed(upkeep([70], { ...DEFAULT_STOP_POLICY, stopForPhaseAbility: false }))).toBe(1);
	});

	it('(A) decideStop over facts: phaseRestricted keeps a non-stop phase only while the rule is on', () => {
		const f = facts({ phase: 'UPKEEP', phaseLabel: 'Upkeep step', myTurn: true, sources: [70], nonManaSources: [70], phaseRestricted: [70] });
		expect(decideStop(f, DEFAULT_STOP_POLICY)).toBeNull();
		expect(decideStop({ ...f, phaseRestricted: [] }, DEFAULT_STOP_POLICY)).toBe('Upkeep step');
	});

	/** The seat chooses ability `chosen` of card 70 from a two-ability offer, as a browser would. */
	function choose(h: Harness, chosen: number): void {
		push(h, 0, {
			kind: 'ask',
			callId: 'ab-1',
			method: 'getAbilityToPlay',
			hostCard: card(70),
			abilities: [
				{ kind: 'spellAbility', id: 9001 },
				{ kind: 'spellAbility', id: 9002 },
			],
			triggerEvent: null,
		});
		const ask = frames(h, 0).find((f) => f.kind === 'ask' && f.method === 'getAbilityToPlay');
		if (ask === undefined || ask.kind !== 'ask') throw new Error('the ability ask never reached the seat');
		const reply = ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: chosen } });
		expect(h.match.fromClient(0, reply)).toEqual({ ok: true });
	}
	function confirm(h: Harness, hostCard: number, abilityId: number, message = 'Do you want to sacrifice Augur of Skulls?'): void {
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: me }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true });
		push(h, 0, {
			kind: 'notify',
			method: 'showPromptMessage',
			player: { kind: 'player', id: me },
			message,
			card: null,
			confirmAbility: { hostCard: card(hostCard), abilityId },
		});
	}
	const confirmed = (h: Harness) => h.logs.filter((l) => l.evt === 'auto-confirmed').length;

	it('(B) the cost confirm for the ability the seat just chose answers Yes, once', () => {
		const h = harness();
		choose(h, 9002);
		const before = frames(h, 0).length;
		confirm(h, 70, 9002);
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } }]);
		expect(confirmed(h)).toBe(1);
		// Nothing is sent for a window the server answers: not the question, and
		// not its bar, which the seat's own choice already left disabled.
		expect(frames(h, 0)).toHaveLength(before);
		// Forge showing the same input again before the Yes reaches it is that
		// same window: withheld, and not pressed twice.
		confirm(h, 70, 9002);
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(1);
		expect(frames(h, 0)).toHaveLength(before);
		// Once Forge has moved on, the choice is spent: the same confirm again is the player's.
		push(h, 0, { kind: 'notify', method: 'clearWeaklySelectable' });
		const moved = frames(h, 0).length;
		confirm(h, 70, 9002);
		expect(confirmed(h)).toBe(1);
		expect(frames(h, 0).slice(moved).map((f) => f.method)).toEqual(['updateButtons', 'showPromptMessage']);
	});

	it('(B) a cost with two parts asks twice, and each of its confirms answers Yes once (Lion’s Eye Diamond)', () => {
		const h = harness();
		choose(h, 9002);
		confirm(h, 70, 9002, 'Do you want to discard your hand?');
		push(h, 0, { kind: 'notify', method: 'clearWeaklySelectable' });
		confirm(h, 70, 9002, "Sacrifice Lion's Eye Diamond?");
		expect(confirmed(h)).toBe(2);
		expect(h.host.commands.filter((c) => c.t === 'act')).toHaveLength(2);
	});

	it('(B) an optional trigger’s confirm still asks — it names the trigger, not the chosen ability', () => {
		const h = harness();
		choose(h, 9002);
		confirm(h, 71, 555);
		expect(confirmed(h)).toBe(0);
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
		expect(frames(h, 0).filter((f) => f.method === 'showPromptMessage' && f.confirmAbility !== undefined)).toHaveLength(1);
	});

	it('(B) the other ability of the same card, or a confirm with no choice before it, still asks', () => {
		const other = harness();
		choose(other, 9001);
		confirm(other, 70, 9002);
		expect(confirmed(other)).toBe(0);
		const none = harness();
		confirm(none, 70, 9002);
		expect(confirmed(none)).toBe(0);
	});

	it('(B) a priority prompt ends the activation: a later confirm for that ability is the player’s', () => {
		const h = harness();
		choose(h, 9002);
		push(h, 0, prompt(MY_STOP_MESSAGE, playerOf(h, 0)));
		confirm(h, 70, 9002);
		expect(confirmed(h)).toBe(0);
	});

	it('(B) full control answers it too: the seat chose that ability, there is nothing left to ask', () => {
		const held = harness();
		held.match.setFullControl(0, true);
		choose(held, 9002);
		confirm(held, 70, 9002);
		expect(confirmed(held)).toBe(1);
	});

	it('(B) chosenCostConfirm is pure over the notes and the choice', () => {
		const me = 1;
		const notes: SeatNotes = {
			playerId: me,
			prompt: {
				kind: 'notify',
				method: 'showPromptMessage',
				player: { kind: 'player', id: me },
				message: 'Sacrifice?',
				card: null,
				confirmAbility: { hostCard: card(70), abilityId: 9002 },
			},
			buttons: { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: me }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true },
			actionable: null,
			openAsks: 0,
		};
		expect(chosenCostConfirm(notes, { hostCard: 70, abilityId: 9002 })).not.toBeNull();
		expect(chosenCostConfirm(notes, null)).toBeNull();
		expect(chosenCostConfirm({ ...notes, openAsks: 1 }, { hostCard: 70, abilityId: 9002 })).toBeNull();
	});
});

describe("an optional search's \"Search your hand?\" — answered when No gains the seat nothing", () => {
	const card = (id: number) => ({ kind: 'card' as const, id });
	type Search = { origin: ('Hand' | 'Library' | 'Graveyard')[]; player: { kind: 'player'; id: number }; mayChooseNothing: boolean };
	/** Forge's question before an optional search's card choice, as the bridge names it (Aether Vial's). */
	function searchConfirm(h: Harness, search: (me: number) => Search, message = 'Search your hand?'): void {
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: me }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true });
		push(h, 0, {
			kind: 'notify',
			method: 'showPromptMessage',
			player: { kind: 'player', id: me },
			message,
			card: null,
			confirmAbility: { hostCard: card(70), abilityId: 9003, search: search(me) },
		});
	}
	const own =
		(origin: Search['origin'], mayChooseNothing = true) =>
		(me: number): Search => ({ origin, player: { kind: 'player', id: me }, mayChooseNothing });
	const presses = (h: Harness) => h.host.commands.filter((c) => c.t === 'act');
	const shown = (h: Harness) => frames(h, 0).filter((f) => f.kind === 'notify' && f.method === 'showPromptMessage' && f.message.startsWith('Search'));

	it('a search of its own hand, with a choice that may be none, is answered Yes and never shown', () => {
		const h = harness();
		searchConfirm(h, own(['Hand']));
		expect(presses(h)).toEqual([{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } }]);
		expect(h.logs.filter((l) => l.evt === 'auto-confirmed').map((l) => l.why)).toEqual(['searching its own hand costs nothing, and the choice after may be none']);
		expect(h.logs.filter((l) => l.evt === 'prompt-withheld').map((l) => l.why)).toEqual(['auto-confirm']);
		expect(shown(h)).toEqual([]);
	});

	it('a library search is the seat’s: No spares it the shuffle', () => {
		const h = harness();
		searchConfirm(h, own(['Library']), 'Search your library?');
		expect(presses(h)).toEqual([]);
		expect(shown(h)).toHaveLength(1);
		const both = harness();
		searchConfirm(both, own(['Hand', 'Library']), 'Search your hand and library?');
		expect(presses(both)).toEqual([]);
	});

	it('a search whose choice must take a card is the seat’s: No is the only way to take none', () => {
		const h = harness();
		searchConfirm(h, own(['Hand'], false));
		expect(presses(h)).toEqual([]);
		expect(shown(h)).toHaveLength(1);
	});

	it('another player’s hand is the seat’s question, full control or not', () => {
		const theirs = harness();
		searchConfirm(theirs, (me) => ({ origin: ['Hand'], player: { kind: 'player', id: me + 1 }, mayChooseNothing: true }), "Search Bob's hand?");
		expect(presses(theirs)).toEqual([]);
		const full = harness();
		full.match.setFullControl(0, true);
		searchConfirm(full, (me) => ({ origin: ['Hand'], player: { kind: 'player', id: me + 1 }, mayChooseNothing: true }), "Search Bob's hand?");
		expect(presses(full)).toEqual([]);
	});

	it('a confirm the bridge names no search for is never answered by this rule', () => {
		const me = 1;
		const notes: SeatNotes = {
			playerId: me,
			prompt: {
				kind: 'notify',
				method: 'showPromptMessage',
				player: { kind: 'player', id: me },
				message: 'Cancel Search? Up to 1 more card(s) can be selected.',
				card: null,
				confirmAbility: { hostCard: card(70), abilityId: 9003 },
			},
			buttons: { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: me }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true },
			actionable: null,
			openAsks: 0,
		};
		expect(freeSearchConfirm(notes)).toBeNull();
		const search = { origin: ['Hand' as const], player: { kind: 'player' as const, id: me }, mayChooseNothing: true };
		const asked = { ...notes, prompt: { ...notes.prompt, confirmAbility: { hostCard: card(70), abilityId: 9003, search } } } as SeatNotes;
		expect(freeSearchConfirm(asked)).not.toBeNull();
		expect(freeSearchConfirm({ ...asked, openAsks: 1 })).toBeNull();
		expect(freeSearchConfirm({ ...asked, buttons: { ...notes.buttons, enable1: false } as SeatNotes['buttons'] })).toBeNull();
	});
});

/*
 * The operator, 2026-10-19, in full control: *"when tapping black lotus why does it ask me if i
 * want to sacrifice? of course i do, i tapped it. for cards like timewarp, why is it asking me to
 * 'select' an ability? there is only one valid choice here."* Full control stops the seat at every
 * priority window and lets it order and choose where there is a real choice; a question with one
 * possible answer, and the cost confirm of the ability it just chose, are no choice in any mode.
 */
describe('full control asks only real questions', () => {
	const card = (id: number) => ({ kind: 'card' as const, id });
	function fullControl(): Harness {
		const h = harness();
		h.match.setFullControl(0, true);
		return h;
	}
	const asked = (h: Harness, callId: string) => frames(h, 0).filter((f) => f.kind === 'ask' && f.callId === callId);
	const replies = (h: Harness) => h.host.commands.filter((c) => c.t === 'reply');

	it('a one-ability getAbilityToPlay (a trigger, nobody clicked) is answered with that ability', () => {
		const h = fullControl();
		push(h, 0, oneAbilityAsk('fc-ab'));
		expect(asked(h, 'fc-ab')).toEqual([]);
		expect(replies(h)).toEqual([{ t: 'reply', seat: 0, callId: 'fc-ab', result: { kind: 'spellAbility', id: 9001 } }]);
		expect(h.logs).toContainEqual(expect.objectContaining({ evt: 'ask-auto-answered', callId: 'fc-ab', why: 'one ability' }));
	});

	it('a one-option getChoices is answered', () => {
		const h = fullControl();
		push(h, 0, { kind: 'ask', callId: 'fc-one', method: 'getChoices', message: 'Choose', min: 1, max: 1, choices: [{ key: 'k1', label: 'option 1', ref: null }], selected: [] });
		expect(asked(h, 'fc-one')).toEqual([]);
		expect(replies(h)).toEqual([{ t: 'reply', seat: 0, callId: 'fc-one', result: ['k1'] }]);
	});

	it('a two-option ask still reaches the player', () => {
		const h = fullControl();
		push(h, 0, { kind: 'ask', callId: 'fc-two', method: 'getChoices', message: 'Choose', min: 1, max: 1, choices: [1, 2].map((i) => ({ key: `k${i}`, label: `option ${i}`, ref: null })), selected: [] });
		push(h, 0, fixture('getAbilityToPlay.json'));
		expect(asked(h, 'fc-two')).toHaveLength(1);
		expect(frames(h, 0).filter((f) => f.kind === 'ask' && f.method === 'getAbilityToPlay')).toHaveLength(1);
		expect(replies(h)).toEqual([]);
	});

	it('simultaneous triggers are still the seat’s to order; one item is no order', () => {
		const h = fullControl();
		push(h, 0, { ...(fixture('order.json') as unknown as Record<string, unknown>), callId: 'fc-order' });
		expect(asked(h, 'fc-order')).toHaveLength(1);
		const base = fixture('order.json') as unknown as { sourceChoices: unknown[] };
		push(h, 0, { ...(base as Record<string, unknown>), callId: 'fc-order-1', sourceChoices: base.sourceChoices.slice(0, 1), remainingObjectsMax: 0 });
		expect(asked(h, 'fc-order-1')).toEqual([]);
		expect(replies(h)).toHaveLength(1);
	});

	it('Black Lotus: the sacrifice confirm for the ability the seat just activated answers Yes', () => {
		const h = fullControl();
		const me = playerOf(h, 0);
		h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: card(70), otherCardViewsToSelect: [], triggerEvent: null }));
		push(h, 0, { kind: 'ask', callId: 'lotus', method: 'getAbilityToPlay', hostCard: card(70), abilities: [{ kind: 'spellAbility', id: 9002 }], triggerEvent: null });
		// The seat's own click: its browser answers (and says what it played), the server does not.
		expect(asked(h, 'lotus')).toHaveLength(1);
		expect(h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'reply', callId: 'lotus', method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9002 } }))).toEqual({ ok: true });
		const before = frames(h, 0).length;
		push(h, 0, { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: me }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true });
		push(h, 0, { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: me }, message: 'Sacrifice Black Lotus?', card: null, confirmAbility: { hostCard: card(70), abilityId: 9002 } });
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 0).at(-1)).toEqual({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } });
		expect(frames(h, 0).slice(before).filter((f) => f.method === 'showPromptMessage')).toEqual([]);
		expect(h.logs).toContainEqual(expect.objectContaining({ evt: 'prompt-withheld', seat: 0, why: 'auto-confirm' }));
	});

	it('Aether Vial: "Search your hand?" is answered as it is by default', () => {
		const h = fullControl();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: me }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true });
		push(h, 0, {
			kind: 'notify',
			method: 'showPromptMessage',
			player: { kind: 'player', id: me },
			message: 'Search your hand?',
			card: null,
			confirmAbility: { hostCard: card(70), abilityId: 9003, search: { origin: ['Hand'], player: { kind: 'player', id: me }, mayChooseNothing: true } },
		});
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 0)).toEqual([{ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectButtonOk' } }]);
	});

	it('an optional trigger’s "may" is still asked — it names the trigger, not a chosen ability', () => {
		const h = fullControl();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: me }, label1: 'Yes', label2: 'No', enable1: true, enable2: true, focus1: true });
		push(h, 0, { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: me }, message: 'Use triggered ability of Augur?', card: null, confirmAbility: { hostCard: card(71), abilityId: 555 } });
		expect(h.host.commands.filter((c) => c.t === 'act' && c.seat === 0)).toEqual([]);
	});

	it('every priority window still stops, and no payment is pressed', () => {
		const h = fullControl();
		const me = playerOf(h, 0);
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [] });
		push(h, 0, prompt(PRIORITY_MESSAGE.replace('Priority: B', 'Priority: A'), me));
		push(h, 0, buttons(true, me));
		push(h, 0, { kind: 'notify', method: 'setWeaklySelectable', cards: [card(67)] });
		push(h, 0, autoBar(true, me));
		push(h, 0, prompt('Pay Mana Cost: {U}', me));
		expect(h.host.commands.filter((c) => c.t === 'act')).toEqual([]);
	});
});
