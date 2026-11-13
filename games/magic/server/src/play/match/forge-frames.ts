import { randomBytes } from 'node:crypto';
import { type ChoiceOption, type ClientFrame, type ServerFrame, currentFace, deltaKey, DELTA_TYPE, idsOf, intOf, strOf } from '@hadoku/forge-wire';

import { PAY_MANA, PRIORITY, type StopWindow } from '../auto.js';
import type { SeatState } from './forge-session.js';
import type { WireObj } from '../visibility.js';

/**
 * The acts that are a game input — a click Forge's game thread must take and
 * answer with something. A yield preference, a concede and a resync are not.
 */
/**
 * A bridge frame that tells the seat what it may do next — an ask, a prompt,
 * a bar or a selection — as opposed to state that changed on the way there.
 */
export function answersAnInput(frame: unknown): boolean {
	const f = frame as { kind?: unknown; method?: unknown } | null;
	return f?.kind === 'ask' || f?.method === 'showPromptMessage' || f?.method === 'updateButtons' || f?.method === 'setSelectables';
}

/** Where the game stood at a window, read off Forge's own priority line ("Turn: 16 (…)", "Phase: …", "Stack: Empty" / "Stack: 1 to Resolve."). */
export interface WindowMark {
	turn: number | null;
	phase: string | null;
	stack: number | null;
}

export function windowMark(prompt: { message?: unknown } | null): WindowMark {
	const message = typeof prompt?.message === 'string' ? prompt.message : '';
	const turn = /^Turn: (\d+)/m.exec(message)?.[1];
	const phase = /^Phase: (.+)$/m.exec(message)?.[1] ?? null;
	const stack = /^Stack: Empty$/m.test(message) ? 0 : /^Stack: (\d+)/m.exec(message)?.[1];
	return { turn: turn === undefined ? null : Number(turn), phase, stack: stack === undefined ? null : Number(stack) };
}

/** Forge putting a question or a selection to the seat: an input of its own, never a priority window. */
export function opensAnInput(frame: unknown): boolean {
	const f = frame as { kind?: unknown; method?: unknown } | null;
	return f?.kind === 'ask' || (f?.kind === 'notify' && f.method === 'setSelectables');
}

/** The `why` of a bridge `dropped` line for an act made on an input Forge had moved past (`PlayBridge.java`'s `madeOnAnother`). */
export const STALE_ACT = 'made on an input Forge has moved past';

/** The frames that show a seat its window: the ones whose input an act made on them names. */
export const WINDOW_FRAMES: ReadonlySet<string> = new Set(['showPromptMessage', 'updateButtons', 'setSelectables', 'setWeaklySelectable']);

/** The acts the bridge checks were made on the input still open (`PlayBridge.java`'s `madeOnAnother`). */
export const CHECKED_ACTS: ReadonlySet<string> = new Set(['selectCard', 'selectPlayer', 'selectButtonOk', 'selectButtonCancel']);

/** Forge turning the seat's last act away: its input stands, and nothing more is shown for it. */
export function isRefusal(frame: unknown): boolean {
	const f = frame as { kind?: unknown; method?: unknown } | null;
	return f?.kind === 'notify' && f.method === 'flashIncorrectAction';
}

/** Forge showing a seat its input — what ends {@link SeatState.staleBar}. An ask does not: answering it can still leave Forge silent. */
export function showsAWindow(frame: unknown): boolean {
	const f = frame as { kind?: unknown; method?: unknown } | null;
	return f?.kind === 'notify' && (f.method === 'showPromptMessage' || f.method === 'updateButtons' || f.method === 'setSelectables');
}

/**
 * The bar Forge still has up when it re-shows a payment by its prompt alone, or null. A payment
 * updates its message after every mana paid into it and sends a bar only when Auto can pay the rest
 * (`InputPayMana.updateMessage`): a prompt for the same card's payment with no bar before it is the
 * same input, whose bar {@link Match.disableStaleButtons} took off the seat's screen for the act. Left
 * off, the payment's Cancel stayed dead with nothing left to tap (monkey run 42372898159, Walking
 * Ballista X=20).
 */
export function barForgeKept(s: SeatState, frame: unknown): ButtonsFrame | null {
	if (s.staleBar === null || s.payment === null) return null;
	const f = frame as ServerFrame;
	if (f.kind !== 'notify' || f.method !== 'showPromptMessage' || promptShape(f) !== 'payment') return null;
	if ((f.card?.id ?? null) !== s.payment.card) return null;
	return s.staleBar;
}

export type ActFrame = Extract<ClientFrame, { kind: 'act' }>;

export const INPUT_ACTS: ReadonlySet<string> = new Set(['selectButtonOk', 'selectButtonCancel', 'selectCard', 'selectPlayer', 'selectAbility', 'useMana']);

/** The act as Forge takes it: `sameTarget` is the server's own (`./trigger-targets.ts`), never Forge's. */
export function forgeAct(frame: ActFrame): ActFrame {
	if ((frame.method !== 'selectPlayer' && frame.method !== 'selectCard') || frame.sameTarget === undefined) return frame;
	const { sameTarget: _sameTarget, ...rest } = frame;
	return rest;
}

/** What a seat is shown when its match fails. Title and wording are ours; the frame is forge-wire's. */
export const MATCH_ENDED_TITLE = 'Match ended';

/**
 * How many `message` lines a seat keeps for a re-send after a snapshot.
 *
 * This used to be 8 — a few turns at most — so a reconnect mid-game refilled
 * only the tail. Raised to the whole game with a generous cap, rather than
 * removed outright, so a pathological match cannot grow this array without
 * bound.
 */
export const SAYS_KEPT = 2000;

/**
 * The longest a game log line waits for the delta that shows its cards
 * ({@link Match.onGameLog}). The wait is about order, not secrecy — the bridge
 * already decided the seat may read the line — so a line whose card never
 * becomes visible on this seat's board still goes, this late.
 */
export const LOG_HOLD_MAX_MS = 1000;

/**
 * The name this seat is entitled to see for a card, off its own projected
 * state — never off the raw stream. A card the projection hid has no name here,
 * and the id it falls back to is the one the seat already holds.
 */
/** Forge's own wording for a target question: "Select target noncreature spell", "Valakut, … - Select any target". */
export const TARGET_QUESTION = /\btargets?\b/i;

export function cardName(state: ReadonlyMap<string, WireObj>, id: number): string | null {
	const view = state.get(deltaKey(DELTA_TYPE.card, id));
	if (view === undefined) return null;
	for (const obj of [currentFace(state, id), view]) {
		const name = strOf(obj, 'Name');
		if (name !== null && name !== '') return name;
	}
	return null;
}

/**
 * The id of the card at the TOP of `Game.Stack`, or null with nothing on it.
 * {@link Match.waitingOnFor}'s own fallback: a `showPromptMessage`
 * carries no `card` for an ordinary priority prompt — including the one-shot
 * "Priority: … Stack: 1 to Resolve." window Forge gives the CASTER before
 * their own spell resolves — so a selection or an ask that opens mid-resolution
 * (Thirst for Knowledge's own discard, confirmed against the real jar: a
 * `setSelectables`, not an ask with a card) has no fresher signal to read.
 * `Game.Stack` lists top-first (reversing it
 * gives arrival order), so index 0 is the top.
 */
export function stackTopHostCardId(state: ReadonlyMap<string, WireObj>): number | null {
	const top = idsOf(state.get(deltaKey(DELTA_TYPE.game, 1)), 'Stack')[0];
	return top === undefined ? null : intOf(state.get(deltaKey(DELTA_TYPE.stackItem, top)), 'SourceCard');
}


export interface ProbeResult {
	answer?: boolean;
	ms?: number;
	error?: string;
}

export function newMatchId(): string {
	return `m-${randomBytes(6).toString('hex')}`;
}

/* ── Wave 35 §S, R4: "Thoughtseize is one step" ───────────────────────────
 *
 * `DiscardEffect`'s `RevealYouChoose` mode (Thoughtseize, and any card shaped
 * like it) resolves in THREE Forge asks, confirmed against a real jar
 * (`scenario-thoughtseize.jvm.test.ts`, `wave35-evidence/s3-thoughtseize.md`):
 *
 *   1. `getChoices(message, -1, -1, wholeHand)` to the CASTER — a REVEAL
 *      (Forge's own encoding of "nothing to choose, just look": `rules.ts`'s
 *      `choiceBounds` reads the same `max <= 0` convention this file's
 *      `onlyAnswer` already does for the identical case).
 *   2. `getChoices(message, min, max, validOnly)` to the CASTER — the real
 *      choice, already correctly excluding lands (`DiscardValid$ Card.nonLand`
 *      is Forge's own filter, not ours).
 *   3. `getChoices(message, -1, -1, [theOneCardTaken])` to the DISCARDER — a
 *      second REVEAL, this time of just what was chosen, with no decision at
 *      all.
 *
 * The operator's ruling (2026-10-02): fold 1 into 2 — the caster gets ONE
 * choice showing the whole hand with the unchoosable cards greyed, the
 * "Rampant Growth shape" `apps/ui/src/play/prompts/ChoicePrompts.tsx` already
 * draws for `chooseSingleEntityForEffect`'s `delayedReveal` — and drop 3
 * outright, because the opponent learns which card went from the log and
 * their own graveyard.
 *
 * Both are applied here, generically, over the STRUCTURE of the asks —
 * never a card name or a message string as the deciding fact, same rule
 * `auto.ts`'s own header states for its shortcuts:
 *
 *  - "fold": a `getChoices` reveal (`min === max === -1`) immediately
 *    followed (ignoring ordinary state/notify frames) by a `getChoices`
 *    choice for the SAME SEAT whose `choices` are a subset of the reveal's.
 *    `max === 1` only for now (`chooseSingleEntityForEffect` is singular) —
 *    a `RevealYouChoose` with `NumCards` above 1 is left unmerged, a known
 *    gap noted in the evidence doc rather than guessed at.
 *  - "drop": a `getChoices` reveal whose `choices` are EXACTLY the card ids a
 *    fold or an ordinary reply just sent Forge as a discard choice, for
 *    EITHER seat — `Match.noteDiscardChoice` is the one place that sets it,
 *    from every path that can answer a real discard choice.
 */

/**
 * How long a held reveal Forge said a choice follows (`choiceFollows`, read off Forge's live,
 * resolving ability by `PlayBridge.java`'s `revealChoiceFollows` — never a guess at Forge's
 * speed) waits for that choice. On a loaded host the choice came 295 ms after its reveal, and
 * the seat was shown the reveal and a bare choice apart (closing run 42354601891) under the
 * fixed 250 ms window this replaced (#39: `PENDING_REVEAL_FOLD_MS`, which held EVERY reveal —
 * folding or not — is gone; an unflagged reveal now shows at once, with no wait at all). This
 * only bounds a reveal whose flagged choice never comes, which is logged.
 */
export const PENDING_REVEAL_CHOICE_MS = 10_000;

export type PromptFrame = Extract<ServerFrame, { method: 'showPromptMessage' }>;
export type ButtonsFrame = Extract<ServerFrame, { method: 'updateButtons' }>;

/**
 * What a window asks, read off its frames (a confirm by the ability it confirms): the identity a
 * repeat was once judged by. Kept only to log a window it would have withheld that is a different
 * Forge input (`repeat-unproven`).
 */
export function windowKey(prompt: PromptFrame, buttons: ButtonsFrame | null): string {
	return prompt.confirmAbility != null
		? JSON.stringify(['confirm', prompt.confirmAbility.hostCard.id, prompt.confirmAbility.abilityId])
		: JSON.stringify([prompt.message, prompt.targetAbility ?? null, buttons?.label1 ?? null, buttons?.label2 ?? null]);
}

/**
 * How long a held half waits for the other before it is forwarded undecided.
 * Forge sends the two within a few milliseconds; a payment's bar and its
 * prompt were measured up to 251 ms apart on a loaded jar, so this is
 * headroom, not a target.
 */
export const PROMPT_HOLD_FLUSH_MS = 2000;

/**
 * How long a window the server withheld may stay Forge's open input, with its queue not moving,
 * before it is shown to the seat ({@link Match.armStuckWindow}). An answer Forge takes moves its
 * queue in milliseconds; this is headroom for a loaded jar, not a target.
 */
export const STUCK_WINDOW_MS = 5000;

/** A withheld window kept for the seat in case Forge never takes the answer it was withheld for. */
export interface StuckWindow {
	timer: NodeJS.Timeout;
	prompt: PromptFrame;
	buttons: ButtonsFrame | null;
	offer: ServerFrame | null;
	order: 'prompt-first' | 'buttons-first';
	why: string;
	input: number | null;
	inputMoves: number;
}

/**
 * How long a seat's {@link SeatState.lookHold} waits for the decision behind it before its frames go
 * out anyway. Forge asks within a few milliseconds of the look (6 ms on run 41604622647's scry); a
 * look nothing asks about (a static's `MayLookAt`) is late by this much, once.
 */
export const LOOK_HOLD_FLUSH_MS = 500;

/** One {@link Match.send}, as it will go on the wire. */
export interface WireSend {
	frame: ServerFrame;
	mark: 'displayOnly' | 'pairsWithNext' | null;
	extra?: { forceNotice: true };
}

/**
 * Which decider-readable window a frame belongs to, and so which way it pairs.
 * Forge's inputs send the two halves in a fixed order per input:
 * `InputPassPriority.showNormalPrompt` the prompt and then its OK bar;
 * `InputPayMana.updateMessage` the `Auto` bar and then the prompt (after
 * `showMessage` has already sent a disabled `Auto` bar);
 * `InputConfirm.showMessage` the Yes/No bar and then the prompt;
 * `InputSelectTargets.showMessage` a trigger's target prompt and then its bar.
 * A prompt with no shape here (an attack, a block, a spell's target) is no decider's to answer and
 * is never held, and neither is a bar with none (InputAttack's per-click
 * refresh above all).
 */
export type WindowShape = 'priority' | 'payment' | 'confirm' | 'target';

export function promptShape(frame: PromptFrame): WindowShape | null {
	if (frame.confirmAbility != null) return 'confirm';
	if (frame.targetAbility !== undefined) return 'target';
	if (PAY_MANA.test(frame.message)) return 'payment';
	if (PRIORITY.test(frame.message)) return 'priority';
	return null;
}

export function buttonsShape(frame: ButtonsFrame): WindowShape | null {
	if (frame.label1 === 'Auto') return 'payment';
	if (frame.label1 === 'Yes' && frame.label2 === 'No') return 'confirm';
	return null;
}

/** One decided window, as {@link Match.recordWindow} keeps it for the `match-frames` log event. */
export interface FrameLogEntry {
	t: number;
	seat: number;
	kind: StopWindow;
	decision: 'forwarded' | 'withheld';
	why: string;
	message: string | null;
	buttons: { label1: string; enable1: boolean; label2: string; enable2: boolean } | null;
}

/** How many {@link FrameLogEntry} rows one match keeps — a ring, not a log that grows forever. */
export const FRAMES_RING_SIZE = 500;

/**
 * `InputPassPriority.showYieldSuggestionPrompt`'s own button labels
 * (`en-US.properties`: `lblAccept`, `lblDecline`) — see
 * {@link Match.maybeDeclineYieldSuggestion}'s own header (wave 35 §S item 2).
 */
export const YIELD_ACCEPT_LABEL = 'Accept';
export const YIELD_DECLINE_LABEL = 'Decline';

/** A wait that appears is told to the other seat after this long; one that clears, at once — `Match.checkWaitingOn`. */
export const WAITING_ON_GRACE_MS = 150;

/** How long a just-sent discard choice stays eligible to silence its own echo. */
export const JUST_DISCARDED_TTL_MS = 5_000;

/** The card ids a `getChoices` frame's `choices` name, in order. */
export function choiceCardIds(choices: readonly ChoiceOption[]): number[] {
	const ids: number[] = [];
	for (const c of choices) if (c.ref !== null && c.ref.kind === 'card') ids.push(c.ref.id);
	return ids;
}

/** Every id of `small` is also in `big` — true for an empty `small` too, which never merges here (`.length > 0` guards every call site). */
export function isCardSubset(small: readonly number[], big: readonly number[]): boolean {
	const set = new Set(big);
	return small.every((id) => set.has(id));
}

export function sameCardSet(a: readonly number[], b: ReadonlySet<number>): boolean {
	return a.length === b.size && a.every((id) => b.has(id));
}

export type RevealFrame = Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>;

/**
 * An ask in which nothing may be chosen (`max <= 0`) is Forge showing cards,
 * not asking about them — `reveal(message, items)` IS `getChoices(message, -1,
 * -1, items)` (`AbstractGuiGame.java:785-788`), and the one legal reply to
 * any such ask is the empty list. A `chooseEntitiesForEffect` of that shape is
 * read as the `getChoices` reveal of every card it names (its options, then
 * its `delayedReveal`), each labelled by `nameOf`, so a reveal reaches the
 * seat in one shape whatever Forge called. Null for an ask with something to
 * choose.
 */
export function asReveal(frame: Extract<ServerFrame, { kind: 'ask' }>, nameOf: (ref: NonNullable<ChoiceOption['ref']>) => string): RevealFrame | null {
	if (frame.method === 'getChoices') return frame.max <= 0 ? frame : null;
	if (frame.method !== 'chooseEntitiesForEffect' || frame.max > 0) return null;
	const refs = new Map<string, NonNullable<ChoiceOption['ref']>>();
	for (const ref of [...frame.optionList, ...(frame.delayedReveal?.cards ?? [])]) refs.set(`${ref.kind}:${ref.id}`, ref);
	return {
		kind: 'ask',
		callId: frame.callId,
		method: 'getChoices',
		message: frame.title,
		min: -1,
		max: -1,
		choices: [...refs.values()].map((ref, i) => ({ key: `c${i}`, label: nameOf(ref), ref })),
		selected: [],
	};
}
