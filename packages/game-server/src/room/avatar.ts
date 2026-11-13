/**
 * The one reading of an avatar id, in every direction. Generic to every room:
 * nothing here depends on a game type, a pod or a draft.
 *
 * `@wolffm/rooms-protocol` types it `avatarId?: string | null` (`RosterIdentity`,
 * `LocalIdentity`), so THREE states arrive — absent, explicitly null, a string —
 * and exactly TWO ever leave this file: a non-blank string, or absent. `null`,
 * `''`, whitespace, an over-long value and anything that is not a string all
 * collapse to absent, because to whoever is drawing a face they all mean the
 * same thing (draw the fallback) and a third state on the wire is a third branch
 * in every consumer for no new fact.
 *
 * An EMPTY STRING reaching a client is the specific bug this function exists to
 * stop. It survives a `!== undefined` check and then resolves to a sprite URL
 * ending `square_.png`, which is a 404 drawn as a broken image rather than the
 * fallback the absence would have produced.
 *
 * Split out of `room/lobby.ts` (wave 110 §L), importing `AVATAR_ID_MAX` straight
 * from the platform package that defines it rather than through `@hadoku/shared`'s
 * mixed barrel.
 */
import { AVATAR_ID_MAX } from '@hadoku/platform-wire/look';

export function avatarIdOf(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const trimmed = v.trim();
	return trimmed === '' || trimmed.length > AVATAR_ID_MAX ? undefined : trimmed;
}
