/**
 * What an external game says about itself: the one file a game publishes beside its embed entry,
 * `manifest.json`, which a host reads to make that game a room type. The game owns these facts
 * (its name, how many players it takes, how long it holds a dropped seat); the host owns
 * everything else about it (whether it is hosted at all, who may play it, where its bundle lives),
 * and nothing in a manifest can change those.
 *
 * Written by `@hadoku/ui-shell/embed/vite`'s `embedBuild({ manifest })`, or by hand beside an
 * embed built some other way; read by a host's server, which validates it with this schema and
 * keeps the last good copy. Unknown keys are dropped, not refused, so a game can publish a field
 * a host learns to read later.
 */
import { z } from 'zod';

/** The manifest's file name, in the same directory as the embed entry it describes. */
export const EXTERNAL_GAME_MANIFEST_FILE = 'manifest.json';

/** The most seats any external game's room takes: a host's own ceiling, whatever a manifest asks. */
export const EXTERNAL_GAME_MAX_SEATS = 16;

/** How long a dropped seat is held when a manifest names no hold of its own. */
export const DEFAULT_SEAT_REJOIN_GRACE_MS = 120_000;

/** The longest hold a manifest may ask for. */
export const MAX_SEAT_REJOIN_GRACE_MS = 10 * 60_000;

const seatCount = z.number().int().min(1).max(EXTERNAL_GAME_MAX_SEATS);

export const externalGameManifest = z.object({
	/** The game's name, as a host's Create room form offers it. */
	label: z.string().trim().min(1).max(40),
	/** Fewest and most seated players a match plays with. One is a solo game (against the game's own bots, say). */
	seats: z.object({ min: seatCount, max: seatCount }).refine((s) => s.min <= s.max, { message: 'seats.min is more than seats.max' }),
	/** How long a dropped seat is held for its player to come back. */
	seatRejoinGraceMs: z.number().int().min(0).max(MAX_SEAT_REJOIN_GRACE_MS).default(DEFAULT_SEAT_REJOIN_GRACE_MS),
});

/** A manifest as a game writes it (the hold may be left out). */
export type ExternalGameManifestInput = z.input<typeof externalGameManifest>;
/** A manifest as a host reads it, every default applied. */
export type ExternalGameManifest = z.output<typeof externalGameManifest>;

/** The manifest's path for an embed entry's path: the same directory, `manifest.json`. */
export function manifestPathOf(embedSrc: string): string {
	const slash = embedSrc.lastIndexOf('/');
	return `${embedSrc.slice(0, slash + 1)}${EXTERNAL_GAME_MANIFEST_FILE}`;
}
