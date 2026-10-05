/**
 * Wave 46 §C (playtest 8) — *"had to click twice for declaring blockers?
 * probably not a bug but just make sure."*
 *
 * **Verdict: it was a bug, now fixed.** The tracker's reading of a real
 * match's bridge log (`m-234c5f46dd94`, its run dir gone by the time this lane
 * started) found two `OK`s from the DEFENDER around one attack: one during
 * `COMBAT_DECLARE_ATTACKERS`, a second confirming the block. Reproducing the
 * attack fresh against a real Forge match (two variants, reading the
 * `stop-decided` trace under `CARDTABLE_PLAY_PROBE=1`) found the SECOND click
 * was the real bug, one phase later than the tracker's own read: the ordinary
 * `COMBAT_DECLARE_BLOCKERS` priority window right AFTER the block is assigned
 * was a hard stop whatever the defender could do there — `idle-blocker.json`'s
 * original run showed it `kept` with `sources: 0, nonLandSources: 0` and
 * `buttons: [true, true]`, a second OK for a seat holding nothing. The window
 * the tracker actually named, `COMBAT_DECLARE_ATTACKERS`, was already correct:
 * it is outside `stopOnTheirTurn` and `skipsThisTurn` skips it whatever the
 * seat could do there, confirmed in both variants below and pinned in
 * `auto.test.ts`.
 *
 * The fix is `StopPolicy.blockStopIsTheDeclaration` (`auto.ts`), the
 * non-active seat's mirror of `attackStopIsTheDeclaration`: the block-select
 * input itself is UNTOUCHED and never passed (it is a `getChoices`-shaped
 * `other` window, not a `Priority:` one — `decideStop`'s own `window !==
 * 'priority'` guard already refused it, before and after this fix). Only the
 * ordinary priority window that follows is now judged by
 * `passWhenNothingToDo` like any other window, same as the attacker's own
 * post-declaration window. With this on:
 *
 *  - **idle** (`w46-c-blocker-idle.state`) — the defender holds one untapped
 *    blocker and nothing else. ONE click: declare the block. The priority
 *    window right after is silently auto-passed.
 *  - **reactive** (`w46-c-blocker-reactive.state`) — the defender ALSO holds
 *    Lightning Bolt and an untapped Mountain. TWO clicks: declare the block,
 *    then the priority window right after — correct Magic, a held response is
 *    still castable once blocks are locked in.
 *
 * Neither variant ever shows a stop during `COMBAT_DECLARE_ATTACKERS`, before
 * the block-select window opens — confirmed directly from the `stop-decided`
 * trace (`docs/planning/wave46-evidence/C/*.json`): that window is
 * `'auto-passed'` for the defender in both variants, even in the reactive one
 * where `sources: 2, nonLandSources: 1` prove Lightning Bolt and its Mountain
 * really were offered there too.
 *
 * Run with `CARDTABLE_PLAY_PROBE=1` so `match.ts`'s `TRACE_STOPS` emits a
 * `stop-decided` log line for every window the server evaluates (kept or
 * passed) — the evidence this suite's diagnosis rests on.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   CARDTABLE_PLAY_PROBE=1 \
 *   pnpm exec vitest run apps/server/src/play/w46-block-stop.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? "the defender's clicks around a declared attack, against real Forge"
	: `the defender's clicks around a declared attack, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('W46C A', ['40 Mountain']), deck('W46C B', ['40 Mountain'])];
const EVIDENCE_DIR = join(
	'/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/w46-manager',
	'docs/planning/wave46-evidence/C',
);

/**
 * `waitUntil`'s own 25ms poll (`scenario.ts`) turned out to be too coarse for
 * a FIRST version of this suite that pre-declared the attack (the `|Attacking`
 * scenario key, landing straight on `COMBAT_DECLARE_ATTACKERS`): with nothing
 * pacing combat to human reaction time, the whole Declare Attackers → Declare
 * Blockers → block-select sequence resolved in under 20ms of real JVM-IPC
 * time, and a 25ms poll could miss a window entirely — not just its button
 * state, the whole `showPromptMessage` text — with nothing left to catch up
 * to once missed. Reproduced directly against the ALREADY-SHIPPED
 * `scenario-blockers.jvm.test.ts` (same pre-declared shape) under host
 * contention, so it was not specific to this suite's own code — see this
 * file's own header. The scenarios here land at the attacker's own, UNDECLARED
 * Main Phase 1 instead (`w46-c-blocker-idle.state`'s own comment), so Forge's
 * real `InputAttack` paces the sequence the same way `blockers.jvm.test.ts`'s
 * own (reliable) suite does — measured there at 100+ms between steps, two
 * orders of magnitude clear of a 25ms poll. This local 3ms loop is kept
 * anyway, as cheap insurance against a slower host: it costs nothing extra
 * when a window is already open for 100ms.
 */
async function fastPoll(p: () => boolean, label: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 3));
	}
}

/**
 * Drive the ATTACKER for real: press its own ordinary priority stops (Main
 * Phase 1) forward, then answer Forge's own LIVE `InputAttack` — select the
 * one creature, confirm it (`label2 === 'Call Back'` is `InputAttack`'s own
 * tell that the declaration is now armed and can be confirmed, the same
 * signal `blockers.jvm.test.ts`'s own `attack()` reads) — until `until` holds.
 * Never touches the defender's prompt; what the defender sees is exactly
 * `driveDefenderThroughBlock`'s to read and answer.
 */
async function driveAttackDeclaration(s: Scenario, attacker: number, creatureId: number, until: () => boolean): Promise<void> {
	let declared = false;
	let confirmed = false;
	await fastPoll(() => {
		s.answerAsks();
		if (until()) return true;
		const msg = s.prompt(attacker);
		const b = s.buttons(attacker);
		if (/^Select creatures to attack/.test(msg) && b?.enable1 === true) {
			if (!declared) {
				declared = true;
				s.select(attacker, creatureId);
				return false;
			}
			if (!confirmed && b.label2 === 'Call Back') {
				confirmed = true;
				s.ok(attacker);
			}
			return false;
		}
		// The ordinary stops on the way there (Main Phase 1 — Beginning of
		// Combat is not a stop and passes itself): press whatever is live.
		if (/^Priority:/.test(msg) && b?.enable1 === true) s.ok(attacker);
		return false;
	}, 'the attack to reach the defender', 60_000);
}

interface Click {
	/** `pre-block priority` (a bug if it ever appears), `block declare` or `post-block priority`. */
	kind: string;
	phase: string | null;
	message: string;
}

interface DriveResult {
	defender: number;
	/** Every click this harness had to make for the defender, in order. */
	clicks: Click[];
	/** The `stop-decided` log lines for the defender, in order — the evidence for WHY each click was or was not needed. */
	decisions: Record<string, unknown>[];
}

/**
 * Drive the DEFENDER from right after the attacker's own Declare Attackers
 * Step stop through to the ordinary priority window AFTER a block is
 * declared. Presses OK only where the wire shows a real, un-auto-passed stop
 * (`buttons(defender).enable1 === true` on a message this function
 * recognises) — anything the server silently auto-passes is never clicked
 * here, so every entry in `clicks` is a window a real player would have had
 * to answer. Terminates either on that press, or — the fix's whole point —
 * on the server's own `auto-passed` log line for `Declare Blockers Step`,
 * with no click at all.
 */
async function driveDefenderThroughBlock(s: Scenario, defender: number, blockerId: number): Promise<DriveResult> {
	const clicks: Click[] = [];
	// A SELECTION is a `selectCard` act, never gated on the OK button's own
	// enablement — only PRESSING OK is. Gating the select itself on `enable1`
	// was the bug a first draft of this harness had: Forge's Declare Blockers
	// input starts with OK already live (an empty block is always legal), so
	// selecting the blocker can race a transient disable of that SAME button
	// while Forge processes the click — and the block window never reappears
	// once it is confirmed, so a select missed that way hangs forever.
	//
	// The `block declare` click is recorded right there, at the `selectCard`
	// act itself, NOT at a later confirm: this scenario's only legal
	// assignment can resolve (no separate "OK" required) in under the 25ms
	// `waitUntil` normally polls at — measured directly, `docs/planning/
	// wave46-evidence/C/`'s raw dumps show the window closing in as little as
	// 10ms — so waiting for a SEPARATE, later confirm to show up before
	// counting the click conflates "did Forge need a second press" (an
	// `InputBlock` mechanics question, outside `auto.ts` and this lane's file
	// ownership) with "how many real decisions did the defender make" (one:
	// which creature blocks).
	let selected = false;
	await fastPoll(() => {
		s.answerAsks();
		const msg = s.prompt(defender);
		const buttons = s.buttons(defender);
		const phase = s.phase(defender);

		if (/^Select creatures to block/.test(msg)) {
			if (!selected) {
				selected = true;
				clicks.push({ kind: 'block declare', phase, message: msg });
				s.select(defender, blockerId);
				return false;
			}
			// Best-effort: press the explicit confirm too, if Forge is still
			// waiting for one and showing it live. Never required for the click
			// count above, and never a SEPARATE click kind — same interaction.
			if (buttons?.enable1 === true) {
				const blocking = [...s.state(defender).values()].some(
					(o) => o._type === 0 && o._id === blockerId && (o.Blocking as { v?: boolean } | undefined)?.v === true,
				);
				if (blocking) s.ok(defender);
			}
			return false;
		}

		if (!selected) {
			// A real stop BEFORE the block-select window ever opened — the window
			// the tracker's own read named; confirmed elsewhere never to fire, but
			// if it ever does, this is the bug and this harness still catches it.
			if (/^Priority:/.test(msg) && buttons?.enable1 === true) {
				clicks.push({ kind: 'pre-block priority', phase, message: msg });
				s.ok(defender);
			}
			return false;
		}

		// Past the block declare. Either the server silently auto-passed the
		// ordinary Declare Blockers priority window that follows — the fix,
		// when nothing is castable, no click of ours needed — or it is a real
		// stop (something castable) and this is the second click.
		if (s.logs.some((l) => l.evt === 'auto-passed' && l.seat === defender && l.phase === 'Declare Blockers Step')) return true;
		if (/^Priority:/.test(msg) && buttons?.enable1 === true) {
			clicks.push({ kind: 'post-block priority', phase, message: msg });
			s.ok(defender);
			return true;
		}
		return false;
	}, 'the defender to pass through a declared block', 60_000);
	return {
		defender,
		clicks,
		decisions: s.logs.filter((l) => l.evt === 'stop-decided' && l.seat === defender),
	};
}

function writeEvidence(name: string, result: DriveResult): void {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	writeFileSync(join(EVIDENCE_DIR, `${name}.json`), JSON.stringify(result, null, 2));
}

/** Nothing castable: exactly ONE click, the block declare — the fix's whole point. */
function expectOneStop(result: DriveResult): void {
	expect(result.clicks.map((c) => c.kind), `clicks: ${JSON.stringify(result.clicks)}`).toEqual(['block declare']);
}

/** Something castable: the block declare, then the real priority stop that follows it — correct Magic. */
function expectTwoStops(result: DriveResult): void {
	expect(result.clicks.map((c) => c.kind), `clicks: ${JSON.stringify(result.clicks)}`).toEqual(['block declare', 'post-block priority']);
}

/** The pre-block `COMBAT_DECLARE_ATTACKERS` window was silently auto-passed for the defender — never a real stop. */
function expectPreBlockAutoPassed(result: DriveResult): void {
	const preBlock = result.decisions.find((d) => d.phase === 'COMBAT_DECLARE_ATTACKERS' && d.window === 'priority');
	expect(preBlock, `no COMBAT_DECLARE_ATTACKERS priority decision recorded for the defender: ${JSON.stringify(result.decisions)}`).toBeDefined();
	expect(result.decisions.some((d) => d.phase === 'COMBAT_DECLARE_ATTACKERS' && d.decision === 'Declare Attackers Step')).toBe(true);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'idle blocker: the defender declares the block and nothing else — no pre-block stop, and the post-block priority auto-passes',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4601, decks: DECKS, scenario: scenarioText('w46-c-blocker-idle') });
			try {
				await finishMulligan(s);
				const attackerCreature = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.creature);
					},
					"the attacker's board to reflect the scripted creature",
					20_000,
					s,
				).then(() => s.zone(0, 'Battlefield').find((c) => c.creature));
				if (attackerCreature === undefined) throw new Error("no creature on seat 0's battlefield");
				const blocker = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(1, 'Battlefield').some((c) => c.creature);
					},
					"the defender's board to reflect the scripted blocker",
					20_000,
					s,
				).then(() => s.zone(1, 'Battlefield').find((c) => c.creature));
				if (blocker === undefined) throw new Error("no creature on seat 1's battlefield");

				await driveAttackDeclaration(s, 0, attackerCreature.id, () => /^Select creatures to block/.test(s.prompt(1)));
				const result = await driveDefenderThroughBlock(s, 1, blocker.id);
				writeEvidence('idle-blocker', result);

				expectPreBlockAutoPassed(result);
				expectOneStop(result);
				// The precondition that makes "one click" non-vacuous: Forge really
				// did offer nothing to this seat at the post-block priority window.
				const postBlock = result.decisions.filter((d) => d.phase === 'COMBAT_DECLARE_BLOCKERS');
				expect(postBlock.length, JSON.stringify(result.decisions)).toBeGreaterThan(0);
				expect(postBlock.at(-1)?.nonLandSources).toBe(0);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);

	it(
		'reactive defender: a held instant with mana up is still a real stop after the block — correct Magic, two clicks',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4602, decks: DECKS, scenario: scenarioText('w46-c-blocker-reactive') });
			try {
				await finishMulligan(s);
				const attackerCreature = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.creature);
					},
					"the attacker's board to reflect the scripted creature",
					20_000,
					s,
				).then(() => s.zone(0, 'Battlefield').find((c) => c.creature));
				if (attackerCreature === undefined) throw new Error("no creature on seat 0's battlefield");
				const blocker = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(1, 'Battlefield').some((c) => c.creature);
					},
					"the defender's board to reflect the scripted blocker",
					20_000,
					s,
				).then(() => s.zone(1, 'Battlefield').find((c) => c.creature));
				if (blocker === undefined) throw new Error("no creature on seat 1's battlefield");
				expect(s.zone(1, 'Hand').some((c) => c.name === 'Lightning Bolt'), 'the defender holds the scripted instant').toBe(true);

				await driveAttackDeclaration(s, 0, attackerCreature.id, () => /^Select creatures to block/.test(s.prompt(1)));
				const result = await driveDefenderThroughBlock(s, 1, blocker.id);
				writeEvidence('reactive-defender', result);

				expectPreBlockAutoPassed(result);
				// The precondition that makes "still auto-passed" non-vacuous: Forge
				// really did offer the instant and its land as actionable right there.
				// `maybeAutoPass` is consulted on both `updateButtons` and
				// `showPromptMessage` (`match.ts:1344-1356`), so this phase can log
				// either one `stop-decided` line (the facts already settled by the
				// first trigger) or two (an interim `'kept'` read before Forge named
				// the sources, then the real decision) — read the LAST one, which is
				// always the one the facts (and the eventual pass) were decided on.
				const preBlockDecisions = result.decisions.filter((d) => d.phase === 'COMBAT_DECLARE_ATTACKERS');
				expect(preBlockDecisions.length, JSON.stringify(result.decisions)).toBeGreaterThan(0);
				expect(preBlockDecisions.at(-1)?.nonLandSources, `nonLandSources: ${JSON.stringify(result.decisions)}`).toBeGreaterThan(0);
				expectTwoStops(result);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});
