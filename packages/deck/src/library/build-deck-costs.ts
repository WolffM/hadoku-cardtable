/*
 * Freezes the mana cost of every card the deck LIBRARY plays into
 * `deck-costs.generated.ts`, so a browser can fold a library deck's colours.
 *
 * Run from the repo root — no corpus, no flags, so it runs in a worktree:
 *
 *   node packages/deck/src/library/build-deck-costs.ts
 *
 * ## Why this exists at all
 *
 * Wave 26 §D put `manaCost` into the frozen pools and exported ONE fold
 * (`DeckView.tsx`'s `deckColorsByName`). `DeckView` and `DeckEditor` can call
 * it because a test and a server can read a file; the room screen's deck
 * dropdown could not, because the only place a browser learns about a library
 * deck is `GET /api/tables/decks`, which sends card NAMES and no costs.
 *
 * The nine fixtures are a little over 1.1 MB between them and hold the whole
 * legal pool of nine power-summer Standard eras — roughly 1200-2100 cards
 * each. The 96 catalogued decks play **981 distinct cards, 813 of which have
 * a mana cost at all** (the other 168 are lands, and a land has no coloured
 * pip). So the slice a dropdown needs is some 27 KB, and that is what this
 * writes: the same cost strings, from the same fixtures, narrowed to the
 * cards that are actually in a deck.
 *
 * ## Why a generated module rather than a wire field
 *
 * Either would work, and the wire is arguably tidier. The reason it is here is
 * that the map is **static**: the library is 96 committed files and the pools
 * are nine committed files, so the answer cannot change between two requests,
 * and a route that recomputed it per request would be a cache with extra steps.
 * A generated module also keeps the data on the same side of the boundary as
 * `catalog.ts`, which is already a committed manifest of the same 96 files.
 *
 * ## The copy is guarded, which is the only reason a copy is allowed
 *
 * `catalog.ts`' own rule is that a second copy of a fact is a copy free to
 * drift invisibly. This IS a second copy — the costs are in `decks/pools/` too
 * — so `library.test.ts` re-derives it from the fixtures and the `.dck` files
 * on every run and fails on any difference. Regenerating is therefore the only
 * way to change it, and forgetting to regenerate is red rather than quiet.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { poolNameKeys } from '../format.ts';
import { LIBRARY, POOL_FIXTURE_KEYS, deckPath, poolFixturePath } from './catalog.ts';
import { loadLibraryDeck } from './library.ts';
import { parsePoolFixture } from './pool-fixture.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const read = (repoRelative: string): string => readFileSync(join(REPO_ROOT, repoRelative), 'utf8');

/**
 * Every card name any catalogued deck plays, main and sideboard alike.
 *
 * The sideboard is included because a deck's list is its list: the room screen
 * folds the MAINDECK only, but a generator that shipped the maindeck's costs
 * would silently stop answering the moment someone folded a sideboard, and the
 * difference is 46 entries.
 */
export function libraryCardNames(): Set<string> {
  const names = new Set<string>();
  for (const collection of LIBRARY) {
    for (const entry of collection.decks) {
      const deck = loadLibraryDeck(read(deckPath(collection, entry)));
      for (const section of deck.file.sections.values()) {
        for (const line of section) for (const key of poolNameKeys(line.card.name)) names.add(key);
      }
    }
  }
  return names;
}

/**
 * The cost of every one of those names that has one, from the frozen pools.
 *
 * A name in two eras' pools is the same card in both, so the two entries must
 * agree; a disagreement means a fixture is stale or a corpus re-sync changed a
 * cost, and either way it is a fact to look at rather than a value to pick
 * between. Hence the throw.
 */
export function libraryCardCosts(): Record<string, string> {
  const wanted = libraryCardNames();
  const costs: Record<string, string> = {};
  for (const { family, date } of POOL_FIXTURE_KEYS) {
    const fixture = parsePoolFixture(JSON.parse(read(poolFixturePath(date, family))) as unknown);
    for (const [name, cost] of Object.entries(fixture.manaCost)) {
      if (!wanted.has(name)) continue;
      const held = costs[name];
      if (held !== undefined && held !== cost) {
        throw new Error(`${name}: ${family} ${date} says ${cost}, an earlier pool says ${held}`);
      }
      costs[name] = cost;
    }
  }
  // Sorted, so the committed file's diff is a real change rather than a
  // re-serialisation — the same reason `fixtureFromStandardPool` builds in
  // `cards` order.
  return Object.fromEntries(Object.entries(costs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The module text, so the test can compare text and not only values. */
export function deckCostsModule(costs: Readonly<Record<string, string>>): string {
  const entries = Object.entries(costs)
    .map(([name, cost]) => `  ${JSON.stringify(name)}: ${JSON.stringify(cost)},`)
    .join('\n');
  return `/*
 * GENERATED by packages/deck/src/library/build-deck-costs.ts. Do not hand-edit
 * — regenerate:
 *
 *   node packages/deck/src/library/build-deck-costs.ts
 *
 * Every card the ${String(LIBRARY.reduce((n, c) => n + c.decks.length, 0))} catalogued library decks play that HAS a mana cost,
 * with Scryfall's own cost string, taken from \`decks/pools/*.generated.json\`.
 * Lands are absent rather than mapped to \`""\`, which is what \`deckColorsByName\`
 * reads absence as: no coloured pip.
 *
 * Keyed by every name a card answers to (\`poolNameKeys\`), so a \`.dck\` line
 * spelling \`Delver of Secrets\` resolves against a pool that spells it
 * \`Delver of Secrets // Insectile Aberration\`.
 *
 * \`library.test.ts\` re-derives this from the fixtures and the \`.dck\` files on
 * every run, so a stale copy is red rather than quiet.
 */

/** ${String(Object.keys(costs).length)} cards. Name → Scryfall \`mana_cost\`. */
export const LIBRARY_CARD_COSTS: Readonly<Record<string, string>> = {
${entries}
};
`;
}

function main(): void {
  const costs = libraryCardCosts();
  const target = join(dirname(fileURLToPath(import.meta.url)), 'deck-costs.generated.ts');
  writeFileSync(target, deckCostsModule(costs), 'utf8');
  console.log(`deck-costs.generated.ts: ${String(Object.keys(costs).length)} cards with a cost`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
