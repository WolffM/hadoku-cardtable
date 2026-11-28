/*
 * The decks a set-cube pod builds, and the board two of them start a two-seat match on.
 *
 * A pod is the server's own: the set's cards as `pools/sets.ts`'s `cardsFor` resolves them through
 * the catalog (here the e2e fixture's, every Bloomburrow printing: a claw has no catalog of its own),
 * dealt as eight seats of three 15-card packs (`@hadoku/draft`'s `deal`), drafted by eight bots
 * (`runBots`) and built as a pod table builds a bot's deck (`botDeckText`). Forge's list of the set
 * is read off the edition file the match runs on, so no pool JVM is started for it.
 *
 * A match between two people starts from a room, which has no client outside a browser. The probe
 * stack takes `{ opponent: 'human', scenario }` instead: the two decks as a Forge `[state]`, each
 * library shuffled by the run's random and seven cards drawn from it, on turn 1's first main phase.
 * No mulligan is played; everything after is the shared match Sunday's tables play.
 */
import { resolve } from 'node:path';

import { parseDck } from '@hadoku/carddata/dck';
import { createDraft, deal, runBots } from '@hadoku/draft';
import type { DraftPlan } from '@hadoku/shared';

import { loadCardCatalog } from '../../../pools/catalog.ts';
import { createSetsStore } from '../../../pools/sets.ts';
import { botDeckText } from '../../../room/botDeck.ts';
import type { Rng } from '../rng.ts';
import { setCards } from '../sweep/set-cards.ts';

const SEATS = 8;
const PACKS = 3;
const PACK_SIZE = 15;
const BASIC = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;
const CATALOG = resolve(import.meta.dirname, '../../../../../../../e2e/fixtures/sets-catalog.json');

/** One pod's eight bot decks, each as its main deck's card names, one entry a copy. */
export async function podDecks(res: string, set: string, seed: string): Promise<string[][]> {
  const names = setCards(res, set).map((c) => c.name).filter((n) => !BASIC.test(n));
  const forge = {
    sets: async () => [],
    setCards: async () => names,
    // No booster sample: `cardsFor` falls back to the set's own list, as it does for a set with no booster template.
    boosters: async () => {
      throw new Error('no booster sample on the monkey stack');
    },
  };
  const store = createSetsStore({ forge, catalog: loadCardCatalog(CATALOG), log: () => {} });
  const cards = await store.cardsFor(set);
  if (cards === null) throw new Error(`${set} resolved to no cards`);
  const plan = { rounds: Array.from({ length: PACKS }, () => ({ kind: 'set' as const, code: set, style: 'set-cube' as const })) } as DraftPlan;
  const packs = deal(plan, () => cards, seed, SEATS, PACK_SIZE);
  const drafted = runBots(createDraft({ draftId: seed, seed, packs, seatCount: SEATS, packCount: PACKS, packSize: PACK_SIZE, humans: [] }), () => {});
  if (drafted.state.status !== 'complete') throw new Error(`pod ${seed}: the bots left the draft ${drafted.state.status}`);
  return [...drafted.state.pools.values()].map((pool, seat) =>
    (parseDck(botDeckText(pool, `${seed} bot ${seat}`)).sections.get('main') ?? []).flatMap((e) => Array.from({ length: e.count }, () => e.card.name)),
  );
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The `[state]` two decks start on: seven drawn, the rest the library, seat 0 to play turn 1. */
export function podBoard(decks: readonly [readonly string[], readonly string[]], rng: Rng): string {
  const [a, b] = decks.map((d) => shuffled(d, rng));
  return [
    'turn=1',
    'activeplayer=human',
    'activephase=MAIN1',
    'humanlife=20',
    'ailife=20',
    `humanhand=${a!.slice(0, 7).join(';')}`,
    `humanlibrary=${a!.slice(7).join(';')}`,
    `aihand=${b!.slice(0, 7).join(';')}`,
    `ailibrary=${b!.slice(7).join(';')}`,
  ].join('\n');
}
