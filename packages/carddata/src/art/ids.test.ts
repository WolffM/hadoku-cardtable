/*
 * The committed art tables, resolved through the REAL resolver.
 *
 * `./index.test.ts` asks what `resolveArtUrl` does, against fabricated ids and
 * fabricated manifests — the right question for a resolver. This file asks the
 * question that broke in a real match (wave 19 §D, #9 *"some art missing"*):
 * **given the cards a match can actually contain, does an art URL come out?**
 * So nothing here is fabricated. It loads the files that ship —
 * `apps/ui/src/draft/art-ids.json`, `pool.json` and `art-manifest.json` — builds
 * the index the way `apps/ui/src/play/adapter.ts` builds it, and puts the answer
 * through `resolveArtUrl` itself. A stub anywhere in that chain would make the
 * test pass while the board stayed blank, which is exactly what happened.
 *
 * Read with `node:fs` rather than imported, because this package is Node-side
 * and must not take a type dependency on the UI's JSON. The browser imports
 * them as modules; the bytes are the same either way.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_ART_HOSTS,
  SCRYFALL_IMAGE_BASE,
  resolveArtUrl,
  type ArtManifestFile,
} from './index.ts';
import { FORGE_TO_SCRYFALL_SET } from '../set-codes.ts';
import {
  artIdIndex,
  artIdIndexFromTable,
  artIdsWithBacks,
  BACK_FACE,
  artIdKey,
  backFaceNames,
  mergeArtIdIndexes,
  scryfallIdFor,
  tokenArtId,
  ART_ID_TABLE_VERSION,
  type ArtIdIndex,
  type ArtIdSource,
  type ArtIdTableFile,
} from './ids.ts';

const DRAFT_DIR = new URL('../../../../apps/ui/src/draft/', import.meta.url);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, DRAFT_DIR)), 'utf8')) as T;
}

const TABLE = readJson<ArtIdTableFile>('art-ids.json');
const POOL = readJson<{ cards: ArtIdSource[] }>('pool.json');
const MANIFEST = readJson<ArtManifestFile>('art-manifest.json');

/** Exactly how `adapter.ts` composes `KNOWN_ART_IDS`: the pool first. */
const KNOWN: ArtIdIndex = mergeArtIdIndexes(artIdIndex(POOL.cards), artIdIndexFromTable(TABLE));
const CUBE_ONLY: ArtIdIndex = artIdIndex(POOL.cards);

/** The whole chain, end to end: a name and a Forge set code in, a URL out. */
function artUrlFor(name: string, setCode: string, index: ArtIdIndex = KNOWN): string | null {
  return resolveArtUrl(scryfallIdFor(index, name, setCode), MANIFEST.entries);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An art id: a Scryfall id, or a back face's (`BACK_FACE`). */
const ART_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(#back)?$/;

describe('every card a match can contain has art', () => {
  /*
   * `Mountain|MRD` is not a hypothetical. It is the exact pair in the committed
   * capture (`apps/ui/src/play/fixtures/tierc-game1-seq1-27.json` carries
   * `ImageKey: "c:Mountain|MRD|1"`, `SetCode: "MRD"`), so this is the card the
   * operator was looking at when they said art was missing.
   */
  it('resolves a basic land the cube pool never held', () => {
    expect(scryfallIdFor(CUBE_ONLY, 'Mountain', 'MRD'), 'the bug: the pool has no basics').toBeUndefined();

    const id = scryfallIdFor(KNOWN, 'Mountain', 'MRD');
    expect(id).toMatch(UUID);

    const url = artUrlFor('Mountain', 'MRD');
    expect(url).not.toBeNull();
    expect(ALLOWED_ART_HOSTS).toContain(new URL(url!).origin);
    expect(url).toContain(id!);
  });

  it('gives each basic land its own printing rather than one generic land', () => {
    const printings = new Set(
      ['MRD', 'LEA', 'M13', 'ZEN', 'UNF'].map((set) => scryfallIdFor(KNOWN, 'Mountain', set)),
    );
    expect(printings.size, 'five sets, five Mountains').toBe(5);
    for (const id of printings) expect(id).toMatch(UUID);
  });

  it('resolves every basic land name the table knows, in the set it was printed in', () => {
    const basics = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes', 'Snow-Covered Forest'];
    for (const name of basics) {
      const url = artUrlFor(name, '');
      expect(url, `${name} has art`).not.toBeNull();
      expect(ALLOWED_ART_HOSTS).toContain(new URL(url!).origin);
    }
  });

  it('resolves an out-of-pool constructed card, by exact printing and by name alone', () => {
    for (const [name, set] of [
      ['Delver of Secrets', 'ISD'],
      ['Vapor Snag', 'NPH'],
    ] as const) {
      expect(POOL.cards.some((c) => c.name === name), `${name} is out of pool`).toBe(false);
      expect(scryfallIdFor(CUBE_ONLY, name, set), `${name} was blank before`).toBeUndefined();

      const exact = artUrlFor(name, set);
      expect(exact, `${name}|${set}`).not.toBeNull();
      expect(ALLOWED_ART_HOSTS).toContain(new URL(exact!).origin);

      // Forge may name a printing nobody wrote down. Another printing's art is
      // still that card's art, so the bare name must still answer.
      const fallback = artUrlFor(name, 'NO-SUCH-SET');
      expect(fallback, `${name} falls back rather than going blank`).not.toBeNull();
    }
  });

  /*
   * The operator, 2026-10-11: "insectile aberation has no art". Forge names
   * the face a card is showing, so a transformed Delver of Secrets crosses the
   * wire as Insectile Aberration — a name a `.dck` never carries.
   */
  it("draws a transformed card's back face as that card's back image", () => {
    const delver = scryfallIdFor(KNOWN, 'Delver of Secrets', 'ISD')!;
    expect(delver).toMatch(UUID);
    for (const set of ['ISD', 'NO-SUCH-SET']) {
      expect(scryfallIdFor(KNOWN, 'Insectile Aberration', set), set).toBe(`${delver}${BACK_FACE}`);
      expect(artUrlFor('Insectile Aberration', set), set).toBe(`${SCRYFALL_IMAGE_BASE}/normal/back/${delver[0]}/${delver[1]}/${delver}.jpg`);
    }
  });

  it("draws a cube card's back face from the printing its front draws", () => {
    const fable = scryfallIdFor(KNOWN, 'Fable of the Mirror-Breaker', '')!;
    expect(scryfallIdFor(KNOWN, 'Reflection of Kiki-Jiki', '')).toBe(`${fable}${BACK_FACE}`);
  });

  it('draws the faces that share one image — split halves, an adventure, a flip card, a meld result — with art', () => {
    for (const [face, card] of [
      ['Death', 'Life // Death'],
      ['Stomp', 'Bonecrusher Giant'],
      ['Tomoya the Revealer', 'Jushi Apprentice'],
    ] as const) {
      expect(scryfallIdFor(KNOWN, face, ''), face).toBe(scryfallIdFor(KNOWN, card, ''));
    }
    expect(scryfallIdFor(KNOWN, 'Urza, Planeswalker', ''), 'the melded Urza is a card of its own').toMatch(UUID);
  });

  it('preloads a back face beside its front', () => {
    const delver = scryfallIdFor(KNOWN, 'Delver of Secrets', '')!;
    const bolt = scryfallIdFor(KNOWN, 'Lightning Bolt', '')!;
    expect(artIdsWithBacks(KNOWN, [delver, bolt])).toEqual([delver, `${delver}${BACK_FACE}`, bolt]);
  });

  it('still draws nothing for a card nothing knows', () => {
    expect(scryfallIdFor(KNOWN, 'Not A Card Anyone Printed', 'XYZ')).toBeUndefined();
    expect(artUrlFor('Not A Card Anyone Printed', 'XYZ')).toBeNull();
  });

  /*
   * R14 (wave 35). The operator: a Goblin Rogue token drew no art, because the
   * table had NO token entries at all. `adapter.ts` asks for a token exactly
   * as it asks for anything else — `scryfallIdFor(artIds, name, setCode)` —
   * and Forge's wire `Name` for a token is `"<the printed name> Token"` for
   * the overwhelming majority of tokens (`build-art-ids.ts`'s `forgeTokenWireNames`
   * reads the real convention off Forge's own `tokenscripts/*.txt` rather than
   * assuming it, which is also why this suffix is correct for "Goblin Rogue"
   * and not applied to a token that copies a specific real card by name).
   */
  it('resolves a creature token by its Forge wire name, "<name> Token"', () => {
    for (const name of ['Goblin Rogue', 'Zombie', 'Soldier', 'Treasure', 'Clue']) {
      const wireName = `${name} Token`;
      expect(scryfallIdFor(KNOWN, wireName, ''), wireName).toMatch(UUID);
      const url = artUrlFor(wireName, '');
      expect(url, wireName).not.toBeNull();
      expect(ALLOWED_ART_HOSTS).toContain(new URL(url!).origin);
    }
  });

  it('never doubles the "Token" suffix for a token that copies a specific real card by name', () => {
    // Kher Keep's token is a copy of the actual printed "Kobolds of Kher
    // Keep" — Forge's own tokenscript names it with NO " Token" suffix, so
    // the row (and the lookup) must be the bare name, not the bare name plus
    // "Token" twice over or once wrongly.
    expect(TABLE.ids['Kobolds of Kher Keep Token']).toBeUndefined();
    expect(scryfallIdFor(KNOWN, 'Kobolds of Kher Keep', ''), 'Kobolds of Kher Keep').toMatch(UUID);
  });
});

describe('the committed table', () => {
  it('is the version this build reads', () => {
    expect(TABLE.version).toBe(ART_ID_TABLE_VERSION);
  });

  it('carries ids and nothing else — no URL, no host, no image metadata (D15)', () => {
    const raw = readFileSync(fileURLToPath(new URL('art-ids.json', DRAFT_DIR)), 'utf8');
    // The note names the module that owns URLs, so look at the data, not the prose.
    const data = JSON.stringify(TABLE.ids);
    expect(data).not.toMatch(/https?:/);
    expect(data).not.toMatch(/image_uris|image_status|art_crop/);
    expect(data).not.toMatch(/\.(jpe?g|png|webp|gif|avif)/i);
    expect(data).not.toMatch(/scryfall\.io|cdn\.hadoku\.me/);
    // And the file as a whole ships no bytes by the back door.
    expect(raw).not.toMatch(/data:image\//);

    for (const id of Object.values(TABLE.ids)) expect(id).toMatch(ART_ID);
  });

  it('names a back face only of a card whose front it also names', () => {
    const fronts = new Set(Object.values(TABLE.ids).filter((id) => !id.endsWith(BACK_FACE)));
    for (const id of POOL.cards.map((c) => c.scryfallId)) if (id !== undefined) fronts.add(id);
    const backs = Object.values(TABLE.ids).filter((id) => id.endsWith(BACK_FACE));
    expect(backs.length).toBeGreaterThan(0);
    expect(backs.filter((id) => !fronts.has(id.slice(0, -BACK_FACE.length)))).toEqual([]);
  });

  it('keys an exact printing as Name|SET, with the set upper-cased', () => {
    for (const key of Object.keys(TABLE.ids)) {
      const pipe = key.indexOf('|');
      if (pipe === -1) continue;
      const set = key.slice(pipe + 1);
      expect(set, key).toBe(set.toUpperCase());
      expect(artIdKey(key.slice(0, pipe), set.toLowerCase()), key).toBe(key);
    }
  });

  /*
   * The invariant is about the INDEX, not the file. Cube cards get their
   * bare-name row from `pool.json`, which is already in the bundle, so the
   * table deliberately does not repeat 534 of them — see the script's header.
   * What must hold is that no name the table names can come out blank when
   * Forge hands us a printing nobody wrote down.
   */
  it('leaves no name that goes blank under an unknown set code', () => {
    const blank = new Set<string>();
    for (const key of Object.keys(TABLE.ids)) {
      const pipe = key.indexOf('|');
      const name = pipe === -1 ? key : key.slice(0, pipe);
      if (scryfallIdFor(KNOWN, name, 'NO-SUCH-SET') === undefined) blank.add(name);
    }
    expect([...blank].sort()).toEqual([]);
  });
});

describe('the pool keeps precedence', () => {
  /*
   * The merge is additive by construction, and this is the assertion that says
   * so: every cube card must resolve to precisely the id it resolved to before
   * `art-ids.json` existed. A regression here would repoint 534 cards' art as a
   * side effect of fixing the basics, which is the sort of thing nobody notices
   * until the operator does.
   */
  it('resolves every cube card exactly as the pool alone did', () => {
    for (const card of POOL.cards) {
      if (card.scryfallId === undefined || card.scryfallId === '') continue;
      expect(scryfallIdFor(KNOWN, card.name, card.setCode), card.name).toBe(
        scryfallIdFor(CUBE_ONLY, card.name, card.setCode),
      );
      expect(scryfallIdFor(KNOWN, card.name, 'NO-SUCH-SET'), card.name).toBe(
        scryfallIdFor(CUBE_ONLY, card.name, 'NO-SUCH-SET'),
      );
    }
  });

  it('adds the Forge set-code aliases the pool could not have', () => {
    /*
     * 92 of Forge's edition codes are not their Scryfall code, so a cube card
     * printed in one of those misses `Name|SET` entirely — Forge says `FOO`
     * where `pool.json` says `BAR`. Those alias rows must exist and must carry
     * the POOL's id, because the pool is the printing the cube was built from.
     *
     * Note what this is NOT: `Arid Mesa|ZEN` is in the table and disagrees with
     * the pool's `Arid Mesa|MH2`, and that is correct — ZEN is not an alias of
     * MH2, it is the printing a committed constructed list named. Only keys
     * whose set code Forge itself maps onto the pool card's set are aliases.
     */
    let checked = 0;
    for (const card of POOL.cards) {
      if (card.scryfallId === undefined || card.scryfallId === '') continue;
      const setCode = card.setCode.toUpperCase();
      for (const [forge, scryfall] of FORGE_TO_SCRYFALL_SET) {
        if (scryfall.toUpperCase() !== setCode) continue;
        const key = artIdKey(card.name, forge);
        expect(scryfallIdFor(KNOWN, card.name, forge), key).toBe(card.scryfallId);
        if (forge.toUpperCase() !== setCode) {
          expect(TABLE.ids[key], key).toBe(card.scryfallId);
          checked += 1;
        }
      }
    }
    expect(checked, 'some cube card is in a set Forge names differently').toBeGreaterThan(0);
  });
});

/*
 * The operator, 2026-10-17: "phyrexian wurm tokens are still wrong. i see a wurmcoil die, and i see the
 * toxic/trample tokens." Forge names Wurmcoil Engine's two Wurms and Phyrexia: All Will Be One
 * Commander's toxic one alike, "Phyrexian Wurm Token", and Scryfall names Wurmcoil's plain "Wurm" — so
 * the name lookup fell through to the toxic one. A token's `ImageKey` names its tokenscript, edition
 * and number (read off a real game: `token-art.jvm.test.ts`), and that is what picks the art now.
 */
describe('a token’s art follows its tokenscript, not its name', () => {
  const TOXIC = '594c55d3-d435-4dec-bc92-011442a43684'; // tonc 16, green */* trample toxic
  const WURMCOIL_2XM = { deathtouch: 'b68e816f-f9ac-435b-ad0b-ceedbe72447a', lifelink: 'a6ee0db9-ac89-4ab6-ac2e-8a7527d9ecbd' }; // t2xm 29, 30
  const WURMCOIL_SOM = { deathtouch: '3e46e703-2157-41e5-9c21-c17af43e0d3f', lifelink: 'ee53b9a0-8e07-404d-87ae-ff8397a0ba29' }; // tsom 8, 9

  it('the name alone picks the toxic Wurm — the bug', () => {
    expect(scryfallIdFor(KNOWN, 'Phyrexian Wurm Token', '2XM')).toBe(TOXIC);
  });

  it('Wurmcoil Engine’s deathtouch and lifelink Wurms each draw their own printing, as Forge sent them', () => {
    expect(tokenArtId(KNOWN, 't:c_3_3_a_phyrexian_wurm_deathtouch|2XM|29|1')).toBe(WURMCOIL_2XM.deathtouch);
    expect(tokenArtId(KNOWN, 't:c_3_3_a_phyrexian_wurm_lifelink|2XM|30|1')).toBe(WURMCOIL_2XM.lifelink);
    expect(tokenArtId(KNOWN, 't:c_3_3_a_phyrexian_wurm_deathtouch|SOM|8|1')).toBe(WURMCOIL_SOM.deathtouch);
    expect(tokenArtId(KNOWN, 't:c_3_3_a_phyrexian_wurm_lifelink|SOM|9|1')).toBe(WURMCOIL_SOM.lifelink);
  });

  it('an edition with no printing of that token still draws that token, never another of its name', () => {
    expect(tokenArtId(KNOWN, 't:c_3_3_a_phyrexian_wurm_lifelink|ZZZ|1|1')).toBe(WURMCOIL_SOM.lifelink);
    expect(tokenArtId(KNOWN, 't:g_x_x_phyrexian_wurm_trample_toxic|ONC|16|1')).toBe(TOXIC);
  });

  it('a colourless Spirit is not drawn as the white flying one its name shares', () => {
    // Shadowmoor's, by name alone: a white 1/1 flier (tshm). Eternal Masters' colourless Spirit by its script.
    expect(scryfallIdFor(KNOWN, 'Spirit Token', 'SHM')).toBe('cba50f25-ad8c-4244-8dc1-f8656f4c8c0b');
    expect(tokenArtId(KNOWN, 't:c_1_1_spirit|SHM|1|1')).toBe(TABLE.ids['t:c_1_1_spirit']);
    expect(TABLE.ids['t:c_1_1_spirit']).not.toBe('cba50f25-ad8c-4244-8dc1-f8656f4c8c0b');
    expect(tokenArtId(KNOWN, 't:w_1_1_spirit_flying|AVR|1|1')).toBe(TABLE.ids['t:w_1_1_spirit_flying|AVR']);
  });

  it('the initiative, the monarch and the Undercity draw their art by the keys a real game sent', () => {
    // Read off a real game by `designations.jvm.test.ts`. The initiative is the back of CLB's
    // Undercity token (`20☇ initiative` in Forge's `[other]`); the monarch, Commander Masters'.
    expect(tokenArtId(KNOWN, 't:initiative|CLB|20☇')).toBe('2c65185b-6cf0-451d-985e-56aa45d9a57d#back');
    expect(tokenArtId(KNOWN, 't:undercity|CLB|20')).toBe('2c65185b-6cf0-451d-985e-56aa45d9a57d');
    expect(tokenArtId(KNOWN, 't:monarch|CMM|50')).toBe(TABLE.ids['t:monarch|CMM']);
    expect(TABLE.ids['t:monarch|CMM']).toBeDefined();
  });

  it('is nothing for a card that is not a token, or a script the table does not know', () => {
    expect(tokenArtId(KNOWN, 'c:Mountain|MRD|1')).toBeUndefined();
    expect(tokenArtId(KNOWN, 't:no_such_tokenscript|2XM|1|1')).toBeUndefined();
    expect(tokenArtId(KNOWN, null)).toBeUndefined();
  });
});

describe('backFaceNames: a two-image card’s other faces, by the table alone', () => {
  it('names Etali, Primal Sickness for Etali, Primal Conqueror’s id, and nothing for a one-image card or a back', () => {
    const etali = scryfallIdFor(KNOWN, 'Etali, Primal Conqueror', 'MOM');
    expect(backFaceNames(KNOWN, etali)).toEqual(['Etali, Primal Sickness']);
    expect(backFaceNames(KNOWN, scryfallIdFor(KNOWN, 'Fable of the Mirror-Breaker', 'NEO'))).toEqual(['Reflection of Kiki-Jiki']);
    expect(backFaceNames(KNOWN, scryfallIdFor(KNOWN, 'Bonecrusher Giant', 'ELD')), 'an adventure is one image').toEqual([]);
    expect(backFaceNames(KNOWN, `${etali}${BACK_FACE}`)).toEqual([]);
    expect(backFaceNames(KNOWN, undefined)).toEqual([]);
  });
});
