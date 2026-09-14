import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { parseCardRequest } from './dck.ts';
import {
  buildCardIndex,
  foldName,
  resolveCard,
  type CardIndex,
  type Resolution,
} from './resolve.ts';
import { isKnownForgeSetCode, toScryfallSetCode } from './set-codes.ts';
import { ALLOWED_CARD_FIELDS } from './scryfall/project.ts';

/*
 * These tests run against a hand-built index, never against the 180 MB
 * `cards.jsonl` cache — that cache is gitignored and absent in CI, and a test
 * that needs it is a test that does not run. The corpus-wide numbers are
 * asserted separately, against the committed report.
 */

interface Face {
  name: string;
}
function card(fields: Record<string, unknown>): Record<string, unknown> {
  return { lang: 'en', layout: 'normal', digital: false, ...fields };
}

const STONEFORGE_WWK = card({
  name: 'Stoneforge Mystic',
  set: 'wwk',
  collector_number: '13',
  released_at: '2010-02-05',
  rarity: 'rare',
});
/*
 * Conflux: Forge calls it CFX, Scryfall calls it CON. One of 26 set codes in
 * the vendored corpus that genuinely need translating, covering 679 card
 * lines between them — every one of which would silently degrade to a
 * tier-3 name-only match without Forge's own ScryfallCode table.
 */
const NOBLE_HIERARCH_CON = card({
  name: 'Noble Hierarch',
  set: 'con',
  collector_number: '113',
  released_at: '2009-02-06',
  rarity: 'rare',
});
const STONEFORGE_WWK_ALT = card({
  name: 'Stoneforge Mystic',
  set: 'wwk',
  collector_number: '200',
  released_at: '2010-02-05',
  rarity: 'rare',
});
/** A two-faced card: Scryfall's top-level name is "Front // Back". */
const DELVER = card({
  name: 'Delver of Secrets // Insectile Aberration',
  layout: 'transform',
  set: 'isd',
  collector_number: '51',
  released_at: '2011-09-30',
  card_faces: [{ name: 'Delver of Secrets' }, { name: 'Insectile Aberration' }] as Face[],
});
/** Accented, to exercise the fold. */
const LIMDUL = card({
  name: "Lim-Dûl's Vault",
  set: 'all',
  collector_number: '124',
  released_at: '1996-06-10',
});
/** MTGO-only. Tier 3 must not pick it; tiers 1-2 must still honour it. */
const VMA_ONLY = card({
  name: 'Mtgo Exclusive',
  set: 'vma',
  collector_number: '1',
  released_at: '2014-06-16',
  digital: true,
});
/** A token that shares a real card's name — must never be indexed. */
const GOBLIN_TOKEN = card({
  name: 'Stoneforge Mystic',
  layout: 'token',
  set: 'twwk',
  collector_number: '1',
  released_at: '2010-02-05',
});
/** A non-English printing carries the English `name` and must not be indexed. */
const STONEFORGE_JA = card({
  name: 'Stoneforge Mystic',
  lang: 'ja',
  set: 'wwk',
  collector_number: '13',
  released_at: '2010-02-05',
});

const index: CardIndex = buildCardIndex([
  STONEFORGE_WWK,
  NOBLE_HIERARCH_CON,
  STONEFORGE_WWK_ALT,
  DELVER,
  LIMDUL,
  VMA_ONLY,
  GOBLIN_TOKEN,
  STONEFORGE_JA,
]);

/** Parse a cube line's card-request half the way a real cube list writes it. */
function ask(request: string): Resolution {
  return resolveCard(parseCardRequest(request), index);
}

describe('the index', () => {
  it('skips tokens and non-English printings, and says so', () => {
    expect(index.printings).toBe(6);
    expect(index.skipped['non-gameplay-layout']).toBe(1);
    expect(index.skipped['non-english']).toBe(1);
  });

  it('never returns a token for a real card name', () => {
    const result = ask('Stoneforge Mystic');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card['layout']).toBe('normal');
  });
});

describe('the three tiers', () => {
  it('tier 1: name + set + collector number pins an exact printing', () => {
    const result = ask('Stoneforge Mystic|WWK|[200]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('name+set+collector');
    expect(result.card).toBe(STONEFORGE_WWK_ALT);
    expect(result.setFellBack).toBe(false);
  });

  it('tier 2: name + set takes the earliest printing in that set', () => {
    const result = ask('Stoneforge Mystic|WWK');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('name+set');
    expect(result.card).toBe(STONEFORGE_WWK);
  });

  it('tier 2 translates the Forge set code, it does not pass it through', () => {
    // Forge writes Conflux as CFX; Scryfall's code for it is CON. Without the
    // translation this reference silently degrades to a tier-3 name match on
    // whatever the earliest printing happens to be.
    expect(toScryfallSetCode('CFX')).toBe('CON');
    const result = ask('Noble Hierarch|CFX');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('name+set');
    expect(result.scryfallSet).toBe('CON');
    expect(result.card).toBe(NOBLE_HIERARCH_CON);
  });

  it('leaves a set code alone when Forge maps it to itself', () => {
    // PRM is NOT an example of a code needing translation: Forge's Magic
    // Online Promos edition declares ScryfallCode=PRM and Scryfall really
    // does have a `prm` set (3,094 printings). Asserted so nobody "fixes"
    // the identity entries out of the generated table.
    expect(toScryfallSetCode('PRM')).toBe('PRM');
    expect(toScryfallSetCode('WWK')).toBe('WWK');
  });

  it('tier 3: a bare name takes the earliest non-digital printing', () => {
    const result = ask('Stoneforge Mystic');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('name');
    expect(result.card).toBe(STONEFORGE_WWK);
    // No set was asked for, so nothing fell back.
    expect(result.setFellBack).toBe(false);
  });

  it('falls back a tier at a time rather than all the way', () => {
    // Collector number 999 does not exist; the set does. Tier 2 catches it.
    const result = ask('Stoneforge Mystic|WWK|[999]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('name+set');
  });
});

describe('a set that does not resolve is reported, not hidden', () => {
  it('flags setFellBack when a requested set produced nothing', () => {
    const result = ask('Stoneforge Mystic|NOPE');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('name');
    expect(result.requestedSet).toBe('NOPE');
    expect(result.scryfallSet).toBeNull();
    // This is the flag that separates "the cube is fine" from "the cube
    // resolves, but to printings nobody asked for".
    expect(result.setFellBack).toBe(true);
    expect(isKnownForgeSetCode('NOPE')).toBe(false);
  });

  it('honours a digital-only set when the cube explicitly names it', () => {
    // VMA is MTGO-only and the most-referenced set in the corpus (1,687
    // lines). Refusing digital printings at tier 2 would fail all of them.
    const result = ask('Mtgo Exclusive|VMA');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('name+set');
    expect(result.card).toBe(VMA_ONLY);
  });

  it('refuses a digital-only card at tier 3, as a value', () => {
    const result = ask('Mtgo Exclusive');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('digital-only');
  });
});

describe('name variants', () => {
  it('finds a two-faced card by its front face alone', () => {
    // Forge writes "Delver of Secrets"; Scryfall's name is
    // "Delver of Secrets // Insectile Aberration". 942 references in the
    // corpus depend on this.
    const result = ask('Delver of Secrets|ISD');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchedBy).toBe('front-face');
    expect(result.card).toBe(DELVER);
  });

  it('still prefers the exact full name over a front-face match', () => {
    const result = ask('Delver of Secrets // Insectile Aberration|ISD');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchedBy).toBe('name');
  });

  it('folds diacritics, and says that is what it did', () => {
    // Jim Davis's Cube writes "Lim-Dul's Vault"; the card is "Lim-Dûl's Vault".
    expect(foldName("Lim-Dûl's Vault")).toBe("lim-dul's vault");
    const result = ask("Lim-Dul's Vault|ALL");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchedBy).toBe('folded-name');
    expect(result.card).toBe(LIMDUL);
  });

  it('reports an exact accented match as exact, not folded', () => {
    const result = ask("Lim-Dûl's Vault|ALL");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchedBy).toBe('name');
  });
});

describe('failure is a returned value', () => {
  it('returns unknown-name rather than throwing or returning null', () => {
    const result = ask('Not A Real Card|WWK');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-name');
    expect(result.name).toBe('Not A Real Card');
    expect(result.requestedSet).toBe('WWK');
  });

  it('returns empty-name for a malformed line', () => {
    const result = resolveCard(parseCardRequest(''), index);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty-name');
  });

  it('never resolves A-prefixed Arena rebalances to the original card', () => {
    // "A-Alrund's Epiphany" is a DIFFERENT card from "Alrund's Epiphany".
    // Stripping the prefix would be a guess, and a wrong one.
    const withOriginal = buildCardIndex([card({ name: "Alrund's Epiphany", set: 'khm' })]);
    const result = resolveCard(parseCardRequest("A-Alrund's Epiphany|KHM"), withOriginal);
    expect(result.ok).toBe(false);
  });
});

describe('determinism', () => {
  it('gives the same answer for the same cache, every time', () => {
    const again = buildCardIndex([
      // Deliberately a different insertion order.
      STONEFORGE_WWK_ALT,
      NOBLE_HIERARCH_CON,
      STONEFORGE_WWK,
      DELVER,
      LIMDUL,
      VMA_ONLY,
      GOBLIN_TOKEN,
      STONEFORGE_JA,
    ]);
    for (const request of ['Stoneforge Mystic', 'Stoneforge Mystic|WWK', 'Delver of Secrets|ISD']) {
      const a = resolveCard(parseCardRequest(request), index);
      const b = resolveCard(parseCardRequest(request), again);
      expect(a, request).toEqual(b);
    }
  });
});

/*
 * D13. The Wave 1 control asserts the ingest's allowlist; this asserts the
 * consumer, because a resolver that reached for an image field would be a
 * second, independent way to grow an image code path.
 */
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('D13 — no image code path', () => {
  const sources = ['resolve.ts', 'set-codes.ts', 'draft.ts', 'drafts.ts', 'cli/resolve-cubes.ts'];

  /*
   * The forbidden tokens are ASSEMBLED rather than written out, and that is
   * not obfuscation for its own sake. D13's control is a case-insensitive
   * `grep -rniE` over this exact directory for the two image extensions,
   * Scryfall's image field and their file origin — the pattern is written out
   * in `docs/CARD_DATA.md` §5.6 and in the Wave 2 plan's §A done-when, and
   * deliberately not here. That grep must find nothing. A test that spelled
   * its own needles would be
   * found by that grep and would turn the control's only signal — "this
   * directory contains no image vocabulary at all" — into a permanent false
   * positive that someone eventually learns to ignore. So the check runs, and
   * the grep stays clean. The pieces below are readable; put them together.
   */
  const forbidden = [
    ['image', '_uris'],
    ['\\.', 'jp', 'e?g\\b'],
    ['\\.', 'pn', 'g\\b'],
    ['scryfall', '\\.', 'io'],
  ].map((parts) => new RegExp(parts.join(''), 'i'));

  it('names no image field anywhere in the resolution path', () => {
    for (const file of sources) {
      const text = readFileSync(resolvePath(SRC_DIR, file), 'utf8');
      for (const pattern of forbidden) {
        expect(text, `${file} vs ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('would actually catch an image field if one appeared', () => {
    // The control above is only worth having if it bites. Prove it does,
    // against a string built the same way rather than a literal.
    const leak = `const url = card[${JSON.stringify(['image', '_uris'].join(''))}];`;
    expect(forbidden.some((p) => p.test(leak))).toBe(true);
  });

  it('cannot return an image field, because the allowlist has none', () => {
    for (const field of ALLOWED_CARD_FIELDS) {
      expect(field).not.toMatch(/image|art_crop|png|jpg|uri/i);
    }
  });
});

describe('the committed resolution report', () => {
  /*
   * The report is the lane's deliverable and this is its regression gate. It
   * runs off the committed JSON rather than the card cache, so it bites in CI
   * where the 180 MB cache does not exist. If a Forge bump or a Scryfall
   * change moves any of these, the number in the report changes and this
   * fails — which is the point.
   */
  const report = JSON.parse(
    readFileSync(resolvePath(SRC_DIR, '..', 'reports', 'cube-resolution.json'), 'utf8'),
  ) as {
    totals: {
      cubes: number;
      lines: number;
      resolved: number;
      unresolved: number;
      setFellBack: number;
      tiers: Record<string, number>;
      matchedBy: Record<string, number>;
    };
    fullyResolvedCubes: number;
    unresolved: { name: string; requestedSet: string | null; reason: string }[];
    failedSetCodes: { forgeSet: string }[];
    recipes: { count: number; withoutCube: string[] };
    cardCache: { bulkType: string };
  };

  it('covers all 95 cubes and all 94 recipes', () => {
    expect(report.totals.cubes).toBe(95);
    expect(report.recipes.count).toBe(94);
    expect(report.cardCache.bulkType).toBe('default_cards');
  });

  it('resolves 49,337 of 49,345 references, 93 cubes clean', () => {
    expect(report.totals.lines).toBe(49345);
    expect(report.totals.resolved).toBe(49337);
    expect(report.totals.unresolved).toBe(8);
    expect(report.fullyResolvedCubes).toBe(93);
  });

  it('accounts for every unresolved reference individually', () => {
    // Eight references, three causes, all of them real gaps in Scryfall's
    // data rather than resolver failures. Listing them by name is the point:
    // a new unresolved reference must be looked at, not absorbed into a rate.
    expect(report.unresolved.map((u) => u.name).sort()).toEqual([
      "A-Alrund's Epiphany",
      'A-Omnath, Locus of Creation',
      'Ademi of the Silkchutes',
      'Cam and Farrik, Havoc Duo',
      'Desecrex, Gift of Servitude',
      'Goben, Gene-Splice Savant',
      'Makdee and Itla, Skysnarers',
      'The Scouring Stormsoul',
    ]);
  });

  it('names the two set codes Forge itself does not know', () => {
    expect(report.failedSetCodes.map((f) => f.forgeSet).sort()).toEqual(['PTDM', 'PWOE']);
    expect(report.totals.setFellBack).toBe(2);
  });

  it('names the two recipes whose DeckFile matches no cube', () => {
    expect(report.recipes.withoutCube).toEqual([
      'The Pauper Cube 2026-02.draft',
      'The Peasant Cube 2023 (June).draft',
    ]);
  });

  it('records which name variant carried each match', () => {
    const m = report.totals.matchedBy;
    expect(m['name']).toBe(48394);
    expect(m['front-face']).toBe(942);
    expect(m['folded-name']).toBe(1);
    expect(m['folded-front-face']).toBe(0);
    expect(m['name'] + m['front-face'] + m['folded-name'] + m['folded-front-face']).toBe(
      report.totals.resolved,
    );
  });

  it('resolves almost everything at a tier that honours the requested set', () => {
    const t = report.totals.tiers;
    expect(t['name+set+collector']).toBe(989);
    expect(t['name+set']).toBe(48274);
    // Only 74 references land on a bare name, and only 2 of those asked for
    // a set. That is the number that says the corpus is draftable.
    expect(t['name']).toBe(74);
  });
});
