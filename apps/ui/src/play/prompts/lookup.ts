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
  name: string;
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
        name: readStr(face, 'Name') ?? readStr(view, 'Name') ?? `card #${id}`,
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
 * Forge's rules text writes symbols in braces — `{T}: Add {R}.` The tap symbol
 * is a WotC mark (CLAUDE.md), so a prompt that shows an ability's text says it
 * in words and letters instead. Same rule `CardTile` follows for card text.
 */
export function plainRulesText(text: string): string {
  return text
    .replace(/\{T\}/g, 'Tap')
    .replace(/\{Q\}/g, 'Untap')
    .replace(/\{([^}]{1,5})\}/g, '$1');
}
