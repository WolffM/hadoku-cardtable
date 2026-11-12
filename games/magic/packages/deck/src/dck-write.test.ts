import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cubesDir, listCubeFiles, parseDck, type CardRequest, type DeckFile } from '@hadoku/carddata';
import {
  DckWriteError,
  composeCardLine,
  composeCardRequest,
  dckSpelling,
  writeDck,
} from './dck-write.ts';

const dir = cubesDir();
const readBytes = (file: string): Buffer => readFileSync(join(dir, file));
const read = (file: string): string => readBytes(file).toString('utf8');

/**
 * `DeckFile` holds Maps, which vitest's `toEqual` compares by content, but the
 * nested `flags` records and readonly arrays make a failure message unreadable.
 * A plain structural dump diffs legibly and loses nothing: every field of
 * `DeckFile` and `CardRequest` is in here.
 */
function snapshot(deck: DeckFile): unknown {
  return {
    name: deck.name,
    metadata: [...deck.metadata],
    sections: [...deck.sections].map(([key, entries]) => [
      key,
      entries.map((e) => [e.count, { ...e.card, flags: e.card.flags === null ? null : { ...e.card.flags } }]),
    ]),
  };
}

const request = (over: Partial<CardRequest> = {}): CardRequest => ({
  name: 'Card',
  set: 'ISD',
  artIndex: 1,
  collectorNumber: null,
  foil: false,
  backFace: false,
  flags: null,
  ...over,
});

describe('round-tripping every vendored cube', () => {
  /*
   * The property that matters: whatever the writer emits must parse back to
   * exactly the deck it was handed. Run over all 95 of Forge's own cube lists,
   * in both art-index policies and both empty-section policies, that covers
   * every grammar feature the format actually uses in the wild — 49,345 card
   * lines, mixed-case headers, UTF-8 names, counts above 99, set-less lines and
   * empty sections.
   */
  it('parse -> write -> parse is a fixed point for all 95 cubes', async () => {
    const files = await listCubeFiles(dir);
    expect(files).toHaveLength(95);

    for (const file of files) {
      const first = parseDck(read(file));
      for (const artIndex of ['minimal', 'always'] as const) {
        const written = writeDck(first, { artIndex, spelling: dckSpelling(read(file)) });
        const second = parseDck(written);
        expect(snapshot(second), `${file} (artIndex: ${artIndex})`).toEqual(snapshot(first));
      }
    }
  });

  it('survives a second round trip unchanged, text and all', async () => {
    // A fixed point on the parse is necessary but not sufficient: the writer
    // could still be non-idempotent on its own output. Once written, the text
    // must be stable.
    for (const file of await listCubeFiles(dir)) {
      const once = writeDck(parseDck(read(file)));
      const twice = writeDck(parseDck(once));
      expect(twice, file).toBe(once);
    }
  });

  it('drops empty sections only when asked, and loses the key when it does', async () => {
    const withEmptySections = (await listCubeFiles(dir)).filter((f) =>
      [...parseDck(read(f)).sections.values()].some((s) => s.length === 0),
    );
    // ArabianExtended's `[sideboard]`, SkieraCube's, and the `[Avatar]` headers
    // in the Old School cubes: 12 files ship a section header with nothing
    // under it. Forge's serializer skips those (DeckSerializer.java:79), which
    // is exactly why 'keep' has to be the default.
    expect(withEmptySections.length).toBe(12);

    for (const file of withEmptySections) {
      const parsed = parseDck(read(file));
      expect(snapshot(parseDck(writeDck(parsed, { emptySections: 'keep' }))), file).toEqual(
        snapshot(parsed),
      );
      const dropped = parseDck(writeDck(parsed, { emptySections: 'drop' }));
      expect(dropped.sections.size, file).toBeLessThan(parsed.sections.size);
    }
  });
});

describe('byte comparison against Forge-authored .dck files', () => {
  /*
   * The 95 files in `cubes/` are copied byte-for-byte from
   * `forge/forge-gui/res/cube/`, so they are Forge's own `.dck` output and the
   * only Forge-authored decks available without a Maven build. Both numbers
   * below were measured, not hoped for, and the failure modes are enumerated in
   * the test that follows so nobody has to guess what the gap is.
   */

  it('reproduces 12 cubes byte-for-byte from the parsed model alone', async () => {
    // No source-derived hints at all: parse the file, write it back using only
    // Forge's canonical spellings (DeckSection constant names, DeckFileHeader
    // key names), and compare bytes. These 12 are the files Forge itself wrote
    // in its canonical shape.
    const exact: string[] = [];
    for (const file of await listCubeFiles(dir)) {
      const original = readBytes(file);
      const parsed = parseDck(original.toString('utf8'));
      for (const artIndex of ['minimal', 'always'] as const) {
        if (Buffer.from(writeDck(parsed, { artIndex }), 'utf8').equals(original)) {
          exact.push(file);
          break;
        }
      }
    }
    expect(exact).toEqual([
      'Arena Powered Cube v3.0 2026-03.dck',
      "Elliot Raff's Khans Expanded Cube (MTGO).dck",
      'JuzamjediCube.dck',
      'MTG Arena Chromatic Cube June 24.dck',
      'MTGO Vintage Cube 2023-10.dck',
      'MTGO Vintage Cube 2024-06.dck',
      'Old School 93-94 Magic Powered 360 Card Cube.dck',
      'Old School 93-94 Magic Unpowered 400 Card Cube.dck',
      'Pioneer Cube.dck',
      "Ryan Overturf's Grixis Cube (MTGO).dck",
      'The Arena Cube.dck',
      'The Pauper Cube 2026-02.dck',
    ]);
  });

  it('reproduces 79 cubes byte-for-byte given the source file spelling', async () => {
    // With `dckSpelling` restoring the header and metadata-key casing that
    // `parseDck` lowercases away, most of the tree comes back untouched.
    let exact = 0;
    for (const file of await listCubeFiles(dir)) {
      const original = readBytes(file);
      const parsed = parseDck(original.toString('utf8'));
      const spelling = dckSpelling(original.toString('utf8'));
      for (const artIndex of ['minimal', 'always'] as const) {
        if (Buffer.from(writeDck(parsed, { artIndex, spelling }), 'utf8').equals(original)) {
          exact++;
          break;
        }
      }
    }
    expect(exact).toBe(79);
  });

  it('reproduces 92 cubes exactly, up to what the parser discards', async () => {
    /*
     * The plain byte comparison above is a floor, not a verdict: 16 of the
     * shipped cubes carry formatting that `parseDck` deliberately throws away,
     * so no writer of any kind could put them back. This test measures the
     * thing that is actually the writer's job — put the source through the
     * SAME losses the parser imposes, and the writer must then match it to the
     * byte, for every file.
     *
     * The losses, each from the parser's own cited source:
     *   - blank lines, and anything before the first section header
     *     (FileSection.java:102);
     *   - `#` and `;` comment lines (FileSection.java:102, CardPool.java:435);
     *   - the whitespace around a metadata key and value (dck.ts parseDck);
     *   - a missing or oddly-spaced count prefix, which becomes `1 ` and a
     *     single space (CardPool.java:413's `((\d+)\s+)?`);
     *   - a repeated section header, which Forge appends into the bucket the
     *     first one opened (FileSection.java:102).
     */
    const failures: string[] = [];
    for (const file of await listCubeFiles(dir)) {
      const text = read(file);
      const want = parserLossyNormalise(text);
      const parsed = parseDck(text);
      const spelling = dckSpelling(text);
      const matched = (['minimal', 'always'] as const).some(
        (artIndex) => writeDck(parsed, { artIndex, spelling }) === want,
      );
      if (!matched) failures.push(file);
    }

    /*
     * The only three that miss, and they miss for a reason no writer can fix:
     * each mixes `Name|SET` and `Name|SET|1` lines in the same file. Forge's
     * `CardRequest` has no "was an art index written?" bit (CardDb.java:284
     * fills the default in silently), so both lines parse to the same request
     * and no single per-file policy can put them back the way they were.
     */
    expect(failures).toEqual([
      'Amaz Peasant Cube.dck',
      'MTGACube.dck',
      'Wtwlf123 Powered Cube (540 cards).dck',
    ]);

    for (const file of failures) {
      const lines = read(file).split('\n');
      const explicit = lines.filter((l) => /^\d+ [^|]+\|[^|]+\|\d{1,2}$/.test(l)).length;
      const implicit = lines.filter((l) => /^\d+ [^|]+\|[^|]+$/.test(l)).length;
      expect(explicit, `${file} should have explicit art indexes`).toBeGreaterThan(0);
      expect(implicit, `${file} should have implicit art indexes too`).toBeGreaterThan(0);
    }
  });
});

/**
 * Put `.dck` text through exactly the information loss `parseDck` imposes, so
 * what comes out is the best any writer could do from a parsed `DeckFile`.
 * Mirrors `parseSections` (FileSection.java:102) and `processCardList`
 * (CardPool.java:435) line for line.
 */
function parserLossyNormalise(text: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  let inMetadata = false;
  let open = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const key = line.slice(1, -1).trim().toLowerCase();
      inMetadata = key === 'metadata';
      open = true;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(line);
      }
      continue;
    }
    if (!open || line.length === 0) continue;
    if (inMetadata) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      out.push(`${line.slice(0, eq).trim()}=${line.slice(eq + 1).trim()}`);
      continue;
    }
    if (line.startsWith(';')) continue;
    const m = /^([0-9]+)\s+([\s\S]*)$/.exec(line);
    out.push(m === null ? `1 ${line}` : `${Number(m[1])} ${m[2]}`);
  }

  return out.map((l) => l + '\n').join('');
}

describe('card request grammar, from the writing side', () => {
  it('writes a bare name with no set', () => {
    expect(composeCardRequest(request({ set: null }))).toBe('Card');
  });

  it('writes name and set', () => {
    expect(composeCardRequest(request({ set: 'DOM' }))).toBe('Card|DOM');
  });

  it('omits a default art index by default and writes it on request', () => {
    expect(composeCardRequest(request())).toBe('Card|ISD');
    expect(composeCardRequest(request(), 'always')).toBe('Card|ISD|1');
  });

  it('always writes a non-default art index', () => {
    expect(composeCardRequest(request({ artIndex: 2 }))).toBe('Card|ISD|2');
  });

  it('keeps the empty set placeholder, as Forge writes it', () => {
    // Forge's compose emits `name + "|" + ""` for a missing set (CardDb.java:137)
    // and `TextUtil.split` drops the blank again on the way in, so `Card|2`
    // would parse identically. The placeholder is kept because it is the shape
    // Forge writes and the shape the shipped cubes carry.
    expect(composeCardRequest(request({ set: null, artIndex: 2 }))).toBe('Card||2');
    expect(parseDck(`[main]\n1 Card||2\n`).sections.get('main')).toEqual(
      parseDck(`[main]\n1 Card|2\n`).sections.get('main'),
    );
  });

  it('writes the foil suffix without doubling one already there', () => {
    expect(composeCardRequest(request({ name: 'Black Lotus', set: 'LEA', foil: true }))).toBe(
      'Black Lotus+|LEA',
    );
    expect(composeCardRequest(request({ name: 'Black Lotus+', set: 'LEA', foil: true }))).toBe(
      'Black Lotus+|LEA',
    );
    // Forge: compose(cardName, isFoil) strips a `+` from a non-foil name.
    expect(composeCardRequest(request({ name: 'Black Lotus+', set: 'LEA', foil: false }))).toBe(
      'Black Lotus|LEA',
    );
  });

  it('writes a back-face art index', () => {
    expect(composeCardRequest(request({ set: 'ISD', backFace: true }))).toBe('Card|ISD|1$alt');
  });

  it('writes a collector number, keeping the art index slot ahead of it', () => {
    expect(composeCardRequest(request({ set: 'DSK', artIndex: -1, collectorNumber: '42' }))).toBe(
      'Card|DSK|[42]',
    );
    expect(composeCardRequest(request({ set: 'DSK', artIndex: 2, collectorNumber: '42' }))).toBe(
      'Card|DSK|2|[42]',
    );
  });

  it('writes a brace flag segment', () => {
    // The art-index slot is skippable here: `#{...}` is neither numeric nor
    // bracketed, so the parser falls straight through to the flag test
    // (CardDb.java:255-268).
    expect(composeCardRequest(request({ flags: { markedColors: 'WU' } }))).toBe(
      'Card|ISD|#{markedColors=WU}',
    );
    expect(composeCardRequest(request({ flags: { markedColors: 'WU' } }), 'always')).toBe(
      'Card|ISD|1|#{markedColors=WU}',
    );
  });

  it('forces an art index when flags would otherwise be read as the set code', () => {
    expect(composeCardRequest(request({ set: null, flags: { markedColors: 'WU' } }))).toBe(
      'Card||1|#{markedColors=WU}',
    );
  });

  it('treats ??? as no set, as Forge does', () => {
    expect(composeCardRequest(request({ set: '???' }))).toBe('Card');
  });

  it('always writes the count, even at one', () => {
    expect(composeCardLine({ count: 1, card: request({ set: 'LEG' }) })).toBe('1 Card|LEG');
    expect(composeCardLine({ count: 100, card: request({ set: 'VIS' }) })).toBe('100 Card|VIS');
  });
});

describe('refusing what the format cannot express', () => {
  const rejected: [string, CardRequest][] = [
    ['collector number with no set', request({ set: null, artIndex: -1, collectorNumber: '42' })],
    ['flags with no set and no art index', request({ set: null, artIndex: -1, flags: { a: 'b' } })],
    ['numeric set code', request({ set: '10' })],
    ["set code containing '|'", request({ set: 'IS|D' })],
    ["card name containing '|'", request({ name: 'Ca|rd' })],
    ['card name containing a newline', request({ name: 'Ca\nrd' })],
    ['empty card name', request({ name: '  ' })],
    ['art index above two digits', request({ artIndex: 100 })],
    ['art index below one', request({ artIndex: 0 })],
    ['flag key containing a tab', request({ flags: { 'a\tb': 'c' } })],
    ['flag key containing =', request({ flags: { 'a=b': 'c' } })],
    ["collector number containing '|'", request({ collectorNumber: 'a|b' })],
  ];

  for (const [why, card] of rejected) {
    it(`refuses a ${why}`, () => {
      expect(() => composeCardRequest(card)).toThrow(DckWriteError);
    });
  }

  it('refuses a metadata value that would not survive the parser trim', () => {
    const deck: DeckFile = {
      name: 'Trailing ',
      metadata: new Map([['name', 'Trailing ']]),
      sections: new Map(),
    };
    expect(() => writeDck(deck)).toThrow(DckWriteError);
  });

  it('refuses a negative card count', () => {
    expect(() => composeCardLine({ count: -1, card: request() })).toThrow(DckWriteError);
  });
});

describe('file shape', () => {
  const deck = (): DeckFile =>
    parseDck('[metadata]\nName=Test\n[main]\n1 Card|ISD\n[sideboard]\n2 Other|DOM\n');

  it('writes the metadata header lowercase and the section headers canonically', () => {
    expect(writeDck(deck())).toBe('[metadata]\nName=Test\n[Main]\n1 Card|ISD\n[Sideboard]\n2 Other|DOM\n');
  });

  it('terminates the last line, as PrintWriter.println does', () => {
    expect(writeDck(deck()).endsWith('\n')).toBe(true);
  });

  it('honours an alternative line separator throughout', () => {
    const out = writeDck(deck(), { lineSeparator: '\r\n' });
    expect(out.split('\r\n')).toHaveLength(7);
    expect(out.endsWith('\r\n')).toBe(true);
    // Still reads back the same: parseDck splits on /\r?\n/.
    expect(snapshot(parseDck(out))).toEqual(snapshot(deck()));
  });

  it('recovers the spelling a file actually used', () => {
    const source = '[metadata]\nname=Test\n[main]\n1 Card|ISD\n[sideboard]\n2 Other|DOM\n';
    expect(writeDck(parseDck(source), { spelling: dckSpelling(source) })).toBe(source);
  });
});
