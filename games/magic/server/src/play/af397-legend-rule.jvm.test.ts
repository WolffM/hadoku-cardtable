/**
 * AF397 (doomed cards): the legend rule's own choice, against real Forge.
 *
 * `GameAction.handleLegendRule` asks through `PlayerController.chooseSingleEntityForEffect`, but
 * every option it offers is a battlefield card, so `PlayerControllerHuman.useSelectCardsInput`
 * routes it through `InputSelectEntitiesFromList` (a plain selection, `setSelectables`) — never the
 * `chooseSingleEntityForEffect` RPC. A first draft of this test waited on that RPC and timed out;
 * this is the fact that correction depends on, so it is pinned here rather than only in a comment.
 *
 * `PlayBridge.java`'s `openSelection` reads the open input's own ability — `sa.getApi() ==
 * ApiType.InternalLegendaryRule` — and carries every legendary of that name as `selection.keepOne`,
 * never a card name. Answering the selection with one of them should keep exactly that one.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
	? 'the legend rule’s own choice carries selection.keepOne, and answering it keeps the chosen card, against real Forge'
	: `the legend rule’s own choice carries selection.keepOne, and answering it keeps the chosen card, against real Forge — SKIPPED: ${available.reason}`;

interface SelectionFrame {
	method: string;
	selection?: { targets: boolean; keepOne?: { cards: { kind: string; id: number }[] } };
}

describe.skipIf(!available.ok)(title, () => {
	it('two Griselbrands: the open selection names both via keepOne; selecting one keeps it and sends the other to the graveyard', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 3970,
			decks: [deck('Griselbrands', ['40 Forest']), deck('Forests', ['40 Forest'])],
			scenario: scenarioText('af397-legend-rule'),
		});
		try {
			const lineFrom = s.lines.length;
			await finishMulligan(s);
			await waitUntil(
				() => {
					s.answerAsks();
					const last = [...s.sent].reverse().find((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
					return (last?.envelope.frame as SelectionFrame | undefined)?.selection?.keepOne !== undefined;
				},
				'the legend rule’s own selection.keepOne',
				60_000,
				s,
			);
			const frame = [...s.sent].reverse().find((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage')!.envelope.frame as SelectionFrame;
			expect(frame.selection?.targets, `the open selection:\n${timeline(s, 0, lineFrom)}`).toBe(false);
			const candidateIds = (frame.selection?.keepOne?.cards ?? []).map((c) => c.id);
			const before = s.zone(0, 'Battlefield').filter((c) => c.name === 'Griselbrand');
			expect(before.map((c) => c.id).sort()).toEqual([...candidateIds].sort());
			expect(candidateIds).toHaveLength(2);
			// Select the SECOND option, never the first — proving the choice is actually honoured, not merely a default.
			const keep = candidateIds[1]!;
			s.select(0, keep);
			await waitUntil(
				() => s.zone(0, 'Battlefield').filter((c) => c.name === 'Griselbrand').length === 1,
				'the legend rule resolved to one Griselbrand',
				30_000,
				s,
			);
			const kept = s.zone(0, 'Battlefield').find((c) => c.name === 'Griselbrand');
			expect(kept?.id, 'the card the seat chose is the one that stayed').toBe(keep);
			expect(s.zone(0, 'Graveyard').some((c) => c.name === 'Griselbrand'), 'the other went to the graveyard').toBe(true);
		} finally {
			await s.stop();
		}
	}, 180_000);
});
