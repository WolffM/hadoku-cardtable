/*
 * Freezes `standardPoolAt` results, computed against the real 183 MB corpus,
 * into the committed fixtures under `decks/pools/`.
 *
 * Run from the repo root:
 *
 *   node --max-old-space-size=6144 packages/deck/src/library/build-pool-fixture.ts \
 *     --cards=/home/hadoku/repos/hadoku-cardtable/packages/carddata/data/cards.jsonl
 *
 * `--cards` defaults to `packages/carddata/data/cards.jsonl` in this checkout.
 * That path is gitignored (`.gitignore`: `data/`) and is absent from a worktree,
 * so pointing it at the main checkout's copy is the normal case — the flag
 * exists for exactly that, following `report-standard-pools.ts`, which takes the
 * same flag for the same reason. It READS the corpus and writes nothing near it.
 *
 * ## Why the fixture is generated and not written
 *
 * A fixture typed out by hand is a restatement of what someone believed the
 * answer to be, and a test against it proves only that they were consistent.
 * Every name in these files came out of `standardPoolAt` over the real cards,
 * so the hermetic test in `library.test.ts` is running the real validator
 * against the real pool — just without the 183 MB.
 *
 * What the fixture therefore CANNOT catch is a change in `standardPoolAt`
 * itself: regenerate it and the fixture moves with it. That is what
 * `validate-library.ts` is for, and what `packages/carddata`'s own
 * `standard-pool.json` is for. Three artefacts, three jobs, and this file's job
 * is the one that has to work with no corpus.
 *
 * ## Why these dates
 *
 * `2011-02-13` is the library's own date — the pool the decks must be legal in.
 *
 * `2011-07-01` is the pool the same decks must FAIL in, and it is real data, not
 * a contrivance: that row of Forge's rotation table is the Jace/Stoneforge ban
 * (`Archived/Standard/2011-07-01.txt`), and four of the eight Top 8 decks play
 * both cards. A failure path demonstrated with a card that was genuinely banned
 * on a date that genuinely happened is worth more than a tampered list, so the
 * library ships both poles.
 */

import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  buildPrintingIndex,
  standardPoolAt,
  type PrintingIndex,
} from '@hadoku/carddata/formats';

import { poolFixturePath } from './catalog.ts';
import { fixtureFromStandardPool } from './pool-fixture.ts';

/** `packages/deck/src/library` → the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const DEFAULT_CARDS = join(REPO_ROOT, 'packages', 'carddata', 'data', 'cards.jsonl');

/**
 * What `buildPrintingIndex` consumes, derived from its own signature rather than
 * imported.
 *
 * The type is `GameplayCard`, and it is only re-exported from
 * `@hadoku/carddata`'s root barrel — which drags in the node-only Scryfall
 * ingest that `index.ts` says nothing in this package may reach. Deriving it
 * keeps that rule intact for a script as well as for a module, and costs one
 * line.
 */
type IndexedCard =
  Parameters<typeof buildPrintingIndex>[0] extends Iterable<infer T> ? T : never;

/** The dates frozen. See the header for why each one is here. */
export const FIXTURE_DATES: readonly string[] = ['2011-02-13', '2011-07-01', '2011-11-20', '2012-02-12'];

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

async function main(): Promise<void> {
  const cardsPath = arg('cards') ?? DEFAULT_CARDS;
  const index = await loadIndex(cardsPath);
  console.log(`indexed ${String(index.printings)} printings from ${cardsPath}`);

  for (const date of FIXTURE_DATES) {
    const pool = standardPoolAt(date, index);
    if (!pool.ok) throw new Error(`${date}: standardPoolAt refused — ${pool.reason}`);
    if (pool.missingSets.length > 0) {
      // A set the format names with no printing in the corpus means a pool that
      // is quietly short, which is the exact failure `standard.ts` was written
      // against. Refuse rather than freeze it.
      throw new Error(`${date}: corpus has no printings for ${pool.missingSets.join(', ')}`);
    }
    if (pool.unmatchedBans.length > 0) {
      throw new Error(`${date}: ban list names cards the corpus has not got: ${pool.unmatchedBans.join(', ')}`);
    }

    const fixture = fixtureFromStandardPool(date, pool);
    const target = join(REPO_ROOT, poolFixturePath(date));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          $comment:
            'GENERATED by packages/deck/src/library/build-pool-fixture.ts from the real Scryfall corpus ' +
            '(packages/carddata/data/cards.jsonl, gitignored and absent in CI). Committed on purpose: ' +
            'library.test.ts validates real decklists against a real pool without the 183 MB, and a diff ' +
            'here is a regression in standardPoolAt or a corpus re-sync. Do not hand-edit — regenerate.',
          generatedAt: new Date().toISOString(),
          command:
            'node --max-old-space-size=6144 packages/deck/src/library/build-pool-fixture.ts --cards=<path to cards.jsonl>',
          counts: pool.counts,
          ...fixture,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(
      `${poolFixturePath(date)}: ${pool.format.name} (${pool.format.effective}), ` +
        `${String(fixture.cards.length)} cards, ${String(fixture.banned.length)} banned`,
    );
  }
}

await main();
