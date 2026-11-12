/*
 * Parser for Forge's `.draft` recipe format — the file that turns a cube list
 * into something draftable.
 *
 * A `.dck` says which cards are in the cube. A `.draft` says how packs are made
 * out of them: how many packs, how many players, whether the pool is singleton,
 * and what each pack contains. Both halves are needed before anyone can sit
 * down at a pod.
 *
 * Like `dck.ts`, this is a reimplementation of Forge's own reader, with the
 * file and line cited at each rule:
 *
 *   forge-gui/src/main/java/forge/gamemodes/limited/CustomLimited.java:104
 *       parse() — the whole recipe
 *   forge-gui/src/main/java/forge/gamemodes/limited/BoosterDraft.java:537
 *       FileUtil.readFile + CustomLimited.parse, the only caller
 *   forge-core/src/main/java/forge/util/FileSection.java:85
 *       parse(lines, COLON_KV_SEPARATOR) — key:value, both sides trimmed
 *   forge-core/src/main/java/forge/util/TextUtil.java:110
 *       splitWithParenthesis — how the Booster line is split
 *
 * Forge is GPL-3.0-or-later and so is this repo.
 */

/** Forge: `FileSection.COLON_KV_SEPARATOR` (FileSection.java:48). */
const KV_SEPARATOR = ':';

/**
 * One slot of a booster: a count and the thing that fills it.
 *
 * `type` is Forge's own vocabulary, kept verbatim rather than mapped onto a
 * rarity enum here. 93 of the 94 vendored recipes use the single slot
 * `15 Any`; the one that does not
 * (`cube_juzamjedi.draft`: `5 Rare, 1 Mythic, 5 Common, 5 Uncommon`) is a
 * legal recipe and is parsed like any other — deciding what `Rare` *means*
 * against a card pool belongs to whoever builds the packs, not to the parser.
 */
export interface BoosterSlot {
  readonly count: number;
  readonly type: string;
}

/** A parsed `.draft` recipe. */
export interface DraftRecipe {
  /** `Name:` — the recipe's display name. Not always the cube's name. */
  readonly name: string | null;
  /**
   * `DeckFile:` — the cube this recipe draws from, referenced by the cube's
   * `[metadata] Name=` value, NOT by its filename. Forge looks it up as
   * `cubes.get(data.get("DeckFile"))` (CustomLimited.java:124), and those two
   * differ in practice: `Frontier.draft` is named "Frontier Draft" and points
   * at the cube named "Frontier Cube".
   */
  readonly deckFile: string | null;
  /** `Singleton:` — Forge's `getBoolean`, so absent or non-"true" is false. */
  readonly singleton: boolean;
  /** `Booster:` — the pack template, one entry per comma-separated slot. */
  readonly booster: readonly BoosterSlot[];
  /** `NumPacks:` — Forge's `getInt`, which defaults to 0 on absent/unparseable. */
  readonly numPacks: number;
  /** `NumPlayers:` — same `getInt` semantics. */
  readonly numPlayers: number;
  /** `LandSetCode:` — set to take basic lands from, or `null`. Forge set code. */
  readonly landSetCode: string | null;
  /**
   * `CustomRankings:` — the bot pick-order file.
   *
   * The wave brief names seven keys; the parser has an eighth. None of the 94
   * vendored recipes sets it, but `CustomLimited.java:123` reads it with a
   * default of `rankings_cubecobra.txt`, so it is part of the format and is
   * parsed here rather than silently dropped. `null` means the file said
   * nothing; the default is applied by whoever actually loads rankings, and
   * this repo's bots do not (Wave 2 decided on a heuristic, no rankings file).
   */
  readonly customRankings: string | null;
  /** Every key:value pair as read, keys lowercased. Nothing is discarded. */
  readonly fields: ReadonlyMap<string, string>;
}

/**
 * Forge's default pack when a recipe carries no `Booster:` line at all
 * (`SealedTemplate.genericDraftBooster`, reached at CustomLimited.java:116).
 * All 94 vendored recipes do carry one, so this is a fallback for
 * hand-written recipes, not something the import exercises.
 */
export const GENERIC_DRAFT_BOOSTER: readonly BoosterSlot[] = [
  { count: 10, type: 'Common' },
  { count: 3, type: 'Uncommon' },
  { count: 1, type: 'RareMythic' },
  { count: 1, type: 'BasicLand' },
];

/**
 * Forge `TextUtil.splitWithParenthesis(input, delimiter, maxEntries, '(', ')', true)`
 * (TextUtil.java:110).
 *
 * Two behaviours matter here and both are load-bearing:
 *   - `skipEmpty` drops zero-length segments, which is what makes
 *     `" 1 Mythic"` split on ' ' into `["1", "Mythic"]` rather than
 *     `["", "1 Mythic"]`. Forge relies on that; without it every slot after
 *     the first comma would parse its count as the empty string.
 *   - once `maxEntries` segments have been emitted the delimiter stops
 *     splitting, so the remainder is returned whole.
 */
function splitWithParenthesis(input: string, delimiter: string, maxEntries = Infinity): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  let emitted = 1;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === ')' && depth > 0) depth--;
    else if (c === '(') depth++;

    if (c === delimiter && depth === 0 && emitted < maxEntries) {
      if (i > start) {
        result.push(input.slice(start, i));
        emitted++;
      }
      start = i + 1;
    }
  }
  if (input.length > start) result.push(input.slice(start));
  return result;
}

/**
 * Parse a `Booster:` value into slots.
 *
 * `CustomLimited.java:110-114`: split on commas, then split each slot on the
 * first space into count and type. Forge calls `Integer.parseInt` on the count
 * and lets a bad one throw; we return `null` instead, so a malformed recipe is
 * a value the caller can report rather than an exception mid-import.
 */
export function parseBoosterSlots(value: string): readonly BoosterSlot[] | null {
  const slots: BoosterSlot[] = [];
  for (const slotDesc of splitWithParenthesis(value, ',')) {
    const kv = splitWithParenthesis(slotDesc, ' ', 2);
    if (kv.length < 2) return null;
    if (!/^[0-9]+$/.test(kv[0])) return null;
    slots.push({ count: Number.parseInt(kv[0], 10), type: kv[1].trim() });
  }
  return slots.length === 0 ? null : slots;
}

/**
 * Forge `FileSection.getInt` (FileSection.java:151): `Integer.parseInt` with 0
 * on any failure, including a missing key (`parseInt(null)` throws
 * NumberFormatException and is caught). Reproduced rather than "improved" —
 * a recipe with no `NumPacks` really does draft zero packs in Forge.
 */
function getInt(fields: ReadonlyMap<string, string>, key: string): number {
  const raw = fields.get(key.toLowerCase());
  if (raw === undefined) return 0;
  // Java's Integer.parseInt rejects anything that is not an optionally-signed
  // run of digits — no leading '+n' surprises, no trailing junk, no floats.
  if (!/^[+-]?[0-9]+$/.test(raw)) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * Parse the text of a `.draft` file.
 *
 * `FileSection.parse` splits each line on the FIRST colon and trims both
 * halves, which is why the CRLF recipes (`Pioneer Cube.draft`,
 * `The Arena Cube.draft`) and the trailing-space one (`Frontier.draft`) need
 * no special handling: the trim absorbs both. Keys are matched
 * case-insensitively, as Forge's `TreeMap(CASE_INSENSITIVE_ORDER)` does
 * (FileSection.java:42); we lowercase them to the same effect.
 *
 * Forge's parser has no comment syntax and no section headers for this format
 * — every line goes into the map, blank ones included (they produce an empty
 * key, which nothing reads). We drop blank lines instead of storing a key
 * nobody can name.
 */
export function parseDraftRecipe(text: string): DraftRecipe {
  const fields = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const sep = raw.indexOf(KV_SEPARATOR);
    const key = (sep === -1 ? raw : raw.slice(0, sep)).trim().toLowerCase();
    const value = sep === -1 ? '' : raw.slice(sep + 1).trim();
    fields.set(key, value);
  }

  const boosterRaw = fields.get('booster');
  // `StringUtils.isNotEmpty` (CustomLimited.java:109): an empty value falls
  // through to the generic booster, it does not produce an empty pack.
  const booster =
    boosterRaw === undefined || boosterRaw.length === 0
      ? GENERIC_DRAFT_BOOSTER
      : (parseBoosterSlots(boosterRaw) ?? GENERIC_DRAFT_BOOSTER);

  return {
    name: fields.get('name') ?? null,
    deckFile: fields.get('deckfile') ?? null,
    singleton: (fields.get('singleton') ?? '').toLowerCase() === 'true',
    booster,
    numPacks: getInt(fields, 'numpacks'),
    numPlayers: getInt(fields, 'numplayers'),
    landSetCode: fields.get('landsetcode') ?? null,
    customRankings: fields.get('customrankings') ?? null,
    fields,
  };
}

/** Total cards in one pack built from this recipe. */
export function packSize(recipe: DraftRecipe): number {
  let total = 0;
  for (const slot of recipe.booster) total += slot.count;
  return total;
}

/** Total cards the recipe deals across the whole pod: packs × players × size. */
export function totalCardsDealt(recipe: DraftRecipe): number {
  return packSize(recipe) * recipe.numPacks * recipe.numPlayers;
}
