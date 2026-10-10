/*
 * The cards a match can show, for `@hadoku/shared`'s `forge:art` — every card
 * of BOTH seats' decks (main and sideboard), plus a test scenario's named cards,
 * deduplicated by name and set. Read off the match's own spec: the `.dck` text
 * each seat was started with, and the scenario's `[state]` text. A seat on a
 * random Forge precon (`deck: null`) names nothing here — the bridge picks it
 * inside the JVM — and its cards rely on the client's decode-before-flip guard
 * alone (`apps/ui/src/draft/cardImage.ts`'s `artReady`).
 */
import { parseDck } from '@hadoku/carddata/dck';
import type { ArtCard } from '@hadoku/shared';

import type { MatchSpec } from './host.js';

/** A scenario key that lists cards in a zone (`humanhand=`, `aibattlefield=`, …); `scenarios/README.md` has the format. */
const SCENARIO_ZONE = /^(?:human|ai)(?:hand|battlefield|library|graveyard|exile|sideboard|command)=(.*)$/;

/**
 * Every card name a scenario's `[state]` text places, in order of first mention. Also what
 * `scripts/art/build-art-ids.ts` gives an art row, so a card a scenario plays is drawn with its art.
 */
export function scenarioCardNames(scenario: string): string[] {
	const names = new Set<string>();
	for (const line of scenario.split(/\r?\n/)) {
		const listed = SCENARIO_ZONE.exec(line.trim())?.[1] ?? '';
		for (const entry of listed.split(';')) {
			const name = entry.split('|')[0]!.trim();
			if (name !== '') names.add(name);
		}
	}
	return [...names];
}

export function artOf(spec: Pick<MatchSpec, 'seats' | 'scenario'>): ArtCard[] {
	const cards = new Map<string, ArtCard>();
	const add = (name: string, set: string | null): void => {
		const key = `${name}|${set ?? ''}`;
		if (name !== '' && !cards.has(key)) cards.set(key, { name, set });
	};
	for (const seat of spec.seats) {
		if (seat.deck === null) continue;
		for (const entries of parseDck(seat.deck).sections.values()) {
			for (const { card } of entries) add(card.name, card.set);
		}
	}
	for (const name of scenarioCardNames(spec.scenario ?? '')) add(name, null);
	return [...cards.values()];
}
