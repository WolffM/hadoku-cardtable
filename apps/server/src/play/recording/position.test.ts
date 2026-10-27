import { describe, expect, it } from 'vitest';

import type { BridgeLine } from '../host.js';
import { boardDigest, createSeatPosition, isStateLine, lastPrompt, normalisedBoard, STATE_METHODS } from './position.js';

function setGameView(seat: number, gameView: Record<string, { _type: number; _id: number; [k: string]: unknown }>): BridgeLine {
	return { t: 'frame', seat, frame: { kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 0 } } };
}

function delta(seat: number, objectDeltas: Record<string, Record<string, unknown>>): BridgeLine {
	return {
		t: 'frame',
		seat,
		frame: { kind: 'notify', method: 'applyDelta', payload: { packet: { seq: 0, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas } } },
	};
}

function prompt(seat: number, message: string): BridgeLine {
	return { t: 'frame', seat, frame: { kind: 'notify', method: 'showPromptMessage', message } };
}

describe('STATE_METHODS / isStateLine', () => {
	it('names exactly the three fold-bearing bridge frames', () => {
		expect([...STATE_METHODS].sort()).toEqual(['applyDelta', 'openView', 'setGameView']);
	});

	it('is false for a non-frame line, a different seat, and a non-state method', () => {
		expect(isStateLine({ t: 'ready', forgePort: 0, bootMs: 0, seats: [] })).toBe(false);
		expect(isStateLine(setGameView(0, {}), 1)).toBe(false);
		expect(isStateLine(prompt(0, 'hi'))).toBe(false);
		expect(isStateLine(setGameView(0, {}))).toBe(true);
	});
});

describe('normalisedBoard / boardDigest', () => {
	it('drops a property at its default value, so a batched-empty send matches an omitted one', () => {
		const withEmpty = [setGameView(0, { 'card:1': { _type: 1, _id: 1, Mana: { t: 'list', v: [] } } })];
		const withoutIt = [setGameView(0, { 'card:1': { _type: 1, _id: 1 } })];
		expect(normalisedBoard(withEmpty, 0)).toBe(normalisedBoard(withoutIt, 0));
		expect(boardDigest(withEmpty, 0)).toBe(boardDigest(withoutIt, 0));
	});

	it('is a sha-256 hex digest, not the board itself', () => {
		const digest = boardDigest([setGameView(0, { 'card:1': { _type: 1, _id: 1, Name: { t: 's', v: 'Shock' } } })], 0);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('differs when the folded board differs', () => {
		const a = boardDigest([setGameView(0, { 'card:1': { _type: 1, _id: 1, Name: { t: 's', v: 'Shock' } } })], 0);
		const b = boardDigest([setGameView(0, { 'card:1': { _type: 1, _id: 1, Name: { t: 's', v: 'Bolt' } } })], 0);
		expect(a).not.toBe(b);
	});

	it('only folds the named seat', () => {
		const lines = [setGameView(0, { 'card:1': { _type: 1, _id: 1 } }), setGameView(1, { 'card:2': { _type: 1, _id: 2 } })];
		expect(normalisedBoard(lines, 0)).not.toBe(normalisedBoard(lines, 1));
	});

	it('folds applyDelta on top of setGameView, same as a client would', () => {
		const lines = [setGameView(0, { 'card:1': { _type: 1, _id: 1, Tapped: { t: 'b', v: false } } }), delta(0, { 'card:1': { Tapped: { t: 'b', v: true } } })];
		expect(normalisedBoard(lines, 0)).toBe(normalisedBoard([setGameView(0, { 'card:1': { _type: 1, _id: 1, Tapped: { t: 'b', v: true } } })], 0));
	});
});

describe('lastPrompt', () => {
	it('is "" before any prompt, and the latest one after', () => {
		expect(lastPrompt([setGameView(0, {})], 0)).toBe('');
		expect(lastPrompt([prompt(0, 'first'), prompt(0, 'second')], 0)).toBe('second');
	});

	it('only reads the named seat', () => {
		expect(lastPrompt([prompt(0, 'A'), prompt(1, 'B')], 0)).toBe('A');
	});
});

describe('createSeatPosition — incremental matches boardDigest/lastPrompt over the same history', () => {
	it('tracks a sequence of setGameView, applyDelta and prompts exactly as the whole-history fold does', () => {
		const lines: BridgeLine[] = [
			setGameView(0, { 'card:1': { _type: 1, _id: 1, Tapped: { t: 'b', v: false } } }),
			prompt(0, 'Priority: A'),
			delta(0, { 'card:1': { Tapped: { t: 'b', v: true } } }),
			prompt(0, 'Priority: B'),
			setGameView(0, { 'card:1': { _type: 1, _id: 1, Tapped: { t: 'b', v: false } }, 'card:2': { _type: 1, _id: 2 } }),
		];
		const pos = createSeatPosition(0);
		const seen: BridgeLine[] = [];
		for (const line of lines) {
			pos.push(line);
			seen.push(line);
			expect(pos.digest()).toBe(boardDigest(seen, 0));
			expect(pos.prompt()).toBe(lastPrompt(seen, 0));
		}
	});

	it('ignores lines for a different seat', () => {
		const pos = createSeatPosition(0);
		pos.push(setGameView(1, { 'card:9': { _type: 1, _id: 9 } }));
		expect(pos.digest()).toBe(boardDigest([], 0));
		pos.push(prompt(1, 'not mine'));
		expect(pos.prompt()).toBe('');
	});
});
