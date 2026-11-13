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
