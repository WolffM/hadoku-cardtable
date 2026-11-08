/**
 * What a person looks like beyond their character: the avatar picture they
 * chose (Discord, Steam or an upload) and the cosmetics they wear.
 *
 * The operator, 2026-11-05: *"picture/character are the same thing and all
 * over the entire site it's the same avatar. we must display all
 * customizations everywhere."* So a look rides beside `avatarId` on every wire
 * that carries a face, and every face and name draws it.
 *
 * The server resolves it from prefs-api (`apps/server/src/people.ts`), which
 * only ever serves what a person owns. This schema guards the shape so one bad
 * field costs that field, never the face or the list it sits in; the browser
 * runs `cleanWorn` from `@wolffm/prefs-client/cosmetics` before drawing, which
 * drops ids its catalogue does not know.
 */

import { z } from 'zod';

/** A cosmetic id, `<slot>.<name>` (`COSMETIC_ID_PATTERN`'s shape, bounded). */
const cosmeticId = z.string().regex(/^[a-z]+\.[a-z0-9-]+$/).max(64).optional().catch(undefined);

const PlacementSchema = z.object({
  x: z.number(),
  y: z.number(),
  r: z.number(),
  s: z.number(),
  flip: z.boolean(),
  back: z.boolean(),
});

export const WornSchema = z.object({
  effect: cosmeticId,
  gradient: cosmeticId,
  font: cosmeticId,
  overlay: cosmeticId,
  message: cosmeticId,
  placement: PlacementSchema.optional().catch(undefined),
});

/** The longest picture URL a look carries: Discord's and Steam's CDN paths are well under it. */
export const LOOK_PICTURE_MAX = 2048;

export const LookSchema = z.object({
  /** An https image, square, drawn instead of the character's portrait. Absent: the character is the picture. */
  picture: z.url({ protocol: /^https$/ }).max(LOOK_PICTURE_MAX).optional().catch(undefined),
  /** What they wear. Absent when nothing is. */
  cosmetics: WornSchema.optional().catch(undefined),
});
export type Look = z.infer<typeof LookSchema>;

/**
 * A person in a record of the past (a tournament, a replay), as the server draws them when the
 * record is shown: their character and their look, looked up then (R12), never kept with the record.
 */
export const PersonFaceSchema = z.object({
  avatarId: z.string().trim().min(1).max(32).optional().catch(undefined),
  look: LookSchema.optional().catch(undefined),
});
export type PersonFace = z.infer<typeof PersonFaceSchema>;
export type Worn = z.infer<typeof WornSchema>;

const WORN_KEYS = ['effect', 'gradient', 'font', 'overlay', 'message', 'placement'] as const;

/** Only the keys that hold something, always in one order, so two copies of one look compare equal. */
function wornOrNone(worn: Worn | undefined): Worn | undefined {
  if (worn === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of WORN_KEYS) {
    const v = worn[k];
    if (v === undefined) continue;
    out[k] = k === 'placement' ? { x: worn.placement!.x, y: worn.placement!.y, r: worn.placement!.r, s: worn.placement!.s, flip: worn.placement!.flip, back: worn.placement!.back } : v;
  }
  return Object.keys(out).length === 0 ? undefined : (out as Worn);
}

/** A look with nothing in it is no look: one `=== undefined` for every reader. */
export function lookOrNone(look: Look | null | undefined): Look | undefined {
  if (look === null || look === undefined) return undefined;
  const worn = wornOrNone(look.cosmetics);
  if (look.picture === undefined && worn === undefined) return undefined;
  return { ...(look.picture === undefined ? {} : { picture: look.picture }), ...(worn === undefined ? {} : { cosmetics: worn }) };
}

/** Whether two looks draw the same. */
export function sameLook(a: Look | undefined, b: Look | undefined): boolean {
  return JSON.stringify(lookOrNone(a) ?? null) === JSON.stringify(lookOrNone(b) ?? null);
}
