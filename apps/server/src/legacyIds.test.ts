/** The one-off move of key-derived ids onto userId-derived ones (`legacyIds.ts`). */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { remapLegacyIds } from './legacyIds.ts';
import { identityFromHeaders } from './room/identity.ts';

const OLD = 'fk:4372dd7678a183d8';
const STRANGER = 'fk:9999999999999999';
const USER = 'de5c2a05-573f-4b26-a27f-705bb604fd69';
const NEW = identityFromHeaders({ 'x-user-id': USER }, 'unused');

function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cardtable-legacy-ids-'));
	mkdirSync(join(dir, 'cubes'));
	writeFileSync(join(dir, 'tournaments.json'), JSON.stringify([{ id: 't1', names: { [OLD]: 'Hadoku', ai: 'AI' }, standings: [{ id: OLD }], results: [{ playerA: OLD, playerB: 'ai' }] }]));
	writeFileSync(join(dir, 'presets.json'), JSON.stringify({ presets: [{ id: 'p1', createdBy: OLD }, { id: 'p2', createdBy: STRANGER }] }));
	writeFileSync(join(dir, 'events.json'), JSON.stringify({ events: [{ attachedById: OLD }] }));
	writeFileSync(join(dir, 'cubes', 'c.json'), JSON.stringify({ id: 'c', importedBy: OLD }));
	return dir;
}

const read = (dir: string, f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'));

describe('remapLegacyIds', () => {
	it('moves every mapped id, as a value or a key, onto the userId-derived one; leaves the rest; runs once', () => {
		const dir = dataDir();
		writeFileSync(join(dir, 'legacy-ids.json'), JSON.stringify({ [OLD]: USER }));
		const logged: Record<string, unknown>[] = [];
		remapLegacyIds(dir, (e) => logged.push(e));
		expect(read(dir, 'tournaments.json')).toEqual([{ id: 't1', names: { [NEW]: 'Hadoku', ai: 'AI' }, standings: [{ id: NEW }], results: [{ playerA: NEW, playerB: 'ai' }] }]);
		expect(read(dir, 'presets.json')).toEqual({ presets: [{ id: 'p1', createdBy: NEW }, { id: 'p2', createdBy: STRANGER }] });
		expect(read(dir, 'events.json')).toEqual({ events: [{ attachedById: NEW }] });
		expect(read(dir, 'cubes/c.json')).toEqual({ id: 'c', importedBy: NEW });
		expect(existsSync(join(dir, 'legacy-ids.json'))).toBe(false);
		expect(existsSync(join(dir, 'legacy-ids.done.json'))).toBe(true);
		expect(logged).toEqual([{ event: 'legacy-ids-remapped', ids: 1, files: 4 }]);
		remapLegacyIds(dir, () => undefined);
		expect(read(dir, 'presets.json')).toEqual({ presets: [{ id: 'p1', createdBy: NEW }, { id: 'p2', createdBy: STRANGER }] });
	});

	it('does nothing without a map', () => {
		const dir = dataDir();
		remapLegacyIds(dir, () => undefined);
		expect(read(dir, 'presets.json')).toEqual({ presets: [{ id: 'p1', createdBy: OLD }, { id: 'p2', createdBy: STRANGER }] });
	});

});
