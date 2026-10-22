/*
 * The match's art, fetched and decoded in the background the moment the
 * server says which cards it holds (`@hadoku/shared`'s `art.ts`): every card of
 * both decks, so a card the other seat turns over — or plays, or reveals — is
 * drawn with its art on the first frame. The operator, 2026-10-09: *"i care
 * much more about pre-loading art so that things load smoothly."*
 *
 * A few at a time, at low priority, and only once the page is idle: the board's
 * own first paint, and any card it is drawing now, come first. A card no deck
 * names (a token, a card made mid-game) is still covered by `artReady`'s own
 * guard where a face is turned over. A double-faced card's back face is warmed
 * beside its front, so a transform draws the other face with its art at once.
 *
 * ## `preloadCubeArt`, since wave 73 §B: the PLAN's cards, never the bundled pool
 *
 * A room now drafts whichever cube its leader picked (`docs/planning/draft-pools-plan.md`),
 * so "every card the cube can deal" is no longer a file this bundle ships —
 * `apps/ui/src/draft/pool.json` is a test fixture only now (`e2e/etali-faces.spec.ts`
 * reads it; nothing at runtime does). The wire has no route that lists a
 * cube's whole card set either (`CubeSummary` carries a count, not the
 * cards; `PodView.verdict` carries a count or a refusal's names, never a
 * list) — so there is no way to warm a plan's cube ahead of the deal this
 * wave. What a drafting client DOES hold, in full, is its own current pack
 * and pool — real `DraftCard`s, each already carrying its own `scryfallId` —
 * so `preloadCubeArt` now takes those and warms them as they arrive, which is
 * strictly less lead time than warming the whole cube during the lobby used
 * to give, but is everything the contract makes available this wave. A
 * dedicated "list a cube's cards" route is the natural next step and is not
 * this lane's to add (`apps/server/src/pools/cubes.ts` is C's; the route
 * table is A's `index.ts`).
 */
import { artIdsWithBacks } from '@hadoku/carddata/art';
import { ArtPreloadSchema, type DraftCard, type DraftView } from '@hadoku/shared';

import { artReady, cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import { relatedCards } from '../../draft/related.ts';

/** How many art loads run at once. */
export const PRELOAD_AT_ONCE = 3;

/** The distinct art URLs a `forge:art` message names for this match — empty for anything else. */
export function preloadUrls(matchId: string, payload: unknown): string[] {
  const parsed = ArtPreloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.matchId !== matchId) return [];
  const ids = parsed.data.cards.map((c) => scryfallIdFor(KNOWN_ART_IDS, c.name, c.set ?? '')).filter((id): id is string => id !== undefined);
  const urls = artIdsWithBacks(KNOWN_ART_IDS, ids).map((id) => cardImageUrl(id));
  return [...new Set(urls.filter((url): url is string => url !== null))];
}

function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 200);
}

/** Start the preload; returns how many distinct images it will warm. */
export function preloadMatchArt(matchId: string, payload: unknown): number {
  return warm(preloadUrls(matchId, payload));
}

/** One card's own art id, each other face's, and whatever rides with it (a back face, a token, a meld partner — `related.json`). */
function idsOf(card: DraftCard): string[] {
  const own = [card.scryfallId, ...(card.faces ?? []).map((f) => f.scryfallId)].filter((id): id is string => id !== undefined);
  return [...own, ...relatedCards(card.scryfallId).map((r) => r.id)];
}

/**
 * `cards`' own art, deduplicated, as URLs — never the bundled cube file (see
 * the header: it is a test fixture only, since wave 73 §B).
 */
export function cubeArtUrls(cards: readonly DraftCard[]): string[] {
  const ids = [...new Set(cards.flatMap(idsOf))];
  return [...new Set(ids.map((id) => cardImageUrl(id)).filter((url): url is string => url !== null))];
}

/** Every URL `preloadCubeArt` has already queued — never warmed twice. */
let warmed = new Set<string>();

/**
 * `cards`' art, warmed once each (the operator, 2026-10-19: *"when a new pack
 * appears i notice slight lag for the art to load … preload the art for all
 * cards in the draft set"*) — called again as more of the plan's cards become
 * visible (a new pack, a new pick), rather than once for a whole cube known
 * up front (see the header). Returns how many NEW urls it queued (0 for cards
 * already warmed).
 */
export function preloadCubeArt(cards: readonly DraftCard[]): number {
  const fresh = cubeArtUrls(cards).filter((url) => !warmed.has(url));
  for (const url of fresh) warmed.add(url);
  return warm(fresh);
}

/** For tests: the next `preloadCubeArt` warms everything again. */
export function resetCubeArtForTests(): void {
  warmed = new Set();
}

/** A seat's or a watcher's visible cards — its current pack and its pool — empty for a spectator. The whole of what `preloadCubeArt` has to warm from, this wave. */
export function viewerCards(view: DraftView): DraftCard[] {
  const v = view.viewer;
  return v.kind === 'spectator' ? [] : [...v.pack, ...v.pool];
}

/** Warm `urls` a few at a time, at low priority, once the page is idle. */
function warm(urls: readonly string[]): number {
  let next = 0;
  const pump = (): void => {
    while (next < urls.length) {
      if (!artReady(urls[next++]!, pump, 'low')) return;
    }
  };
  whenIdle(() => {
    for (let i = 0; i < PRELOAD_AT_ONCE; i++) pump();
  });
  return urls.length;
}
