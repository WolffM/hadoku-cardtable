/**
 * `secretsFor`'s own blind spot: a face-down card in a PUBLIC zone (the stack, a battlefield, …)
 * used to be waved through as fully known to every viewer, because the zone itself is public —
 * `visibility.ts`'s own rule is finer than that (`PEEKABLE_FACE_DOWN_ZONES`): a face-down card's
 * TRUE face stays secret from everyone but its controller, even on the stack. Before the fix, such a
 * card's id never reached `hiddenCards`, so a real leak of its name would never have been registered
 * as a secret to catch — `leaked()` would have stayed silent over a server that actually leaked it.
 *
 * `states` here models Forge's own UNFILTERED per-seat stream (`rawStatesOf`'s shape, as every other
 * `secretsFor` caller uses it): Forge's raw data always carries a card's real `Name`, whether or not
 * this seat is allowed to know it. `secretsFor`'s job is to say which of those names are secrets.
 */

import { describe, expect, it } from 'vitest';

import { DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';

import type { WireObj } from '../visibility.js';
import { leaked, secretsFor } from './transcript.js';

const int = (v: number) => ({ t: 'int', v });
const bool = (v: boolean) => ({ t: 'bool', v });
const str = (v: string) => ({ t: 'str', v });
const list = (ids: readonly number[]) => ({ t: 'list', v: ids.map(int) });

/** Seat 0 is the viewer; seat 1 controls a face-down spell (card 50) on the stack. */
const CARD_ID = 50;
const STACK_ITEM_ID = 1;
const NAME = 'Lightning Bolt';

function stateWith(opts: { facedown: boolean; controller: number }): Map<string, WireObj> {
	const card: WireObj = { _type: DELTA_TYPE.card, _id: CARD_ID, Owner: int(opts.controller), Controller: int(opts.controller), Facedown: bool(opts.facedown), Name: str(NAME) };
	const stackItem: WireObj = { _type: DELTA_TYPE.stackItem, _id: STACK_ITEM_ID, SourceCard: int(CARD_ID) };
	const game: WireObj = { _type: DELTA_TYPE.game, _id: 0, Stack: list([STACK_ITEM_ID]) };
	const empty = (id: number): WireObj => ({ _type: DELTA_TYPE.player, _id: id, Hand: list([]), Sideboard: list([]), Library: list([]) });
	return new Map([
		[deltaKey(DELTA_TYPE.card, CARD_ID), card],
		[deltaKey(DELTA_TYPE.stackItem, STACK_ITEM_ID), stackItem],
		[deltaKey(DELTA_TYPE.game, 0), game],
		[deltaKey(DELTA_TYPE.player, 0), empty(0)],
		[deltaKey(DELTA_TYPE.player, 1), empty(1)],
	]);
}

describe('secretsFor: a face-down card in a public zone is not waved through just because the zone is', () => {
	it("an opponent's face-down spell on the stack stays a secret, not everyone's to know", () => {
		const { secrets, hiddenCards } = secretsFor([stateWith({ facedown: true, controller: 1 })], 0);
		expect(hiddenCards.has(CARD_ID), 'the stack is public, but this viewer is not its controller').toBe(true);
		expect(secrets.has(NAME), 'its true name is a secret from this viewer').toBe(true);
	});

	it('is non-vacuous: a server that leaked the name into this viewer’s packet would be caught', () => {
		const { secrets } = secretsFor([stateWith({ facedown: true, controller: 1 })], 0);
		// What the product actually sends this viewer, correctly redacted (no Name) — not leaked.
		const correct = JSON.stringify({ _type: DELTA_TYPE.card, _id: CARD_ID, Facedown: bool(true) });
		expect(leaked(secrets, correct), 'a correctly redacted packet names nothing').toEqual([]);
		// A buggy send that forgot to redact it.
		const buggy = JSON.stringify({ _type: DELTA_TYPE.card, _id: CARD_ID, Facedown: bool(true), Name: str(NAME) });
		expect(leaked(secrets, buggy), 'the oracle catches the leak').toEqual([NAME]);
	});

	it('a face-down card the viewer controls is theirs to know: not a secret, and its own face-down stack items stay full to them', () => {
		const { secrets, hiddenCards } = secretsFor([stateWith({ facedown: true, controller: 0 })], 0);
		expect(hiddenCards.has(CARD_ID)).toBe(false);
		expect(secrets.has(NAME)).toBe(false);
	});

	it('a card that is not face-down is shown in a public zone as before, facedown or not aside', () => {
		const { hiddenCards } = secretsFor([stateWith({ facedown: false, controller: 1 })], 0);
		expect(hiddenCards.has(CARD_ID), 'face up on the stack, anyone may know it').toBe(false);
	});
});
