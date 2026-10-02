/*
 * Validates every deck in the library against `standardPoolAt` built from the
 * REAL card corpus, and says per deck what it found.
 *
 * Run from the repo root:
 *
 *   node --max-old-space-size=6144 packages/deck/src/library/validate-library.ts \
 *     --cards=/home/hadoku/repos/hadoku-cardtable/packages/carddata/data/cards.jsonl
 *
 * Exit code 0 means every deck is legal in the format it names, on the date it
 * names. Any other code means read the output: it names the deck, the card and
 * the rule.
 *
 * ## Why this is a script and not a test
 *
 * Because the corpus is 183 MB, gitignored, and absent in CI. A test that
 * needed it would be skipped everywhere it matters, and a skipped test is the
 * green-gate failure this repo has found five times. So the split is:
 *
 *   - this script is the REAL measurement, run by hand against the real cards,
 *     and its result is a finding to be reported;
 *   - `library.test.ts` is the standing check, run in CI against the fixtures
 *     `build-pool-fixture.ts` froze out of those same real cards.
 *
 * Both go through `fixtureFromStandardPool` → `poolFromFixture`, so they are
 * running one conversion and not two.
 *
 * ## `--date`
 *
 * Overrides every deck's own date, which is how a cross-era check is exercised
 * against real data: `--date=2011-07-15` validates the whole library against
 * the Standard that banned Jace, the Mind Sculptor and Stoneforge Mystic —
 * 2010's UG Polymorph (Antoine Ruel), which plays four Jace, fails it, and so
 * does every deck playing a card that era's sets do not carry. Under an
 * override the format mismatch is expected and reported as a note rather than
 * a fault, and a non-zero exit is the POINT rather than a failure — the header
 * of each run says which mode it is in.
 */

import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  buildPrintingIndex,
  standardPoolAt,
  type PrintingIndex,
} from '@hadoku/carddata/formats';

import { LIBRARY, deckPath } from './catalog.ts';
import { libraryIssues, libraryPoolMismatch, loadLibraryDeck } from './library.ts';
import { fixtureFromStandardPool, poolFromFixture } from './pool-fixture.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const DEFAULT_CARDS = join(REPO_ROOT, 'packages', 'carddata', 'data', 'cards.jsonl');

type IndexedCard =
  Parameters<typeof buildPrintingIndex>[0] extends Iterable<infer T> ? T : never;

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return null;
}

async function loadIndex(cardsPath: string): Promise<PrintingIndex> {
  const cards: IndexedCard[] = [];
  const rl = createInterface({ input: createReadStream(cardsPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    cards.push(JSON.parse(line) as IndexedCard);
  }
  return buildPrintingIndex(cards);
}

async function main(): Promise<number> {
  const cardsPath = arg('cards') ?? DEFAULT_CARDS;
  const dateOverride = arg('date');
  const index = await loadIndex(cardsPath);
  console.log(`corpus: ${cardsPath}`);
  console.log(`indexed ${String(index.printings)} printings across ${String(index.bySet.size)} sets`);
  console.log(
    dateOverride === null
      ? 'mode: each deck against the pool for its own date (expect 0 issues)'
      : `mode: every deck against the pool for ${dateOverride} (issues are the point)`,
  );

  let decks = 0;
  let clean = 0;
  let issues = 0;

  for (const collection of LIBRARY) {
    console.log(`\n== ${collection.event}  [${collection.format} @ ${collection.date}]`);
    for (const entry of collection.decks) {
      decks++;
      const path = deckPath(collection, entry);
      const deck = loadLibraryDeck(readFileSync(join(REPO_ROOT, path), 'utf8'));
      const date = dateOverride ?? deck.date;

      const pool = standardPoolAt(date, index);
      if (!pool.ok) {
        console.log(`  ${entry.id}: POOL REFUSED for ${date} — ${pool.reason}`);
        issues++;
        continue;
      }
      const formatPool = poolFromFixture(fixtureFromStandardPool(date, pool));

      const mismatch = libraryPoolMismatch(deck, formatPool);
      if (mismatch !== null && dateOverride === null) {
        console.log(`  ${entry.id}: FORMAT MISMATCH — ${mismatch}`);
        issues++;
        continue;
      }

      const found = libraryIssues(deck, formatPool);
      if (found.length === 0) {
        clean++;
        console.log(`  ${entry.id}: OK — ${deck.name} legal in ${formatPool.name}`);
        console.log(`      cited: ${deck.citation}`);
        continue;
      }
      issues += found.length;
      console.log(`  ${entry.id}: ${String(found.length)} issue(s) in ${formatPool.name}`);
      for (const issue of found) console.log(`      [${issue.kind}] ${issue.message}`);
    }
  }

  console.log(`\ndecks ${String(decks)}, clean ${String(clean)}, issues ${String(issues)}`);
  return issues === 0 ? 0 : 1;
}

process.exitCode = await main();
