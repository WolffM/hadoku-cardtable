import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countCards, countEntries, parseCardLine, parseCardRequest, parseDck } from './dck.ts';
import { cubesDir, listCubeFiles } from './cubes.ts';

const dir = cubesDir();
const read = (file: string): string => readFileSync(join(dir, file), 'utf8');

describe('real Forge cube lists', () => {
  /*
   * Counts asserted against the actual vendored files, and independently
   * cross-checked with awk before being written down here — not copied from the
   * cube's own name, which is exactly where a wrong number would come from.
   * `Hypercube (383 cards).dck`, for instance, is a reminder that the filename
   * is not the count.
   *
   * `entries` is distinct card lines (a singleton cube's real size); `cards` is
   * the sum of the per-line counts.
   */
  const cases = [
    { file: 'ArabianExtended.dck', name: 'ArabianExtended', entries: 96, cards: 195 },
    {
      file: "Adam Styborkski's Pauper Cube.dck",
      name: "Adam Styborkski's Pauper Cube",
      entries: 395,
      cards: 395,
    },
    {
      file: 'MTGO Vintage Cube 2022-02.dck',
      name: 'MTGO Vintage Cube 2022-02',
      entries: 540,
      cards: 540,
    },
    { file: 'Amaz Peasant Cube.dck', name: 'Amaz Peasant Cube', entries: 600, cards: 600 },
    { file: 'Legendary Cube.dck', name: 'Legendary Cube', entries: 598, cards: 598 },
  ] as const;

  for (const { file, name, entries, cards } of cases) {
    it(`parses ${file}`, () => {
      const deck = parseDck(read(file));
      expect(deck.name).toBe(name);
      expect(countEntries(deck, 'main')).toBe(entries);
      expect(countCards(deck, 'main')).toBe(cards);
      for (const entry of deck.sections.get('main') ?? []) {
        expect(entry.card.name.length).toBeGreaterThan(0);
        expect(entry.count).toBeGreaterThan(0);
      }
    });
  }

  it('reads a count well above one digit', () => {
    // ArabianExtended's 195 cards come from 95 singletons plus this one line;
    // a count regex that only matched `[0-9]` would silently lose 99 cards.
    const deck = parseDck(read('ArabianExtended.dck'));
    const big = (deck.sections.get('main') ?? []).find((e) => e.card.name === "Suleiman's Legacy");
    expect(big?.count).toBe(100);
  });

  it('keeps sections other than main, lowercased', () => {
    const deck = parseDck(read('Amaz Peasant Cube.dck'));
    // That file writes `[Main]` and `[Avatar]` in mixed case; 60 of the 95
    // cubes use `[main]` and 35 use `[Main]`, so lookups must not care.
    expect([...deck.sections.keys()]).toEqual(
      expect.arrayContaining(['main', 'avatar', 'sideboard', 'planes', 'schemes', 'conspiracy']),
    );
  });

  it('preserves non-ASCII card names', () => {
    // 12 of the 95 files are UTF-8 rather than ASCII; losing the encoding would
    // turn these into names no card database can resolve.
    const deck = parseDck(read('ArabianExtended.dck'));
    const names = (deck.sections.get('main') ?? []).map((e) => e.card.name);
    expect(names).toContain('Dandân');
    expect(names).toContain('El-Hajjâj');
  });

  it('parses every vendored cube without losing a line', async () => {
    const files = await listCubeFiles(dir);
    expect(files).toHaveLength(95);

    let totalEntries = 0;
    for (const file of files) {
      const text = read(file);
      const deck = parseDck(text);
      expect(deck.name, `${file} has no Name= metadata`).not.toBeNull();
      expect(countEntries(deck, 'main'), `${file} has an empty main section`).toBeGreaterThan(0);
      totalEntries += countEntries(deck, 'main');

      // Independent check: every non-blank, non-comment line inside a card
      // section must have produced exactly one entry. This is what catches a
      // line the parser quietly drops.
      let expectedLines = 0;
      let section: string | null = null;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('#')) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
          section = line.slice(1, -1).trim().toLowerCase();
          continue;
        }
        if (section === null || section === 'metadata' || line.length === 0) continue;
        if (line.startsWith(';')) continue;
        expectedLines++;
      }
      const parsedLines = [...deck.sections.values()].reduce((n, s) => n + s.length, 0);
      expect(parsedLines, `${file}: dropped lines`).toBe(expectedLines);
    }
    expect(totalEntries).toBe(49_345);
  });
});

describe('card request grammar', () => {
  it('takes a bare name with no set', () => {
    // 16 of the vendored cubes carry set-less lines like this one.
    expect(parseCardRequest('Allosaurus Shepherd')).toMatchObject({
      name: 'Allosaurus Shepherd',
      set: null,
      artIndex: 1,
      collectorNumber: null,
      foil: false,
    });
  });

  it('takes name and set', () => {
    expect(parseCardRequest('Academy Journeymage|DOM')).toMatchObject({
      name: 'Academy Journeymage',
      set: 'DOM',
      artIndex: 1,
    });
  });

  it('takes an art index', () => {
    expect(parseCardRequest('Abbey Gargoyles|HML|2')).toMatchObject({
      name: 'Abbey Gargoyles',
      set: 'HML',
      artIndex: 2,
      collectorNumber: null,
    });
  });

  it('takes a bracketed collector number and does not then default the art index', () => {
    expect(parseCardRequest('Abhorrent Oculus|DSK|[42]')).toMatchObject({
      name: 'Abhorrent Oculus',
      set: 'DSK',
      collectorNumber: '42',
      artIndex: -1,
    });
  });

  it('recognises the foil suffix', () => {
    expect(parseCardRequest('Black Lotus+|LEA')).toMatchObject({
      name: 'Black Lotus',
      set: 'LEA',
      foil: true,
    });
  });

  it('recognises a back-face art index', () => {
    expect(parseCardRequest('Delver of Secrets|ISD|1$alt')).toMatchObject({
      artIndex: 1,
      backFace: true,
    });
  });

  it('treats ??? as no set', () => {
    expect(parseCardRequest('Some Card|???').set).toBeNull();
  });

  it('drops empty segments, as Forge does', () => {
    expect(parseCardRequest('Some Card||2')).toMatchObject({ set: null, artIndex: 2 });
  });

  it('parses a brace flag segment', () => {
    expect(parseCardRequest('Some Card|ISD|1|#{markedColors=WU}').flags).toEqual({
      markedColors: 'WU',
    });
  });

  it('keeps a three-digit art index out of the art-index slot', () => {
    // Forge's isArtIndex caps at two digits, so `100` falls through to the
    // set-code test having already failed, and is simply ignored.
    expect(parseCardRequest('Some Card|ISD|100')).toMatchObject({ set: 'ISD', artIndex: 1 });
  });
});

describe('card lines', () => {
  it('defaults a missing count to one', () => {
    expect(parseCardLine('Abomination|LEG')).toMatchObject({ count: 1 });
  });

  it('reads a multi-digit count', () => {
    expect(parseCardLine('100 Suleiman’s Legacy|VIS')?.count).toBe(100);
  });

  it('ignores comments and blanks', () => {
    expect(parseCardLine('# 1 Ineffable Blessing|UST')).toBeNull();
    expect(parseCardLine('; not yet supported')).toBeNull();
    expect(parseCardLine('   ')).toBeNull();
  });
});
