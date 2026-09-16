/*
 * Measures `standardPoolAt` against the real corpus and writes
 * `standard-pool.json`.
 *
 * The unit tests in `standard.test.ts` run against a hand-built index of a
 * dozen real cards, because `packages/carddata/data/cards.jsonl` is 183 MB,
 * gitignored and absent in CI — `resolve.test.ts:16` establishes that rule and
 * this lane follows it. The corpus-wide numbers therefore live in a committed
 * report instead, exactly as `reports/cube-resolution.json` does for the
 * resolver, and `standard.test.ts` asserts against the report rather than
 * against the file that generated it.
 *
 * Run it from `packages/carddata`:
 *
 *   node --max-old-space-size=6144 src/formats/report-standard-pools.ts
 *
 * It READS `data/cards.jsonl` — `--cards=<path>` points it somewhere else, which
 * is what a worktree without the cache symlink needs — and writes only
 * `src/formats/standard-pool.json`. It writes nothing under `data/`.
 */

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameplayCard } from '../scryfall/project.ts';
import {
  buildPrintingIndex,
  standardPoolAt,
  standardRotations,
  FIRST_EFFECTIVE,
  LAST_EFFECTIVE,
  STANDARD_HISTORY,
  SANCTIONED_MATCHES_NEWEST,
} from './standard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'standard-pool.json');

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return null;
}

const CARDS = arg('cards') ?? join(HERE, '..', '..', 'data', 'cards.jsonl');

/**
 * The dates measured. Each is chosen to sit inside a different rotation model,
 * so the report is evidence about the eras and not about one of them four
 * times. The cited boundary for each is in `standard.ts`'s header and in the
 * `source` field of the row that answers it.
 */
const DATES = [
  '2005-01-01', // block rotation, biennial core sets (8ED era)
  '2012-12-25', // block rotation, annual core sets (RTR + ISD blocks + M13)
  '2016-06-01', // the two-block experiment, mid-flight
  '2019-09-01', // the brief's date: the last month before Eldraine
  '2019-10-04', // the rotation itself, first day
  '2019-10-03', // the day before it
  '2023-06-01', // the three-year extension, the year with no rotation
  LAST_EFFECTIVE, // the newest transcribed snapshot
];

async function loadCards(): Promise<GameplayCard[]> {
  const cards: GameplayCard[] = [];
  const rl = createInterface({ input: createReadStream(CARDS), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    cards.push(JSON.parse(line) as GameplayCard);
  }
  return cards;
}

/** How many sets contain at least one card `legalities.standard` calls legal. */
function oracleLegalitySpread(cards: readonly GameplayCard[]): {
  setsWithALegalCard: number;
  distinctSets: number;
} {
  const sets = new Set<string>();
  const legalSets = new Set<string>();
  for (const card of cards) {
    const set = typeof card['set'] === 'string' ? card['set'].toUpperCase() : null;
    if (set === null) continue;
    sets.add(set);
    const legalities = card['legalities'];
    if (typeof legalities === 'object' && legalities !== null) {
      const std = (legalities as Record<string, unknown>)['standard'];
      if (std === 'legal') legalSets.add(set);
    }
  }
  return { setsWithALegalCard: legalSets.size, distinctSets: sets.size };
}

async function main(): Promise<void> {
  const cards = await loadCards();
  const index = buildPrintingIndex(cards);
  // The same corpus with the digital filter off, so the report can state what
  // that default is worth instead of asserting it. See `PrintingIndexOptions`.
  const withDigital = buildPrintingIndex(cards, { includeDigital: true });
  const spread = oracleLegalitySpread(cards);

  const rotations = standardRotations();
  const drops = rotations.filter((r) => r.dropped.length > 0);

  const dates: Record<string, unknown> = {};
  for (const date of DATES) {
    const pool = standardPoolAt(date, index);
    if (!pool.ok) {
      dates[date] = { ok: false, reason: pool.reason };
      continue;
    }
    const loose = standardPoolAt(date, withDigital);
    dates[date] = {
      digitalPrintingsThatWouldJoin: loose.ok ? loose.counts.cards - pool.counts.cards : null,
      effective: pool.format.effective,
      supersededBy: pool.format.supersededBy,
      name: pool.format.name,
      source: pool.format.source,
      sets: pool.format.setList,
      counts: pool.counts,
      missingSets: pool.missingSets,
      unmatchedBans: pool.unmatchedBans,
      banned: pool.format.banned,
    };
  }

  // The one independent check available: Forge's newest snapshot and Scryfall's
  // own `legalities.standard` are two unrelated sources, and they should agree
  // on which sets Standard consists of TODAY. A set counts when every one of
  // its printings is standard-legal-or-banned, which is what separates a
  // Standard set from a set that merely reprints Standard cards.
  //
  // Two filters are load-bearing and both were diagnosed from the data rather
  // than guessed, which is the whole reason they are written down here:
  //
  //  - digital printings are excluded, by `buildPrintingIndex` itself. Without
  //    it five Forge Standard sets miss, by exactly six cards: the Arena `A-`
  //    rebalanced printings. See `PrintingIndexOptions` for the list.
  //  - `set_type` must be `core` or `expansion`. Without it 28 promo sets join
  //    (`PWOE`, `PMKM`, …) because a promo of a Standard card is a legal card,
  //    which is the oracle-level trap this module exists to route around.
  //
  // Neither filter is a derivation of Standard and this check is not one
  // either: it only works for TODAY, because `legalities.standard` is dated
  // today. It is a corroboration of one row, not a substitute for the table.
  // `OM1` is the case that proves it — 189 printings, `set_type: expansion`,
  // every card `standard: legal`, every printing `digital: true` and
  // `games: ["mtgo"]`. It is the MTGO release of SPM, not a Standard set, and
  // only the digital filter keeps it out.
  const whollyLegalSets: string[] = [];
  for (const [set, printings] of index.bySet) {
    let considered = 0;
    let legal = 0;
    for (const card of printings) {
      const setType = card['set_type'];
      if (setType !== 'core' && setType !== 'expansion') continue;
      considered++;
      const legalities = card['legalities'];
      const std =
        typeof legalities === 'object' && legalities !== null
          ? (legalities as Record<string, unknown>)['standard']
          : undefined;
      if (std === 'legal' || std === 'banned') legal++;
    }
    if (considered > 0 && legal === considered) whollyLegalSets.push(set);
  }
  const newest = STANDARD_HISTORY[STANDARD_HISTORY.length - 1];
  const newestSets = new Set(newest.sets);
  const agreement = {
    $comment:
      'Forge\'s newest archived Standard snapshot vs. the sets Scryfall\'s own legalities.standard marks wholly legal, over non-digital core/expansion printings. Both lists empty below the fold means two unrelated sources agree exactly on today\'s Standard.',
    forgeNewestSets: [...newest.sets].sort(),
    scryfallWhollyLegalSets: [...whollyLegalSets].sort(),
    inForgeNotScryfall: newest.sets.filter((s) => !whollyLegalSets.includes(s)).sort(),
    inScryfallNotForge: whollyLegalSets.filter((s) => !newestSets.has(s)).sort(),
  };

  // The done-when's explicit pair: a card legal then and not now, and one legal
  // now that was not then. The second is only interesting when the card already
  // EXISTED in 2019 — "it had not been printed yet" is a weaker claim than "it
  // was printed, in a set Standard did not contain". Both lists are name-sorted
  // so the report is reproducible.
  const THEN = '2019-09-01';
  const thenPool = standardPoolAt(THEN, index);
  const nowPool = standardPoolAt(LAST_EFFECTIVE, index);
  let drift: unknown = { error: 'one of the two dates is unsupported' };
  if (thenPool.ok && nowPool.ok) {
    const nowNames = new Set(nowPool.cards.map((c) => c.name));
    const thenNames = new Set(thenPool.cards.map((c) => c.name));
    const legalThenNotNow = thenPool.cards.filter((c) => !nowNames.has(c.name));
    const legalNowNotThen = nowPool.cards.filter((c) => !thenNames.has(c.name));
    // A pool card's representative printing is one from inside the format, so
    // its `released_at` is the format set's date and says nothing about when
    // the card first existed. That needs the earliest printing anywhere in the
    // corpus, which is a separate pass.
    const earliest = new Map<string, string>();
    for (const printings of index.bySet.values()) {
      for (const card of printings) {
        const name = card['name'];
        const released = card['released_at'];
        if (typeof name !== 'string' || typeof released !== 'string') continue;
        const seen = earliest.get(name);
        if (seen === undefined || released < seen) earliest.set(name, released);
      }
    }
    const existedIn2019 = legalNowNotThen.filter((c) => {
      const released = earliest.get(c.name);
      return released !== undefined && released < THEN;
    });
    drift = {
      $comment: `Cards in ${THEN}'s pool vs ${LAST_EFFECTIVE}'s. legalities.standard cannot express either column: it reports one date for all of them.`,
      legalThenNotNow: legalThenNotNow.length,
      legalNowNotThen: legalNowNotThen.length,
      legalNowNotThenButAlreadyPrintedIn2019: existedIn2019.length,
      examples: {
        legalThenNotNow: legalThenNotNow.slice(0, 5).map((c) => ({ name: c.name, sets: c.sets })),
        legalNowNotThenButAlreadyPrintedIn2019: existedIn2019.slice(0, 5).map((c) => ({
          name: c.name,
          sets: c.sets,
          firstPrintedInCorpus: earliest.get(c.name) ?? null,
        })),
      },
    };
  }

  // Whether front-face matching earns its keep on ban lists. Forge writes the
  // ban as the player says it; Scryfall's `name` for a two-faced card is
  // `Front // Back`. If this comes back 0 the `nameKeysFor` front-face arm is
  // decoration and should be deleted rather than believed.
  const everBanned = new Set<string>();
  for (const snapshot of STANDARD_HISTORY) {
    for (const name of snapshot.banned) everBanned.add(name);
    for (const name of snapshot.restricted) everBanned.add(name);
  }
  const banMatch = { exactName: 0, frontFaceOnly: [] as string[], unmatched: [] as string[] };
  {
    const byExact = new Set<string>();
    const byFront = new Set<string>();
    for (const printings of index.bySet.values()) {
      for (const card of printings) {
        const name = card['name'];
        if (typeof name === 'string') byExact.add(name.toLowerCase());
        const faces = card['card_faces'];
        const first = Array.isArray(faces) && faces.length > 0 ? (faces[0] as Record<string, unknown>) : null;
        const front = first === null ? null : first['name'];
        if (typeof front === 'string') byFront.add(front.toLowerCase());
      }
    }
    for (const name of everBanned) {
      const key = name.toLowerCase();
      if (byExact.has(key)) banMatch.exactName++;
      else if (byFront.has(key)) banMatch.frontFaceOnly.push(name);
      else banMatch.unmatched.push(name);
    }
    banMatch.frontFaceOnly.sort();
    banMatch.unmatched.sort();
  }

  const report = {
    $comment:
      'GENERATED by packages/carddata/src/formats/report-standard-pools.ts. Committed on purpose: the unit tests run against a hand-built index because data/cards.jsonl is gitignored and absent in CI, so this file is the corpus-scale evidence that standardPoolAt is right, and a diff here is a regression.',
    generatedAt: new Date().toISOString(),
    source: {
      rotationTable: 'packages/carddata/src/formats/standard-history.generated.ts',
      rotationTableFrom: 'forge/forge-gui/res/formats/Archived/Standard/*.txt',
      snapshots: STANDARD_HISTORY.length,
      supported: { from: FIRST_EFFECTIVE, to: LAST_EFFECTIVE },
      sanctionedMatchesNewest: SANCTIONED_MATCHES_NEWEST,
    },
    cardCache: {
      cardCount: cards.length,
      indexedPrintings: index.printings,
      distinctSets: index.bySet.size,
      skipped: index.skipped,
      withDigitalIncluded: {
        $comment:
          'The same corpus with buildPrintingIndex({ includeDigital: true }). The delta is what the default is worth; per-date it is `digitalPrintingsThatWouldJoin` below.',
        indexedPrintings: withDigital.printings,
        distinctSets: withDigital.bySet.size,
      },
    },
    whyNotLegalitiesStandard: {
      $comment:
        'legalities.standard is oracle-level and dated today. These two numbers are the argument: as many sets contain a standard-legal card as there are sets with any Alpha-era reprint, against the handful Standard actually consists of.',
      setsWithAtLeastOneStandardLegalCard: spread.setsWithALegalCard,
      distinctSetsInCorpus: spread.distinctSets,
      setsInNewestStandard: newest.sets.length,
    },
    rotations: {
      total: rotations.length,
      thatDroppedASet: drops.length,
      events: drops.map((r) => ({
        date: r.date,
        name: r.name,
        dropped: r.dropped,
        added: r.added,
        size: r.size,
        source: r.source,
      })),
    },
    agreement,
    banList: {
      $comment:
        'Every distinct banned or restricted name across all snapshots, matched against the corpus. frontFaceOnly non-empty is what makes the front-face arm of nameKeysFor load-bearing; unmatched non-empty means a ban is silently doing nothing.',
      distinctNames: everBanned.size,
      matchedByExactName: banMatch.exactName,
      matchedOnlyByFrontFace: banMatch.frontFaceOnly,
      unmatched: banMatch.unmatched,
    },
    drift,
    dates,
  };

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`wrote ${OUT}\n`);
  process.stdout.write(`  cards ${cards.length}, indexed ${index.printings}, sets ${index.bySet.size}\n`);
  process.stdout.write(
    `  agreement: forge-only [${agreement.inForgeNotScryfall.join(',')}] scryfall-only [${agreement.inScryfallNotForge.join(',')}]\n`,
  );
  for (const date of DATES) {
    const d = dates[date] as { counts?: { sets: number; cards: number }; reason?: string };
    process.stdout.write(
      `  ${date}: ${d.reason ?? `${String(d.counts?.sets)} sets, ${String(d.counts?.cards)} cards`}\n`,
    );
  }
}

await main();
