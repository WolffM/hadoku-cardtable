import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openEvents } from '../room/events.ts';
import { placeholderId, replaceIds } from './anonymise.ts';
import { personOf } from './index.ts';
import { legacyIdsStep } from './legacy-ids.ts';

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
