/**
 * "Last played": a finished room match stamps each person's deck in their own document
 * (`users/`), bot games included, over a real store directory.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Match } from '../play/match.js';
import { createMagicUserStore } from '../users/index.ts';
import { createKeyBook, createMatchStats, type MatchStartInput } from './index.ts';

const ALICE = 'a11ce000-7b3d-4a8e-9c56-2f0d1b8e6a03';
const BOB = 'b0b00000-2a4f-4e6b-8c9d-0f1e2d3c4b5a';
const MEMBERS: Record<string, string> = { 'fk:alice': ALICE, 'fk:bob': BOB };

const deck = (id?: string) => ({ name: 'A deck', ...(id === undefined ? {} : { id }), colors: [], cards: 40, basicLands: 17 });

function setup(start: MatchStartInput, at = 5_000) {
	const users = createMagicUserStore(join(mkdtempSync(join(tmpdir(), 'played-')), 'users'), () => undefined);
	const logs: Record<string, unknown>[] = [];
	const stats = createMatchStats({
		keys: createKeyBook(),
		log: (e) => logs.push(e),
		reporter: { report: async () => undefined } as never,
		startOf: () => start,
		now: () => at,
		played: { users, userOf: (roomId, memberId) => (roomId === start.roomId ? (MEMBERS[memberId] ?? null) : null) },
	});
	return { users, stats, logs };
}

const match = { id: 'm-aaaaaaaaaaaa' } as Match;

describe('the last-played stamp', () => {
	it("stamps each person's deck in their own document, and not the AI's", async () => {
		const { users, stats } = setup({
			mode: 'constructed',
			roomId: 'r-1',
			startedAt: 0,
			attrs: {},
			seats: [
				{ ai: false, memberId: 'fk:alice', deck: deck('draft:pod-1') },
				{ ai: true, memberId: null, deck: deck('library-deck') },
			],
		});
		stats.gameOver(match);
		await vi.waitFor(async () => expect((await users.get(ALICE)).decks).toEqual({ 'draft:pod-1': { lastPlayedAt: 5_000 } }));
		expect(await users.get(BOB)).toMatchObject({ decks: {} });
	});

	it('stamps both people in a game between two, each under their own deck', async () => {
		const { users, stats } = setup({
			mode: 'constructed',
			roomId: 'r-1',
			startedAt: 0,
			attrs: {},
			seats: [
				{ ai: false, memberId: 'fk:alice', deck: deck('built:abc') },
				{ ai: false, memberId: 'fk:bob', deck: deck('draft:pod-9') },
			],
		});
		stats.gameOver(match);
		await vi.waitFor(async () => expect((await users.get(BOB)).decks).toEqual({ 'draft:pod-9': { lastPlayedAt: 5_000 } }));
		expect((await users.get(ALICE)).decks).toEqual({ 'built:abc': { lastPlayedAt: 5_000 } });
	});

	it('stamps nothing for a pasted deck, a seat nobody can be named for, or a match no room started', async () => {
		const { users, stats } = setup({
			mode: 'constructed',
			roomId: 'r-1',
			startedAt: 0,
			attrs: {},
			seats: [
				{ ai: false, memberId: 'fk:alice', deck: deck() },
				{ ai: false, memberId: 'fk:stranger', deck: deck('draft:pod-1') },
			],
		});
		stats.gameOver(match);
		const none = createMatchStats({ keys: createKeyBook(), log: () => undefined, reporter: { report: async () => undefined } as never, startOf: () => null, played: { users, userOf: () => ALICE } });
		none.gameOver(match);
		await new Promise((r) => setTimeout(r, 50));
		expect((await users.get(ALICE)).decks).toEqual({});
	});

	it('never moves a stamp backwards', async () => {
		const start: MatchStartInput = { mode: 'constructed', roomId: 'r-1', startedAt: 0, attrs: {}, seats: [{ ai: false, memberId: 'fk:alice', deck: deck('draft:pod-1') }] };
		const { users, stats } = setup(start, 1_000);
		await users.update(ALICE, (d) => void (d.decks['draft:pod-1'] = { lastPlayedAt: 9_000 }));
		stats.gameOver(match);
		await new Promise((r) => setTimeout(r, 50));
		expect((await users.get(ALICE)).decks['draft:pod-1']).toEqual({ lastPlayedAt: 9_000 });
	});
});
