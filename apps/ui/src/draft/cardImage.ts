/*
 * The only place in this project where a card image URL enters the UI.
 *
 * ## Where the bytes come from now
 *
 * They come from `cdn.hadoku.me`, and that is a deliberate reversal. The repo
 * used to say "never host card images, be a link and not a host"; the operator
 * decided otherwise, explicitly, and `docs/LICENSING.md` and `docs/DECISIONS.md`
 * carry the new rule and the reasoning trail behind it. Do not re-derive the old
 * posture from a stale comment — this one is current.
 *
 * What did NOT change is that the app's own origin never serves an image. We
 * serve `apps/ui/dist` and an API, and there is no image route in it. Art comes
 * from the CDN or from Scryfall; a relative or same-origin `src` is still a bug,
 * and `cardImage.test.ts` fails on one.
 *
 * ## The manifest is the point, not the CDN
 *
 * WotC art is a placeholder here. The operator expects to source art elsewhere,
 * and the whole design exists so that when it happens, repointing a card is a
 * **data edit** — one entry in `art-manifest.json` — and no component moves.
 *
 * So this module holds no host, no path shape and no id validation. All of that
 * lives in `@hadoku/carddata/art`, behind `resolveArtUrl`, which takes an id and
 * a manifest and returns a URL or `null`. This file's entire job is to bind that
 * resolver to *this* app's committed manifest and hand back something an `<img>`
 * can use.
 *
 * The manifest ships this wave with `entries: {}`, so every card falls through
 * to Scryfall — which is exactly what the deployed UI renders today. Filling it
 * in is a data change, not a code change. That is the property being bought.
 *
 * ## Why `normal`, and why not `art_crop`
 *
 * `normal` is the whole card face — frame, type line, and the copyright and
 * artist credit printed on the card itself. That mattered under Scryfall's
 * presentation guidelines (don't cover, crop or clip off the copyright or artist
 * name; don't distort, skew, stretch, blur, sharpen or recolour), and serving the
 * unmodified whole card satisfied all of them by construction, with nothing for
 * us to remember.
 *
 * It still matters with our own CDN, for a plainer reason: `art_crop` would
 * oblige the UI to surface the artist and copyright itself, somewhere, forever —
 * a promise the first redesign that moved a caption would quietly break. And
 * because the art is a placeholder that may revert to a source that *does* carry
 * presentation rules, the whole-card choice is the one that survives the swap.
 *
 * ## No WotC marks — still true, and not in tension
 *
 * The trademark rule is untouched and absolute: no mana symbols, set symbols,
 * tap symbol, card frames or Magic wordmark drawn by *us*. That governs the
 * chrome we author, which is why `ManaPip` draws its own circles and renders
 * `{T}` as the word TAP. A card image is the card; it is not us drawing their
 * marks.
 */

import { resolveArtUrl, type ArtManifestFile } from '@hadoku/carddata/art';
import manifest from './art-manifest.json';

/** The image sizes the resolver knows how to build. */
export type CardImageSize = 'small' | 'normal' | 'large';

/**
 * Build the image URL for a card, or `null` when there is nothing to build from.
 *
 * `null` — not a placeholder, not a guess, not a URL that 404s — is the contract
 * the caller depends on: `CardTile` renders the text tile, which is a complete,
 * readable card on its own. An unresolvable id takes that path, and so does a
 * CDN key that was never uploaded (via the `<img onError>` fallback, because
 * that failure only shows up as a 404 at fetch time).
 */
export function cardImageUrl(
  scryfallId: string | undefined,
  size: CardImageSize = 'normal',
): string | null {
  return resolveArtUrl(scryfallId, (manifest as ArtManifestFile).entries, { size });
}

/**
 * Deliberately no `srcset`.
 *
 * A card tile is `--card-w: 190px`. A `normal` image is 488px wide, which covers
 * that to ~2.5x device pixel ratio — so `large` (672px) is never the right choice
 * for this UI, at any display density.
 *
 * The first cut shipped a srcset with `sizes="var(--card-w)"`. A CSS variable is
 * not a valid length in a `sizes` attribute, so the browser discarded it, fell
 * back to `100vw`, and picked the LARGEST candidate every time: 780x1086 images
 * for a 190px slot, verified in a real browser. Fifteen of those per pack is
 * roughly three times the bytes for no visible difference, and it was a good part
 * of why the table felt slow.
 *
 * One size, chosen correctly, beats a responsive set that resolves wrong. This
 * is still true with the art on our own CDN — a byte we serve is as slow to
 * download as a byte Scryfall serves.
 */
