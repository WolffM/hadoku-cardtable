/*
 * The Discord mirror (`./discord-events.ts`) over a real events store on a temp dir, against a
 * loopback stand-in for ArchiveBot that keeps its rules (`./archivebot-events.testing.ts`). `service`
 * is a sample value, never cardtable's.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { standInArchivebot, type StandInArchivebot } from './archivebot-events.testing.ts';
import { DISCORD_EVENT_LENGTH_MS, DISCORD_REMIND_BEFORE_MS, discordEvents, type DiscordEventShape } from './discord-events.ts';
import { openEvents, type Events } from './events.ts';

const SECRET = 'test-secret';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const dirs: string[] = [];
const bots: StandInArchivebot[] = [];
afterEach(async () => {
	await Promise.all(bots.splice(0).map((b) => b.close()));
});
afterAll(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function harness(opts: { secret?: string } = {}) {
	const clock = { now: Date.UTC(2026, 10, 17, 12) };
	const now = () => clock.now;
	const dir = await mkdtemp(join(tmpdir(), 'discord-events-test-'));
	dirs.push(dir);
	const file = join(dir, 'events.json');
	const events: Events = await openEvents(file, () => {}, now);
	const bot = await standInArchivebot(SECRET, now);
	bots.push(bot);
	/** What each event's room says on Discord; null keeps it off. */
	const shapes = new Map<string, DiscordEventShape | null>();
	const logged: Record<string, unknown>[] = [];
	const mirror = discordEvents({
		service: 'myapp',
		secret: opts.secret ?? SECRET,
		archivebotUrl: bot.url,
		events,
		shape: async (e) => shapes.get(e.id) ?? null,
		log: (entry) => void logged.push(entry),
		now,
	});
	const make = (name: string, startsAt: number) => {
		const event = events.create({ roomId: `r-${name}`, startsAt, organizerId: 'm-alice', organizerUserId: 'u-alice' }, clock.now);
		shapes.set(event.id, { name, description: `${name}, organized by Alice.`, location: `hadoku.me/myapp/room/r-${name}` });
		return event;
	};
	return { clock, file, events, bot, shapes, logged, mirror, make };
}

describe('discordEvents', () => {
	it('makes one Discord event for a new event, with its name, start, a three-hour end, the room link and a reminder', async () => {
		const { bot, events, mirror, make, clock } = await harness();
		const event = make('Friday draft', clock.now + 2 * DAY);
		await mirror.sync(event.id);
		expect(bot.live()).toHaveLength(1);
		expect(bot.live()[0]).toMatchObject({
			name: 'Friday draft',
			startTime: new Date(event.startsAt).toISOString(),
			endTime: new Date(event.startsAt + DISCORD_EVENT_LENGTH_MS).toISOString(),
			description: 'Friday draft, organized by Alice.',
			location: 'hadoku.me/myapp/room/r-Friday draft',
			remindBeforeMs: DISCORD_REMIND_BEFORE_MS,
			sourceKey: `myapp-event-${event.id}`,
		});
		expect(events.get(event.id)?.discord?.eventId).toBe('d-1');
		// Nothing changed: a second sync, and a sweep, send nothing.
		const sent = bot.paths.length;
		await mirror.sync(event.id);
		await mirror.sweep();
		expect(bot.paths).toHaveLength(sent);
	});

	it('moves the Discord event with a reschedule, and back again, never making a second one', async () => {
		const { bot, events, mirror, make, clock } = await harness();
		const event = make('Cube night', clock.now + 2 * DAY);
		await mirror.sync(event.id);
		events.reschedule(event.id, 'm-alice', clock.now + 3 * DAY);
		await mirror.sync(event.id);
		expect(bot.live()).toMatchObject([{ eventId: 'd-1', startTime: new Date(clock.now + 3 * DAY).toISOString() }]);
		// Back to the first start: a key ArchiveBot has not applied last, so it is not dropped.
		events.reschedule(event.id, 'm-alice', clock.now + 2 * DAY);
		await mirror.sync(event.id);
		expect(bot.live()).toMatchObject([{ eventId: 'd-1', startTime: new Date(clock.now + 2 * DAY).toISOString() }]);
		expect(bot.made).toHaveLength(1);
	});

	it('a sweep picks up a room renamed with no call, and cancels the event of a room that closed', async () => {
		const { bot, mirror, make, shapes, clock, events } = await harness();
		const renamed = make('Old name', clock.now + DAY);
		const closing = make('Doomed', clock.now + DAY);
		await mirror.sweep();
		expect(bot.live().map((e) => e.name).sort()).toEqual(['Doomed', 'Old name']);
		shapes.set(renamed.id, { name: 'New name', description: 'New name, organized by Alice.', location: 'hadoku.me/myapp/room/r-Old name' });
		shapes.set(closing.id, null);
		await mirror.sweep();
		expect(bot.live().map((e) => e.name)).toEqual(['New name']);
		expect(events.get(closing.id)?.discord).toBeUndefined();
	});

	it("the organizer's cancel takes it off Discord", async () => {
		const { bot, events, mirror, make, clock } = await harness();
		const event = make('Cancelled', clock.now + DAY);
		await mirror.sync(event.id);
		const result = events.cancel(event.id, 'm-alice');
		expect(result.ok).toBe(true);
		if (result.ok) await mirror.cancel(result.event);
		expect(bot.live()).toEqual([]);
	});

	it('a cancel made while the create is still out leaves nothing on Discord', async () => {
		const { bot, events, mirror, make, clock } = await harness();
		const event = make('Quick change of plan', clock.now + DAY);
		const release = bot.holdCreates();
		const creating = mirror.sync(event.id);
		await vi.waitFor(() => expect(bot.paths).toContain('/api/events/create'));
		const result = events.cancel(event.id, 'm-alice');
		if (!result.ok) throw new Error('cancel refused');
		expect(result.event.discord).toBeUndefined();
		const cancelling = mirror.cancel(result.event);
		release();
		await Promise.all([creating, cancelling]);
		expect(bot.made).toHaveLength(1);
		expect(bot.live()).toEqual([]);
	});

	it('an event someone deleted in Discord is made afresh on its next change', async () => {
		const { bot, events, mirror, make, clock } = await harness();
		const event = make('Deleted by hand', clock.now + 2 * DAY);
		await mirror.sync(event.id);
		bot.deleteByHand('d-1');
		events.reschedule(event.id, 'm-alice', clock.now + 3 * DAY);
		await mirror.sync(event.id);
		expect(bot.live()).toMatchObject([{ eventId: 'd-2', startTime: new Date(clock.now + 3 * DAY).toISOString() }]);
		expect(events.get(event.id)?.discord?.eventId).toBe('d-2');
	});

	it('a create ArchiveBot did not take is logged, and the next sweep makes it', async () => {
		const { bot, events, mirror, make, clock, logged } = await harness();
		const event = make('Outage', clock.now + DAY);
		bot.down = true;
		await mirror.sync(event.id);
		expect(bot.made).toEqual([]);
		expect(logged).toContainEqual(expect.objectContaining({ event: 'discord-event', outcome: 'failed', act: 'create', id: event.id, status: 503 }));
		bot.down = false;
		await mirror.sweep();
		expect(bot.live()).toHaveLength(1);
		expect(events.get(event.id)?.discord?.eventId).toBe('d-1');
	});

	it('what Discord holds survives a restart, so the reopened store updates rather than duplicates', async () => {
		const { mirror, make, clock, file } = await harness();
		const event = make('Restart', clock.now + DAY);
		await mirror.sync(event.id);
		// The store writes behind the change: read it back as a boot would, once that write lands.
		await vi.waitFor(async () => {
			const reopened = await openEvents(file, () => {}, () => clock.now);
			expect(reopened.get(event.id)?.discord?.eventId).toBe('d-1');
		});
	});

	it('leaves alone an event whose start has passed or is about to', async () => {
		const { bot, mirror, make, clock } = await harness();
		const event = make('Too soon', clock.now + 30_000);
		await mirror.sync(event.id);
		expect(bot.paths).toEqual([]);
	});

	it('does nothing at all without the secret', async () => {
		const { bot, mirror, make, clock } = await harness({ secret: '' });
		const event = make('No secret', clock.now + DAY);
		await mirror.sync(event.id);
		await mirror.sweep();
		expect(bot.paths).toEqual([]);
	});
});
