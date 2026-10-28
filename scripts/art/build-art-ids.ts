/*
 * Build `apps/ui/src/draft/art-ids.json` — the committed `Name|SET → Scryfall id`
 * table the play board looks a card's art up in.
 *
 * ## Regenerate with
 *
 *   pnpm --filter @hadoku/carddata sync            # refresh the Scryfall cache
 *   node --max-old-space-size=6144 scripts/art/build-art-ids.ts
 *
 * That is the whole command. `--cache=<dir>` overrides the cache location
 * (default `packages/carddata/data`, which `.gitignore` refuses) and
 * `--out=<file>` the output. `--no-tokens` adds no token row: what
 * `scripts/land.sh` runs to give a new scenario's or deck's cards their rows
 * without the bulk token rows a whole rebuild would bring. Re-running against the same cache produces the
 * same bytes: every lookup goes through `resolveCard`, whose ordering is total,
 * and the keys are sorted before they are written. Verified by running it twice
 * and comparing SHA-256.
 *
 * A worktree has no cache of its own, and a 78 MB re-download to regenerate a
 * committed file is waste, so point it at one that already exists:
 *
 *   node --max-old-space-size=6144 scripts/art/build-art-ids.ts \
 *     --cache=<any checkout>/packages/carddata/data
 *
 * The committed `art-ids.json` was built that way from `default_cards` as of
 * the `sourceUpdatedAt` its own `note` records.
 *
 * ## Why this file exists
 *
 * Forge's wire carries no Scryfall id. A card crosses as `Name` + `SetCode`
 * (Forge's own set vocabulary — `ImageKey` spells it `c:Mountain|MRD|1`), and
 * `apps/ui/src/play/adapter.ts` has to turn that into an id before
 * `@hadoku/carddata/art` can resolve a URL. Until now the only name → id table
 * in the browser was the cube's own `pool.json`, so **every card a match can
 * contain that is not in the drafted cube had no id and therefore no art** —
 * basic lands above all, which is exactly the blank set the operator hit
 * (wave 19 §D, #9).
 *
 * ## Why committed data rather than a lookup
 *
 * Scryfall's rate-limit guidance is explicit: cache, and use the bulk files for
 * bulk resolution. `packages/carddata/src/scryfall/bulk.ts` already honours
 * that, and this script is a consumer of that cache, not a new caller of their
 * API. Nothing here runs in a browser and nothing here runs at request time.
 *
 * ## What is in the table, and what is deliberately not
 *
 * The output goes into the browser bundle, so scope is a size decision:
 *
 *   - **every basic land, under every Forge set code that names it.** A basic
 *     is the one card where the printing really matters — a match is half
 *     lands, and one generic Forest for all of them reads as broken. 14 basic
 *     names (5 basics, Wastes, 6 snow-covered, 2 joke lands) across every Forge
 *     edition whose Scryfall set has them.
 *   - **every card named by the committed constructed lists** under `decks/`,
 *     under the set that list named. Those are the decks `ConstructedScreen`
 *     offers, so they are cards a match can actually contain.
 *   - **the cube pool's Forge aliases.** `pool.json` already carries all 534
 *     cube ids keyed by their SCRYFALL set code; Forge names 92 of its editions
 *     with a different code, so a cube card printed in one of those misses the
 *     exact key. Those alias rows — and only those — are added here.
 *   - **a bare-name row per card**, which is the documented fallback: another
 *     printing's art is still that card's art.
 *   - **a bare-name row per card a test scenario places**
 *     (`apps/server/src/play/scenarios/*.state`): the e2e suite plays those
 *     matches on camera, and a scenario's Grizzly Bears had no row at all.
 *   - **every other face of every card above**, under each key its front has.
 *     Forge names the face it is showing, and a `.dck` only ever names the
 *     front: a transformed Delver of Secrets crosses the wire as Insectile
 *     Aberration. See {@link otherFaces} for what each layout gets.
 *
 * NOT in the table: Forge's 505 bundled quest precons (12,722 distinct
 * `Name|SET` references, ~8,900 distinct names — roughly half a megabyte, for
 * decks the UI never offers), and every other printing of every other card.
 * A whole-corpus table is a performance bug, not thoroughness.
 *
 * ## The one rule this file must not break
 *
 * It emits **ids**. No URL, no host, no `image_uris` blob — a card's art is a
 * lookup, not a URL (D15), and `packages/carddata/src/art/index.ts` is the only
 * thing that decides where the bytes come from. The cache this reads was
 * already projected onto a gameplay allowlist (`scryfall/project.ts`), so there
 * is no image field here to leak even by accident.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDck, type CardRequest } from '../../packages/carddata/src/dck.ts';
import { buildCardIndex, resolveCard, type CardIndex } from '../../packages/carddata/src/resolve.ts';
import { FORGE_TO_SCRYFALL_SET } from '../../packages/carddata/src/set-codes.ts';
import type { GameplayCard } from '../../packages/carddata/src/scryfall/project.ts';
import { ART_ID_TABLE_VERSION, BACK_FACE } from '../../packages/carddata/src/art/ids.ts';
import { otherFaces } from '../../packages/carddata/src/faces.ts';
import { scenarioCardNames } from '../../apps/server/src/play/art.ts';

const REPO_ROOT = resolvePath(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DEFAULT_CACHE = join(REPO_ROOT, 'packages', 'carddata', 'data');
const DEFAULT_OUT = join(REPO_ROOT, 'apps', 'ui', 'src', 'draft', 'art-ids.json');
const DECKS_DIR = join(REPO_ROOT, 'decks');
const POOL_FILE = join(REPO_ROOT, 'apps', 'ui', 'src', 'draft', 'pool.json');
const SCENARIOS_DIR = join(REPO_ROOT, 'apps', 'server', 'src', 'play', 'scenarios');

/** Every card a test scenario (`apps/server/src/play/scenarios/*.state`) places — a match the e2e suite plays shows them. */
export function scenarioNames(dir = SCENARIOS_DIR): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.state')).sort()) {
    for (const name of scenarioCardNames(readFileSync(join(dir, file), 'utf8'))) names.add(name);
  }
  return [...names];
}

/** A reference with no set and no collector number — `resolveCard`'s tier 3. */
function request(name: string, set: string | null): CardRequest {
  return { name, set, artIndex: 1, collectorNumber: null, foil: false, backFace: false, flags: null };
}

function str(card: GameplayCard, field: string): string | null {
  const value = card[field];
  return typeof value === 'string' ? value : null;
}

/** Stream the projected cache. Kept as an array so basics can be found in it too. */
async function loadCards(cacheDir: string): Promise<GameplayCard[]> {
  const cards: GameplayCard[] = [];
  const lines = createInterface({
    input: createReadStream(join(cacheDir, 'cards.jsonl'), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length === 0) continue;
    cards.push(JSON.parse(line) as GameplayCard);
  }
  return cards;
}

/**
 * Every name Forge can put on the board as a basic land.
 *
 * Read off the corpus rather than hardcoded: `Wastes`, the six snow-covered
 * lands and the two joke basics are all `Basic Land` type lines, and a list
 * written by hand is a list that goes stale the next time Wizards prints one.
 */
function basicLandNames(cards: readonly GameplayCard[]): string[] {
  const names = new Set<string>();
  for (const card of cards) {
    if (str(card, 'lang') !== 'en') continue;
    const type = str(card, 'type_line');
    if (type === null || !/^basic\s+(snow\s+)?land\b/i.test(type)) continue;
    const name = str(card, 'name');
    if (name !== null && name.length > 0) names.add(name);
  }
  return [...names].sort();
}

/** Every `.dck` under `decks/`, recursively. */
function deckFiles(): string[] {
  return readdirSync(DECKS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.dck'))
    .map((entry) => join(DECKS_DIR, entry))
    .sort();
}

interface Counts {
  basics: number;
  decks: number;
  cubeAliases: number;
  bareNames: number;
  faces: number;
  tokens: number;
  unresolved: string[];
}

/** One committed `Name|SET` reference (a deck line or a cube pool card) naming a printing by id. */
export interface PrintingVote {
  readonly name: string;
  readonly id: string;
  /** ISO release date of that printing, or `null` when Scryfall has none. */
  readonly releasedAt: string | null;
}

/**
 * The bare-name fallback's printing, per name: the id with the most votes,
 * ties broken by the newest `releasedAt`, a remaining tie broken by id so the
 * result is total and reproducible. A name with no votes is absent from the
 * result — the caller falls back to the old tier-3 "earliest" pick, which is
 * still correct when nothing committed ever pinned a set for that name.
 */
export function mostUsedPrinting(votes: readonly PrintingVote[]): ReadonlyMap<string, string> {
  const byName = new Map<string, Map<string, { count: number; releasedAt: string }>>();
  for (const vote of votes) {
    let byId = byName.get(vote.name);
    if (byId === undefined) {
      byId = new Map();
      byName.set(vote.name, byId);
    }
    const releasedAt = vote.releasedAt ?? '0000-01-01';
    const existing = byId.get(vote.id);
    if (existing === undefined) byId.set(vote.id, { count: 1, releasedAt });
    else existing.count += 1;
  }

  const winners = new Map<string, string>();
  for (const [name, byId] of byName) {
    const ranked = [...byId.entries()].sort(([idA, a], [idB, b]) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.releasedAt !== b.releasedAt) return a.releasedAt < b.releasedAt ? 1 : -1;
      return idA < idB ? -1 : 1;
    });
    winners.set(name, ranked[0]![0]);
  }
  return winners;
}

/**
 * The rows `otherFaces` adds for a table: each source row `Name|SET` (or bare
 * `Name`) naming a card with other faces gives every other face the same key
 * shape, `Face|SET` (or bare `Face`) — so both faces of one printing draw that
 * printing. Sources are read in order and a face already keyed is left alone,
 * the table's own first-write-wins.
 */
export function faceRows(sources: Iterable<readonly [string, string]>, cardById: (id: string) => GameplayCard | undefined): [string, string][] {
  const rows = new Map<string, string>();
  for (const [key, id] of sources) {
    const card = cardById(id);
    if (card === undefined) continue;
    const pipe = key.indexOf('|');
    const name = pipe === -1 ? key : key.slice(0, pipe);
    const set = pipe === -1 ? '' : key.slice(pipe);
    for (const face of otherFaces(card)) {
      if (face.name === name) continue;
      const faceKey = `${face.name}${set}`;
      if (!rows.has(faceKey)) rows.set(faceKey, face.artId);
    }
  }
  return [...rows];
}

/*
 * ── token art (R14, wave 35) ────────────────────────────────────────────────
 *
 * The operator: a Goblin Rogue token has no art, because `art-ids.json` has
 * NO token entries at all (wave 29's own finding). A token crosses the play
 * wire exactly like any other permanent — `adapter.ts`'s `toBoardCard` reads
 * `Name` and `SetCode` off the SAME wire fields and calls the SAME
 * `scryfallIdFor(artIds, name, card.setCode)` — so a token needs rows keyed
 * the identical way: `Name|FORGE_EDITION_CODE`.
 *
 * What `SetCode` Forge actually sends for a token is the interesting half.
 * Forge's `TokenInfo.getProtoType` (forge-game/.../card/token/TokenInfo.java)
 * sets the token's edition to `CardEdition.getTokenSet(script)`, which returns
 * `this.getCode()` for whichever Forge edition's own token list credits that
 * token art — a FORGE edition code, the same vocabulary `host.getSetCode()`
 * already uses for every other permanent. So the Forge-code side of the
 * lookup is unchanged; what's missing is the SCRYFALL side, because Scryfall
 * does not file a token under its host set's own code — it files it under a
 * SEPARATE token set, almost always `"t" + the host set's Scryfall code`
 * (`tdom` for Dominaria, `tznr` for Zendikar Rising, …). Verified against this
 * project's own cache rather than assumed: of 213 distinct token-set codes in
 * the committed `default_cards` cache, 189 (89%) are exactly `t` + an existing
 * non-token set code; the other 24 are promo/league token sets (`l12`..`l17`,
 * `sbro`, `wmom`, …) with no derivable host, which just fall through to the
 * bare-name fallback below like everything else this file cannot pin exactly.
 *
 * So: for every `(forgeCode, scryfallCode)` this file already knows about
 * (`forgeAliases()`, built for the cube-alias section above), look up
 * `t<scryfallCode>` among the cache's token printings; every name found there
 * gets an EXACT `Name|forgeCode` row, for every Forge code that names that
 * Scryfall edition — not just the first found.
 *
 * **The name itself needs one more step, and this is the part a first attempt
 * would miss.** Scryfall names a token card plainly (`"Zombie"`, `"Clue"`,
 * `"Goblin Rogue"`), but Forge's in-game `Name` is whatever its OWN tokenscript
 * file says, verbatim (`forge-gui/res/tokenscripts/*.txt`) — and the
 * overwhelming convention there is `"<the Scryfall name> Token"`
 * (`b_2_2_zombie.txt`: `Name:Zombie Token`; `b_1_1_rat_rogue.txt`:
 * `Name:Rat Rogue Token`). That is exactly the "Goblin Rogue" the operator
 * reported art-less — the wire name is "Goblin Rogue **Token**".
 *
 * **It is a convention, not a rule, and treating it as a rule is a real bug a
 * first pass of this section had**: 128 of the corpus's 848 tokenscripts do
 * NOT end in " Token" — a token that is a named COPY of a specific real card
 * (Kher Keep's "Kobolds of Kher Keep", no suffix — Forge's own `Name:` line
 * says so) or a flavour token with its own name ("Bling", "Galactus"). Suffix
 * those anyway and the row sits at a key the adapter will never ask for, which
 * is worse than no row: it LOOKS covered in a count and is blank on the board.
 * So when `--forge-res` is given, every row's name comes from a map built off
 * the tokenscripts themselves (`forgeTokenWireNames`) — the real `Name:` line
 * for a Scryfall bare name that some tokenscript already uses, falling back to
 * `"<name> Token"` only for a Scryfall token this project's Forge pin has no
 * script for at all. Without `--forge-res` the fallback is all this section
 * has, which is right for ~85% of printings and wrong for the rest — said
 * in the write-up, not hidden in a silently-wrong row.
 */

/** Scryfall's bulk data marks a dedicated token set with `set_type: "token"` — the authoritative signal, not the type line. */
function isTokenPrinting(card: GameplayCard): boolean {
  return str(card, 'lang') === 'en' && str(card, 'set_type') === 'token';
}

/**
 * A printing Scryfall marks `textless`: no type line, no rules box, no power and toughness — the
 * Unglued tokens are a picture and a credit. A creature token drawn from one reads as a card with
 * no stats, so one is never the printing a token falls back to while a printing with its text exists.
 */
function isTextless(card: GameplayCard): boolean {
  return card['textless'] === true;
}

/**
 * Deterministic "best" printing of two token cards with the same name: one with its text before a
 * textless one, then earliest release, then collector number, then id.
 */
export function tokenPrintingOrder(a: GameplayCard, b: GameplayCard): number {
  if (isTextless(a) !== isTextless(b)) return isTextless(a) ? 1 : -1;
  const ra = str(a, 'released_at') ?? '9999-12-31';
  const rb = str(b, 'released_at') ?? '9999-12-31';
  if (ra !== rb) return ra < rb ? -1 : 1;
  const ca = str(a, 'collector_number') ?? '';
  const cb = str(b, 'collector_number') ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  const ia = str(a, 'id') ?? '';
  const ib = str(b, 'id') ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Every token printing, grouped by its OWN (lowercased) Scryfall set code, then by name — one, deterministic, printing per name. */
function tokensBySet(cards: readonly GameplayCard[]): Map<string, Map<string, GameplayCard>> {
  const bySet = new Map<string, Map<string, GameplayCard>>();
  for (const card of cards) {
    if (!isTokenPrinting(card)) continue;
    const name = str(card, 'name');
    const set = str(card, 'set');
    if (name === null || set === null || str(card, 'id') === null) continue;
    const setKey = set.toLowerCase();
    const nameKey = name.trim().toLowerCase();
    let byName = bySet.get(setKey);
    if (byName === undefined) {
      byName = new Map();
      bySet.set(setKey, byName);
    }
    const existing = byName.get(nameKey);
    if (existing === undefined || tokenPrintingOrder(card, existing) < 0) byName.set(nameKey, card);
  }
  return bySet;
}

/**
 * The real Forge wire `Name` for a token, keyed by the Scryfall BARE name it
 * corresponds to (lowercased) — built off `forge-gui/res/tokenscripts/*.txt`
 * directly rather than assumed. Most entries are `"zombie" → "Zombie Token"`;
 * the ~15% that do not end in " Token" (a named copy of a real card, a
 * flavour-named token) map to themselves unchanged, which is the whole point
 * of reading this off Forge rather than appending a suffix unconditionally.
 *
 * Returns `null` (not an empty map) when `tokenscripts/` is not there, so a
 * caller can tell "found nothing" from "could not look".
 */
function forgeTokenWireNames(forgeResDir: string): ReadonlyMap<string, string> | null {
  const dir = join(forgeResDir, 'tokenscripts');
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .sort();
  } catch {
    return null;
  }
  const byBareName = new Map<string, string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const match = /^Name:(.+)$/m.exec(text);
    if (match === null) continue;
    const forgeName = match[1]!.trim();
    if (forgeName.length === 0) continue;
    const bareName = forgeName.endsWith(' Token') ? forgeName.slice(0, -' Token'.length) : forgeName;
    // First file alphabetically wins on a collision — deterministic, and a
    // genuine collision (two scripts claiming the same bare Scryfall name
    // with different Forge names) has not been observed in the corpus.
    const key = bareName.toLowerCase();
    if (!byBareName.has(key)) byBareName.set(key, forgeName);
  }
  return byBareName;
}

/** One numbered token of one Forge edition: what `t:<script>|<set>|<number>` in a token's `ImageKey` names. */
interface ForgeTokenPrinting {
  script: string;
  forgeCode: string;
  /** Lowercased Scryfall set the edition files its tokens under: `TokensCode`, else `t` + `ScryfallCode` (`CardEdition.java`'s own rule). */
  tokenSet: string;
  collectorNumber: string;
  /** Forge draws the printing's back face: its number carries `☇` (`initiative`, the back of CLB's Undercity token). */
  back: boolean;
}

/**
 * Every numbered `[tokens]` and `[other]` line of every Forge edition (`forge-gui/res/editions/*.txt`:
 * `29 c_3_3_a_phyrexian_wurm_deathtouch @Raymond Swanland`). Forge puts exactly these three — the
 * tokenscript, the edition, the number — in a token's `ImageKey`
 * (`t:c_3_3_a_phyrexian_wurm_deathtouch|2XM|29|1`, read off a real game by `token-art.jvm.test.ts`),
 * so they name ONE Scryfall printing, where a token's name may name several: Forge calls Wurmcoil
 * Engine's deathtouch and lifelink Wurms and Phyrexia: All Will Be One Commander's toxic one all
 * "Phyrexian Wurm Token". `[other]` names what Forge draws for a game piece that is not a token —
 * the monarch, the initiative, the city's blessing (`StaticData.getOtherImageKey`, the same
 * `t:<name>|<set>|<number>` key): `20☇ initiative`, `☇` for the printing's back face. Null when
 * `editions/` is not there.
 */
function forgeTokenPrintings(forgeResDir: string): ForgeTokenPrinting[] | null {
  const dir = join(forgeResDir, 'editions');
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .sort();
  } catch {
    return null;
  }
  const out: ForgeTokenPrinting[] = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const field = (name: string): string | null => new RegExp(`^${name}=(.+)$`, 'm').exec(text)?.[1]?.trim() ?? null;
    const forgeCode = field('Code');
    const scryfallCode = field('ScryfallCode') ?? forgeCode;
    if (forgeCode === null || scryfallCode === null) continue;
    const tokenSet = (field('TokensCode') ?? `t${scryfallCode}`).toLowerCase();
    for (const name of ['tokens', 'other']) {
      const section = new RegExp(`^\\[${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '';
      for (const line of section.split(/\r?\n/)) {
        const m = /^\s*(\S+)\s+([a-z0-9_]+)\b/.exec(line);
        if (m === null) continue;
        const back = m[1]!.endsWith('☇');
        out.push({ script: m[2]!, forgeCode: forgeCode.toUpperCase(), tokenSet, collectorNumber: back ? m[1]!.slice(0, -1) : m[1]!, back });
      }
    }
  }
  return out;
}

/**
 * Forge's own `cardsfolder` filename for a card name — verified against real
 * files, not assumed: `Lim-Dûl's Vault` → `lim_duls_vault.txt`,
 * `Jace, the Mind Sculptor` → `jace_the_mind_sculptor.txt`. Diacritics fold,
 * apostrophes drop (not the letter after them), everything else non-alphanumeric
 * becomes one underscore.
 */
function forgeCardSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Every `TokenScript$ <id>` a card's Forge script names — the overwhelming majority of "this card makes a token" (checked: 2,473 of 2,474 `DB$ Token` abilities in the corpus go through one; the one exception defines its token fully inline and is not worth a second code path here). */
function tokenScriptsNamedBy(cardScript: string): string[] {
  const out = new Set<string>();
  for (const m of cardScript.matchAll(/TokenScript\$\s*([A-Za-z0-9_]+)/g)) out.add(m[1]!);
  return [...out];
}

/**
 * How many of the library's own decks' cards make a token, how many distinct
 * tokens they name, and how many of THOSE now resolve to art — a real
 * measurement off Forge's own card scripts, not a guess. `forgeResDir` is
 * `forge/forge-gui/res` of a checkout that has it (the main checkout; never
 * written here, never this worktree's empty gitlink placeholder).
 */
function reportTokenDeckCoverage(
  forgeResDir: string,
  deckFilePaths: readonly string[],
  ids: ReadonlyMap<string, string>,
): void {
  const cardsDir = join(forgeResDir, 'cardsfolder');
  const tokenScriptsDir = join(forgeResDir, 'tokenscripts');
  if (!existsSync(cardsDir) || !existsSync(tokenScriptsDir)) {
    console.log(`--forge-res=${forgeResDir} has no cardsfolder/tokenscripts under it — skipping the deck-token report.`);
    return;
  }

  const deckCardNames = new Set<string>();
  for (const file of deckFilePaths) {
    for (const entries of parseDck(readFileSync(file, 'utf8')).sections.values()) {
      for (const entry of entries) deckCardNames.add(entry.card.name);
    }
  }

  const tokenScriptName = new Map<string, string | null>();
  const readTokenScriptName = (scriptId: string): string | null => {
    const cached = tokenScriptName.get(scriptId);
    if (cached !== undefined) return cached;
    let result: string | null;
    try {
      const match = /^Name:(.+)$/m.exec(readFileSync(join(tokenScriptsDir, `${scriptId}.txt`), 'utf8'));
      result = match !== null ? match[1]!.trim() : null;
    } catch {
      result = null;
    }
    tokenScriptName.set(scriptId, result);
    return result;
  };

  /*
   * A double-faced card's script file is named for BOTH faces
   * (`huntmaster_of_the_fells_ravager_of_the_fells.txt`), and a `.dck` only
   * ever names the front — so an exact `<slug>.txt` miss falls back to the
   * one file in that letter's directory whose name STARTS with the slug
   * (checked: this is what every DFC in the library's decks needs; a bare
   * name match is still tried first because it is unambiguous and cheaper).
   */
  const dirListing = new Map<string, string[]>();
  const listDir = (letter: string): readonly string[] => {
    const cached = dirListing.get(letter);
    if (cached !== undefined) return cached;
    let entries: string[];
    try {
      entries = readdirSync(join(cardsDir, letter));
    } catch {
      entries = [];
    }
    dirListing.set(letter, entries);
    return entries;
  };
  const readCardScript = (name: string): string | null => {
    const slug = forgeCardSlug(name);
    if (slug.length === 0) return null;
    const letter = slug.charAt(0);
    try {
      return readFileSync(join(cardsDir, letter, `${slug}.txt`), 'utf8');
    } catch {
      const prefixed = listDir(letter).find((f) => f.startsWith(`${slug}_`) && f.endsWith('.txt'));
      if (prefixed === undefined) return null;
      try {
        return readFileSync(join(cardsDir, letter, prefixed), 'utf8');
      } catch {
        return null;
      }
    }
  };

  let missingScript = 0;
  let cardsThatMakeTokens = 0;
  const producedTokenNames = new Set<string>();
  for (const name of deckCardNames) {
    const text = readCardScript(name);
    if (text === null) {
      missingScript += 1;
      continue;
    }
    const scriptIds = tokenScriptsNamedBy(text);
    if (scriptIds.length === 0) continue;
    cardsThatMakeTokens += 1;
    for (const scriptId of scriptIds) {
      const tokenName = readTokenScriptName(scriptId);
      if (tokenName !== null) producedTokenNames.add(tokenName);
    }
  }

  /*
   * `tokenName` here is already the exact Forge wire name — `readTokenScriptName`
   * reads the same `Name:` line `forgeTokenWireNames` (the art-row builder
   * above) keys its rows on, suffixed or not (Kher Keep's "Kobolds of Kher
   * Keep" carries no " Token" in either place) — so a plain, exact lookup
   * against the FINAL table is what makes this count agree with what the
   * adapter will actually resolve, with no suffix-guessing of its own.
   */
  const hasArt = (name: string): boolean => ids.has(name);
  let withArt = 0;
  for (const tokenName of producedTokenNames) {
    if (hasArt(tokenName)) withArt += 1;
  }
  console.log(
    `Token art coverage of the library's decks (off ${forgeResDir}): ${deckCardNames.size} distinct deck cards, ` +
      `${missingScript} with no matching Forge script found by name; ${cardsThatMakeTokens} card(s) make at least ` +
      `one token, naming ${producedTokenNames.size} distinct token(s); ${withArt} of those ${producedTokenNames.size} ` +
      `now resolve to art.`,
  );
  if (producedTokenNames.size > withArt) {
    console.log(
      `  without art: ${[...producedTokenNames].filter((n) => !hasArt(n)).sort().join(', ')}`,
    );
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let cacheDir = DEFAULT_CACHE;
  let outFile = DEFAULT_OUT;
  let forgeResDir: string | null = null;
  let tokens = true;
  for (const arg of argv) {
    if (arg.startsWith('--cache=')) cacheDir = resolvePath(arg.slice('--cache='.length));
    else if (arg.startsWith('--out=')) outFile = resolvePath(arg.slice('--out='.length));
    else if (arg.startsWith('--forge-res=')) forgeResDir = resolvePath(arg.slice('--forge-res='.length));
    else if (arg === '--no-tokens') tokens = false;
    else {
      console.error(`Unknown argument '${arg}'`);
      console.error('Usage: build-art-ids.ts [--cache=<dir>] [--out=<file>] [--forge-res=<forge-gui/res dir>] [--no-tokens]');
      return 2;
    }
  }

  return await run(cacheDir, outFile, forgeResDir, tokens);
}

/** Forge set codes, grouped by the Scryfall set they name. */
function forgeAliases(): ReadonlyMap<string, string[]> {
  const byScryfall = new Map<string, string[]>();
  for (const [forge, scryfall] of FORGE_TO_SCRYFALL_SET) {
    const bucket = byScryfall.get(scryfall.toUpperCase());
    if (bucket === undefined) byScryfall.set(scryfall.toUpperCase(), [forge]);
    else bucket.push(forge);
  }
  for (const bucket of byScryfall.values()) bucket.sort();
  return byScryfall;
}

/**
 * Every row already committed at `outFile`, or an empty map if there is none
 * yet (first run) or it does not parse.
 *
 * Read BEFORE anything else runs, so {@link run} can seed `ids` with it:
 * `put()`'s "first write wins" then means an existing row is never
 * recomputed, only ever matched or left alone. See `run()`'s own comment for
 * why that matters.
 */
function existingRows(outFile: string): ReadonlyMap<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(outFile, 'utf8')) as { ids?: unknown };
    const ids = parsed.ids;
    if (typeof ids !== 'object' || ids === null) return new Map();
    const rows = new Map<string, string>();
    for (const [key, value] of Object.entries(ids as Record<string, unknown>)) {
      if (typeof value === 'string') rows.set(key, value);
    }
    return rows;
  } catch {
    return new Map();
  }
}

async function run(cacheDir: string, outFile: string, forgeResDir: string | null = null, tokens = true): Promise<number> {
  const started = Date.now();
  const manifestPath = join(cacheDir, 'manifest.json');
  const sourceUpdatedAt = (() => {
    try {
      return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { sourceUpdatedAt?: string }).sourceUpdatedAt ?? null;
    } catch {
      // No manifest is not fatal — the table is built from cards.jsonl, and the
      // timestamp is provenance in the output, not an input.
      return null;
    }
  })();

  const cards = await loadCards(cacheDir);
  {
    console.log(`Loaded ${cards.length} printings from ${cacheDir}`);
    const index: CardIndex = buildCardIndex(cards);
    console.log(`Indexed ${index.printings} printings across ${index.knownSets.size} Scryfall sets`);

    // ADDITIVE REGENERATION RULE: an existing row's printing never changes
    // just because the library grew. Seeded here, before anything else runs,
    // so `put()`'s "first write wins" protects every row already committed —
    // a bare-name fallback (the one vote-weighted bucket) would otherwise
    // shift whenever a new deck's votes change which printing wins, and a
    // shifted Forest or Island is a different image every player already
    // sees, silently, for no reason the player caused. New cards (a name
    // this file has never carried a row for) still get one, normally.
    const seeded = existingRows(outFile);
    const ids = new Map<string, string>(seeded);
    // A token row committed before textless printings ranked last is the one row this rule
    // re-derives: below, it lands on the same printing unless that printing has no text.
    const textlessTokens = new Set(cards.filter((c) => isTokenPrinting(c) && isTextless(c)).map((c) => str(c, 'id')));
    for (const [key, id] of seeded) if (textlessTokens.has(id.replace(BACK_FACE, ''))) ids.delete(key);
    const counts: Counts = { basics: 0, decks: 0, cubeAliases: 0, bareNames: 0, faces: 0, tokens: 0, unresolved: [] };

    /**
     * Release date by id, built once off the already-loaded cache, so a vote
     * cast from `pool.json` (which carries no date of its own) can still break
     * a tie the same way a deck-cast vote does.
     */
    const releasedAtById = new Map<string, string | null>();
    for (const card of cards) {
      const id = str(card, 'id');
      if (id !== null && !releasedAtById.has(id)) releasedAtById.set(id, str(card, 'released_at'));
    }

    /*
     * One vote per committed REFERENCE, not per physical copy: a deck's own
     * `12 Forest|M12` line casts one vote for M12, the same as a sideboard's
     * single `1 Forest|ZEN`. Weighting by the deck's own `count` would let one
     * ramp deck's land count outvote eleven other decks' unanimous choice of a
     * different printing, which is the opposite of "the printing the decks and
     * pools use most" — that phrase is about how many committed lists made the
     * same editorial choice, not how many cards one of them happens to run.
     */
    const votes: PrintingVote[] = [];

    /** First write wins, exactly as the browser-side index resolves. */
    const put = (key: string, id: string, bucket: keyof Counts): void => {
      if (ids.has(key) || (bucket === 'tokens' && !tokens)) return;
      ids.set(key, id);
      if (bucket !== 'unresolved') counts[bucket] += 1;
    };

    // ── basics, under every Forge code that names their set ──────────────────
    const basics = basicLandNames(cards);
    console.log(`Basic land names: ${basics.join(', ')}`);
    for (const name of basics) {
      for (const forgeCode of FORGE_TO_SCRYFALL_SET.keys()) {
        const hit = resolveCard(request(name, forgeCode), index);
        // Only an exact set hit earns a row: tier `name` means this edition has
        // no such basic, and a row pointing at some other set's art would be a
        // worse answer than the bare-name fallback below already gives.
        if (!hit.ok || hit.tier !== 'name+set') continue;
        const id = str(hit.card, 'id');
        if (id !== null) put(`${name}|${forgeCode.toUpperCase()}`, id, 'basics');
      }
    }

    // ── the cube pool's Forge aliases ────────────────────────────────────────
    //
    // `pool.json` is already in the bundle and already keys all 534 cube cards
    // by their SCRYFALL set code, so nothing is duplicated here. What it cannot
    // cover is Forge naming the same edition differently: 92 of Forge's codes
    // are not their Scryfall code. Those rows, and only those, are added.
    const aliases = forgeAliases();
    const pool = JSON.parse(readFileSync(POOL_FILE, 'utf8')) as {
      cards: { name: string; setCode: string; scryfallId?: string }[];
    };
    for (const card of pool.cards) {
      if (card.scryfallId === undefined || card.scryfallId === '') continue;
      // The pool pinned this printing for this card — one vote towards it
      // being that name's deliberate bare-name printing, same as a deck's own
      // `Name|SET` line below.
      votes.push({ name: card.name, id: card.scryfallId, releasedAt: releasedAtById.get(card.scryfallId) ?? null });
      const setCode = card.setCode.toUpperCase();
      for (const forgeCode of aliases.get(setCode) ?? []) {
        if (forgeCode.toUpperCase() === setCode) continue; // pool.json covers it
        put(`${card.name}|${forgeCode.toUpperCase()}`, card.scryfallId, 'cubeAliases');
      }
    }

    // ── the committed constructed lists ──────────────────────────────────────
    const decks = deckFiles();
    for (const file of decks) {
      const deck = parseDck(readFileSync(file, 'utf8'));
      for (const entries of deck.sections.values()) {
        for (const entry of entries) {
          const hit = resolveCard(entry.card, index);
          if (!hit.ok) {
            counts.unresolved.push(`${entry.card.name}|${entry.card.set ?? ''} (${hit.reason})`);
            continue;
          }
          const id = str(hit.card, 'id');
          if (id === null) continue;
          if (entry.card.set !== null) {
            put(`${entry.card.name}|${entry.card.set.toUpperCase()}`, id, 'decks');
            // The deck PINNED a set, so this is a real editorial choice of
            // printing — a vote. A bare deck reference (no set) casts none:
            // it defers to the bare-name fallback itself and would be a
            // circular signal.
            votes.push({ name: entry.card.name, id, releasedAt: str(hit.card, 'released_at') });
          }
        }
      }
    }
    console.log(`Read ${decks.length} deck lists under decks/`);

    // ── bare-name fallbacks ──────────────────────────────────────────────────
    //
    // `scryfallIdFor` falls back from `Name|SET` to `Name`, so one row per name
    // is what guarantees a card is never blank. The printing named is the one
    // the committed decks and pools pinned most often for that name (ties ->
    // newest release) — a revealed card whose face resolves by name alone
    // should still look like the printing this library actually plays, not
    // whichever printing happened to be written first into the Scryfall
    // cache. A name nothing ever pinned a set for (no votes) falls back to the
    // old rule: the earliest non-digital printing (`resolveCard` tier 3),
    // which is still the only deterministic answer with nothing to prefer among.
    const winners = mostUsedPrinting(votes);
    const bareNames = new Set<string>(basics);
    for (const file of decks) {
      for (const entries of parseDck(readFileSync(file, 'utf8')).sections.values()) {
        for (const entry of entries) bareNames.add(entry.card.name);
      }
    }
    for (const name of scenarioNames()) bareNames.add(name);
    for (const name of [...bareNames].sort()) {
      if (ids.has(name)) continue;
      const voted = winners.get(name);
      if (voted !== undefined) {
        put(name, voted, 'bareNames');
        continue;
      }
      const hit = resolveCard(request(name, null), index);
      if (!hit.ok) continue;
      const id = str(hit.card, 'id');
      if (id !== null) put(name, id, 'bareNames');
    }

    // ── every other face ─────────────────────────────────────────────────────
    //
    // The pool first, as `KNOWN_ART_IDS` merges it: a cube card's back face
    // draws the printing its front does. Then every row this table holds.
    const cardById = new Map<string, GameplayCard>();
    for (const card of cards) {
      const id = str(card, 'id');
      if (id !== null) cardById.set(id, card);
    }
    const faceSources: [string, string][] = [];
    for (const card of pool.cards) {
      if (card.scryfallId === undefined || card.scryfallId === '') continue;
      faceSources.push([`${card.name}|${card.setCode.toUpperCase()}`, card.scryfallId], [card.name, card.scryfallId]);
    }
    for (const key of [...ids.keys()].sort()) faceSources.push([key, ids.get(key)!]);
    for (const [key, artId] of faceRows(faceSources, (id) => cardById.get(id))) put(key, artId, 'faces');

    // ── token art (R14) ───────────────────────────────────────────────────────
    //
    // Deliberately NOT routed through `buildCardIndex`/`resolveCard`: that index
    // excludes `token`/`double_faced_token` layouts on purpose
    // (`resolve.ts`'s `NON_GAMEPLAY_LAYOUTS`), because a token sharing a real
    // card's bare name must never resolve a deck reference to a blank token
    // printing. This section reads the raw cache directly instead, and never
    // touches `resolve.ts`.
    // Keyed by tokenscript first: `t:<script>|<FORGE SET>` for the exact printing a token's
    // `ImageKey` names, and `t:<script>` for any printing of that token at all — earliest release —
    // when its edition has none on Scryfall. The adapter tries these before any name row.
    const printings = forgeResDir !== null ? forgeTokenPrintings(forgeResDir) : null;
    if (printings !== null) {
      const bySetNumber = new Map<string, GameplayCard>();
      for (const card of cards) {
        if (!isTokenPrinting(card)) continue;
        const set = str(card, 'set');
        const number = str(card, 'collector_number');
        if (set !== null && number !== null && str(card, 'id') !== null) bySetNumber.set(`${set.toLowerCase()}|${number}`, card);
      }
      const exact: [string, string, string][] = []; // script, Forge set, id
      const anyPrinting = new Map<string, { card: GameplayCard; back: boolean }>();
      for (const p of printings) {
        const card = bySetNumber.get(`${p.tokenSet}|${p.collectorNumber}`);
        if (card === undefined) continue;
        exact.push([p.script, p.forgeCode, `${str(card, 'id')!}${p.back ? BACK_FACE : ''}`]);
        const best = anyPrinting.get(p.script);
        if (best === undefined || tokenPrintingOrder(card, best.card) < 0) anyPrinting.set(p.script, { card, back: p.back });
      }
      const fallback = new Map([...anyPrinting].map(([script, { card, back }]) => [script, `${str(card, 'id')!}${back ? BACK_FACE : ''}`]));
      for (const script of [...fallback.keys()].sort()) put(`t:${script}`, fallback.get(script)!, 'tokens');
      // A per-set row only where it names a different printing from the script's own row.
      for (const [script, forgeCode, id] of exact) if (fallback.get(script) !== id) put(`t:${script}|${forgeCode}`, id, 'tokens');
    } else if (forgeResDir !== null) {
      console.log(`--forge-res=${forgeResDir} has no editions/ under it — no tokenscript rows.`);
    }
    const tokenSets = tokensBySet(cards);
    const forgeNames = forgeResDir !== null ? forgeTokenWireNames(forgeResDir) : null;
    if (forgeResDir !== null && forgeNames === null) {
      console.log(`--forge-res=${forgeResDir} has no tokenscripts/ under it — token rows fall back to "<name> Token" for all of them.`);
    }
    /** The wire `Name` for a Scryfall token printing: the real one off Forge's own script when known, else the "<name> Token" convention. */
    const wireNameFor = (scryfallName: string): string => forgeNames?.get(scryfallName.toLowerCase()) ?? `${scryfallName} Token`;

    const tokenNames = new Map<string, GameplayCard>(); // wire name (lowercased) → best printing, any set
    const noteToken = (card: GameplayCard): void => {
      const scryfallName = str(card, 'name');
      if (scryfallName === null || str(card, 'id') === null) return;
      const key = wireNameFor(scryfallName).toLowerCase();
      const existing = tokenNames.get(key);
      if (existing === undefined || tokenPrintingOrder(card, existing) < 0) tokenNames.set(key, card);
    };
    for (const [scryfallUpper, forgeCodes] of aliases) {
      const tokenSetKey = `t${scryfallUpper.toLowerCase()}`;
      const byName = tokenSets.get(tokenSetKey);
      if (byName === undefined) continue;
      for (const card of byName.values()) {
        const scryfallName = str(card, 'name');
        const id = str(card, 'id');
        if (scryfallName === null || id === null) continue;
        const wireName = wireNameFor(scryfallName);
        for (const forgeCode of forgeCodes) put(`${wireName}|${forgeCode.toUpperCase()}`, id, 'tokens');
        noteToken(card);
      }
    }
    // Bare wire-name fallback for every token name in the cache, including the
    // ~11% whose own set code is not a plain `t<host>` (promo/league token sets
    // with no derivable host edition) — so a token Forge sends with an edition
    // this file could not pin still gets SOME art rather than none.
    for (const [, byName] of tokenSets) {
      for (const card of byName.values()) noteToken(card);
    }
    for (const key of [...tokenNames.keys()].sort()) {
      const card = tokenNames.get(key)!;
      const id = str(card, 'id')!;
      const wireName = wireNameFor(str(card, 'name')!);
      put(wireName, id, 'tokens');
    }

    // ── which of the library's own decks now have token art (R14) ─────────────
    //
    // A `.dck` never lists the tokens a card MAKES, only the cards themselves —
    // so "does this deck's card make a token with art" is answered by reading
    // the same Forge card scripts Forge itself reads: `T:…Execute$ …` +
    // `SVar:…:DB$ Token | TokenScript$ <script>` names a tokenscript file
    // (`forge-gui/res/cardsfolder/**`, `forge-gui/res/tokenscripts/*.txt`),
    // whose own `Name:` line is already in Forge's "<name> Token" wire form.
    // `--forge-res=<dir>` points this at a checkout that has them (the main
    // checkout's `forge/forge-gui/res`, never written here); omitted, this
    // section is skipped and said so, rather than guessing.
    if (forgeResDir !== null) {
      reportTokenDeckCoverage(forgeResDir, decks, ids);
    } else {
      console.log('--forge-res not given: skipping the "tokens of the library\'s decks" report.');
    }

    // ── write ────────────────────────────────────────────────────────────────
    const keys = [...ids.keys()].sort();
    const rows = keys.map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(ids.get(key))}`);
    const note =
      'GENERATED by scripts/art/build-art-ids.ts — do not edit by hand. ' +
      "Forge's wire carries Name + SetCode, never a Scryfall id; this is the table that turns one into the other so " +
      'packages/carddata/src/art/index.ts can resolve a URL. Ids only — no URL, no host, no image metadata (D15). ' +
      'Scope: every basic land under every Forge set code, every card in the committed decks/ lists, the cube pool’s ' +
      'Forge-code aliases (pool.json already carries the Scryfall-code keys), one bare-name fallback row per name (and per ' +
      'card a test scenario under apps/server/src/play/scenarios/ places), every other face of each of those cards ' +
      '(a transform or modal back face as "<id>#back", its back image), and ' +
      'every Forge edition token under its tokenscript, "t:<script>" and, where its printing differs, "t:<script>|<SET>" — what a token\'s ' +
      'ImageKey names — and ' +
      '(R14) every Scryfall token printing under "<name> Token" — the form Forge actually sends — keyed under every ' +
      'Forge edition whose own token set the printing belongs to, plus a bare "<name> Token" fallback row. ' +
      (sourceUpdatedAt === null ? '' : `Built from Scryfall default_cards updated ${sourceUpdatedAt}.`);
    const body = `{
  "version": ${ART_ID_TABLE_VERSION},
  "note": ${JSON.stringify(note)},
  "ids": {
${rows.join(',\n')}
  }
}
`;
    writeFileSync(outFile, body, 'utf8');

    const bytes = Buffer.byteLength(body, 'utf8');
    const newRows = keys.length - seeded.size;
    console.log(
      `Wrote ${keys.length} rows (${bytes} bytes) to ${outFile}\n` +
        `  kept ${seeded.size} already-committed row(s) unchanged, added ${newRows} new\n` +
        `  (of the new rows: basics ${counts.basics}, decks ${counts.decks}, cube aliases ${counts.cubeAliases}, bare names ${counts.bareNames}, other faces ${counts.faces}, token rows ${counts.tokens})`,
    );
    if (counts.unresolved.length > 0) {
      console.log(`  ${counts.unresolved.length} deck reference(s) did not resolve:`);
      for (const line of [...new Set(counts.unresolved)].sort()) console.log(`    ${line}`);
    }
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return 0;
  }
}

// Guarded so the generator's own test file can import `mostUsedPrinting`
// without this CLI's file I/O and network-cache reads running on import —
// `main()` only runs when this file is the one Node was asked to execute.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
