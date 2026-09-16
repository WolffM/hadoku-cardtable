import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, dirname } from 'node:path';
import {
  STANDARD_HISTORY,
  SANCTIONED_MATCHES_NEWEST,
  FIRST_EFFECTIVE,
  LAST_EFFECTIVE,
  buildPrintingIndex,
  isStandardLegalAt,
  standardFormatAt,
  standardPoolAt,
  standardRotations,
} from './standard.ts';
import type { GameplayCard } from '../scryfall/project.ts';

/*
 * These tests run against a hand-built index of real cards, never against the
 * 183 MB `data/cards.jsonl` cache — that cache is gitignored and absent in CI,
 * and a test that needs it is a test that does not run (`resolve.test.ts:16`
 * said it first). The corpus-wide numbers are asserted separately at the bottom
 * of this file, against the committed `standard-pool.json`.
 *
 * Every fixture below is a real Scryfall record, copied field-for-field out of
 * the corpus including its `legalities.standard`. That matters more here than
 * anywhere else in this package: the central claim is that
 * `legalities.standard` is the wrong answer for a historical date, and a made-up
 * fixture could not demonstrate it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function card(fields: Record<string, unknown>): GameplayCard {
  return { lang: 'en', layout: 'normal', digital: false, ...fields };
}

/**
 * Standard-legal on 2019-09-01 (WAR was in the pool). `legalities.standard` on
 * the 2026-09-15 corpus says `not_legal`. This one card is the whole lane.
 */
const TEFERI_WAR = card({
  name: 'Teferi, Time Raveler',
  oracle_id: 'ae7604bb-4818-45a3-960c-cf3d83f15964',
  set: 'war',
  set_type: 'expansion',
  collector_number: '221',
  released_at: '2019-05-03',
  rarity: 'rare',
  legalities: { standard: 'not_legal' },
});

/**
 * Arena's rebalanced Teferi. Scryfall files it under `war` — the paper set —
 * because that is the card it rebalances, so a set-list pool picks it up unless
 * digital printings are excluded. It was never legal in Standard.
 */
const TEFERI_WAR_ARENA = card({
  name: 'A-Teferi, Time Raveler',
  oracle_id: '1e019acb-0ab9-4f6e-9e44-f4e61f681597',
  set: 'war',
  set_type: 'expansion',
  collector_number: 'A-221',
  released_at: '2022-01-27',
  rarity: 'rare',
  digital: true,
  legalities: { standard: 'not_legal' },
});

/** ELD, released on the day of the 2019 rotation. Not legal the day before. */
const QUESTING_BEAST_ELD = card({
  name: 'Questing Beast',
  oracle_id: 'b685757b-521e-4353-a233-97052359723d',
  set: 'eld',
  set_type: 'expansion',
  collector_number: '171',
  released_at: '2019-10-04',
  rarity: 'mythic',
  legalities: { standard: 'not_legal' },
});

/** Banned on 2018-01-19, UNBANNED on 2019-08-30. Both are in the table. */
const FEROCIDON_XLN = card({
  name: 'Rampaging Ferocidon',
  oracle_id: '3e5ca524-8dd1-4f7f-a467-5210d768b8a1',
  set: 'xln',
  set_type: 'expansion',
  collector_number: '154',
  released_at: '2017-09-29',
  rarity: 'rare',
  legalities: { standard: 'not_legal' },
});

/**
 * Forge bans `Fable of the Mirror-Breaker`. Scryfall's `name` is
 * `Fable of the Mirror-Breaker // Reflection of Kiki-Jiki`, so the ban only
 * lands through front-face matching. It is the ONE name of the 91 distinct
 * banned-or-restricted names in the table that needs it — see
 * `standard-pool.json`'s `banList`.
 */
const FABLE_NEO = card({
  name: 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki',
  oracle_id: 'c0957e5e-c71b-439c-931c-9f55d2f76ace',
  layout: 'transform',
  set: 'neo',
  set_type: 'expansion',
  collector_number: '141',
  released_at: '2022-02-18',
  rarity: 'rare',
  legalities: { standard: 'not_legal' },
  card_faces: [{ name: 'Fable of the Mirror-Breaker' }, { name: 'Reflection of Kiki-Jiki' }],
});

/** The reverse of the Teferi case, and the stronger half of it: printed in
 * 2017, NOT legal on 2019-09-01 (HOU had already rotated), legal today via LCI.
 * `legalities.standard` reads `legal` and is right about today and wrong about
 * 2019 — the same field, the opposite error. */
const ABRADE_HOU = card({
  name: 'Abrade',
  oracle_id: 'f9db72dc-9a5b-48a4-a86e-7464d9a2166a',
  set: 'hou',
  set_type: 'expansion',
  collector_number: '83',
  released_at: '2017-07-14',
  rarity: 'uncommon',
  legalities: { standard: 'legal' },
});
const ABRADE_LCI = card({
  name: 'Abrade',
  oracle_id: 'f9db72dc-9a5b-48a4-a86e-7464d9a2166a',
  set: 'lci',
  set_type: 'expansion',
  collector_number: '131',
  released_at: '2023-11-17',
  rarity: 'common',
  legalities: { standard: 'legal' },
});

/** Legal on 2019-09-01 via M20 and still legal today via a later reprint. */
const SHOCK_M20 = card({
  name: 'Shock',
  oracle_id: 'a9d288b8-cdc1-4e55-a0c9-d6edfc95e65d',
  set: 'm20',
  set_type: 'core',
  collector_number: '160',
  released_at: '2019-07-12',
  rarity: 'common',
  legalities: { standard: 'legal' },
});

/** DOM, in the 2019-08-30 pool. */
const LLANOWAR_DOM = card({
  name: 'Llanowar Elves',
  oracle_id: '68954295-54e3-4303-a6bc-fc4547a4e3a3',
  set: 'dom',
  set_type: 'expansion',
  collector_number: '168',
  released_at: '2018-04-27',
  rarity: 'common',
  legalities: { standard: 'legal' },
});

/** ICE — the set that rotated out in 1997 and came back. */
const DARK_RITUAL_ICE = card({
  name: 'Dark Ritual',
  oracle_id: '53f7c868-b03e-4fc2-8dcf-a75bbfa3272b',
  set: 'ice',
  set_type: 'expansion',
  collector_number: '120',
  released_at: '1995-06-03',
  rarity: 'common',
  legalities: { standard: 'not_legal' },
});

/** Banned in Standard on 2004-06-20, four months after Darksteel released. */
const SKULLCLAMP_DST = card({
  name: 'Skullclamp',
  oracle_id: '65986c1b-8e51-4604-b685-d82fa7d1263a',
  set: 'dst',
  set_type: 'expansion',
  collector_number: '140',
  released_at: '2004-02-06',
  rarity: 'uncommon',
  legalities: { standard: 'not_legal' },
});

/** Never in any Standard snapshot: LEA is not a set Standard ever contained. */
const ANCESTRAL_LEA = card({
  name: 'Ancestral Recall',
  oracle_id: '550c74d4-1fcb-406a-b02a-639a760a4380',
  set: 'lea',
  set_type: 'core',
  collector_number: '47',
  released_at: '1993-08-05',
  rarity: 'rare',
  legalities: { standard: 'not_legal' },
});

/** A token printed in a Standard set: shares a name, is not a card. */
const TREASURE_TOKEN_LCI = card({
  name: 'Treasure',
  layout: 'token',
  set: 'lci',
  set_type: 'expansion',
  collector_number: 'T1',
  released_at: '2023-11-17',
});

/** A non-English printing of a card that IS in the pool. */
const SHOCK_M20_JA = card({
  name: 'Shock',
  oracle_id: 'a9d288b8-cdc1-4e55-a0c9-d6edfc95e65d',
  lang: 'ja',
  set: 'm20',
  set_type: 'core',
  collector_number: '160',
  released_at: '2019-07-12',
  legalities: { standard: 'legal' },
});

const CARDS: readonly GameplayCard[] = [
  TEFERI_WAR,
  TEFERI_WAR_ARENA,
  QUESTING_BEAST_ELD,
  FEROCIDON_XLN,
  FABLE_NEO,
  ABRADE_HOU,
  ABRADE_LCI,
  SHOCK_M20,
  SHOCK_M20_JA,
  LLANOWAR_DOM,
  DARK_RITUAL_ICE,
  SKULLCLAMP_DST,
  ANCESTRAL_LEA,
  TREASURE_TOKEN_LCI,
];

const index = buildPrintingIndex(CARDS);

/** Names in the pool on a date. Throws on a refusal so a test cannot pass one. */
function poolNames(date: string, options?: Parameters<typeof standardPoolAt>[2]): string[] {
  const pool = standardPoolAt(date, index, options);
  if (!pool.ok) throw new Error(`unexpected refusal ${pool.reason} for ${date}`);
  return pool.cards.map((c) => c.name);
}

describe('the transcribed table', () => {
  it('covers 1995 to the present, one row per Forge file', () => {
    expect(STANDARD_HISTORY.length).toBe(154);
    expect(FIRST_EFFECTIVE).toBe('1995-01-10');
    expect(LAST_EFFECTIVE).toBe('2026-08-14');
  });

  it("agrees with Forge's undated Sanctioned/Standard.txt on the newest row", () => {
    // If this is ever false the newest row is stale, not current, and
    // `allowProvisional` would be answering with a format that has rotated.
    expect(SANCTIONED_MATCHES_NEWEST).toBe(true);
  });

  it('holds no regional variant: every row is a top-level Forge file', () => {
    // `Archived/Standard/` has a `China/` subdirectory with 8 more dated files.
    // Recursive: 162 files. Top level: 154. All eight collide on effective date
    // with a top-level file, so mixing them in duplicates rows rather than
    // appending them — and the China variant of THIS LANE'S OWN DATE,
    // `China/2019-08-30.txt`, carries `GS1` (Global Series: Jiang Yanggu & Mu
    // Yanling), a set real Standard never contained. That is precisely the
    // one-set error the brief calls worse than refusing to answer.
    for (const row of STANDARD_HISTORY) {
      expect(row.source.split('/').length).toBe(3);
      expect(row.source).not.toContain('China');
    }
    const brief = standardFormatAt('2019-09-01');
    expect(brief.ok && brief.setList).not.toContain('GS1');
  });

  it('is strictly ordered, fully populated, and cites a distinct file per row', () => {
    const sources = new Set<string>();
    for (let i = 0; i < STANDARD_HISTORY.length; i++) {
      const row = STANDARD_HISTORY[i];
      expect(row.effective).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.sets.length).toBeGreaterThan(0);
      // Every Forge code translated, or the generator would have refused.
      expect(row.sets.length).toBe(row.forgeSets.length);
      expect(row.source).toBe(`Archived/Standard/${row.effective}.txt`);
      sources.add(row.source);
      if (i > 0) expect(row.effective > STANDARD_HISTORY[i - 1].effective).toBe(true);
    }
    expect(sources.size).toBe(STANDARD_HISTORY.length);
  });
});

describe('rotation boundaries, each against its cited source', () => {
  it('2019-09-01 is the 2019-08-30 snapshot: nine sets, XLN through M20', () => {
    const format = standardFormatAt('2019-09-01');
    expect(format.ok).toBe(true);
    if (!format.ok) return;
    expect(format.effective).toBe('2019-08-30');
    expect(format.source).toBe('Archived/Standard/2019-08-30.txt');
    expect(format.supersededBy).toBe('2019-10-04');
    expect(format.setList).toEqual(['XLN', 'RIX', 'DOM', 'M19', 'GRN', 'G18', 'RNA', 'WAR', 'M20']);
  });

  it('2012-12-25 is block rotation with an annual core set', () => {
    const format = standardFormatAt('2012-12-25');
    expect(format.ok).toBe(true);
    if (!format.ok) return;
    expect(format.effective).toBe('2012-10-05');
    expect(format.source).toBe('Archived/Standard/2012-10-05.txt');
    expect(format.setList).toEqual(['ISD', 'DKA', 'AVR', 'M13', 'RTR']);
  });

  it('2005-01-01 is block rotation with a biennial core set', () => {
    const format = standardFormatAt('2005-01-01');
    expect(format.ok).toBe(true);
    if (!format.ok) return;
    expect(format.effective).toBe('2004-10-20');
    expect(format.source).toBe('Archived/Standard/2004-10-20.txt');
    // 8ED is there alone: core sets rotated on their own two-year clock, which
    // is why `2005-08-20` later drops 8ED and nothing else.
    expect(format.setList).toEqual(['8ED', 'MRD', 'DST', '5DN', 'CHK']);
  });

  it('2016-06-01 keeps DTK and ORI, which is the misremembered boundary', () => {
    // The two-block experiment's April 2016 rotation dropped Khans of Tarkir,
    // Fate Reforged and Ugin's Fate. Dragons of Tarkir and Magic Origins did
    // NOT rotate until Kaladesh that September. A "rotate the oldest block"
    // rule gets this wrong, which is why the table is transcribed.
    const format = standardFormatAt('2016-06-01');
    expect(format.ok).toBe(true);
    if (!format.ok) return;
    expect(format.effective).toBe('2016-04-08');
    expect(format.source).toBe('Archived/Standard/2016-04-08.txt');
    expect(format.setList).toEqual(['DTK', 'ORI', 'BFZ', 'OGW', 'SOI', 'W16']);
  });

  it('1997 rotates Ice Age OUT and then back IN', () => {
    // No rotation rule produces a set re-entering Standard. This pair is the
    // reason this module transcribes a dated table instead of computing one.
    const before = standardFormatAt('1997-04-01');
    const after = standardFormatAt('1997-08-01');
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.effective).toBe('1997-03-05');
    expect(before.setList).not.toContain('ICE');
    expect(after.effective).toBe('1997-07-01');
    expect(after.setList).toContain('ICE');
  });

  it('has no rotation at all in 2023 — the three-year extension', () => {
    const drops = standardRotations().filter((r) => r.dropped.length > 0);
    expect(drops.filter((r) => r.date.startsWith('2023'))).toEqual([]);
    const dates = drops.map((r) => r.date);
    expect(dates).toContain('2022-09-09');
    // The next drop after 2022 is Bloomburrow, in August, not an autumn set.
    const next = dates[dates.indexOf('2022-09-09') + 1];
    expect(next).toBe('2024-08-02');
  });

  it('names what each rotation dropped, from the table rather than beside it', () => {
    const byDate = new Map(standardRotations().map((r) => [r.date, r]));
    expect(byDate.get('2016-04-08')?.dropped).toEqual(['KTK', 'FRF', 'UGIN']);
    expect(byDate.get('2016-09-30')?.dropped).toEqual(['DTK', 'ORI']);
    expect(byDate.get('2019-10-04')?.dropped).toEqual(['XLN', 'RIX', 'DOM', 'M19', 'G18']);
    expect(byDate.get('2024-08-02')?.dropped).toEqual(['MID', 'VOW', 'NEO', 'SNC']);
    expect(byDate.get('2025-08-01')?.dropped).toEqual(['DMU', 'BRO', 'ONE', 'MOM', 'MAT']);
    expect(standardRotations().filter((r) => r.dropped.length > 0).length).toBe(40);
  });
});

describe('refusing is an answer', () => {
  it('refuses a date before the table starts', () => {
    const format = standardFormatAt('1994-12-31');
    expect(format).toMatchObject({ ok: false, reason: 'before-standard-existed' });
  });

  it('refuses a date after the table ends, and says what it can answer', () => {
    const format = standardFormatAt('2030-01-01');
    expect(format).toMatchObject({
      ok: false,
      reason: 'after-known-history',
      supported: { from: '1995-01-10', to: '2026-08-14' },
    });
  });

  it('answers past the end only when asked, and marks it provisional', () => {
    const format = standardFormatAt('2030-01-01', { allowProvisional: true });
    expect(format.ok).toBe(true);
    if (!format.ok) return;
    expect(format.provisional).toBe(true);
    expect(format.effective).toBe(LAST_EFFECTIVE);
    // A date inside the table is never provisional, whatever the caller asks.
    const inside = standardFormatAt('2019-09-01', { allowProvisional: true });
    expect(inside.ok && inside.provisional).toBe(false);
  });

  it('refuses a non-date and an impossible day', () => {
    expect(standardFormatAt('yesterday')).toMatchObject({ reason: 'malformed-date' });
    expect(standardFormatAt('2019-9-1')).toMatchObject({ reason: 'malformed-date' });
    // `new Date('2019-02-30')` rolls over to March 2nd rather than failing.
    expect(standardFormatAt('2019-02-30')).toMatchObject({ reason: 'malformed-date' });
  });

  it('propagates the refusal through the pool, rather than returning an empty one', () => {
    const pool = standardPoolAt('1994-12-31', index);
    expect(pool).toMatchObject({ ok: false, reason: 'before-standard-existed' });
  });
});

describe('the pool on 2019-09-01', () => {
  it("contains Teferi, whose legalities.standard says not_legal TODAY", () => {
    // The trap, stated as an assertion rather than a comment. The fixture is a
    // real record and this is its real field value.
    expect((TEFERI_WAR['legalities'] as Record<string, string>)['standard']).toBe('not_legal');
    expect(poolNames('2019-09-01')).toContain('Teferi, Time Raveler');
  });

  it('excludes Abrade, whose legalities.standard says legal TODAY', () => {
    // The same field, the opposite error: Abrade is legal now (LCI) and was not
    // then (HOU had rotated on 2018-10-05).
    expect((ABRADE_HOU['legalities'] as Record<string, string>)['standard']).toBe('legal');
    expect(poolNames('2019-09-01')).not.toContain('Abrade');
    expect(poolNames(LAST_EFFECTIVE)).toContain('Abrade');
  });

  it('is exactly the fixtures whose sets were legal then', () => {
    expect(poolNames('2019-09-01').sort()).toEqual([
      'Llanowar Elves',
      'Rampaging Ferocidon',
      'Shock',
      'Teferi, Time Raveler',
    ]);
  });

  it('keeps no Arena rebalanced printing, though Scryfall files it under WAR', () => {
    expect(poolNames('2019-09-01')).not.toContain('A-Teferi, Time Raveler');
    const loose = buildPrintingIndex(CARDS, { includeDigital: true });
    const pool = standardPoolAt('2019-09-01', loose);
    expect(pool.ok).toBe(true);
    if (!pool.ok) return;
    expect(pool.cards.map((c) => c.name)).toContain('A-Teferi, Time Raveler');
    expect(index.skipped['digital']).toBe(1);
  });

  it('keeps no token and no non-English printing', () => {
    expect(poolNames(LAST_EFFECTIVE)).not.toContain('Treasure');
    expect(index.skipped['non-gameplay-layout']).toBe(1);
    expect(index.skipped['non-english']).toBe(1);
    // Shock survives once, through its English printing, not twice.
    expect(poolNames('2019-09-01').filter((n) => n === 'Shock')).toEqual(['Shock']);
  });
});

describe('the rotation is a cliff, on the cited day', () => {
  it('drops DOM and admits ELD between 2019-10-03 and 2019-10-04', () => {
    const before = poolNames('2019-10-03');
    const after = poolNames('2019-10-04');
    expect(before).toContain('Llanowar Elves');
    expect(before).not.toContain('Questing Beast');
    expect(after).not.toContain('Llanowar Elves');
    expect(after).toContain('Questing Beast');
  });

  it('keeps WAR through the 2019 rotation, then bans, then rotates', () => {
    // Written the other way round first, and the table said no twice. The
    // 2019-10-04 rotation dropped XLN, RIX, DOM, M19 and G18 — War of the Spark
    // survived it. Teferi then left the pool on 2020-08-03 by BAN, with WAR
    // still legal, and WAR itself rotated on 2020-09-25. Three dates and two
    // mechanisms, none of them recalled: recalling a rotation and checking one
    // are different activities, which is the whole design here.
    expect(poolNames('2019-10-04')).toContain('Teferi, Time Raveler');
    expect(isStandardLegalAt('Teferi, Time Raveler', '2020-06-15', index)).toMatchObject({
      legal: true,
    });
    // It left the pool on 2020-08-03 by BAN, with WAR still in the set list —
    // a different mechanism from rotation, and `why` is what tells them apart.
    expect(isStandardLegalAt('Teferi, Time Raveler', '2020-09-24', index)).toMatchObject({
      legal: false,
      why: 'banned',
    });
    const banEra = standardFormatAt('2020-09-24');
    expect(banEra.ok && banEra.setList).toContain('WAR');
    expect(isStandardLegalAt('Teferi, Time Raveler', '2020-09-25', index)).toMatchObject({
      legal: false,
      why: 'not-in-pool',
    });
    const byDate = new Map(standardRotations().map((r) => [r.date, r]));
    expect(byDate.get('2020-09-25')?.dropped).toEqual(['GRN', 'RNA', 'WAR', 'M20']);
  });

  it('treats the effective date as inclusive', () => {
    const on = standardFormatAt('2019-10-04');
    const before = standardFormatAt('2019-10-03');
    expect(on.ok && on.effective).toBe('2019-10-04');
    expect(before.ok && before.effective).toBe('2019-08-30');
  });
});

describe('ban lists', () => {
  it('removes a banned card, and puts it back when it is unbanned', () => {
    // Rampaging Ferocidon: banned 2018-01-19, still banned in the 2019-07-12
    // snapshot, absent from the 2019-08-30 one.
    expect(poolNames('2019-08-01')).not.toContain('Rampaging Ferocidon');
    expect(poolNames('2019-09-01')).toContain('Rampaging Ferocidon');
  });

  it('matches a ban written as a front face', () => {
    // Forge bans `Fable of the Mirror-Breaker`; the card's name is
    // `Fable of the Mirror-Breaker // Reflection of Kiki-Jiki`.
    const banned = standardFormatAt('2023-09-08');
    expect(banned.ok && banned.banned).toContain('Fable of the Mirror-Breaker');
    expect(poolNames('2023-09-08')).not.toContain(
      'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki',
    );
    // It is in the set list — the ban is what removed it, not the rotation.
    expect(banned.ok && banned.setList).toContain('NEO');
    expect(poolNames('2023-02-01')).toContain(
      'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki',
    );
  });

  it('bans Skullclamp mid-format, with Darksteel still legal', () => {
    expect(poolNames('2004-05-01')).toContain('Skullclamp');
    expect(poolNames('2004-07-01')).not.toContain('Skullclamp');
    const after = standardFormatAt('2004-07-01');
    expect(after.ok && after.setList).toContain('DST');
  });

  it('reports a ban it could not match instead of dropping it silently', () => {
    // The whole pool minus the one card the 2023-09-08 ban list can reach:
    // three of its four banned names have no printing in this tiny index, and
    // `unmatchedBans` is how a caller finds out rather than getting a pool that
    // is quietly wrong.
    const pool = standardPoolAt('2023-09-08', index);
    expect(pool.ok).toBe(true);
    if (!pool.ok) return;
    expect(pool.unmatchedBans).toEqual([
      'Invoke Despair',
      'Reckoner Bankbuster',
      'The Meathook Massacre',
    ]);
  });

  it('keeps banned cards when asked, and counts them either way', () => {
    const kept = standardPoolAt('2019-08-01', index, { includeBanned: true });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.cards.map((c) => c.name)).toContain('Rampaging Ferocidon');
    expect(kept.counts.banned).toBe(1);
  });

  it('carries the 1995 restricted list and the legendary rule', () => {
    const format = standardFormatAt('1995-02-01');
    expect(format.ok).toBe(true);
    if (!format.ok) return;
    expect(format.restrictedLegendary).toBe(true);
    expect(format.restricted).toContain('Channel');
    expect(format.banned).toContain('Contract From Below');
    // And the rule is gone by the modern era, rather than assumed gone.
    const modern = standardFormatAt('2019-09-01');
    expect(modern.ok && modern.restrictedLegendary).toBe(false);
    expect(modern.ok && modern.restricted).toEqual([]);
  });
});

describe('a missing set is a returned value, not a short pool', () => {
  it('names the sets the index knew nothing about', () => {
    const pool = standardPoolAt('2019-09-01', index);
    expect(pool.ok).toBe(true);
    if (!pool.ok) return;
    // This tiny index holds WAR, M20, DOM and XLN of the nine legal sets.
    expect(pool.missingSets).toEqual(['RIX', 'M19', 'GRN', 'G18', 'RNA']);
    expect(pool.counts.sets).toBe(9);
  });
});

describe('isStandardLegalAt', () => {
  it('answers legal, with the sets that made it so', () => {
    const answer = isStandardLegalAt('Teferi, Time Raveler', '2019-09-01', index);
    expect(answer).toMatchObject({ ok: true, legal: true, sets: ['WAR'] });
  });

  it('distinguishes "not in the pool" from "banned"', () => {
    expect(isStandardLegalAt('Abrade', '2019-09-01', index)).toMatchObject({
      legal: false,
      why: 'not-in-pool',
    });
    expect(isStandardLegalAt('Rampaging Ferocidon', '2019-08-01', index)).toMatchObject({
      legal: false,
      why: 'banned',
    });
  });

  it('finds a two-faced card by its front face', () => {
    expect(isStandardLegalAt('Fable of the Mirror-Breaker', '2023-02-01', index)).toMatchObject({
      legal: true,
    });
  });

  it('never answers for a card that was never in Standard', () => {
    expect(isStandardLegalAt('Ancestral Recall', '1995-02-01', index)).toMatchObject({
      legal: false,
      why: 'not-in-pool',
    });
  });

  it('refuses an unsupported date rather than calling the card illegal', () => {
    expect(isStandardLegalAt('Shock', '2030-01-01', index)).toMatchObject({
      ok: false,
      reason: 'after-known-history',
    });
  });

  it('handles the 1997 Ice Age reversal card-by-card', () => {
    expect(isStandardLegalAt('Dark Ritual', '1996-01-01', index)).toMatchObject({ legal: true });
    expect(isStandardLegalAt('Dark Ritual', '1997-04-01', index)).toMatchObject({ legal: false });
    expect(isStandardLegalAt('Dark Ritual', '1997-08-01', index)).toMatchObject({ legal: true });
  });
});

/*
 * The corpus-scale half. `standard-pool.json` is generated by
 * `report-standard-pools.ts` against all 118,026 cards and committed on
 * purpose; these assertions are what make a regression in it fail the gate
 * rather than sit in a diff nobody reads.
 */
describe('the committed corpus report', () => {
  const report = JSON.parse(
    readFileSync(resolvePath(HERE, 'standard-pool.json'), 'utf8'),
  ) as Record<string, never>;
  const get = (path: string): unknown =>
    path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], report);

  it('was generated against the whole corpus', () => {
    expect(get('cardCache.cardCount')).toBe(118026);
    expect(get('cardCache.indexedPrintings')).toBe(100173);
    expect(get('cardCache.distinctSets')).toBe(712);
    expect(get('source.snapshots')).toBe(STANDARD_HISTORY.length);
    expect(get('source.sanctionedMatchesNewest')).toBe(true);
  });

  it('shows why legalities.standard cannot answer a historical date', () => {
    // 488 sets contain a card the field calls Standard-legal. Standard is 19.
    expect(get('whyNotLegalitiesStandard.setsWithAtLeastOneStandardLegalCard')).toBe(488);
    expect(get('whyNotLegalitiesStandard.setsInNewestStandard')).toBe(19);
  });

  it('agrees with Scryfall exactly on the one date Scryfall can speak to', () => {
    // Two unrelated sources — Forge's format files and Scryfall's own
    // legalities — and neither has a set the other lacks.
    expect(get('agreement.inForgeNotScryfall')).toEqual([]);
    expect(get('agreement.inScryfallNotForge')).toEqual([]);
    expect((get('agreement.forgeNewestSets') as string[]).length).toBe(19);
  });

  it('resolves every set of every tested date, and every ban', () => {
    const dates = get('dates') as Record<string, { missingSets: string[]; unmatchedBans: string[] }>;
    expect(Object.keys(dates).length).toBeGreaterThanOrEqual(8);
    for (const [date, row] of Object.entries(dates)) {
      expect({ date, missingSets: row.missingSets }).toEqual({ date, missingSets: [] });
      expect({ date, unmatchedBans: row.unmatchedBans }).toEqual({ date, unmatchedBans: [] });
    }
  });

  it('measures the pool at each tested date', () => {
    expect(get('dates.2019-09-01.counts.cards')).toBe(2025);
    expect(get('dates.2019-09-01.counts.sets')).toBe(9);
    expect(get('dates.2019-10-03.counts.cards')).toBe(2025);
    expect(get('dates.2019-10-04.counts.cards')).toBe(1370);
    expect(get('dates.2012-12-25.counts.cards')).toBe(1111);
    expect(get('dates.2005-01-01.counts.cards')).toBe(1239);
    expect(get('dates.2016-06-01.counts.cards')).toBe(1233);
    expect(get('dates.2026-08-14.counts.cards')).toBe(4898);
  });

  it('shows the front-face arm of the ban matcher earning its keep', () => {
    expect(get('banList.distinctNames')).toBe(91);
    expect(get('banList.matchedOnlyByFrontFace')).toEqual(['Fable of the Mirror-Breaker']);
    expect(get('banList.unmatched')).toEqual([]);
  });

  it('measures the drift the whole lane exists to express', () => {
    expect(get('drift.legalThenNotNow')).toBe(1864);
    expect(get('drift.legalNowNotThen')).toBe(4737);
    // The strong half: printed before 2019 and still not legal in 2019.
    expect(get('drift.legalNowNotThenButAlreadyPrintedIn2019')).toBe(190);
  });
});
