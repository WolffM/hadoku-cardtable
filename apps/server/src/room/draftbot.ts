/*
 * CubeCobra's ML draftbot, asked over HTTP for the seat-filling bots' picks.
 *
 * The service (WolffM/cardtable-draftbot) rates every card of a pack it knows
 * for a pool, by oracle id. A bot takes the top-rated card of its pack; a seat
 * the service could not answer for — no service, a failure, a timeout, no
 * rated card, or a card that has since left the pack — takes the heuristic's
 * pick (`@hadoku/draft`'s `botTurn`), which is what every bot did before this.
 *
 * `Draftbot` is the seam: `httpDraftbot` is one plain service for local runs
 * (`CARDTABLE_DRAFTBOT_URL`); production passes its own to `attachDraftSocket`.
 */

import { z } from 'zod';
import type { SeatId } from '@wolffm/rooms-protocol';
import type { DraftCard } from '@hadoku/shared';
import { isBotSeat, packOf, waitingOn, type DraftState } from '@hadoku/draft';

/** Oracle ids: the cards in the pack being picked from, and the ones already taken. */
export interface DraftbotInput {
	pack: string[];
	pool: string[];
}

/** One list per input, in input order: each pack's known cards, best first. */
export type DraftbotRatings = { oracle: string; rating: number }[][];

export interface Draftbot {
	/** Rejects on any failure, including an answer of the wrong shape. */
	batchDraft(inputs: DraftbotInput[], signal: AbortSignal): Promise<DraftbotRatings>;
}

const BatchDraftResponse = z.object({
	success: z.literal(true),
	results: z.array(z.array(z.object({ oracle: z.string(), rating: z.number() }))),
});

export function httpDraftbot(baseUrl: string, token?: string): Draftbot {
	const url = `${baseUrl.replace(/\/+$/, '')}/batchdraft`;
	return {
		async batchDraft(inputs, signal) {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(token ? { 'x-internal-token': token } : {}) },
				body: JSON.stringify({ inputs }),
				signal,
			});
			if (!res.ok) throw new Error(`draftbot answered ${res.status}`);
			const parsed = BatchDraftResponse.safeParse(await res.json());
			if (!parsed.success) throw new Error(`draftbot answer malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
			if (parsed.data.results.length !== inputs.length) {
				throw new Error(`draftbot answered ${parsed.data.results.length} packs for ${inputs.length}`);
			}
			return parsed.data.results;
		},
	};
}

/** Where one bot pick came from: the draftbot, or the heuristic and why. */
export type DraftbotOutcome = 'served' | 'unset' | 'timeout' | 'error' | 'unrated' | 'stale';
export const DRAFTBOT_OUTCOMES: readonly DraftbotOutcome[] = ['served', 'unset', 'timeout', 'error', 'unrated', 'stale'];

/** The answer for one bot turn: ratings per bot seat asked, or why there are none. */
export type DraftbotAnswer =
	| { ratings: ReadonlyMap<SeatId, DraftbotRatings[number]> }
	| { failed: 'unset' | 'timeout' | 'error'; detail?: string };

function oracles(cards: readonly DraftCard[]): string[] {
	return cards.map((c) => c.oracleId).filter((o): o is string => o !== undefined);
}

function owingBots(state: DraftState): SeatId[] {
	return waitingOn(state).filter((s) => isBotSeat(state, s));
}

/**
 * One batch for every bot seat holding a pack. Never rejects: a failure is the
 * answer `{ failed }`, a timeout when `signal` was aborted first. A seat whose
 * pack has no card with an oracle id is not sent and answers with no ratings.
 */
export async function askDraftbot(draftbot: Draftbot, state: DraftState, signal: AbortSignal): Promise<DraftbotAnswer> {
	const seats = owingBots(state);
	const ratings = new Map<SeatId, DraftbotRatings[number]>(seats.map((s) => [s, []]));
	const asked = seats
		.map((seat) => ({ seat, input: { pack: oracles(packOf(state, seat)), pool: oracles(state.pools[seat] as DraftCard[]) } }))
		.filter((a) => a.input.pack.length > 0);
	if (asked.length === 0) return { ratings };
	try {
		const results = await draftbot.batchDraft(
			asked.map((a) => a.input),
			signal,
		);
		asked.forEach((a, i) => ratings.set(a.seat, results[i] ?? []));
		return { ratings };
	} catch (err) {
		return { failed: signal.aborted ? 'timeout' : 'error', detail: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * The card each bot seat takes from the draftbot's answer, against the draft as
 * it is NOW — the answer may be older than the state. A seat gets a card only if
 * the top-rated card is still in its pack; every owing seat gets an outcome.
 */
export function chooseByRatings(state: DraftState, answer: DraftbotAnswer): { chosen: Map<SeatId, string>; outcomes: DraftbotOutcome[] } {
	const chosen = new Map<SeatId, string>();
	const outcomes: DraftbotOutcome[] = [];
	for (const seat of owingBots(state)) {
		if ('failed' in answer) {
			outcomes.push(answer.failed);
			continue;
		}
		const rated = answer.ratings.get(seat);
		if (rated === undefined) {
			outcomes.push('stale');
			continue;
		}
		const top = rated.reduce<DraftbotRatings[number][number] | null>((best, r) => (best === null || r.rating > best.rating ? r : best), null);
		if (top === null) {
			outcomes.push('unrated');
			continue;
		}
		const card = packOf(state, seat).find((c) => c.oracleId === top.oracle);
		if (card === undefined) {
			outcomes.push('stale');
			continue;
		}
		chosen.set(seat, card.cardId);
		outcomes.push('served');
	}
	return { chosen, outcomes };
}

/**
 * Picks by outcome, drained into each `capacity` post. A failure streak logs
 * once when it starts and once when the draftbot serves again, never per pick.
 */
export function draftbotTally(log: (entry: Record<string, unknown>) => void): {
	record(answer: DraftbotAnswer, outcomes: readonly DraftbotOutcome[]): void;
	drain(): Record<DraftbotOutcome, number>;
} {
	const zero = (): Record<DraftbotOutcome, number> => Object.fromEntries(DRAFTBOT_OUTCOMES.map((o) => [o, 0])) as Record<DraftbotOutcome, number>;
	let counts = zero();
	let failedTurns = 0;
	return {
		record(answer, outcomes) {
			for (const o of outcomes) counts[o] += 1;
			if ('failed' in answer && answer.failed !== 'unset') {
				if (failedTurns === 0) log({ evt: 'draftbot-failing', reason: answer.failed, detail: answer.detail });
				failedTurns += 1;
			} else if ('ratings' in answer && failedTurns > 0) {
				log({ evt: 'draftbot-recovered', failedTurns });
				failedTurns = 0;
			}
		},
		drain() {
			const out = counts;
			counts = zero();
			return out;
		},
	};
}
