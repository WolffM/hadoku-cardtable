/*
 * One resolved Scryfall card -> one engine `DraftCard`. The single projection
 * `build-pool.ts` (a cube's `.dck` list, resolved through `resolve.ts`'s join)
 * and `build-catalog.ts` (every known card name, resolved through
 * `buildCardIndex`'s own ranked buckets) both need, extracted here so there
 * is one copy rather than two drifting ones — wave 73 §C follow-up 2. Every
 * field is named explicitly in `toDraftCard`/`faceCards`: a `{...card}`
 * spread would pull the whole Scryfall record, which is how an image field
 * reaches a payload without anyone deciding to send one (D13; both CLIs' own
 * `assertNoImageData`-style controls are the belt to this file's braces).
 */

import { otherFaces } from './faces.ts';
import type { GameplayCard } from './scryfall/project.ts';

/** The five real colours. Scryfall's `colors` is already exactly this set. */
const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);

function filterColors(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string' && COLORS.has(c)) : [];
}

/**
 * Split/adventure/flip/meld already carry a card-level colour; every other
 * record that has one also means it (checked against `colors === null` is
 * never half-populated the other way in the data).
 */
const UNION_FACES_LAYOUTS = new Set(['split', 'adventure', 'flip', 'meld']);

/**
 * One card's real colour — the class fix for a gap live in the shipped pool
 * (the operator: Jace, Vryn's Prodigy showed colourless).
 *
 * Scryfall's CARD-level `colors` is `null` for `transform`/`modal_dfc` (and
 * `art_series`/`double_faced_token`/`reversible_card`, none of them real
 * draftable cards) — confirmed against `cards.jsonl`: every `colors === null`
 * record is one of those five layouts, and no other. The colour lives on
 * each face instead.
 *
 * - `split`/`adventure`/`flip`/`meld`: both halves are one card, so the
 *   colour is the UNION of every face's own. (In practice Scryfall already
 *   gives these a card-level `colors`, so this branch is a correctness net
 *   for data that varies — not the common path — rather than load-bearing
 *   today.)
 * - Everything else with faces (`transform`, `modal_dfc`, …): the FRONT
 *   face's colour is the card's own, same rule `manaCost`/`typeLine`/
 *   `oracleText` below already use when the card-level field is absent.
 */
export function cardColors(raw: { colors?: unknown; layout?: unknown; card_faces?: unknown }): string[] {
  if (Array.isArray(raw.colors)) return filterColors(raw.colors);
  const faces = Array.isArray(raw.card_faces) ? (raw.card_faces as Array<{ colors?: unknown }>) : [];
  if (faces.length === 0) return [];
  const layout = typeof raw.layout === 'string' ? raw.layout : '';
  if (UNION_FACES_LAYOUTS.has(layout)) {
    return [...new Set(filterColors(faces.flatMap((f) => (Array.isArray(f.colors) ? f.colors : []))))];
  }
  return filterColors(faces[0]?.colors);
}

/**
 * Split a Scryfall mana cost string into the pip tokens a renderer needs.
 *
 * `"{3}{W}{W}"` -> `['3','W','W']`, `"{X}{R}"` -> `['X','R']`,
 * `"{W/U}"` -> `['W/U']`. Deliberately tokens rather than a rendered string:
 * the renderer needs the pieces. `apps/ui/src/components/ManaPip.tsx` turns one
 * token into one symbol, and a hybrid into Mana's two-half split — which is a
 * class per PART, so a pre-rendered `{W/U}` would have to be taken apart again.
 *
 * This used to read "we draw our own pips (no WotC symbol font, ever)". D20
 * (operator, 2026-09-27) repealed the drawing half: the symbols are Keyrune's
 * and Mana's now, third-party fonts and never WotC's own files
 * (`docs/LICENSING.md` §3.2). The token list is unaffected, and the reason for
 * it never depended on who drew the glyph.
 */
export function manaTokens(cost: string | undefined): string[] {
  if (typeof cost !== 'string' || cost.length === 0) return [];
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

export function rarityOf(raw: unknown): string {
  const r = typeof raw === 'string' ? raw : 'common';
  return ['common', 'uncommon', 'rare', 'mythic'].includes(r) ? r : 'special';
}

/**
 * Project one resolved card into the engine's `DraftCard`.
 *
 * Every field is named explicitly. A `{...card}` spread here would pull the
 * whole Scryfall record — which is how an image field would reach the browser
 * without anyone deciding to send one.
 */
export function toDraftCard(card: GameplayCard, cardId: string): Record<string, unknown> {
  const raw = card as unknown as Record<string, unknown>;
  const faces = Array.isArray(raw.card_faces) ? (raw.card_faces as Array<Record<string, unknown>>) : null;
  const front = faces?.[0];

  const manaCost = manaTokens(
    (typeof raw.mana_cost === 'string' && raw.mana_cost.length > 0
      ? raw.mana_cost
      : typeof front?.mana_cost === 'string'
        ? front.mana_cost
        : '') as string,
  );

  const colors = cardColors(raw);

  const out: Record<string, unknown> = {
    cardId,
    // Scryfall's id, so the BROWSER can derive an image URL. Not a URL, and not
    // their `image_uris` blob — see this file's header, and
    // apps/ui/src/draft/cardImage.ts for the only place it becomes a URL.
    ...(typeof raw.id === 'string' ? { scryfallId: raw.id } : {}),
    name: String(raw.name ?? front?.name ?? 'Unknown'),
    manaCost,
    manaValue: typeof raw.cmc === 'number' ? raw.cmc : 0,
    colors,
    typeLine: String(raw.type_line ?? front?.type_line ?? ''),
    oracleText: String(raw.oracle_text ?? front?.oracle_text ?? ''),
    setCode: String(raw.set ?? '???').toUpperCase(),
    collectorNumber: String(raw.collector_number ?? '0'),
    rarity: rarityOf(raw.rarity),
  };
  if (typeof raw.power === 'string') out.power = raw.power;
  if (typeof raw.toughness === 'string') out.toughness = raw.toughness;
  if (typeof raw.loyalty === 'string') out.loyalty = raw.loyalty;
  const others = faceCards(card, out);
  if (others.length > 0) out.faces = others;
  return out;
}

/**
 * The card's other faces, printed as the card is (`DraftCard.faces`): each face's own text from its
 * `card_faces` entry, and the art `otherFaces` says it draws — Etali, Primal Sickness its own back
 * image. A face Scryfall prints no entry for (a meld result, a card of its own) is left out: a face
 * with no text and a borrowed set line is not one this pool can print.
 */
export function faceCards(card: GameplayCard, front: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = card as unknown as Record<string, unknown>;
  const printed = Array.isArray(raw.card_faces) ? (raw.card_faces as Array<Record<string, unknown>>) : [];
  return otherFaces(card).flatMap(({ name, artId }) => {
    const face = printed.find((f) => f.name === name);
    if (face === undefined) return [];
    const colors = filterColors(face.colors);
    const manaCost = manaTokens(typeof face.mana_cost === 'string' ? face.mana_cost : '');
    const out: Record<string, unknown> = {
      scryfallId: artId,
      name,
      manaCost,
      manaValue: typeof face.cmc === 'number' ? face.cmc : manaCost.reduce((n, t) => n + (/^\d+$/.test(t) ? Number(t) : t === 'X' ? 0 : 1), 0),
      colors,
      typeLine: String(face.type_line ?? ''),
      oracleText: String(face.oracle_text ?? ''),
      setCode: front.setCode,
      collectorNumber: front.collectorNumber,
      rarity: front.rarity,
    };
    if (typeof face.power === 'string') out.power = face.power;
    if (typeof face.toughness === 'string') out.toughness = face.toughness;
    if (typeof face.loyalty === 'string') out.loyalty = face.loyalty;
    return [out];
  });
}
