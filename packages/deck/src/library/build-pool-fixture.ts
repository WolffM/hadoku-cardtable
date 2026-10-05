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
 * One per power-summer era (`catalog.ts`'s `POOL_FIXTURE_DATES`, which is just
 * `LIBRARY.map(c => c.date)`): each era's own `Effective` date, the last
 * Standard snapshot before that year's fall rotation. Every deck is validated
 * against the pool for the era it was chosen into — `2008-07-25` (EVE),
 * `2009-07-17` (M10), `2010-07-16` (M11), `2011-07-15` (M12, the Jace/
 * Stoneforge ban already in force), `2012-07-13` (M13), `2013-07-19` (M14),
 * `2014-07-18` (M15), `2015-07-17` (ORI), `2016-07-22` (EMN).
 *
 * Wave 34 replaced the library's previous nine dates with these: the old ones
 * were eight mid-season collections and a deliberate FAILURE pool
 * (`2011-07-01`, the two-week Jace/Stoneforge ban row with no collection
 * filed under it) — real data, but a demonstration fixture rather than an
 * era anyone played a season in, and `apps/server/src/http/library.ts` used to
 * leak it into the picker as a ninth "era" because it read every file in
 * `decks/pools/` rather than the catalogue. The loader now reads exactly the
 * catalogued eras' own dates, so a fixture of this kind can exist again
 * without reaching the picker — but this library does not ship one.
 */

import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  buildPrintingIndex,
  formatPoolAt,
  type PrintingIndex,
} from '@hadoku/carddata/formats';

import { POOL_FIXTURE_KEYS, poolFixturePath, type PoolFixtureKey } from './catalog.ts';
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

/**
 * Scryfall set codes that are 100% `digital: true` in the corpus — MTGO-only
 * compilation/reprint products with no new cards at all, so excluding them
 * from the printing index (which `buildPrintingIndex` does on purpose,
 * `standard.ts`'s own header has the argument) costs nothing: every card they
 * contain already has an earlier, non-digital printing in an earlier legal
 * set. Legacy's set list is "every paper set ever", which inevitably reaches
 * one of these; Standard and Modern's set lists never have, so this allowlist
 * only ever fires for Legacy, in practice.
 *
 * Each one verified directly against the corpus (every printing under the
 * code has `"digital":true`, zero exceptions) before being added here — found
 * building Legacy's fixtures, which reach every one of these by 2016 (Legacy
 * 2008 already needs `ME1`, Forge calls it `MED`, and refused with "corpus
 * has no printings for ME1" until this existed). Computed by running
 * `formatPoolAt('legacy', date, index)` for every Legacy 2005-2016 era and
 * collecting every `missingSets` entry across all twelve, not guessed one
 * error at a time:
 *
 *   ME1 "Masters Edition", ME2 "Masters Edition II", ME3 "Masters Edition
 *   III", ME4 "Masters Edition IV" — the four Masters Editions.
 *   VMA "Vintage Masters", TPR "Tempest Remastered" — later MTGO-only
 *   "Masters"-style reprint sets.
 *   TD0 "Magic Online Theme Decks", TD2 "Duel Decks: Mirrodin Pure vs. New
 *   Phyrexia" (an MTGO-only duel-deck release despite the paper-sounding
 *   name — checked against the corpus like everything else here, not
 *   assumed from the name), PZ1 "Legendary Cube Prize Pack" — MTGO prize/
 *   theme products, same shape.
 *
 * All nine: zero paper printings, every card in them a reprint already legal
 * via an earlier paper set. A set NOT on this list that the corpus is
 * missing is still refused: this is a narrow, verified exception, not a
 * general "ignore missing sets" escape hatch.
 */
const ALL_DIGITAL_SETS = new Set(['ME1', 'ME2', 'ME3', 'ME4', 'VMA', 'TPR', 'TD0', 'TD2', 'PZ1']);

/**
 * `--family=modern` (or `legacy`) freezes only that family's keys, and
 * `--only=2012,2013` narrows further to those years — handy for a lane
 * re-freezing its own fixtures without recomputing all 31. No flags freezes
 * every catalogued (family, date) pair, which is what CI's committed fixtures
 * must stay in sync with.
 */
function keysToFreeze(): readonly PoolFixtureKey[] {
  const family = arg('family');
  const only = arg('only');
  const years = only === null ? null : only.split(',');
  return POOL_FIXTURE_KEYS.filter(
    (k) => (family === null || k.family === family) && (years === null || years.includes(k.date.slice(0, 4))),
  );
}

async function main(): Promise<void> {
  const cardsPath = arg('cards') ?? DEFAULT_CARDS;
  const index = await loadIndex(cardsPath);
  console.log(`indexed ${String(index.printings)} printings from ${cardsPath}`);

  const keys = keysToFreeze();
  if (keys.length === 0) throw new Error('no (family, date) pairs matched --family/--only');

  for (const { family, date } of keys) {
    const pool = formatPoolAt(family, date, index);
    if (!pool.ok) throw new Error(`${family} ${date}: formatPoolAt refused — ${pool.reason}`);
    const unexpectedMissing = pool.missingSets.filter((s) => !ALL_DIGITAL_SETS.has(s));
    if (unexpectedMissing.length > 0) {
      // A set the format names with no printing in the corpus means a pool that
      // is quietly short, which is the exact failure `standard.ts` was written
      // against. Refuse rather than freeze it — unless the set is a KNOWN,
      // verified all-digital one (see `ALL_DIGITAL_SETS`), in which case it is
      // expected and reported instead.
      throw new Error(`${family} ${date}: corpus has no printings for ${unexpectedMissing.join(', ')}`);
    }
    const expectedMissing = pool.missingSets.filter((s) => ALL_DIGITAL_SETS.has(s));
    if (expectedMissing.length > 0) {
      console.log(`  ${family} ${date}: no printings for ${expectedMissing.join(', ')} (all-digital, expected — see ALL_DIGITAL_SETS)`);
    }
    if (pool.unmatchedBans.length > 0) {
      throw new Error(`${family} ${date}: ban list names cards the corpus has not got: ${pool.unmatchedBans.join(', ')}`);
    }

    const fixture = fixtureFromStandardPool(date, pool);
    const target = join(REPO_ROOT, poolFixturePath(date, family));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          $comment:
            'GENERATED by packages/deck/src/library/build-pool-fixture.ts from the real Scryfall corpus ' +
            '(packages/carddata/data/cards.jsonl, gitignored and absent in CI). Committed on purpose: ' +
            'library.test.ts validates real decklists against a real pool without the 183 MB, and a diff ' +
            'here is a regression in formatPoolAt or a corpus re-sync. Do not hand-edit — regenerate.',
          generatedAt: new Date().toISOString(),
          command:
            'node --max-old-space-size=6144 packages/deck/src/library/build-pool-fixture.ts --cards=<path to cards.jsonl>',
          family,
          counts: pool.counts,
          ...fixture,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(
      `${poolFixturePath(date, family)}: ${pool.format.name} (${pool.format.effective}), ` +
        `${String(fixture.cards.length)} cards, ${String(fixture.banned.length)} banned`,
    );
  }
}

await main();
