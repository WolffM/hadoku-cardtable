/*
 * Build `apps/ui/src/draft/related.json` — for every card, the other cards that
 * come with it: the tokens (and emblems) it makes, and a meld card's partner and
 * the card they meld into. The draft's fan draws them in a row under the card
 * under the pointer, and every tile adds them to the inspector's wheel (the
 * operator, 2026-10-19: *"when hovering a transform card in fan mode, let's show
 * all the related cards below it in a line"*, then *"tokens and meld results
 * too"*; 2026-10-22: *"fan mode must show all tokens and transforms when
 * hovering a card"*, of Jungle Patrol's Wood).
 *
 * A back face is not here: every card carries its own (`DraftCard.faces`, and
 * a board card's from Forge), so `related.ts` reads it off the card.
 *
 * ## Where a card's tokens come from
 *
 * Forge's own card script first — `TokenScript$ <id>`, the token the engine
 * really makes — read off `forge-gui/res/tokenscripts/<id>.txt` for its name,
 * type, P/T, colours and text, with its art from `art-ids.json`'s `t:<id>` row
 * where there is one. Scryfall's `all_parts` misses tokens it never printed
 * (Jungle Patrol's Wood has no Scryfall row at all), and a token with no art
 * still draws, as a text card. Then Scryfall's `all_parts`, for what Forge makes
 * without naming a script (investigate's Clue, fabricate's Servo) and for a meld
 * card's partner and result, by name, for any not already there.
 *
 * Every card, not one cube's: a room drafts whichever cube or set its leader
 * picked, and a match deals whatever its decks hold. Keyed by the card's name —
 * its front face's for a card with faces — because a board card crosses from
 * Forge as a name, with no Scryfall id. Each related card is stored once and
 * named by index, since a handful of tokens (Treasure, Clue, Food) are made by
 * hundreds of cards.
 *
 * ## Regenerate with
 *
 *   node scripts/art/build-related.ts --cache=<any checkout>/packages/carddata/data \
 *     --forge-res=<a checkout with forge>/forge/forge-gui/res
 *
 * after `build-art-ids.ts`, whose token rows it reads. No network. Sorted, so a
 * re-run against the same inputs writes the same bytes.
 */

import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '../..');
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CACHE = resolve(arg('cache') ?? resolve(ROOT, 'packages/carddata/data'), 'cards.jsonl');
const FORGE_RES = resolve(arg('forge-res') ?? resolve(ROOT, 'forge/forge-gui/res'));
const ART_IDS = resolve(ROOT, 'apps/ui/src/draft/art-ids.json');
const OUT = resolve(arg('out') ?? resolve(ROOT, 'apps/ui/src/draft/related.json'));

/** Scryfall rows that are not a card anyone plays: a token's own row, an emblem's, an art card's. */
const NOT_A_CARD = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);

/** Forge's colour words, as the card's own colour letters. */
const COLOUR = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, string>;
/** The words of a Forge `Types:` line that come before the dash. */
const SUPERTYPES_AND_TYPES = new Set(['Legendary', 'Snow', 'Basic', 'World', 'Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle', 'Kindred', 'Tribal', 'Instant', 'Sorcery', 'Emblem']);

type Kind = 'token' | 'meld';

/** One related card: an art id where it has art, and the words to draw it by where it has none. */
interface Part {
  id?: string;
  name: string;
  kind: Kind;
  typeLine?: string;
  pt?: string;
  colors?: string[];
  text?: string;
}

/** The name a card is keyed by: its front face's, as Forge names it on the board. */
function relatedKey(name: string): string {
  return name.split(' // ')[0]!;
}

/** A Forge script's `<field>:` lines' values. */
function fields(script: string, field: string): string[] {
  return [...script.matchAll(new RegExp(`^${field}:(.*)$`, 'gm'))].map((m) => m[1]!.trim());
}

/** A Forge token script as a related card. */
function forgeToken(script: string, artId: string | undefined): Part {
  const name = fields(script, 'Name')[0]!.replace(/ Token$/, '');
  const words = (fields(script, 'Types')[0] ?? '').split(/\s+/).filter((w) => w.length > 0);
  const main = words.filter((w) => SUPERTYPES_AND_TYPES.has(w));
  const subs = words.filter((w) => !SUPERTYPES_AND_TYPES.has(w));
  const colors = (fields(script, 'Colors')[0] ?? '').split(',').flatMap((c) => (COLOUR[c.trim()] === undefined ? [] : [COLOUR[c.trim()]!]));
  const pt = fields(script, 'PT')[0];
  const text = (fields(script, 'Oracle')[0] ?? '').replace(/\\n/g, '\n');
  return {
    ...(artId === undefined ? {} : { id: artId }),
    name,
    kind: 'token',
    typeLine: `Token ${main.join(' ')}${subs.length > 0 ? ` — ${subs.join(' ')}` : ''}`,
    ...(pt === undefined ? {} : { pt }),
    ...(colors.length > 0 ? { colors } : {}),
    ...(text.length > 0 ? { text } : {}),
  };
}

/** Every Forge card's front-face name, and the tokens its script names, art from `artIds`. */
function forgeTokens(artIds: Record<string, string>): Map<string, Part[]> {
  const tokenDir = join(FORGE_RES, 'tokenscripts');
  const tokens = new Map<string, Part | null>();
  const token = (id: string): Part | null => {
    if (!tokens.has(id)) {
      let script: string | null = null;
      try {
        script = readFileSync(join(tokenDir, `${id}.txt`), 'utf8');
      } catch {
        // A script a card names and Forge does not ship: Forge cannot make it either.
      }
      tokens.set(id, script === null || fields(script, 'Name').length === 0 ? null : forgeToken(script, artIds[`t:${id}`]));
    }
    return tokens.get(id)!;
  };
  const out = new Map<string, Part[]>();
  const cardsDir = join(FORGE_RES, 'cardsfolder');
  for (const letter of readdirSync(cardsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of readdirSync(join(cardsDir, letter.name)).filter((f) => f.endsWith('.txt'))) {
      const script = readFileSync(join(cardsDir, letter.name, file), 'utf8');
      const name = fields(script, 'Name')[0];
      if (name === undefined) continue;
      const seen = new Set<string>();
      const made = [...new Set([...script.matchAll(/TokenScript\$\s*([A-Za-z0-9_,\s]+?)\s*(?:\||$)/gm)].flatMap((m) => m[1]!.split(',').map((s) => s.trim())))]
        .flatMap((id) => {
          const t = token(id);
          return t === null || seen.has(t.name) || !seen.add(t.name) ? [] : [t];
        });
      if (made.length > 0) out.set(relatedKey(name), made);
    }
  }
  return out;
}

interface Row {
  id: string;
  name: string;
  layout?: string;
  all_parts?: { id: string; component: string; name: string }[];
}

/** One Scryfall card's tokens, then a meld card's partner, then what they meld into. */
function scryfallParts(row: Row): Part[] {
  const own = new Set([row.name, ...row.name.split(' // ')]);
  const seen = new Set<string>();
  const parts = (row.all_parts ?? []).filter((p) => p.id !== row.id && !own.has(p.name) && !seen.has(p.name) && seen.add(p.name));
  return [
    ...parts.filter((p) => p.component === 'token').map((p) => ({ id: p.id, name: p.name, kind: 'token' as const })),
    ...parts.filter((p) => p.component === 'meld_part').map((p) => ({ id: p.id, name: p.name, kind: 'meld' as const })),
    ...parts.filter((p) => p.component === 'meld_result').map((p) => ({ id: p.id, name: p.name, kind: 'meld' as const })),
  ];
}

async function main(): Promise<void> {
  const artIds = (JSON.parse(readFileSync(ART_IDS, 'utf8')) as { ids: Record<string, string> }).ids;
  const byName = forgeTokens(artIds);
  const fromScryfall = new Set<string>();
  const lines = createInterface({ input: createReadStream(CACHE, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"all_parts"')) continue;
    const row = JSON.parse(line.replace(/,$/, '')) as Row;
    if (row.layout !== undefined && NOT_A_CARD.has(row.layout)) continue;
    const key = relatedKey(row.name);
    if (fromScryfall.has(key)) continue;
    fromScryfall.add(key);
    const have = byName.get(key) ?? [];
    const names = new Set(have.map((p) => p.name));
    const extra = scryfallParts(row).filter((p) => !names.has(p.name));
    if (extra.length > 0) byName.set(key, [...have, ...extra]);
  }
  const partKey = (p: Part): string => JSON.stringify(p);
  const unique = new Map<string, Part>();
  for (const list of byName.values()) for (const p of list) unique.set(partKey(p), p);
  const parts = [...unique.values()].sort((a, b) => (partKey(a) < partKey(b) ? -1 : 1));
  const index = new Map(parts.map((p, i) => [partKey(p), i]));
  const cards = Object.fromEntries(
    [...byName.keys()].sort().map((name) => [name, byName.get(name)!.map((p) => index.get(partKey(p))!)]),
  );
  const note = 'scripts/art/build-related.ts — every card with tokens or a meld partner, by front-face name: Forge token scripts, then Scryfall all_parts';
  writeFileSync(OUT, `${JSON.stringify({ note, parts, cards })}\n`);
  console.log(`${byName.size} cards, ${parts.length} related cards (${parts.filter((p) => p.id === undefined).length} without art) -> ${OUT}`);
}

if (process.argv[1] === import.meta.filename) await main();
