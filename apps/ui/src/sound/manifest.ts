/*
 * Where a cue's audio comes from — as a lookup, not as a URL.
 *
 * This is `packages/carddata/src/art/index.ts` applied to sound, on purpose and
 * almost line for line. Go and read that file's header: every argument it makes
 * holds here, because the situation is identical. The operator has no audio
 * assets yet, will source them later, and must be able to repoint one cue
 * without a code change:
 *
 *   manifest row  →  { source, key }  →  resolveCueUrl  →  a URL
 *   no row        →  null             →  the synthesised envelope in cues.ts
 *
 * So there is no list of URLs anywhere in this module, and there is no
 * `new Audio('/sounds/click.mp3')` in a component. Giving `select` a real sound
 * is one row in `cue-manifest.json`.
 *
 * ## Why we reuse the art resolver's key rules rather than restate them
 *
 * `cdnUrlFor`, `isCdnKey` and `CDN_BASE` are imported from `@hadoku/carddata/art`.
 * A CDN key is a CDN key whatever bytes are behind it — the SHA-256 of the object
 * plus an extension — and the hostname is expected to move one day, which is
 * precisely why that file keeps it in one constant. A second copy of the pattern
 * and a second copy of the hostname here would be two things to migrate instead
 * of one, and they would drift.
 *
 * What we do NOT reuse is `resolveArtUrl` itself: its fallback for an unknown id
 * is Scryfall, and Scryfall does not serve audio. A cue with no usable row falls
 * back to **synthesis**, which is expressed as `null`.
 *
 * ## No audio bytes in this repo
 *
 * `.gitignore` refuses `*.jpg`/`*.png` for images and the reason given in
 * `CLAUDE.md` for keeping them out of the bundle — *"a 5.85 MB inlined PNG is a
 * performance bug"* — is a size argument, not a copyright one, and it applies
 * unchanged to a directory of `.ogg` files. So audio lives on the CDN too. This
 * is a decision recorded rather than a rule inherited: nothing in `CLAUDE.md`
 * mentions audio, and D18 no longer restricts which host serves media. If the
 * operator would rather ship a handful of small files from the app's own origin,
 * that is a new `case` in the switch below plus manifest rows — nothing else.
 */

import { CDN_BASE, cdnUrlFor, isCdnKey } from '@hadoku/carddata/art';

import cueManifestFile from './cue-manifest.json';
import type { Cue } from './cues.ts';

/** Where a cue's audio is stored. A new source is a new member plus a new `case`. */
export type CueSource = 'cdn';

/**
 * One cue's audio assignment.
 *
 * `key` is the CDN key: the SHA-256 of the bytes plus an extension. A row
 * without a well-formed key names no object, so it resolves the same way an
 * absent row does — see `resolveCueUrl`.
 */
export interface CueEntry {
  readonly source: CueSource;
  readonly key?: string;
}

/** cue name -> entry. A cue with no row is not an error; it synthesises. */
export type CueManifest = Readonly<Partial<Record<Cue, CueEntry>>>;

/**
 * The shape of the committed `cue-manifest.json`.
 *
 * `version` exists so a future format change is detectable rather than silently
 * misread, exactly as in the art manifest. Nothing switches on it yet.
 */
export interface CueManifestFile {
  readonly version: 1;
  /** Human note in the committed file. Carried so the type matches the file. */
  readonly note?: string;
  readonly entries: CueManifest;
}

/** The committed manifest. Empty today; every cue synthesises. */
export const CUE_MANIFEST: CueManifestFile = cueManifestFile as CueManifestFile;

/**
 * Resolve a cue's audio URL, or `null` when there is none to build.
 *
 * `null` is not a failure — it is the instruction *"synthesise this one"*, which
 * is what every cue does today. Three cases, each pinned by a test:
 *
 * 1. a `cdn` row with a well-formed key → `${cdnBase}/${key}`;
 * 2. no row at all → `null`, and the sink plays the envelope;
 * 3. a row this build does not understand, or a `cdn` row whose key is missing,
 *    empty or malformed → also `null`.
 *
 * Case 3 takes the same answer as case 2 for the reason the art resolver gives
 * at length: the manifest is hand-edited data, a typo in `source` or a row
 * written ahead of the upload that would fill in its key carries no information,
 * and one rule beats two. Here the degradation is even gentler than it is for
 * art — a bad row costs you a placeholder beep, not a blank card.
 *
 * It must never throw. A malformed manifest silencing the app would be a worse
 * bug than the one it was trying to report.
 */
export function resolveCueUrl(
  cue: Cue,
  manifest: CueManifest,
  options?: { readonly cdnBase?: string },
): string | null {
  const entry = manifest[cue];
  if (entry == null) return null;

  // Read `source` as a plain string on purpose: the manifest is JSON on disk, so
  // its declared type is a claim about what we intend to write, not a proof
  // about what is there, and a `default` arm TypeScript has narrowed to `never`
  // is an arm nobody maintains. Same reasoning as the art resolver's.
  const source: string = entry.source;
  switch (source) {
    case 'cdn': {
      const key = entry.key;
      if (!isCdnKey(key)) return null;
      return cdnUrlFor(key, options?.cdnBase ?? CDN_BASE);
    }
    default:
      return null;
  }
}

/** `resolveCueUrl` against the committed manifest. What `playCue` calls. */
export function cueUrl(cue: Cue): string | null {
  return resolveCueUrl(cue, CUE_MANIFEST.entries);
}
