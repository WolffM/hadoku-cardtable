/**
 * ONE-OFF, delete after the release that carries it (cardtable#25): moves the participant ids prod
 * minted from keys (`hadoku.cardtable.participant.v1`, `{ friendKey }`) onto the ids it mints from the
 * userId now (`identity.ts`), in the few files that name a person by id outside room-store.
 *
 * The operator, 2026-11-01: *"you can clear the old data. but please dont clear the win/loss results
 * if possible"*, and *"just assign them to me"* for the ones nobody could name. Win/loss itself is
 * already safe under userIds in prefs-api's `_games`; this keeps cardtable's own copies (past
 * tournaments, a cube's importer, a preset's or an event form's author) pointing at the same people.
 *
 * Driven by `<dataDir>/legacy-ids.json`: `{ "fk:<old>": "<userId>", … }`, written by hand before the
 * release from each tournament's own `names` map, resolved through `/session/identity/resolve` and
 * checked against `_games` (no key is read). Absent: nothing happens. Applied: renamed to
 * `legacy-ids.done.json`, so a second boot does nothing. The rooms and pods those ids filled were
 * already reset by `STORE_VERSION` 2 (v0.44.0).
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveParticipantId } from './room/identity.js';

/** A JSON value with every string and object key found in `ids` replaced by its new id. */
function remap(value: unknown, ids: ReadonlyMap<string, string>): unknown {
	if (typeof value === 'string') return ids.get(value) ?? value;
	if (Array.isArray(value)) return value.map((v) => remap(v, ids));
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.get(k) ?? k, remap(v, ids)]));
	}
	return value;
}

/** Before anything opens these files. */
export function remapLegacyIds(dataDir: string, log: (entry: Record<string, unknown>) => void): void {
	const mapFile = join(dataDir, 'legacy-ids.json');
	if (!existsSync(mapFile)) return;
	const toUser = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, string>;
	const ids = new Map(Object.entries(toUser).map(([old, userId]) => [old, deriveParticipantId({ accountId: userId, socketId: '' })]));
	const cubes = join(dataDir, 'cubes');
	const files = [
		join(dataDir, 'tournaments.json'),
		join(dataDir, 'presets.json'),
		join(dataDir, 'events.json'),
		...(existsSync(cubes) ? readdirSync(cubes).filter((f) => f.endsWith('.json')).map((f) => join(cubes, f)) : []),
	];
	for (const file of files) {
		if (!existsSync(file)) continue;
		const before = readFileSync(file, 'utf8');
		const after = JSON.stringify(remap(JSON.parse(before), ids));
		if (after !== JSON.stringify(JSON.parse(before))) writeFileSync(file, after);
	}
	renameSync(mapFile, join(dataDir, 'legacy-ids.done.json'));
	log({ event: 'legacy-ids-remapped', ids: ids.size, files: files.length });
}

