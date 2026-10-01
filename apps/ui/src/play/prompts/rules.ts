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
import { REPLY_SCHEMAS, type BlockingMethod, type ZoneType } from '@hadoku/forge-wire';

import type { PromptLookup } from './lookup.ts';
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
  const known = new Set(ask.choices.map((c) => c.key));
  for (const key of reply) if (!known.has(key)) problems.push(`"${key}" was not offered`);
  for (const key of duplicates(reply)) problems.push(`"${key}" chosen twice`);
  const { min, max } = choiceBounds(ask.min, ask.max);
  if (reply.length < min) problems.push(`choose at least ${min}`);
  if (reply.length > max) problems.push(max === 0 ? 'nothing may be chosen here' : `choose at most ${max}`);
  return problems;
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
 * own order, and cannot be picked. Nothing is invented and nothing is hidden:
 * every row is an id this seat was sent in this ask.
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
  const drawn = new Set(ask.optionList.map(refKey));
  for (const ref of ask.delayedReveal?.cards ?? []) {
    const key = refKey(ref);
    // A reveal can name a card the options already hold, and Forge's own
    // `toReveal` can repeat one (two zones concatenated). Each entity draws once.
    if (drawn.has(key)) continue;
    drawn.add(key);
    rows.push({ ref, option: null, choosable: false });
  }
  return rows;
}

/* ── Zones ───────────────────────────────────────────────────────────── */

/** `CMatchUI.FLOATING_ZONE_TYPES` (CMatchUI.java:150-152). */
export const FLOATING_ZONES: ReadonlySet<ZoneType> = new Set<ZoneType>([
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

/**
 * The target of damage the attacker assigns past its blockers — the player or
 * planeswalker it attacked. Forge's reply map is `Map<CardView, Integer>` and
 * spells this entry as a `null` key or "key with -1"
 * (`PlayerControllerHuman.java:309-311`). The wire reply's `target` is a
 * `CardRef`, so the defender is `{ kind: 'card', id: -1 }`.
 */
export const DEFENDER_SENTINEL = { kind: 'card', id: -1 } as const;

export interface CombatDamageRules {
  /** Blockers in damage order, each with the damage that kills it. */
  blockers: { id: number; lethal: number }[];
  /** Whether a defender slot exists at all — trample, or divide-as-you-choose with override. */
  defenderSlot: boolean;
  /** "Assign combat damage as though it weren't blocked" with override: no ordering rule. */
  unordered: boolean;
  overrideOrder: boolean;
  damage: number;
}

/**
 * Forge's combat facts for one ask (`VAssignCombatDamage.java:155-206,459-478`).
 * A blocker's lethal damage is its `LethalDamage` (a planeswalker's loyalty),
 * capped at 1 when the attacker has deathtouch; unknown lethal is treated as
 * 0, which lets damage flow past it — the lenient reading, stated here because
 * it is the one fact the dialog cannot get from the ask itself.
 */
export function combatDamageRules(ask: AskOf<'assignCombatDamage'>, lookup: PromptLookup): CombatDamageRules {
  const attacker = lookup.card(ask.attacker.id);
  const keywords = attacker?.keywords ?? [];
  const deathtouch = keywords.includes('Deathtouch');
  const trample = ask.defender !== null && keywords.includes('Trample');
  // `CardStateView.hasDivideDamage()`; Forge's keyword text for it, as matched at
  // PlayerControllerHuman.java:290-291.
  const divide = keywords.some((k) => k.startsWith('You may assign CARDNAME\'s combat damage divided as you choose'));
  const blockers = ask.blockers.map((b) => {
    const facts = lookup.card(b.id);
    let lethal = Math.max(0, facts?.lethalDamage ?? 0);
    if (facts?.isPlaneswalker) lethal = facts.loyalty ?? lethal;
    else if (deathtouch) lethal = Math.min(lethal, 1);
    return { id: b.id, lethal };
  });
  return {
    blockers,
    defenderSlot: trample || (divide && ask.overrideOrder),
    unordered: divide && ask.overrideOrder,
    overrideOrder: ask.overrideOrder,
    damage: ask.damage,
  };
}

/** One amount per slot: the blockers in order, then the defender if it has a slot. */
export type CombatAssignment = { blockers: readonly number[]; defender: number };

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

/** The wire reply for an assignment: every slot, zeros included, as Forge's `getDamageMap` does. */
export function combatDamageReply(rules: CombatDamageRules, a: CombatAssignment): unknown[] {
  const entries: unknown[] = rules.blockers.map((b, i) => ({
    target: { kind: 'card', id: b.id },
    amount: a.blockers[i] ?? 0,
  }));
  if (rules.defenderSlot) entries.push({ target: DEFENDER_SENTINEL, amount: a.defender });
  return entries;
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

/** Move one item of a list to another index — the only edit `order` and `manipulateCardList` make. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

/* ── Ordering ────────────────────────────────────────────────────────── */

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
  if (reply.rememberDecision && !ask.showRememberCheckbox) problems.push('"remember" was not offered');
  return problems;
}

/**
 * `ListCardArea.validIndex` (ListCardArea.java:134-148), stated as a property
 * of the final list rather than of each drag: the answer is a permutation of
 * `cards`; the cards that may not move keep their order and stay together; and
 * unless `toAnywhere`, a movable card sits above that block only if `toTop`
 * and below it only if `toBottom`.
 */
export function manipulateProblems(
  ask: AskOf<'manipulateCardList'>,
  reply: ReplyOf<'manipulateCardList'>,
): Problems {
  const problems: Problems = [];
  const ids = reply.map((c) => c.id);
  const original = ask.cards.map((c) => c.id);
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b).join(',');
  if (sorted(ids) !== sorted(original)) {
    problems.push('the answer must hold exactly the cards shown');
    return problems;
  }
  const movable = new Set(ask.manipulable.map((c) => c.id));
  const fixedBefore = original.filter((id) => !movable.has(id));
  const fixedAfter = ids.filter((id) => !movable.has(id));
  if (fixedBefore.join(',') !== fixedAfter.join(',')) problems.push('cards that cannot move must keep their order');
  if (ask.toAnywhere || fixedAfter.length === 0) return problems;

  const first = ids.indexOf(fixedAfter[0]!);
  const last = ids.indexOf(fixedAfter[fixedAfter.length - 1]!);
  if (ids.slice(first, last + 1).some((id) => movable.has(id))) {
    problems.push('movable cards go to the top or the bottom, not between the others');
  }
  // A movable card that is already where it started is not a move.
  const moved = (id: number) => ids.indexOf(id) !== original.indexOf(id);
  if (!ask.toTop && ids.slice(0, first).some(moved)) problems.push('nothing may be put on top');
  if (!ask.toBottom && ids.slice(last + 1).some(moved)) problems.push('nothing may be put on the bottom');
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

/* ── One answer is no question ───────────────────────────────────────── */

/**
 * The single reply an ask admits, when it admits exactly one.
 *
 * This is the ONE place the browser decides "does this question answer
 * itself". `../live/LiveBoard.tsx` calls it before a prompt would render and
 * sends the reply instead; no component calls it, and no component embeds a
 * policy decision of its own.
 *
 * The rule it obeys is the server's (`apps/server/src/play/auto.ts`): a
 * shortcut may remove a question, never information, and it never decides
 * anything about the GAME — only that Forge left one possibility. The seat's
 * full-control toggle turns it off (`LiveBoard`), and then every stop comes
 * back.
 *
 * ## Why `getAbilityToPlay` and only `getAbilityToPlay`
 *
 * Everything else with one legal reply is already answered a hop earlier, by
 * `onlyAnswer` in the server's `auto.ts`, and duplicating those here would be
 * two statements of one policy. `getAbilityToPlay` is the exception on
 * purpose: the offer's LABEL is what makes the shortcut safe to report, and
 * labels are resolved on this side (`lookup.ts`'s `withAbilityLabels` over the
 * ask's own `label`), so the client is the only side that can name what it
 * played.
 *
 * Forge's own desktop client does the same thing, in exactly our case:
 * `CMatchUI.getAbilityToPlay` with a null `triggerEvent` returns the only
 * ability and never opens `GuiChoose.oneOrNone`
 * (`CMatchUI.java:1017-1023`) — and every act this client sends carries
 * `triggerEvent: null` (`../live/match.ts`'s `selectCard`). Our bridge opens an
 * ask regardless (`PlayBridge.java:1010-1013`), which is why a one-ability offer
 * reached the browser at all; answering it here restores Forge's behaviour
 * rather than inventing one. And a one-ability offer is always the direct consequence of
 * THIS seat's own click — `InputPassPriority` for a card in hand, or
 * `InputPayMana.onCardSelected` for a land, which plays a lone mana ability
 * itself and only asks for two or more (`InputPayMana.java:101-106`) — so the
 * player has already said what they want.
 *
 * ## Why a REVEAL is still not answered here (wave 24 §D.5)
 *
 * The operator asked for a reveal that *"shows both players at once and needs
 * no OK"*. A reveal is `getChoices` with `min === max === -1`
 * (`AbstractGuiGame.java:785-788`: `reveal(message, items)` IS
 * `getChoices(message, -1, -1, items)`), reached from
 * `PlayerControllerHuman.reveal` (`PlayerControllerHuman.java:933-972`), and it
 * has exactly one legal reply — the empty list. So it looks like the easiest
 * auto-answer in the file, and it is refused on purpose:
 *
 * **answering it here would delete the information.** `answerAsk` closes the
 * ask the instant the reply is sent (`../live/match.ts`'s `answerAsk`, which
 * calls `closeAsk` before it sends) and `../live/LiveBoard.tsx` draws nothing at
 * all for an ask that answers itself (`const ask = auto === null ? pending : null`) — so the revealed cards would never reach a screen. A
 * shortcut may remove a question, never information (`apps/server/src/play/auto.ts`
 * says the same thing about the same ask).
 *
 * What would make it safe is a surface that outlives the ask, and the data for
 * one is already on the wire and unread: `TrackableProperty.RevealedCardsCollection`
 * (`forge-game/src/main/java/forge/trackable/TrackableProperty.java:48`), which
 * `PlayerControllerHuman.reveal` fills through `getGui().updateRevealedCards`
 * (`:970`, `AbstractGuiGame.java:252-260`) and `apps/ui/src/play/adapter.ts`
 * does not read. Until something draws that, the reveal keeps its OK. The
 * "both players" half needs nothing from us: `reveal` is called on each
 * player's own controller by the effect, so a seat is asked **only when Forge
 * revealed to it** — the UI never decides to share.
 */
export type AutoAnswer =
  | {
      method: 'getAbilityToPlay';
      reply: ReplyOf<'getAbilityToPlay'>;
      /**
       * What was played, in Forge's own words: the offer's `label`. Said on the
       * board (`../live/match.ts`'s `noteAutoAnswered`) — a shortcut nobody can see
       * is indistinguishable from a board that swallowed the click.
       */
      why: string;
    }
  | {
      /** Wave 32 Q7: the one spell on the stack a counterspell can target. */
      method: 'getChoices';
      reply: ReplyOf<'getChoices'>;
      why: string;
    };

/**
 * The stack item a `getChoices` ask is choosing between, or null when it is not
 * that kind of ask.
 *
 * Forge asks *"select target spell"* through `TargetSelection.chooseCardFromStack`
 * (`TargetSelection.java:299-343`), which calls `getGui().one(...)` — a
 * mandatory `getChoices` with `min = max = 1` — whose options are
 * `StackItemView`s, and which the bridge projects with `ref.kind === 'stackItem'`
 * (`PlayBridge.java:288`). `oneOrNone` is the optional variant (`min = 0`) and
 * stays a question: declining is the player's. Shared with `gestures/stack.ts`,
 * which draws the arrow to the same items.
 */
export function stackItemChoices(ask: AskOf<BlockingMethod>): { key: string; stackItemId: number; label: string }[] | null {
  if (ask.method !== 'getChoices') return null;
  const out: { key: string; stackItemId: number; label: string }[] = [];
  for (const choice of ask.choices) {
    if (choice.ref?.kind === 'stackItem') out.push({ key: choice.key, stackItemId: choice.ref.id, label: choice.label });
  }
  return out.length === 0 ? null : out;
}

export function autoAnswer(ask: AskOf<BlockingMethod>): AutoAnswer | null {
  if (ask.method === 'getChoices') return onlyStackTarget(ask);
  if (ask.method !== 'getAbilityToPlay') return null;
  // Exactly one, and nothing else: two abilities are a real choice, and zero
  // is Forge asking about nothing, which the picker shows as "None" only.
  if (ask.abilities.length !== 1) return null;
  const only = ask.abilities[0];
  if (only === undefined) return null;
  // A malformed auto-answer must never leave: it would be refused a hop later
  // with no player to blame. Fall through to asking instead.
  const parsed = REPLY_SCHEMAS.getAbilityToPlay.safeParse(only);
  if (!parsed.success) return null;
  return {
    method: 'getAbilityToPlay',
    reply: parsed.data as ReplyOf<'getAbilityToPlay'>,
    why: only.label ?? `ability #${only.id}`,
  };
}

/**
 * *"If there's only one spell on the stack then the target of Mana Leak is
 * obvious"* (operator, wave 32 Q7). Exactly one option, it is a stack item, and
 * the ask is mandatory and takes exactly one — so there is one legal reply and no
 * question. A rule, not a branch: the same `autoAnswer` that answers a lone
 * ability, off for full control and for a spectator by its one caller.
 */
function onlyStackTarget(ask: AskOf<'getChoices'>): AutoAnswer | null {
  if (ask.min !== 1 || ask.max !== 1 || ask.choices.length !== 1) return null;
  const only = stackItemChoices(ask)?.[0];
  if (only === undefined || getChoicesProblems(ask, [only.key]).length > 0) return null;
  return { method: 'getChoices', reply: [only.key], why: only.label };
}
