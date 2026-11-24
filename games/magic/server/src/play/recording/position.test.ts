import { describe, expect, it } from 'vitest';
import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { loadTranscript } from '../fixtures/transcript.js';
import type { BridgeLine } from '../bridge-protocol.js';
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
	it("leaves a player's name out, never a card's: the action log names its humans Player N", () => {
		const player = deltaKey(DELTA_TYPE.player, 0);
		const card = deltaKey(DELTA_TYPE.card, 81);
		const live = [setGameView(0, { [player]: { _type: 1, _id: 0, Name: { t: 'str', v: 'Ada' }, LobbyPlayerName: { t: 'str', v: 'Ada' }, Life: { t: 'int', v: 20 } } })];
		const rebuilt = [setGameView(0, { [player]: { _type: 1, _id: 0, Name: { t: 'str', v: 'Player 1' }, LobbyPlayerName: { t: 'str', v: 'Player 1' }, Life: { t: 'int', v: 20 } } })];
		expect(boardDigest(rebuilt, 0)).toBe(boardDigest(live, 0));
		const game = deltaKey(DELTA_TYPE.game, 1);
		const titled = (title: string, winner: string) => [setGameView(0, { [game]: { _type: 3, _id: 1, Title: { t: 'str', v: title }, WinningPlayerName: { t: 'str', v: winner }, Turn: { t: 'int', v: 1 } } })];
		expect(boardDigest(titled('Player 1 vs Player 2 (0-0)', 'Player 2'), 0)).toBe(boardDigest(titled('Ada vs Bo (0-0)', 'Bo'), 0));
		const lifeLost = [setGameView(0, { [player]: { _type: 1, _id: 0, Name: { t: 'str', v: 'Ada' }, Life: { t: 'int', v: 17 } } })];
		expect(boardDigest(lifeLost, 0)).not.toBe(boardDigest(live, 0));
		const bolt = [setGameView(0, { [card]: { _type: 0, _id: 81, Name: { t: 'str', v: 'Lightning Bolt' } } })];
		const shock = [setGameView(0, { [card]: { _type: 0, _id: 81, Name: { t: 'str', v: 'Shock' } } })];
		expect(boardDigest(shock, 0)).not.toBe(boardDigest(bolt, 0));
	});

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

	it("folds a real bridge transcript, both seats, to boardDigest's whole-history fold after every line", () => {
		const transcript = loadTranscript();
		const positions = [createSeatPosition(0), createSeatPosition(1)];
		for (let i = 0; i < transcript.length; i++) {
			for (const pos of positions) pos.push(transcript[i]!);
			const seen = transcript.slice(0, i + 1);
			positions.forEach((pos, seat) => expect(pos.digest(), `seat ${seat}, line ${i}`).toBe(boardDigest(seen, seat)));
		}
		expect(transcript.filter((l) => isStateLine(l, 0)).length).toBeGreaterThan(4);
	});

	it('ignores lines for a different seat', () => {
		const pos = createSeatPosition(0);
		pos.push(setGameView(1, { 'card:9': { _type: 1, _id: 9 } }));
		expect(pos.digest()).toBe(boardDigest([], 0));
		pos.push(prompt(1, 'not mine'));
		expect(pos.prompt()).toBe('');
	});
});
