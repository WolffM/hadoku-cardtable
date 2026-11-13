/**
 * A modal spell's modes are one prompt.
 *
 * Forge asks "choose two" as one question per mode
 * (`PlayerControllerHuman.chooseModeForAbility`): a `getChoices` of one over
 * every mode, then the same question over the modes left, `num` times in all
 * — `oneOrNone` once `min` modes are in, where the player may stop. The
 * operator, on Cryptic Command: *"it has two steps, first pick one then pick
 * another. ideally this is just a single step where you pick two."*
 *
 * The bridge marks the first question with Forge's own count (`modes`,
 * `PlayBridge.java`'s `ModeCounts`). The seat is asked that question once,
 * picking `min`..`max` modes; Forge is sent the first pick, and every later
 * mode question is answered here from the same reply, never shown. A later
 * question that does not offer the mode next in line (Forge took modes away
 * the reply could not foresee) is shown to the seat like any other.
 */

import type { ServerFrame } from '@hadoku/forge-wire';

type ChoicesAsk = Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>;

/** The modes the seat's one reply still owes Forge, in the order it gave them, and the question they answer. */
export interface ModesLeft {
	message: string;
	labels: string[];
}

/** The seat's question for a modal spell's first mode question: every mode it picks, at once. Null for any other ask. */
export function modesAsk(frame: Extract<ServerFrame, { kind: 'ask' }>): ChoicesAsk | null {
	if (frame.method !== 'getChoices' || frame.modes === undefined || frame.max !== 1) return null;
	const { min, max } = frame.modes;
	if (max < 2 || max > frame.choices.length || min > max) return null;
	return { ...frame, min, max };
}

/** Forge's answer to its first mode question, from the seat's reply to `ask`, and what that reply still owes. */
export function firstMode(ask: ChoicesAsk, reply: readonly string[]): { result: string[]; left: ModesLeft } {
	const labelOf = new Map(ask.choices.map((c) => [c.key, c.label]));
	return { result: reply.slice(0, 1), left: { message: ask.message, labels: reply.slice(1).map((k) => labelOf.get(k)!) } };
}

/**
 * A later mode question answered from what the reply still owes: the next mode
 * by its label, or no mode at all once the seat's picks are spent (Forge asks
 * on, optionally, past `min`). Null when `frame` is not that question.
 */
export function nextMode(frame: Extract<ServerFrame, { kind: 'ask' }>, left: ModesLeft): { result: string[]; left: ModesLeft } | null {
	if (frame.method !== 'getChoices' || frame.message !== left.message || frame.max !== 1 || frame.modes !== undefined) return null;
	const [next, ...rest] = left.labels;
	if (next === undefined) return frame.min === 0 ? { result: [], left } : null;
	const choice = frame.choices.find((c) => c.label === next);
	return choice === undefined ? null : { result: [choice.key], left: { message: left.message, labels: rest } };
}
