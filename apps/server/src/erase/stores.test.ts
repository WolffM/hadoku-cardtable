import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openEvents } from '../room/events.ts';
import { placeholderId, replaceIds } from './anonymise.ts';
import { personOf } from './index.ts';
import { legacyIdsStep } from './legacy-ids.ts';
import { recordingsStep } from './recordings.ts';
import { UNNAMED } from '../room/constants.ts';

const IDS = new Set(['fk:alice', 'uid-alice']);
const TO = 'erased:0a1b2c3d';
const temp = (): string => mkdtempSync(join(tmpdir(), 'erase-stores-'));

describe('replaceIds', () => {
	it('replaces an id as a value, an element, a key, a Map key and value, and a Set member, and counts each', () => {
		const shared = { by: 'fk:alice' };
		const value = {
			creator: 'fk:alice',
			other: 'fk:bob',
			list: ['uid-alice', 'fk:bob', null, 3],
			byId: { 'fk:alice': 'Alice', 'fk:bob': 'Bob' },
			map: new Map<string, unknown>([['fk:alice', 'uid-alice']]),
			set: new Set(['fk:alice', 'fk:bob']),
			twice: [shared, shared],
			fn: () => 'fk:alice',
		};
		expect(replaceIds(value, IDS, TO)).toBe(7);
		expect(value.creator).toBe(TO);
		expect(value.other).toBe('fk:bob');
		expect(value.list).toEqual([TO, 'fk:bob', null, 3]);
		expect(value.byId).toEqual({ 'fk:bob': 'Bob', [TO]: 'Alice' });
		expect([...value.map]).toEqual([[TO, TO]]);
		expect([...value.set].sort()).toEqual([TO, 'fk:bob'].sort());
		expect(shared.by).toBe(TO);
		expect(replaceIds(value, IDS, TO)).toBe(0);
	});

	it('writes nothing it does not change, so a shared frozen constant is safe to walk past', () => {
		const constant = Object.freeze({ on: false, rounds: Object.freeze(['cube']) });
		const room = { settings: constant, leader: 'fk:alice' };
		expect(replaceIds(room, IDS, TO)).toBe(1);
		expect(room.settings).toBe(constant);
	});

	it('mints a fresh placeholder per erase, and a person keeps one within an erase', () => {
		expect(placeholderId()).toMatch(/^erased:[0-9a-f]{8}$/);
		expect(placeholderId()).not.toBe(placeholderId());
		const person = personOf('uid-alice');
		expect([...person.ids]).toEqual(['uid-alice', person.participantId]);
	});
});

describe('account erase in the events', () => {
	it('keeps the event and the form, credits them to the placeholder with no name, and saves before answering', async () => {
		const file = join(temp(), 'events.json');
		const now = Date.now();
		const events = await openEvents(file, () => {}, () => now);
		events.create({ roomId: 'r-1', startsAt: now + 60_000, organizerId: 'fk:alice', organizerName: 'Alice' }, now);
		events.create({ roomId: 'r-2', startsAt: now + 60_000, organizerId: 'fk:bob', organizerName: 'Bob' }, now);
		events.attachForm({ formId: 'f-1', attachedById: 'fk:alice', attachedByName: 'Alice' }, now);

		expect(await events.anonymise(IDS, TO)).toEqual({ events: 1, forms: 1 });
		const saved = readFileSync(file, 'utf8');
		expect(saved).not.toContain('fk:alice');
		expect(saved).not.toContain('Alice');
		const parsed = JSON.parse(saved) as { events: { roomId: string; organizerId: string; organizerName: string }[]; forms: { attachedById: string; attachedByName: string }[] };
		expect(parsed.events.find((e) => e.roomId === 'r-1')).toMatchObject({ organizerId: TO, organizerName: '' });
		expect(parsed.events.find((e) => e.roomId === 'r-2')).toMatchObject({ organizerId: 'fk:bob', organizerName: 'Bob' });
		expect(parsed.forms).toEqual([expect.objectContaining({ attachedById: TO, attachedByName: '' })]);
		expect(await events.anonymise(IDS, 'erased:ffffffff')).toEqual({ events: 0, forms: 0 });
	});

	it('fails rather than answering counts it could not save', async () => {
		const dir = temp();
		const now = Date.now();
		// The store's file sits under a FILE, so its directory can never be made.
		writeFileSync(join(dir, 'blocked'), '');
		const events = await openEvents(join(dir, 'blocked', 'events.json'), () => {}, () => now);
		events.create({ roomId: 'r-1', startsAt: now + 60_000, organizerId: 'fk:alice', organizerName: 'Alice' }, now);
		await expect(events.anonymise(IDS, TO)).rejects.toThrow(/not saved/);
	});
});

describe('account erase in the R12 remap record', () => {
	it("removes the person's entries, keeps everyone else's, and is fine with no file", async () => {
		const file = join(temp(), 'legacy-ids.done.json');
		const step = legacyIdsStep(file);
		const person = personOf('uid-alice');
		expect(await step.erase(person)).toBe(0);
		expect(existsSync(file)).toBe(false);

		writeFileSync(file, JSON.stringify({ 'fk:old1': 'uid-alice', 'fk:old2': 'uid-bob', 'fk:old3': 'uid-alice' }));
		expect(await step.erase(person)).toBe(2);
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'fk:old2': 'uid-bob' });
		expect(await step.erase(person)).toBe(0);
	});
});

describe('account erase in the match recordings', () => {
	const gz = (lines: unknown[]): Buffer => gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
	const read = (path: string): string => gunzipSync(readFileSync(path)).toString('utf8');

	it("drops the seat's userId and plays it under the unnamed word in both files, keeping each file's age", async () => {
		const dir = temp();
		const pub = join(dir, 'm-000000000001.public.jsonl.gz');
		const act = join(dir, 'm-000000000001.actions.jsonl.gz');
		writeFileSync(pub, gz([{ t: 'header', players: ['Alice', 'Bob'] }, { t: 'env', env: { players: [{ name: 'Alice' }, { name: 'Bob' }] } }, { t: 'end', seats: [{ seat: 0, userId: 'uid-alice' }, { seat: 1, userId: 'uid-bob' }] }]));
		writeFileSync(act, gz([{ t: 'header', spec: { seats: [{ name: 'Alice' }, { name: 'Bob' }] } }]));
		// One from before seats kept a userId: nothing in it can be matched.
		const old = join(dir, 'm-000000000002.public.jsonl.gz');
		writeFileSync(old, gz([{ t: 'header', players: ['Alice', 'Bob'] }, { t: 'end' }]));
		const aged = new Date('2026-11-01T00:00:00Z');
		for (const f of [pub, act, old]) utimesSync(f, aged, aged);

		const step = recordingsStep(dir);
		const person = personOf('uid-alice');
		expect(await step.erase(person)).toBe(1);
		for (const f of [pub, act]) {
			expect(read(f)).not.toContain('Alice');
			expect(read(f)).toContain(`"${UNNAMED}"`);
			expect(read(f)).toContain('Bob');
			expect(statSync(f).mtime).toEqual(aged);
		}
		expect(read(pub)).not.toContain('uid-alice');
		expect(read(pub)).toContain('uid-bob');
		expect(read(old)).toContain('Alice');
		expect(await step.erase(person)).toBe(0);
	});

	it('matches an action log whose public stream has aged out, by its end line\'s by-seat users', async () => {
		const dir = temp();
		const act = join(dir, 'm-000000000003.actions.jsonl.gz');
		writeFileSync(act, gz([{ t: 'header', spec: { seats: [{ name: 'Bob' }, { name: 'Alice' }] } }, { t: 'end', users: ['uid-bob', 'uid-alice'] }]));
		const step = recordingsStep(dir);
		expect(await step.erase(personOf('uid-alice'))).toBe(1);
		const lines = read(act).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(lines).toEqual([{ t: 'header', spec: { seats: [{ name: 'Bob' }, { name: UNNAMED }] } }, { t: 'end', users: ['uid-bob', null] }]);
		expect(await step.erase(personOf('uid-alice'))).toBe(0);
	});

	it('parses only a recording whose text holds the userId, so the rest of the archive costs a substring search', async () => {
		const dir = temp();
		// Not JSON at all: parsing it would throw. It does not hold the userId, so it is never parsed.
		writeFileSync(join(dir, 'm-000000000004.public.jsonl.gz'), gzipSync(Buffer.from('not json\n')));
		const pub = join(dir, 'm-000000000005.public.jsonl.gz');
		writeFileSync(pub, gz([{ t: 'header', players: ['Alice'] }, { t: 'end', seats: [{ seat: 0, userId: 'uid-alice' }] }]));
		expect(await recordingsStep(dir).erase(personOf('uid-alice'))).toBe(1);
		expect(read(pub)).not.toContain('uid-alice');
		// The garbage file is untouched, and a person it does not name passes it by.
		expect(read(join(dir, 'm-000000000004.public.jsonl.gz'))).toBe('not json\n');
	});

	it('a missing recordings dir is nothing to erase; an unreadable one fails the erase rather than answering 0', async () => {
		expect(await recordingsStep(join(temp(), 'never-made')).erase(personOf('uid-alice'))).toBe(0);
		const file = join(temp(), 'a-file');
		writeFileSync(file, '');
		await expect(recordingsStep(file).erase(personOf('uid-alice'))).rejects.toThrow(/ENOTDIR/);
	});
});
