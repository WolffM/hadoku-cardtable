/*
 * What makes an answer legal — per method, as pure functions.
 *
 * A wire schema sees one message; it cannot say that `showOptionDialog`'s
 * reply is a valid index into the options that were SENT, or that combat
 * damage sums to the damage dealt. `@hadoku/forge-wire`'s envelope says so
 * itself ("correlation is the bridge's job"). These functions are that
 * correlation, for the browser side: each takes the ask and a candidate answer
 * and returns every reason the answer may not be sent. Empty means sendable.
 * Components disable their submit on a non-empty list, so an answer that fails
 * here cannot leave the component.
 *
 * ## Where the rules come from
 *
 * The client decides nothing about the GAME — which blockers, how much damage,
 * which options: Forge computes all of that and sends it. What the client does
 * own is the shape of the answer, and for that every rule below is transcribed
 * from Forge's own desktop dialog for the same method, cited file:line. That
 * matters most for combat damage: `PlayerControllerHuman.assignCombatDamage`
 * copies whatever map comes back without re-checking it
 * (`PlayerControllerHuman.java:300-312`), so Forge's desktop dialog is the only
 * place its ordering rule is enforced — and here, this file is.
 */

import { deckIssues, newDeck, type Deck } from '@hadoku/deck';
import { oneEachFit, type BlockingMethod, type ZoneType } from '@hadoku/forge-wire';
import type { CombatAssignment, CombatDamageRules } from '@hadoku/shared';

import type { AskOf, ReplyOf } from './types.ts';

type Problems = string[];

function duplicates<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const dup = new Set<T>();
  for (const item of items) {
    if (seen.has(item)) dup.add(item);
    seen.add(item);
  }
  return [...dup];
}

const refKey = (r: { kind: string; id: number }) => `${r.kind}:${r.id}`;

/* ── Tier A dialogs ──────────────────────────────────────────────────── */

/** An index into `options` (`CMatchUI.showOptionDialog` → `SOptionPane`). */
export function optionDialogProblems(ask: AskOf<'showOptionDialog'>, reply: number): Problems {
  if (!Number.isInteger(reply) || reply < 0 || reply >= ask.options.length) {
    return [`option ${reply} is not one of the ${ask.options.length} offered`];
  }
  return [];
}

/**
 * `null` is cancel. A numeric dialog answers an integer
 * (`RecordActionsMacroSystem.java:361` parses it with `Integer.parseInt`), and a
 * dialog with `inputOptions` answers one of them.
 */
export function inputDialogProblems(ask: AskOf<'showInputDialog'>, reply: string | null): Problems {
  if (reply === null) return [];
  const problems: Problems = [];
  if (ask.isNumeric && !/^-?\d+$/.test(reply.trim())) problems.push(`"${reply}" is not a whole number`);
  if (ask.inputOptions.length > 0 && !ask.inputOptions.includes(reply)) {
    problems.push(`"${reply}" is not one of the offered answers`);
  }
  return problems;
}

/**
 * `confirm`'s options are button labels and the reply is "the FIRST one was
 * pressed" (`GuiDialog.java:28-29`: `answer == 0`). A one-button confirm
 * (`PlayerControllerHuman.java:1882`, a lone "OK") therefore cannot answer
 * `false`. An empty list is Forge's default pair, Yes/No
 * (`InputConfirm.java:51`).
 */
export function confirmButtons(ask: AskOf<'confirm'>): string[] {
  return ask.options.length > 0 ? ask.options.slice(0, 2) : ['Yes', 'No'];
}

export function confirmProblems(ask: AskOf<'confirm'>, reply: boolean): Problems {
  if (reply === false && confirmButtons(ask).length < 2) return ['this question has only one answer'];
  return [];
}

/* ── Choosing from a list ────────────────────────────────────────────── */

/**
 * How many of `getChoices`' options may be selected, from `ListChooser`
 * (`ListChooser.java:116-122,172,387`): OK is enabled while
 * `min <= selected <= max`. A negative `max` is Forge's display-only list
 * (`PlayerControllerHuman.java:2595` passes -1, -1): OK only while nothing is
 * selected, so the answer is always empty.
 */
export function choiceBounds(min: number, max: number): { min: number; max: number } {
  if (max < 0) return { min: 0, max: 0 };
  return { min: Math.max(0, min), max };
}

export function getChoicesProblems(ask: AskOf<'getChoices'>, reply: readonly string[]): Problems {
  const problems: Problems = [];
  const known = new Set(ask.names ?? ask.choices.map((c) => c.key));
  for (const key of reply) if (!known.has(key)) problems.push(`"${key}" was not offered`);
  for (const key of duplicates(reply)) problems.push(`"${key}" chosen twice`);
  const { min, max } = choiceBounds(ask.min, ask.max);
  if (reply.length < min) problems.push(`choose at least ${min}`);
  if (reply.length > max) problems.push(max === 0 ? 'nothing may be chosen here' : `choose at most ${max}`);
  return problems;
}

export interface NumericChoiceRange {
  min: number;
  max: number;
  /**
   * The wire `key` for each integer `min..max`, in order (`keys[0]` answers
   * `min`, `keys[keys.length - 1]` answers `max`). **Never the integer
   * itself** — wave 34 §G item 1, found against a real Forge match: every
   * `getChoices` key is `PlayBridge.choices()`'s own `"c" + index`
   * (`PlayBridge.java:1186`), positional in the list Forge sent, regardless of
   * what the choice MEANS. A real ask for `Fireball`'s X measured
   * `choices: [{key:"c0",label:"0"},{key:"c1",label:"1"},…]` — no key is ever
   * the bare integer a fixture built by hand had always used
   * (`docs/planning/wave34-evidence/g1-choose-x-slider.md`).
   */
  keys: readonly string[];
  /**
   * The most X the seat can pay, when the ask is a mana X: the bridge tries the
   * ability's cost at each X with Forge's own payer (`PlayBridge.java`'s
   * `affordableX`). Absent for any other number.
   */
  affordable?: number;
}

/**
 * Forge's `chooseNumber`/`getInteger` — `announceRequirements`'s X, `NumTimes`,
 * `chooseNumberForKeywordCost`/`chooseNumberForCostReduction`
 * (`PlayerController.java:117,283-291`) — reaches the wire as a `getChoices`
 * with `min=0, max=1` whose `choices` are the literal integers, AS LABELS —
 * the KEY is never the integer; see `NumericChoiceRange.keys`' doc. Forge lists
 * ten numbers and an "Other…" entry; the bridge lists on past them instead
 * (`PlayBridge.java`'s `numberAsk`): at least 20, and a mana X up to the most
 * the seat can pay.
 *
 * Nothing on the wire marks an ask as "this is a number" — so this is
 * structural: every choice must have `ref: null` and a `label` that is an
 * integer, one more than the choice before it. A word/card choice list can
 * never match this by accident, because nothing else here labels consecutive
 * options with consecutive integers.
 */
export function numericChoiceRange(ask: AskOf<'getChoices'>): NumericChoiceRange | null {
  const choices = ask.choices;
  if (choices.length < 2 || choices.some((c) => c.ref !== null || !/^-?\d+$/.test(c.label))) return null;
  const values = choices.map((c) => Number.parseInt(c.label, 10));
  for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]! + 1) return null;
  const range: NumericChoiceRange = { min: values[0]!, max: values[values.length - 1]!, keys: choices.map((c) => c.key) };
  return ask.affordable === undefined ? range : { ...range, affordable: ask.affordable };
}

/** `null` only when the effect is optional (`CMatchUI.java:1333-1341`: `oneOrNone` vs `one`). */
export function chooseSingleProblems(
  ask: AskOf<'chooseSingleEntityForEffect'>,
  reply: ReplyOf<'chooseSingleEntityForEffect'>,
): Problems {
  if (reply === null) return ask.isOptional ? [] : ['a choice is required'];
  const known = new Set(ask.optionList.map(refKey));
  return known.has(refKey(reply)) ? [] : [`${refKey(reply)} was not offered`];
}

/**
 * `CMatchUI.chooseEntitiesForEffect` is a dual list whose source must end with
 * `size - max .. size - min` items left in it (`CMatchUI.java:1344-1349`), i.e.
 * between `min` and `max` chosen.
 */
export function chooseEntitiesProblems(
  ask: AskOf<'chooseEntitiesForEffect'>,
  reply: ReplyOf<'chooseEntitiesForEffect'>,
): Problems {
  const problems: Problems = [];
  const known = new Set(ask.optionList.map(refKey));
  const keys = reply.map(refKey);
  for (const key of keys) if (!known.has(key)) problems.push(`${key} was not offered`);
  for (const key of duplicates(keys)) problems.push(`${key} chosen twice`);
  const { min, max } = choiceBounds(ask.min, ask.max);
  if (keys.length < min) problems.push(`choose at least ${min}`);
  if (keys.length > max) problems.push(`choose at most ${max}`);
  return problems;
}

/** One of the abilities offered, or none (`CMatchUI.java:1016-1024`, `oneOrNone`). */
export function abilityProblems(
  ask: AskOf<'getAbilityToPlay'>,
  reply: ReplyOf<'getAbilityToPlay'>,
): Problems {
  if (reply === null) return [];
  return ask.abilities.some((a) => a.id === reply.id) ? [] : [`ability #${reply.id} was not offered`];
}

/* ── A search: what is choosable, and what is only being looked at ───── */

/**
 * One row of a search view: an entity the ask carried, and whether **Forge**
 * offered it.
 *
 * Wave 24 §D.2, the operator: *"library search: valid targets at top, rest
 * greyed"*. The two lists that say so are already in one ask, and both come
 * from `ChangeZoneEffect`'s search
 * (`forge-game/src/main/java/forge/game/ability/effects/ChangeZoneEffect.java`):
 *
 *   - `optionList` is Forge's `fetchList`, already filtered by the ability's
 *     `ChangeType` (`:1096-1099`) — a Scalding Tarn's Islands and Mountains
 *     and nothing else. **These and only these may be answered.**
 *   - `delayedReveal.cards` is `toReveal`: the WHOLE library (`:1047-1052`),
 *     captioned "<source> - Looking at cards in …" (`:1062`).
 *
 * So "choosable" is never a rule of ours — it is membership in the list Forge
 * sent as the options. A revealed card that is not in it is drawn, in Forge's
 * own order, and cannot be picked — but only from an opponent's hand, which the
 * seat sees nowhere else. A library reveal draws no rows of its own: the
 * operator, 2026-10-11, searching with Nissa, Vastwood Seer, *"i dont need to
 * see 'not offered' text in this list, it makes the list much longer than it
 * needs to be"*. Every row is an id this seat was sent in this ask.
 *
 * `option` is the index into `optionList`, so a component answers with
 * `ask.optionList[option]` and the reply is byte-identical to what it was
 * before this view existed.
 */
export interface SearchRow {
  ref: ReplyOf<'chooseEntitiesForEffect'>[number];
  /** Its index in `optionList`, or `null` when Forge did not offer it. */
  option: number | null;
  /** Forge's own answer. Exactly `option !== null`. */
  choosable: boolean;
}

export function searchRows(
  ask: AskOf<'chooseSingleEntityForEffect'> | AskOf<'chooseEntitiesForEffect'>,
): SearchRow[] {
  const rows: SearchRow[] = ask.optionList.map((ref, option) => ({ ref, option, choosable: true }));
  const reveal = ask.delayedReveal;
  if (reveal === null || reveal.zones.includes('Library')) return rows;
  const drawn = new Set(ask.optionList.map(refKey));
  for (const ref of reveal.cards) {
    const key = refKey(ref);
    // A reveal can name a card the options already hold, and Forge's own
    // `toReveal` can repeat one (two zones concatenated). Each entity draws once.
    if (drawn.has(key)) continue;
    drawn.add(key);
    rows.push({ ref, option: null, choosable: false });
  }
  return rows;
}

/**
 * The caption of a search: one sentence, `"<source>: searching <owner>'s library"`.
 *
 * Forge's own `messagePrefix` is `"<source> - Looking at cards in "`
 * (`ChangeZoneEffect.java:1062`, `lblLookingCardIn`), written to be followed by
 * a zone its desktop draws elsewhere; joined to the owner and zone it read
 * *"Nissa, Vastwood Seer - Looking at cards in from Bella's Library"* (the
 * operator, 2026-10-11: *"this is a bit ugly"*). Only the source is taken from
 * it — the text before Forge's own `" - "` — and the rest is said from the
 * reveal's facts: whose zones, and which.
 */
export function revealCaption(reveal: { zones: readonly string[]; messagePrefix: string }, ownerName: string): string {
  const cut = reveal.messagePrefix.indexOf(' - ');
  const source = cut > 0 ? reveal.messagePrefix.slice(0, cut).trim() : '';
  const zones = reveal.zones.map((z) => z.toLowerCase()).join(' and ');
  const act = `${reveal.zones.includes('Library') ? 'searching' : 'looking at'} ${ownerName}’s ${zones}`;
  return source === '' ? act.charAt(0).toUpperCase() + act.slice(1) : `${source}: ${act}`;
}

/* ── Zones ───────────────────────────────────────────────────────────── */

/** `CMatchUI.FLOATING_ZONE_TYPES` (CMatchUI.java:150-152). */
const FLOATING_ZONES: ReadonlySet<ZoneType> = new Set<ZoneType>([
  'Library', 'Graveyard', 'Exile', 'Flashback', 'Command', 'Ante', 'Sideboard',
  'PlanarDeck', 'SchemeDeck', 'AttractionDeck', 'ContraptionDeck', 'Junkyard',
]);

type ZoneUpdates = ReplyOf<'tempShowZones'>;

/**
 * Which of the requested zones this client actually opens
 * (`CMatchUI.tempShowZones`, CMatchUI.java:584-609): never the battlefield
 * (always shown), a hand only when it is someone else's, otherwise the
 * floating zones. The reply is what was opened, so `hideZones` can close it.
 *
 * One deliberate difference: Forge adds the WHOLE `PlayerZoneUpdate` once per
 * zone it showed, so an update naming two floating zones is returned twice
 * with both. This returns each player once, with exactly the zones shown —
 * the same set, without the duplicates (two updates for one player merge).
 */
export function zonesShown(controllerId: number, requested: ZoneUpdates): ZoneUpdates {
  const out: ZoneUpdates = [];
  for (const update of requested) {
    const zones = update.zones.filter((z) =>
      z === 'Hand' ? update.player.id !== controllerId : FLOATING_ZONES.has(z),
    );
    if (zones.length === 0) continue;
    const existing = out.find((u) => u.player.id === update.player.id);
    if (existing === undefined) out.push({ player: update.player, zones });
    else for (const z of zones) if (!existing.zones.includes(z)) existing.zones.push(z);
  }
  return out;
}

/**
 * `CMatchUI.openZones` (CMatchUI.java:1362-1381): every requested zone for
 * every player, except the battlefield, the hand and the stack.
 */
export function zonesOpened(ask: AskOf<'openZones'>): ReplyOf<'openZones'> {
  const zones = ask.zones.filter((z) => z !== 'Battlefield' && z !== 'Hand' && z !== 'Stack');
  if (zones.length === 0) return [];
  return ask.players.map((player) => ({ player, zones: [...zones] }));
}

/** An answer may only name players and zones the ask named. */
export function zoneReplyProblems(requested: ZoneUpdates, reply: ZoneUpdates): Problems {
  const allowed = new Map<number, Set<string>>();
  for (const u of requested) {
    const set = allowed.get(u.player.id) ?? new Set<string>();
    for (const z of u.zones) set.add(z);
    allowed.set(u.player.id, set);
  }
  const problems: Problems = [];
  for (const u of reply) {
    const set = allowed.get(u.player.id);
    for (const z of u.zones) {
      if (set === undefined || !set.has(z)) problems.push(`player #${u.player.id} ${z} was not requested`);
      if (z === 'Battlefield') problems.push('the battlefield is never opened as a zone');
    }
  }
  return problems;
}

/* ── Dividing an amount ──────────────────────────────────────────────── */

/** An assignment against Forge's facts for the ask (`@hadoku/shared`'s `combatDamageRules`). */
export function combatDamageProblems(rules: CombatDamageRules, a: CombatAssignment): Problems {
  const problems: Problems = [];
  if (a.blockers.length !== rules.blockers.length) problems.push('one amount per blocker');
  const all = [...a.blockers, a.defender];
  if (all.some((n) => !Number.isInteger(n) || n < 0)) problems.push('amounts are whole numbers, 0 or more');
  if (!rules.defenderSlot && a.defender !== 0) problems.push('no damage can go past the blockers');

  const total = all.reduce((s, n) => s + n, 0);
  if (total !== rules.damage) problems.push(`assign exactly ${rules.damage} (assigned ${total})`);

  // `checkDamageQueue` (VAssignCombatDamage.java:330-348): once a blocker is
  // short of lethal, nothing after it may take damage — except that with
  // override only the DEFENDER waits. With divide-as-you-choose, no rule.
  if (!rules.unordered) {
    let aliveBefore = false;
    rules.blockers.forEach((b, i) => {
      const amount = a.blockers[i] ?? 0;
      if (aliveBefore && !rules.overrideOrder && amount > 0) {
        problems.push(`blocker ${i + 1} cannot take damage until the ones before it have lethal`);
      }
      aliveBefore ||= amount < b.lethal;
    });
    if (aliveBefore && a.defender > 0) problems.push('every blocker needs lethal damage before any tramples over');
  }
  return problems;
}

/**
 * Forge's own `checkDamageQueue` (VAssignCombatDamage.java:330-348), run after
 * every change: once a blocker is short of lethal, what comes after it that may
 * not take damage yet is cleared — every later slot, or with override only the
 * defender; nothing with divide-as-you-choose. So the order rules are never a
 * reason OK is disabled: the window cannot hold an assignment that breaks them.
 */
export function settleCombatAssignment(rules: CombatDamageRules, a: CombatAssignment): CombatAssignment {
  if (rules.unordered) return a;
  let aliveBefore = false;
  const blockers = rules.blockers.map((b, i) => {
    const amount = a.blockers[i] ?? 0;
    if (aliveBefore && !rules.overrideOrder) return 0;
    aliveBefore ||= amount < b.lethal;
    return amount;
  });
  return { blockers, defender: aliveBefore ? 0 : a.defender };
}

/**
 * `VAssignGenericAmount` (VAssignGenericAmount.java:157,230-309): each target
 * carries its own maximum (the map's value, or the whole amount), OK needs
 * nothing left over, and `atLeastOne` floors every target at 1.
 */
export function genericAmountProblems(
  ask: AskOf<'assignGenericAmount'>,
  amounts: readonly number[],
): Problems {
  const problems: Problems = [];
  if (amounts.length !== ask.target.length) problems.push('one amount per target');
  ask.target.forEach((t, i) => {
    const n = amounts[i] ?? 0;
    if (!Number.isInteger(n) || n < 0) problems.push(`target ${i + 1}: amounts are whole numbers, 0 or more`);
    if (n > t.amount) problems.push(`target ${i + 1}: at most ${t.amount}`);
    if (ask.atLeastOne && n < 1) problems.push(`target ${i + 1}: at least 1`);
  });
  const total = amounts.reduce((s, n) => s + n, 0);
  if (total !== ask.amount) problems.push(`assign exactly ${ask.amount} (assigned ${total})`);
  return problems;
}

/** `MagicColor` masks (MagicColor.java:16-23) → the mana token and its word. */
export const MANA_COLOR: Readonly<Record<number, { token: string; word: string }>> = {
  0: { token: 'C', word: 'colorless' },
  1: { token: 'W', word: 'white' },
  2: { token: 'U', word: 'blue' },
  4: { token: 'B', word: 'black' },
  8: { token: 'R', word: 'red' },
  16: { token: 'G', word: 'green' },
};

export interface ManaCombo {
  /** One mana token per mana made, in the ask's colour order: `['R', 'G']`. */
  tokens: string[];
  /** One amount per `ask.target` entry — the reply's amounts. */
  amounts: number[];
}

/**
 * A mana combination (`PlayerControllerHuman.specifyManaCombo`: Fire-Lit
 * Thicket's "Add {R}{R}, {R}{G}, or {G}{G}") as the short list of whole answers
 * it is, rather than a division to make: every way to split `ask.amount` over
 * the colours, each colour within its own maximum, first colour heaviest first.
 * `null` when any key is not a colour — that ask is a division.
 */
export function manaCombos(ask: AskOf<'assignGenericAmount'>): ManaCombo[] | null {
  const colors: number[] = [];
  for (const t of ask.target) {
    if (t.key.target !== 'manaColor') return null;
    colors.push(t.key.color);
  }
  const out: ManaCombo[] = [];
  const walk = (i: number, left: number, amounts: number[]): void => {
    if (i === colors.length) {
      if (left === 0 && !(ask.atLeastOne && amounts.some((n) => n < 1))) {
        out.push({ amounts, tokens: amounts.flatMap((n, j) => Array<string>(n).fill(MANA_COLOR[colors[j]!]?.token ?? '?')) });
      }
      return;
    }
    for (let n = Math.min(left, ask.target[i]!.amount); n >= 0; n -= 1) walk(i + 1, left - n, [...amounts, n]);
  };
  walk(0, ask.amount, []);
  return out;
}

/** Move one item of a list to another index — the only edit `order` and `manipulateCardList` make. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

/* ── Ordering ────────────────────────────────────────────────────────── */

/** `order`'s two lists: what is left (`source`) and the answer (`dest`), as keys. */
export interface OrderLists {
  source: readonly string[];
  dest: readonly string[];
}

/**
 * Move `key` into list `to`, just before `before` when that is in `to`, at the
 * end otherwise. `keepSourceIn` is the source's fixed order when its order is
 * not part of the answer (everything but a scry): a key returning there goes
 * back to its own place in it, wherever it was dropped.
 */
export function moveBetween(lists: OrderLists, key: string, to: keyof OrderLists, before: string | null, keepSourceIn?: readonly string[]): OrderLists {
  const next = { source: lists.source.filter((k) => k !== key), dest: lists.dest.filter((k) => k !== key) };
  if (to === 'source' && keepSourceIn !== undefined) {
    const kept = new Set([...next.source, key]);
    next.source = keepSourceIn.filter((k) => kept.has(k));
    return next;
  }
  const at = before === null || before === key ? -1 : next[to].indexOf(before);
  next[to] = at === -1 ? [...next[to], key] : [...next[to].slice(0, at), key, ...next[to].slice(at)];
  return next;
}

/**
 * `DualListBox` (DualListBox.java:481-493): OK is enabled while the SOURCE list
 * holds between `remainingObjectsMin` and `remainingObjectsMax` items; a
 * negative max means any number. The reply is the destination list, in order.
 */
export function orderProblems(ask: AskOf<'order'>, reply: ReplyOf<'order'>): Problems {
  const problems: Problems = [];
  const known = new Set([...ask.sourceChoices, ...ask.destChoices].map((c) => c.key));
  for (const key of reply.ordered) if (!known.has(key)) problems.push(`"${key}" was not offered`);
  for (const key of duplicates(reply.ordered)) problems.push(`"${key}" appears twice`);
  const remaining = known.size - new Set(reply.ordered.filter((k) => known.has(k))).size;
  if (ask.remainingObjectsMax >= 0) {
    if (remaining < ask.remainingObjectsMin) {
      problems.push(`leave at least ${ask.remainingObjectsMin} unplaced (${remaining} left)`);
    }
    if (remaining > ask.remainingObjectsMax) {
      problems.push(
        ask.remainingObjectsMax === 0
          ? `place every item (${remaining} left)`
          : `leave at most ${ask.remainingObjectsMax} unplaced (${remaining} left)`,
      );
    }
  }
  const locked = new Set(ask.locked ?? []);
  for (const key of reply.ordered) if (locked.has(key)) problems.push(`"${key}" may not be moved there`);
  if (ask.oneEach !== undefined && oneEachFit(ask.oneEach, reply.ordered) === null) problems.push('two cards for one type');
  if (reply.rememberDecision && !ask.showRememberCheckbox) problems.push('"remember" was not offered');
  return problems;
}

/* ── Sideboarding ────────────────────────────────────────────────────── */

/**
 * The ask's two pools as an `@hadoku/deck` `Deck` — the maindeck and the
 * sideboard are one pool partitioned, which is exactly that model.
 */
export function deckFromSideboardAsk(ask: AskOf<'sideboard'>): Deck {
  // `newDeck` merges repeated lines into one entry per card; the main pool is
  // put through it too so both piles are in the shape the move functions expect.
  const main = newDeck('main', ask.main).sideboard;
  return { ...newDeck('sideboarding', ask.sideboard), main };
}

/**
 * A new maindeck may only hold cards from the two pools, no more copies than
 * they had between them. `deckIssues`' pool check is exactly that
 * (`more-copies-than-drafted`); its size floor is the LIMITED floor and is not
 * this prompt's rule — Forge re-asks until the deck conforms
 * (`PlayerControllerHuman.java:275-277`), so size is shown, not enforced.
 */
export function sideboardProblems(ask: AskOf<'sideboard'>, reply: ReplyOf<'sideboard'>): Problems {
  if (reply === null) return [];
  const pool = [...ask.main, ...ask.sideboard];
  const probe: Deck = { name: 'probe', main: reply, sideboard: [], basics: [] };
  return deckIssues(probe, pool)
    .filter((i) => i.kind === 'more-copies-than-drafted')
    .map((i) => i.message);
}

/**
 * The stack item a `getChoices` ask is choosing between, or null when it is not
 * that kind of ask.
 *
 * Forge asks *"select target spell"* through `TargetSelection.chooseCardFromStack`
 * (`TargetSelection.java:299-343`), which calls `getGui().one(...)` — a
 * `getChoices` with `min = max = 1` (`oneOrNone` is `min 0, max 1`) — whose options are
 * `StackItemView`s, and which the bridge projects with `ref.kind === 'stackItem'`
 * (`PlayBridge.java:288`). `gestures/stack.ts` draws the arrow to the same items;
 * a lone one answers itself (`@hadoku/shared`'s `selfAnswer`).
 */
export function stackItemChoices(ask: AskOf<BlockingMethod>): { key: string; stackItemId: number; label: string }[] | null {
  if (ask.method !== 'getChoices') return null;
  const out: { key: string; stackItemId: number; label: string }[] = [];
  for (const choice of ask.choices) {
    if (choice.ref?.kind === 'stackItem') out.push({ key: choice.key, stackItemId: choice.ref.id, label: choice.label });
  }
  return out.length === 0 ? null : out;
}
