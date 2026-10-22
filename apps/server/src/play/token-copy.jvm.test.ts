/**
 * A token that is a copy of a card, on the wire, against real Forge: what it is, and what it was printed as.
 *
 * The operator, 2026-10-20: "vaultborn tyrant: 1. the copy doesn't appear to be a token in any way 2. the copy
 * is missing the artifact pill which should have been added to it when it came back." Vaultborn Tyrant dies and
 * Forge makes a token copy of it "except it's an artifact in addition to its other types"
 * (`CopyPermanent | AddTypes$ Artifact`). That copy is built from the card's own faces with the exception
 * already in them (`CopyPermanentEffect.getProtoType`), so it has no clone origin to read a printed line from:
 * the board draws it as the card it copied, art and all, and nothing says it is a token or an artifact.
 *
 * Seat 0 controls Vaultborn Tyrant and Grizzly Bears with three Swamps and four Islands, and holds Murder and
 * Cackling Counterpart. It murders its own Tyrant (the copy is an Artifact Creature — Dinosaur token), then
 * copies its Bears with Cackling Counterpart (a plain copy: a Creature — Bear token). Both seats must be told,
 * in `printedTypes`, that each copy was printed as the nontoken card it copied — the Tyrant copy as
 * Creature — Dinosaur, the Bears copy as Creature — Bear — and neither the original Bears is named.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/token-copy \
 *   pnpm exec vitest run apps/server/src/play/token-copy.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'token-copy: a token copy of a card is named a token printed as that card, against real Forge'
	: `token-copy: a token copy of a card is named a token printed as that card, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Plains', ['40 Plains'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Murder;Cackling Counterpart',
	'humanbattlefield=Vaultborn Tyrant;Grizzly Bears;Swamp;Swamp;Swamp;Island;Island;Island;Island',
	'humanlibrary=Island;Island;Island;Island;Island;Island',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

interface CardType {
	t: 'cardtype';
	sup: string[];
	core: string[];
	sub: string[];
	all: boolean;
	exc: string[];
}

type Printed = [number, CardType, boolean?];

/** The latest `printedTypes` snapshot `seat` was sent, by card id, or null when none has been. */
function latestPrintedTypes(s: Scenario, seat: number): Map<number, Printed> | null {
	const snapshots = s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { printedTypes?: Printed[] } }).payload?.printedTypes)
		.filter((p): p is Printed[] => Array.isArray(p));
	const last = snapshots.at(-1);
	return last === undefined ? null : new Map(last.map((row) => [row[0], row]));
}

const line = (t: CardType | undefined): string | undefined => (t === undefined ? undefined : `${[...t.sup, ...t.core].join(' ')}${t.sub.length > 0 ? ` — ${t.sub.join(' ')}` : ''}`);

/** What `seat` holds of card `id` on the wire: its `Token` flag and its current face's `Type`. */
function wireCard(s: Scenario, seat: number, id: number): { token: boolean; type: string | undefined } {
	const state = s.state(seat);
	const view = state.get(deltaKey(DELTA_TYPE.card, id));
	const current = view?.CurrentState as { v?: number } | undefined;
	const face = state.get(deltaKey(DELTA_TYPE.cardState, id * 16 + (current?.v ?? 0)));
	return { token: (view?.Token as { v?: boolean } | undefined)?.v === true, type: line(face?.Type as CardType | undefined) };
}

/**
 * Cast `spell` from seat 0's hand at `target`, driving every window Forge opens until `done()`: the target
 * selection, the payment (Forge's own Auto, button one), and either seat's pass while anything is on the stack.
 */
async function castAt(s: Scenario, spell: string, target: () => number, done: () => boolean): Promise<void> {
	await waitUntil(() => {
		s.answerAsks();
		return inOwnMain(s, 0, 1) && /^Stack: Empty$/m.test(s.prompt(0)) && s.zone(0, 'Hand').some((c) => c.name === spell);
	}, `seat 0 to hold priority with ${spell} in hand and an empty stack`, 30_000, s);
	s.select(0, s.zone(0, 'Hand').find((c) => c.name === spell)!.id);
	const pressed = new Set<string>();
	await waitUntil(() => {
		s.answerAsks();
		for (const seat of [0, 1]) {
			const at = s.sent.findLastIndex((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage');
			const key = `${seat}:${at}`;
			if (at < 0 || pressed.has(key)) continue;
			const msg = (s.sent[at]!.envelope.frame as unknown as { message: string }).message;
			if (seat === 0 && /Select target/.test(msg)) {
				pressed.add(key);
				console.log(`[vt-token-copy.jvm] seat 0 aims ${spell} at #${target()}`);
				s.select(0, target());
			} else if (s.buttons(seat)?.enable1 === true && (/Pay Mana Cost/.test(msg) || !/^Stack: Empty$/m.test(msg))) {
				pressed.add(key);
				console.log(`[vt-token-copy.jvm] seat ${seat} presses OK on ${JSON.stringify(msg.split('\n')[0])}`);
				s.ok(seat);
			}
		}
		return done();
	}, `${spell} to resolve`, 45_000, s).catch((e: unknown) => {
		console.log(`[vt-token-copy.jvm] ${spell} never resolved: seat 0 battlefield [${s.zone(0, 'Battlefield').map((c) => `${c.name}#${c.id}`).join(', ')}]; prompt ${JSON.stringify(s.prompt(0))}`);
		throw e;
	});
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Vaultborn Tyrant’s death copy and a Cackling Counterpart copy are tokens printed as the cards they copied, on both sides',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 86, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				const tyrant = s.zone(0, 'Battlefield').find((c) => c.name === 'Vaultborn Tyrant')!;
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				const tyrantCopy = (): number | undefined => s.zone(0, 'Battlefield').find((c) => c.name === 'Vaultborn Tyrant' && c.id !== tyrant.id)?.id;
				const bearsCopy = (): number | undefined => s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears' && c.id !== bears.id)?.id;

				await castAt(s, 'Murder', () => tyrant.id, () => tyrantCopy() !== undefined && /^Stack: Empty$/m.test(s.prompt(0)));
				await castAt(s, 'Cackling Counterpart', () => bears.id, () => bearsCopy() !== undefined && /^Stack: Empty$/m.test(s.prompt(0)));
				const copies = { tyrant: tyrantCopy()!, bears: bearsCopy()! };

				await waitUntil(() => {
					s.answerAsks();
					return [0, 1].every((seat) => latestPrintedTypes(s, seat)?.has(copies.tyrant) === true && latestPrintedTypes(s, seat)?.has(copies.bears) === true);
				}, 'both seats to be sent a printedTypes snapshot naming both copies', 10_000, s).catch(() => undefined);

				for (const seat of [0, 1]) {
					const printed = latestPrintedTypes(s, seat);
					const named = [...(printed?.values() ?? [])].map(([id, t, token]) => `#${id}=${line(t)}${token === undefined ? '' : ` printedToken=${token}`}`).join(', ');
					const tyrantWire = wireCard(s, seat, copies.tyrant);
					const bearsWire = wireCard(s, seat, copies.bears);
					console.log(
						`[vt-token-copy.jvm] seat ${seat}: tyrant copy #${copies.tyrant} wire token=${tyrantWire.token} type "${tyrantWire.type}"; bears copy #${copies.bears} wire token=${bearsWire.token} type "${bearsWire.type}"; printedTypes {${named}}`,
					);
					expect(tyrantWire.token, `seat ${seat}: the Tyrant copy is a token on the wire`).toBe(true);
					expect(tyrantWire.type, `seat ${seat}: the Tyrant copy is an artifact on the wire`).toBe('Artifact Creature — Dinosaur');
					expect(bearsWire.token, `seat ${seat}: the Bears copy is a token on the wire`).toBe(true);
					expect(printed, `seat ${seat} was sent a printedTypes snapshot`).not.toBeNull();
					const tyrantRow = printed!.get(copies.tyrant);
					expect(line(tyrantRow?.[1]), `seat ${seat}: the Tyrant copy was printed as Vaultborn Tyrant`).toBe('Creature — Dinosaur');
					expect(tyrantRow?.[2], `seat ${seat}: the Tyrant copy was printed as a card, not a token`).toBe(false);
					const bearsRow = printed!.get(copies.bears);
					expect(line(bearsRow?.[1]), `seat ${seat}: the Bears copy was printed as Grizzly Bears`).toBe('Creature — Bear');
					expect(bearsRow?.[2], `seat ${seat}: the Bears copy was printed as a card, not a token`).toBe(false);
					expect(printed!.has(bears.id), `seat ${seat}: the original Bears is unchanged`).toBe(false);
				}
			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});
