/**
 * `launch.json` (`readLaunchRecord`, `local-jvm.ts`) and `jvm.json` (`readJvmRecord`, `host.ts`)
 * both survive a deploy and are read back to re-attach orphans — see `local-jvm.ts`'s module
 * header, "A JVM outlives its server". These decoders must still read a file today's code wrote
 * before this lane touched either file, so each fixture here is copied verbatim (`cp`, never
 * hand-typed) from a real run directory on this host:
 *
 *   fixtures/launch.sample.json  ~/.cache/cardtable-play-work/botgame-failover/h-18797c9fcd05/launch.json
 *   fixtures/jvm.sample.json     ~/.cache/cardtable-play-work/rt-allowed/h-b0bec7175f1d/jvm.json
 *
 * Neither names a person: `launch.json` carries only a host id, a pid and a timestamp; the
 * `jvm.json` sample is a scripted scenario match (seats "A"/"B", `owners: [null, null]`, a
 * `scenario` string of card names, no account id, display name or filesystem path) — checked by
 * hand before this file was added. Nothing here was scrubbed because nothing needed it.
 *
 * Each decoder reads `"<dir>/launch.json"` / `"<dir>/jvm.json"` by that exact name, so the
 * fixture is copied into a fresh temp dir under that name before the decoder runs: this exercises
 * the decoder's own file read, not just `JSON.parse` on the fixture's text.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { readJvmRecord } from './host.ts';
import { LAUNCH_RECORD_FILE, readLaunchRecord } from './local-jvm.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, 'fixtures', name);

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh run dir holding one fixture under its real on-disk name. */
function stageFixture(fixtureName: string, realName: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'decode-old-'));
	made.push(dir);
	copyFileSync(fixture(fixtureName), join(dir, realName));
	return dir;
}

describe('readLaunchRecord decodes a real launch.json', () => {
	it('reads hostId, pid and startedAt from the file as a server wrote it', () => {
		const dir = stageFixture('launch.sample.json', LAUNCH_RECORD_FILE);
		expect(readLaunchRecord(dir)).toEqual({ hostId: 'h-18797c9fcd05', pid: 371105, startedAt: '2026-11-09T14:14:56.323Z' });
	});
});

describe('readJvmRecord decodes a real jvm.json', () => {
	it('reads the match, its seats and its owners from the file as a server wrote it', () => {
		const dir = stageFixture('jvm.sample.json', 'jvm.json');
		const record = readJvmRecord(dir);
		expect(record?.hostId).toBe('h-b0bec7175f1d');
		expect(record?.startedAt).toBe('2026-11-06T00:19:15.684Z');
		expect(record?.matches).toHaveLength(1);
		const match = record?.matches[0];
		expect(match?.matchId).toBe('m-3fdac6ff0bb1');
		expect(match?.owners).toEqual([null, null]);
		expect(match?.spec.seats.map((s: { name: string }) => s.name)).toEqual(['A', 'B']);
		// `checkpoint` is opaque and absent on a record written before checkpoints existed decodes
		// as null, never dropped.
		expect(match?.checkpoint).toBeNull();
		// `snapshot` was written by this same real server (it is in the fixture's own JSON, above)
		// but never read back until now.
		expect(match?.snapshot).toEqual({ turn: 10, state: expect.stringContaining('turn=10\nactiveplayer=p1') });
	});

	/**
	 * A file whose server DID write a checkpoint decodes it through, opaque to this file — never
	 * `JSON.parse`d or shape-checked here, since only the game that wrote it knows its shape. Added
	 * onto a COPY of the real fixture, never hand-typed, so the rest of the match is still real.
	 */
	it('decodes a checkpoint a server actually wrote, opaque, whatever shape it is', () => {
		const dir = stageFixture('jvm.sample.json', 'jvm.json');
		const raw = JSON.parse(readFileSync(join(dir, 'jvm.json'), 'utf8')) as { matches: Record<string, unknown>[] };
		raw.matches[0]!.checkpoint = { score: [2, 1] };
		writeFileSync(join(dir, 'jvm.json'), JSON.stringify(raw));
		const record = readJvmRecord(dir);
		expect(record?.matches[0]?.checkpoint).toEqual({ score: [2, 1] });
	});

	/**
	 * A `snapshot` that is not the shape `TurnSnapshot` ever is (Forge never writes anything else
	 * there, but a hand-edited or corrupted file might) is dropped, not thrown on or passed through
	 * malformed — the same fallback-not-crash contract `epoch`/`owners` already have.
	 */
	it('drops a snapshot that is not shaped like one, rather than passing it through malformed', () => {
		const dir = stageFixture('jvm.sample.json', 'jvm.json');
		const raw = JSON.parse(readFileSync(join(dir, 'jvm.json'), 'utf8')) as { matches: Record<string, unknown>[] };
		raw.matches[0]!.snapshot = { turn: 'ten', state: 123 };
		writeFileSync(join(dir, 'jvm.json'), JSON.stringify(raw));
		const record = readJvmRecord(dir);
		expect(record?.matches[0]?.snapshot).toBeUndefined();
	});

	/**
	 * w103 §H step 2 — the field-drop mutation w101-R couldn't run: `epoch` and `owners` absent
	 * entirely, as a file older than either field (or one `JSON.stringify` dropped them from —
	 * `undefined` never survives a round trip) would read back. Dropped from a COPY of the real
	 * fixture, never hand-typed, so the rest of the match (its spec, its seats) is still real.
	 * `readJvmRecord`'s own fallbacks (`epoch: typeof m.epoch === 'string' ? m.epoch : null`,
	 * `owners: Array.isArray(m.owners) ? … : []`) are what this proves: break either — require the
	 * field instead of falling back — and this goes red; restore it and it is green again. Counts
	 * from that check (§H step 2's report): 1 test, 1 assertion red on the mutation (`owners`
	 * required), the same on `epoch`'s; both green restored, with the other 66 `host.test.ts` cases
	 * (¬ this file) untouched either way.
	 */
	it('decodes a match with no epoch and no owners — a file older than Durable — as unremembered, not dropped', () => {
		const dir = stageFixture('jvm.sample.json', 'jvm.json');
		const raw = JSON.parse(readFileSync(join(dir, 'jvm.json'), 'utf8')) as { matches: Record<string, unknown>[] };
		delete raw.matches[0]!.epoch;
		delete raw.matches[0]!.owners;
		writeFileSync(join(dir, 'jvm.json'), JSON.stringify(raw));
		const record = readJvmRecord(dir);
		expect(record?.matches).toHaveLength(1);
		const match = record?.matches[0];
		expect(match?.matchId).toBe('m-3fdac6ff0bb1');
		expect(match?.epoch).toBeNull();
		expect(match?.owners).toEqual([]);
		expect(match?.checkpoint).toBeNull();
	});
});
