import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { DraftCard } from '@hadoku/shared';
import { createDraft } from '@hadoku/draft';

import { askDraftbot, chooseByRatings, draftbotTally, httpDraftbot, modelSeatsOf, type Draftbot } from './draftbot.ts';

function card(name: string, oracleId?: string): DraftCard {
	return {
		cardId: name,
		name,
		manaCost: [],
		manaValue: 1,
		colors: [],
		typeLine: 'Creature — Test',
		oracleText: '',
		setCode: 'TST',
		collectorNumber: '1',
		rarity: 'common',
		...(oracleId === undefined ? {} : { oracleId }),
	};
}

/** Three bot seats, three cards a pack; seat 2's cards have no oracle id. */
function draft() {
	const packs = [[0, 1, 2].map((seat) => [0, 1, 2].map((k) => card(`p${seat}-${k}`, seat === 2 ? undefined : `o${seat}-${k}`)))];
	return createDraft({ draftId: 'd', seed: 'd', packs, seatCount: 3, packCount: 1, packSize: 3, humans: [] });
}

const never = new AbortController().signal;

describe('askDraftbot', () => {
	it('sends one batch of the packs with oracle ids, and a seat with none answers unrated', async () => {
		const batchDraft = vi.fn<Draftbot['batchDraft']>(async (inputs) => inputs.map((i) => i.pack.map((oracle, k) => ({ oracle, rating: k }))));
		const state = draft();
		const answer = await askDraftbot({ batchDraft }, state, never);
		expect(batchDraft).toHaveBeenCalledTimes(1);
		expect(batchDraft.mock.calls[0]![0]).toEqual([
			{ pack: ['o0-0', 'o0-1', 'o0-2'], pool: [] },
			{ pack: ['o1-0', 'o1-1', 'o1-2'], pool: [] },
		]);
		const { chosen, outcomes } = chooseByRatings(state, answer);
		expect([...chosen]).toEqual([
			[0, 'p0-2'],
			[1, 'p1-2'],
		]);
		expect(outcomes).toEqual(['served', 'served', 'unrated']);
	});

	it('a split room asks for the odd seats only, and the even seats are the heuristic\'s with no outcome', async () => {
		const batchDraft = vi.fn<Draftbot['batchDraft']>(async (inputs) => inputs.map((i) => i.pack.map((oracle, k) => ({ oracle, rating: k }))));
		const state = draft();
		const answer = await askDraftbot({ batchDraft }, state, never, modelSeatsOf('split'));
		expect(batchDraft.mock.calls[0]![0]).toEqual([{ pack: ['o1-0', 'o1-1', 'o1-2'], pool: [] }]);
		const { chosen, outcomes } = chooseByRatings(state, answer, modelSeatsOf('split'));
		expect([...chosen]).toEqual([[1, 'p1-2']]);
		expect(outcomes).toEqual(['served']);
	});

	it('a pick-order room never calls the draftbot, and every bot is the heuristic\'s with no outcome', async () => {
		const batchDraft = vi.fn<Draftbot['batchDraft']>(async () => []);
		const state = draft();
		const answer = await askDraftbot({ batchDraft }, state, never, modelSeatsOf('pick-order'));
		expect(batchDraft).not.toHaveBeenCalled();
		const { chosen, held, outcomes } = chooseByRatings(state, answer, modelSeatsOf('pick-order'));
		expect([chosen.size, held.size, outcomes]).toEqual([0, 0, []]);
	});

	it('a rejection is an error and an abort a timeout, for every seat', async () => {
		const state = draft();
		const error = await askDraftbot({ batchDraft: async () => Promise.reject(new Error('boom')) }, state, never);
		expect(error).toEqual({ failed: 'error', detail: 'boom' });
		expect(chooseByRatings(state, error).outcomes).toEqual(['error', 'error', 'error']);
		const ask = new AbortController();
		const late = askDraftbot({ batchDraft: (_i, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }, state, ask.signal);
		ask.abort();
		expect(chooseByRatings(state, await late).outcomes).toEqual(['timeout', 'timeout', 'timeout']);
	});

	it('a seat the answer does not cover is held for the next ask; a top card gone from the pack is stale', async () => {
		const state = draft();
		const answer = { ratings: new Map([[0, [{ oracle: 'o0-0', rating: 1 }]]]) };
		// Seats 1 and 2 were never asked: their packs reached them after the ask.
		const now = chooseByRatings(state, answer);
		expect(now.outcomes).toEqual(['served', 'held', 'held']);
		expect([...now.held]).toEqual([1, 2]);
		// Seat 0's top-rated card is one its pack does not hold.
		const gone = chooseByRatings(state, { ratings: new Map([[0, [{ oracle: 'o1-0', rating: 1 }]], [1, []], [2, []]]) });
		expect(gone.chosen.size).toBe(0);
		expect(gone.outcomes).toEqual(['stale', 'unrated', 'unrated']);
		expect(gone.held.size).toBe(0);
	});
});

describe('draftbotTally', () => {
	it('counts picks by outcome per drain, and logs a failure streak once and its end once', () => {
		const log = vi.fn();
		const tally = draftbotTally(log);
		for (let turn = 0; turn < 3; turn++) tally.record({ failed: 'timeout' }, ['timeout', 'timeout']);
		tally.record({ ratings: new Map() }, ['served', 'unrated']);
		tally.record({ failed: 'unset' }, ['unset']);
		expect(tally.drain()).toEqual({ served: 1, held: 0, unset: 1, timeout: 6, error: 0, unrated: 1, stale: 0 });
		expect(tally.drain().timeout).toBe(0);
		expect(log.mock.calls.map(([l]) => l.evt)).toEqual(['draftbot-failing', 'draftbot-recovered']);
		expect(log.mock.calls[1]![0].failedTurns).toBe(3);
	});
});

describe('httpDraftbot', () => {
	async function serve(answer: (req: IncomingMessage, body: string) => unknown): Promise<{ url: string; close: () => void }> {
		const server = createServer((req, res) => {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify(answer(req, body)));
			});
		});
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
	}

	it('posts the batch with its token and returns the ratings', async () => {
		const seen: { path?: string; token?: string; body?: unknown } = {};
		const svc = await serve((req, body) => {
			Object.assign(seen, { path: req.url, token: req.headers['x-internal-token'], body: JSON.parse(body) });
			return { success: true, results: [[{ oracle: 'a', rating: 0.9 }]] };
		});
		try {
			const ratings = await httpDraftbot(svc.url, 'secret').batchDraft([{ pack: ['a', 'b'], pool: [] }], never);
			expect(ratings).toEqual([[{ oracle: 'a', rating: 0.9 }]]);
			expect(seen).toEqual({ path: '/batchdraft', token: 'secret', body: { inputs: [{ pack: ['a', 'b'], pool: [] }] } });
		} finally {
			svc.close();
		}
	});

	it('rejects an answer of the wrong shape, or for the wrong number of packs', async () => {
		for (const bad of [{ success: false }, { success: true, results: [[{ oracle: 'a' }]] }, { success: true, results: [] }]) {
			const svc = await serve(() => bad);
			try {
				await expect(httpDraftbot(svc.url).batchDraft([{ pack: ['a'], pool: [] }], never)).rejects.toThrow(/draftbot/);
			} finally {
				svc.close();
			}
		}
	});

	const real = process.env.CARDTABLE_DRAFTBOT_URL;
	it.skipIf(!real)('a real service rates a pack it knows', async () => {
		// Two oracle ids every CubeCobra model knows: Lightning Bolt and Counterspell.
		const pack = ['4457ed35-7c10-48c8-9776-456485fdf070', 'cc187110-1148-4090-bbb8-e205694a39f5'];
		const ratings = await httpDraftbot(real!, process.env.CARDTABLE_DRAFTBOT_TOKEN || undefined).batchDraft(
			[{ pack, pool: [] }],
			AbortSignal.timeout(5000),
		);
		expect(ratings).toHaveLength(1);
		expect(ratings[0]!.map((r) => r.oracle).sort()).toEqual([...pack].sort());
	});
});
