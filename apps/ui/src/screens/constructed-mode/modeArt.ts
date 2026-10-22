/*
 * The art behind each mode's large card (`ModeRow.tsx`): the operator's own
 * generated pieces (2026-10-21), cut from their backgrounds, trimmed, scaled to
 * 384px and encoded as WebP, then uploaded to the CDN, which addresses an object
 * by the SHA-256 of its bytes. One line per mode, so new art is a one-line edit
 * here and nothing else.
 */
import { cdnUrlFor, isCdnKey } from '@hadoku/carddata/art';
import type { ConstructedMode } from '@hadoku/shared';

const MODE_ART_KEYS: Readonly<Record<ConstructedMode, string>> = {
  classic: '1c190e248802eecf6ddfcb39c0192c7ce4fd477a2d5c758cece8f20fa60868ab.webp',
  gauntlet: '7c2080854ff9876223165fe2a955b4da311ae2bc06607598f122a6c1dc6618b8.webp',
  random: '7c7ac4dcb5c78a74253cc61bdad8fdd638a82a17138a614dfaf7eb32e8c99e89.webp',
};

/** The URL of a mode's art, or undefined for a key the CDN could not hold (the card then shows its name alone). */
export function modeArtUrl(mode: ConstructedMode): string | undefined {
  const key = MODE_ART_KEYS[mode];
  return isCdnKey(key) ? cdnUrlFor(key) : undefined;
}

let decoded: Promise<void> | null = null;

/**
 * Every mode's art fetched and decoded, once per page: what the large cards draw
 * the moment they grow back, so the transition never photographs a card before
 * its art is there. Settles either way; art that will not load leaves the name.
 */
export function decodeModeArt(): Promise<void> {
  if (decoded === null) {
    const urls = (Object.keys(MODE_ART_KEYS) as ConstructedMode[]).flatMap((mode) => modeArtUrl(mode) ?? []);
    decoded = Promise.all(
      urls.map((url) => {
        const image = new Image();
        image.src = url;
        // A browser without `decode` (and the test DOM) still fetches on `src`; there is nothing to wait for.
        if (typeof image.decode !== 'function') return Promise.resolve();
        return image.decode().catch((err: unknown) => console.warn('[cardtable] mode art did not decode; the card shows its name', url, err));
      }),
    ).then(() => undefined);
  }
  return decoded;
}
