/*
 * What a prompt needs to know about the ids an ask carries.
 *
 * An ask never carries a card; it carries `{ kind: 'card', id }`
 * (`@hadoku/forge-wire`'s `refs.ts`), because the client already holds the
 * object from the state channel. So a prompt needs a way back from an id to a
 * name — and, for combat damage, to the two facts Forge's own dialog reads off
 * the `CardView`: `LethalDamage` and the attacker's keywords
 * (`VAssignCombatDamage.java:163-166,459-478`).
 *
 * `lookupFromState` reads those straight off the folded wire state
 * (`../fold.ts`), property by property, rather than off `BoardView`: the
 * adapter drops `LethalDamage` and `Keywords`, and neither belongs on a board.
 *
 * ## Spell abilities are not on the wire
 *
 * `getAbilityToPlay` asks "which of these abilities", and each ability is a
 * `SpellAbilityRef`. The state channel carries no `SpellAbilityView` objects at
 * all — the committed Tier C stream has objects of types 0–4 only (card,
 * player, stack item, game, card state; `../wire.ts` `WireType`). So there is
 * no label for an ability anywhere the client can read it. `withAbilityLabels`
 * is how a caller supplies one; the bridge will have to send them (a finding,
 * recorded in the lane report). Until then an ability draws as "ability #id".
 */

import type { WireState } from '../fold.ts';
import { cardStateKey, deltaKey, WireType, type Tagged, type WireObject } from '../wire.ts';

export interface PromptCardFacts {
  /**
   * The face's `Name`, or `null` when the card object reached this seat with
   * no name on it: a card Forge is revealing from another player's hidden zone
   * can arrive before its face does. Readers supply their own fallback, so no
   * invented name ever becomes an art key.
   */
  name: string | null;
  /**
   * Forge's `SetCode` for the face on show — the other half of the art-id key.
   *
   * `adapter.ts` resolves a board card's art with `Name` + `SetCode`
   * (`scryfallIdFor(artIds, name, card.setCode)`), and a prompt tile used to
   * resolve with the name alone, so a prompt could draw a different printing
   * from the board for the same card (or nothing, where only the exact
   * printing has a row). Carrying the set code here is what makes
   * `PromptShell`'s `promptCardTile` use **the same** key the board uses —
   * wave 24 §D.3. Empty when the wire did not carry one.
   */
  setCode: string;
  /** Forge's `CardView.getLethalDamage()` — toughness minus damage already marked. */
  lethalDamage: number | null;
  /** Current loyalty, for a planeswalker; `null` otherwise. */
  loyalty: number | null;
  keywords: readonly string[];
  isPlaneswalker: boolean;
}

export interface PromptPlayerFacts {
  name: string;
  life: number | null;
}

export interface PromptLookup {
  card(id: number): PromptCardFacts | undefined;
  player(id: number): PromptPlayerFacts | undefined;
  /** A label for a `SpellAbilityRef`. See the module header: not on the wire. */
  ability(id: number): string | undefined;
}

/** A lookup that knows nothing. Every id draws as its fallback label. */
export const EMPTY_LOOKUP: PromptLookup = {
  card: () => undefined,
  player: () => undefined,
  ability: () => undefined,
};

function prop(obj: WireObject | undefined, name: string): Tagged | undefined {
  const v = obj?.[name];
  return typeof v === 'object' && v !== null ? v : undefined;
}

function readInt(obj: WireObject | undefined, name: string): number | null {
  const v = prop(obj, name);
  return v !== undefined && (v.t === 'int' || v.t === 'long' || v.t === 'byte') && typeof v.v === 'number'
    ? v.v
    : null;
}

function readStr(obj: WireObject | undefined, name: string): string | null {
  const v = prop(obj, name);
  return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

function readKeywords(obj: WireObject | undefined): string[] {
  const v = prop(obj, 'Keywords');
  if (v === undefined || v.t !== 'keywords' || !Array.isArray(v.v)) return [];
  return (v.v as unknown[]).filter((k): k is string => typeof k === 'string');
}

function isPlaneswalkerType(obj: WireObject | undefined): boolean {
  const v = prop(obj, 'Type');
  return v !== undefined && v.t === 'cardtype' && Array.isArray(v.core) && v.core.includes('Planeswalker');
}

/**
 * A lookup over folded Tier C state. Card facts come from the `CardView` and
 * its current `CardStateView` (`cardId*16 + CurrentState`, `../wire.ts`).
 */
export function lookupFromState(state: WireState): PromptLookup {
  return {
    card(id) {
      const view = state.get(deltaKey(WireType.Card, id));
      if (view === undefined) return undefined;
      const face = state.get(cardStateKey(id, readInt(view, 'CurrentState') ?? 0));
      const loyaltyText = readStr(face, 'Loyalty');
      const loyalty = loyaltyText === null ? null : Number.parseInt(loyaltyText, 10);
      return {
        name: readStr(face, 'Name') ?? readStr(view, 'Name'),
        setCode: readStr(face, 'SetCode') ?? '',
        lethalDamage: readInt(view, 'LethalDamage'),
        loyalty: loyalty !== null && Number.isFinite(loyalty) ? loyalty : null,
        keywords: readKeywords(face),
        isPlaneswalker: isPlaneswalkerType(face),
      };
    },
    player(id) {
      const view = state.get(deltaKey(WireType.Player, id));
      if (view === undefined) return undefined;
      return { name: readStr(view, 'Name') ?? `player #${id}`, life: readInt(view, 'Life') };
    },
    ability: () => undefined,
  };
}

/** Layer ability labels over a lookup — the bridge's job once it sends them. */
export function withAbilityLabels(base: PromptLookup, labels: Readonly<Record<number, string>>): PromptLookup {
  return { ...base, ability: (id) => labels[id] ?? base.ability(id) };
}

/** The name an entity ref draws as, with a fallback that still says what it is. */
export function refName(lookup: PromptLookup, ref: { kind: string; id: number }): string {
  switch (ref.kind) {
    case 'card':
      return lookup.card(ref.id)?.name ?? `card #${ref.id}`;
    case 'player':
      return lookup.player(ref.id)?.name ?? `player #${ref.id}`;
    case 'spellAbility':
      return lookup.ability(ref.id) ?? `ability #${ref.id}`;
    default:
      return `${ref.kind} #${ref.id}`;
  }
}

/**
 * Forge's message for its open selection, with an exact count said as one. Forge words some picks
 * by the most they may take whatever the least is — `ChangeZoneEffect`'s multi-card pick is
 * "Select up to 2 cards from your hand" for Brainstorm's put-back, which takes exactly 2 — while the
 * selection itself (`setSelectables`) carries both: when its least is its most, "up to N" is N.
 */
export function selectionText(text: string, selection: { min: number; max: number } | null): string {
  if (selection === null || selection.min === 0 || selection.min !== selection.max) return text;
  return text.replace(/\bup to (\d+)\b/gi, (said: string, n: string) => (Number(n) === selection.max ? n : said));
}

/** Forge writes a card as "Dragonskull Summit (31)" — its own id. The seat reads the name (the operator, 2026-10-08). */
const CARD_ID_SUFFIX = /\s\(\d{1,5}\)/g;

/**
 * {@link translateTargetWords}, with the card-id suffix and {@link LIFE_PAYMENT_LINE}
 * stripped — nothing else. For text that will still draw through `RulesText`
 * itself (braces and all), rather than through plain prose.
 */
export function promptText(text: string): string {
  return translateTargetWords(text).replace(CARD_ID_SUFFIX, '').replace(LIFE_PAYMENT_LINE, '');
}

/**
 * Forge's rules text writes symbols in braces — `{T}: Add {R}.` The tap symbol
 * is a WotC mark (CLAUDE.md), so a prompt that shows an ability's text says it
 * in words and letters instead. Same rule `CardTile` follows for card text.
 *
 * Also runs {@link translateTargetWords} (this module's own "Y18" section,
 * below) first, so any raw `ValidTgts$`-shaped expression a card's text or a
 * prompt's title happens to carry — `Card.inZoneStack` and the rest — reads
 * as words too. A string with no such expression in it passes through
 * unchanged, so doing this unconditionally is safe everywhere this already runs.
 *
 * Strips the card-id suffix too (T4, a drift fix: the operator's "Dragonskull
 * Summit (31)… just the name" rule, AD-era, now holds on this path as well as
 * {@link promptText}'s).
 */
export function plainRulesText(text: string): string {
  return translateTargetWords(text)
    .replace(CARD_ID_SUFFIX, '')
    .replace(ATTACK_PROMPT, 'Select creatures to attack.')
    .replace(LIFE_PAYMENT_LINE, '')
    .replace(/\{T\}/g, 'Tap')
    .replace(/\{Q\}/g, 'Untap')
    .replace(/\{([^}]{1,5})\}/g, '$1');
}

/**
 * `InputAttack`'s own line: "Select creatures to attack <defender>" and
 * `lblSelectAttackTarget`, " or select player/card you wish to attack." The
 * operator, 2026-10-07: *"It's too wordy. maybe just 'Select creatures to
 * attack.'"* The defender it names is the one the arrow and the attack
 * drag already show; the sentence is shortened to its first four words.
 */
const ATTACK_PROMPT = /^Select creatures to attack [^\n]*? or select player\/card you wish to attack\.$/m;

/**
 * `InputPayManaOfCostPayment.getMessage`'s last line, `(Click on your life total
 * to pay life for phyrexian mana.)` and its black-mana variants
 * (`lblClickOnYourLifeTotalToPayLife…`), with the newline before it. The
 * payment window pays life with a button (the operator, 2026-10-15: *"why not
 * just show a button on the card decision modal"*), so the sentence goes.
 */
const LIFE_PAYMENT_LINE = /\n?^\(?Click on your life total to pay life for [^\n]*$/m;

/*
 * ── Y18: Forge's raw target-type expressions, in words ─────────────────
 *
 * The operator, 2026-10-06: *"i played vensor and the decision box has this
 * as the title: 'Select target permanent or Card.inZoneStack' thats a bit
 * ugly, can we give that friendly words?"*
 *
 * `Venser, Shaper Savant, forge-gui/res/cardsfolder/v/venser_shaper_savant.txt:7`:
 * `SVar:VensersBounce:DB$ ChangeZone | ValidTgts$ Permanent,Card.inZoneStack |
 * TgtZone$ Stack,Battlefield | …` — and, unlike nearly every other card that
 * targets the stack this way, carries neither a `TgtPrompt$` nor a
 * `ValidTgtsDesc$` override. So Forge falls through to its own default:
 *
 *   `TargetRestrictions.java:141`: `validTgtsDesc =
 *     Lang.getInstance().buildValidDesc(Arrays.asList(validTgts), …)`
 *   `TargetRestrictions.java:149`: `uiPrompt = "Select target " + validTgtsDesc`
 *   `Lang.java:226-242`: `buildValidDesc` lowercases a token only when it is
 *     one of five bare words (`Player`, `Opponent`, `Card`, `Spell`,
 *     `Permanent`) or `CardType.isACardType` says so (a CORE type —
 *     `Creature`/`Artifact`/`Land`/`Enchantment`/`Planeswalker`/`Instant`/
 *     `Sorcery`/`Battle`/`Tribal` — never a subtype). Anything else — every
 *     `Type.Qualifier[+Qualifier]` expression `CardProperty`'s `.`/`+` grammar
 *     can build — is appended VERBATIM. `Card.inZoneStack` (a Card object
 *     whose zone is the stack — i.e. a spell) is exactly such an expression,
 *     so Venser's own `uiPrompt` reaches the wire as
 *     `"Select target permanent or Card.inZoneStack"`, unfixed.
 *
 * Venser is not an isolated case; it is the only one with NO override. Dozens
 * of other cards share the identical shape and route around the same bug by
 * hand (`grep -rl 'ValidTgts\$.*inZoneStack' forge-gui/res/cardsfolder`):
 *
 *   `futurist_spellthief.txt`:   `Card.inZoneStack`            → `TgtPrompt$ Select target spell`
 *   `jeskai_revelation.txt`:     `Permanent,Card.inZoneStack`  → `TgtPrompt$ Select target spell or permanent`
 *   `subtlety.txt`:              `Card.inZoneStack+Creature,
 *                                 Card.inZoneStack+Planeswalker` → `TgtPrompt$ …creature spell or planeswalker spell`
 *   `commit_memory.txt`:         `Permanent.nonLand,Card.inZoneStack` → `TgtPrompt$ Select target spell or nonland permanent`
 *
 * — which is where "spell" (and "<type> spell") come from below: Forge's OWN
 * word for this shape, read off its own hand-written prompts, not invented
 * prose. The qualifier vocabulary below (`YouCtrl` → "you control", `Other` →
 * "another", `nonLand` → "nonland", `powerGE3` → "with power 3 or greater", …)
 * is read the same way, off real `TgtPrompt$` text for cards whose author DID
 * write one for the identical `ValidTgts$` qualifier (cited inline below).
 *
 * `translateTargetWords` is a pure substring translation: every substring
 * shaped like a raw `ValidTgts$` token is replaced with the words above; every
 * other character — including Forge's own "or"/"and/or"/", " joins
 * (`Lang.java:97-115`'s `joinHomogenous`, 2 items "A or B", 3+ items
 * "A, B or C" — no comma before the last) — passes through untouched. So it
 * is safe to run over ANY prompt text (a prompt title, a choice label, a
 * selection's message): prose with no raw token in it is returned unchanged.
 */

/** Bare words Forge's own `buildValidDesc` already lowercases — left as is. */
const KNOWN_BARE_WORDS = new Set([
  'Player', 'Opponent', 'Card', 'Spell', 'Permanent',
  'Creature', 'Artifact', 'Land', 'Enchantment', 'Planeswalker',
  'Instant', 'Sorcery', 'Battle', 'Tribal', 'Kindred',
]);

/** A qualifier naming one of Forge's own core card types (the `inZoneStack+Creature` shape). */
const CORE_TYPE_WORDS = new Set([
  'Creature', 'Artifact', 'Land', 'Enchantment', 'Planeswalker', 'Instant', 'Sorcery', 'Battle',
]);

/** A clause appended AFTER the noun — `Creature.YouCtrl` → "creature you control". */
const QUALIFIER_SUFFIX: Readonly<Record<string, string>> = {
  YouCtrl: 'you control',
  OppCtrl: 'an opponent controls',
  YouDontCtrl: "you don't control",
  YouOwn: 'you own',
  OppOwn: 'an opponent owns',
};

/** A word placed BEFORE the noun — `Land.nonBasic` → "nonbasic land". Irregular spellings only; `non<Type>` is derived below. */
const QUALIFIER_PREFIX: Readonly<Record<string, string>> = {
  tapped: 'tapped',
  untapped: 'untapped',
  attacking: 'attacking',
  blocking: 'blocking',
  Legendary: 'legendary',
  MultiColor: 'multicolored',
  Snow: 'snow',
  Historic: 'historic',
  faceDown: 'face-down',
  suspended: 'suspended',
  Basic: 'basic',
  Black: 'black', Blue: 'blue', Red: 'red', Green: 'green', White: 'white', Colorless: 'colorless',
};

/** `cmcGE3` → "3 or greater", `powerLE2` → "2 or less", `toughnessEQX` → "X". */
function comparisonWords(cmp: string, num: string): string {
  switch (cmp) {
    case 'GE': return `${num} or greater`;
    case 'LE': return `${num} or less`;
    case 'GT': return `more than ${num}`;
    case 'LT': return `less than ${num}`;
    default: return num; // EQ
  }
}

/** `inZoneGraveyard` → "in a graveyard" (`inZoneStack` is handled on its own — see `translateTargetToken`). */
function zonePhrase(zone: string): string {
  const word = zone.toLowerCase();
  if (word === 'exile') return 'in exile';
  if (word === 'command') return 'in the command zone';
  return `in a ${word}`;
}

/**
 * The long tail `CardProperty` supports that no card in the cardsfolder's own
 * default-builder path exercises (every real one found already carries a
 * `TgtPrompt$`/`ValidTgtsDesc$` override — this module's own header). Never
 * the raw CamelCase/underscore spelling, even so: spaced and lowercased, so an
 * expression this table does not yet name still reads as words, not code.
 */
function humanizeFallback(qualifier: string): string {
  return qualifier
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/**
 * One `Type.Qualifier+Qualifier` token (`TargetRestrictions.java`'s own
 * `ValidTgts$`/`CardProperty` grammar), in words.
 */
function translateTargetToken(token: string): string {
  const parts = token.split(/[.+]/).filter((p) => p !== '');
  const base = parts[0];
  if (base === undefined) return token;
  const quals = parts.slice(1);

  const stackIdx = quals.indexOf('inZoneStack');
  const isSpell = stackIdx !== -1;
  if (isSpell) quals.splice(stackIdx, 1);

  let noun: string;
  if (isSpell) {
    // `Card.inZoneStack+Creature` → "creature spell" (`subtlety.txt`'s own
    // `TgtPrompt$`): a qualifier that is itself a core type narrows WHAT kind
    // of spell, read the same way `Creature.YouCtrl` reads "creature".
    const typeIdx = quals.findIndex((q) => CORE_TYPE_WORDS.has(q));
    if (typeIdx !== -1) {
      noun = `${quals[typeIdx]!.toLowerCase()} spell`;
      quals.splice(typeIdx, 1);
    } else if (CORE_TYPE_WORDS.has(base)) {
      noun = `${base.toLowerCase()} spell`;
    } else {
      noun = 'spell';
    }
  } else {
    noun = KNOWN_BARE_WORDS.has(base) ? base.toLowerCase() : base;
  }

  const prefixes: string[] = [];
  const suffixes: string[] = [];
  let another = false;
  let isToken = false;

  for (const qual of quals) {
    if (qual === 'Other') { another = true; continue; }
    if (qual === 'token') { isToken = true; continue; }
    const suffixWord = QUALIFIER_SUFFIX[qual];
    if (suffixWord !== undefined) { suffixes.push(suffixWord); continue; }
    const prefixWord = QUALIFIER_PREFIX[qual];
    if (prefixWord !== undefined) { prefixes.push(prefixWord); continue; }
    const zoneMatch = /^inZone([A-Z][a-zA-Z]*)$/.exec(qual);
    if (zoneMatch) { suffixes.push(zonePhrase(zoneMatch[1]!)); continue; }
    const nonMatch = /^non([A-Z][a-zA-Z]*)$/.exec(qual);
    if (nonMatch) { prefixes.push(`non${nonMatch[1]!.toLowerCase()}`); continue; }
    const cmpMatch = /^(power|toughness|cmc)(GE|LE|GT|LT|EQ)(\d+|X)$/.exec(qual);
    if (cmpMatch) {
      const stat = cmpMatch[1] === 'cmc' ? 'mana value' : cmpMatch[1]!;
      suffixes.push(`with ${stat} ${comparisonWords(cmpMatch[2]!, cmpMatch[3]!)}`);
      continue;
    }
    const withMatch = /^(without|with)([A-Z][a-zA-Z]*)$/.exec(qual);
    if (withMatch) { suffixes.push(`${withMatch[1]} ${withMatch[2]!.toLowerCase()}`); continue; }
    suffixes.push(humanizeFallback(qual));
  }

  const headNoun = isToken ? `${noun} token` : noun;
  const words = [...prefixes, headNoun, ...suffixes].join(' ');
  return another ? `another ${words}` : words;
}

/** Any substring shaped like a raw `ValidTgts$` token — a capitalised identifier with a `.` or `+` qualifier chain. */
const TARGET_TOKEN = /\b[A-Z][A-Za-z0-9]*(?:[.+][A-Za-z0-9_]+)+\b/g;

/**
 * Forge's own target-type expressions, made readable — see this module's own
 * header for the citations. Composed into {@link plainRulesText}, so every
 * caller of that function gets this for free; exported separately so a
 * caller that wants ONLY this (no brace-symbol rewriting) can ask for it.
 */
export function translateTargetWords(text: string): string {
  return text.replace(TARGET_TOKEN, (token) => translateTargetToken(token));
}

/*
 * ── Y18 (second half): the zone header is a drawn line, not a choice ────
 *
 * `TargetSelection.chooseCardFromList` (`forge-gui/src/main/java/forge/
 * player/TargetSelection.java:199-250` — reached whenever a `ValidTgts$`
 * targets more than one zone AND one of them is the stack, Venser's own
 * shape: `TgtZone$ Stack,Battlefield`) groups its candidates by zone and
 * splices a literal marker string — `"--CARDS ON BATTLEFIELD:--"`,
 * `"--CARDS IN STACK:--"`, …(`:228-250`) — into the very list of `Object`s it
 * hands `getGui().one(message, choicesFiltered)`. That `one()` is
 * `getChoices(message, 1, 1, choicesFiltered)` (`AbstractGuiGame.java:771-779`
 * — `one`/`oneOrNone` are both thin wrappers over `getChoices`), and
 * `PlayBridge.java`'s own `choices()` (`:1403-1425`) turns EVERY item in that
 * list into an ordinary `{key, label, ref}` option — the marker string
 * included, as `{label: "--CARDS ON BATTLEFIELD:--", ref: null}` — because it
 * has no way to know the string is not really an option. This is the
 * operator's second complaint, *"it also has an ugly '<-- CARDS ON THE
 * BATTLEFIELD -->' slot at the beginning"*: a phantom row with a checkbox
 * that answers nothing real.
 *
 * Settled (the wave file): no text of ours, so this is not translated into a
 * caption — it is drawn as a rule line between the real groups, and excluded
 * from the choice list entirely (`ChoicePrompts.tsx`'s `GetChoicesPrompt`).
 */

/** A zone-group marker Forge spliced into a `getChoices` choice list, not a real option. */
export function isZoneDividerLabel(label: string): boolean {
  return /^--.+--$/.test(label);
}
