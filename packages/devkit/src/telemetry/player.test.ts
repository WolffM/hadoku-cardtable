import { describe, expect, it } from 'vitest';

import { fold, idsForName, renderVisit, visit } from './player.ts';
import type { Event, Row } from './watch.ts';

const ALICE = '980bdcb9-ac07-4470-9cd7-7081698f9ec8';
const BOB = '6d8f7b5d-2384-473a-a2a7-47d9a4106411';

const row = (timestamp: string, method: string, path: string, status: number, user = ALICE): Row => ({
	timestamp,
	method,
	path,
	status,
	backend: 'tunnel',
	user_id: user,
	user_type: 'guest',
	ip_address: null,
	user_agent: 'Mozilla/5.0',
	country: 'US',
});
const event = (timestamp: string, name: string, context: Record<string, unknown>, level = 'info'): Event => ({
	timestamp,
	event: name,
	level,
	context_json: JSON.stringify(context),
});

describe('player', () => {
	const events = [
		event('2026-11-21T06:45:00.000Z', 'usage-user', {
			from: '2026-11-21T06:40:00.000Z',
			userId: ALICE,
			name: 'Player 80583',
			tier: 'guest',
			trail: ['06:40:48 view room', '06:41:20 click room pick', '06:41:30 click room pick'],
		}),
		event('2026-11-21T06:45:00.000Z', 'usage-user', { from: '2026-11-21T06:40:00.000Z', userId: BOB, name: 'ohmusama', tier: 'friend', trail: ['06:41:00 click room pick'] }),
		event('2026-11-21T07:07:49.000Z', 'costly-act', { act: 'match-start', userId: ALICE }),
		event('2026-11-21T07:37:03.500Z', 'rate-limited', { act: 'match-start', userId: ALICE }, 'warn'),
	];
	const rows = [
		row('2026-11-21T06:40:48.000Z', 'POST', '/cardtable/api/rooms/r-15bc7e47c9b1/join', 200),
		row('2026-11-21T06:41:00.000Z', 'POST', '/cardtable/api/usage', 204),
		row('2026-11-21T06:41:05.000Z', 'GET', '/prefs/api/v1/cardtable-play', 200),
		row('2026-11-21T07:37:03.000Z', 'POST', '/cardtable/api/tables/rooms/r-15bc7e47c9b1/ready', 404),
		row('2026-11-21T07:37:13.000Z', 'POST', '/cardtable/api/tables/rooms/r-15bc7e47c9b1/ready', 404),
		row('2026-11-21T07:38:00.000Z', 'GET', '/cardtable/api/rooms', 200, BOB),
	];

	it('finds an account by the name its trail recorded, case-insensitively', () => {
		expect(idsForName(events, 'player 80583')).toEqual([ALICE]);
		expect(idsForName(events, 'nobody')).toEqual([]);
	});

	it("merges one person's requests, trail and events in time order, folding background chatter and repeats", () => {
		const v = visit(ALICE, rows, events, false);
		expect(v).toMatchObject({ names: ['Player 80583'], tiers: ['guest'], requests: 5, errors: 2, views: 1, clicks: 2, folded: { 'usage posts': 1, 'prefs reads': 1 } });
		expect(v.topControls).toEqual([['room pick', 2]]);
		expect(v.lines.map((l) => [l.at.slice(11, 19), l.source, l.text, l.bad])).toEqual([
			['06:40:48', 'edge', '200 POST /cardtable/api/rooms/r-15bc7e47c9b1/join', false],
			['06:40:48', 'ui', 'view room', false],
			['06:41:20', 'ui', 'click room pick  ×2 until 06:41:30', false],
			['07:07:49', 'event', 'costly-act match-start', false],
			['07:37:03', 'edge', '404 POST /cardtable/api/tables/rooms/r-15bc7e47c9b1/ready', true],
			['07:37:03', 'event', 'rate-limited match-start', true],
			['07:37:13', 'edge', '404 POST /cardtable/api/tables/rooms/r-15bc7e47c9b1/ready', true],
		]);
		expect(renderVisit(v)).toContain('2026-11-21 07:37:03 ! edge  404 POST /cardtable/api/tables/rooms/r-15bc7e47c9b1/ready');
	});

	it('--all keeps every request and every repeat', () => {
		const v = visit(ALICE, rows, events, true);
		expect(v.folded).toEqual({});
		expect(v.lines.filter((l) => l.source === 'edge')).toHaveLength(5);
		expect(v.lines.filter((l) => l.text === 'click room pick')).toHaveLength(2);
	});

	it('rolls a trail line past midnight onto the next day', () => {
		const v = visit(ALICE, [], [event('2026-11-22T00:02:00.000Z', 'usage-user', { from: '2026-11-21T23:58:00.000Z', userId: ALICE, trail: ['23:59:00 view lobby', '00:01:00 view room'] })], true);
		expect(v.lines.map((l) => l.at)).toEqual(['2026-11-21T23:59:00.000Z', '2026-11-22T00:01:00.000Z']);
	});

	it('keeps a press stamped just before the window on the window\'s day', () => {
		const v = visit(ALICE, [], [event('2026-11-25T23:49:54.000Z', 'usage-user', { from: '2026-11-25T23:44:54.054Z', userId: ALICE, trail: ['23:44:52 click lobby settings-game', '23:45:56 view lobby'] })], true);
		expect(v.lines.map((l) => l.at)).toEqual(['2026-11-25T23:44:52.000Z', '2026-11-25T23:45:56.000Z']);
	});

	it('keeps a press stamped just before a window that opens after midnight on the previous day', () => {
		const v = visit(ALICE, [], [event('2026-11-26T00:05:00.000Z', 'usage-user', { from: '2026-11-26T00:00:01.000Z', userId: ALICE, trail: ['23:59:58 view lobby', '00:00:30 view room'] })], true);
		expect(v.lines.map((l) => l.at)).toEqual(['2026-11-25T23:59:58.000Z', '2026-11-26T00:00:30.000Z']);
	});

	it('fold leaves distinct neighbours alone', () => {
		const l = (text: string) => ({ at: '2026-11-21T00:00:00.000Z', source: 'ui' as const, text, bad: false });
		expect(fold([l('a'), l('b'), l('a')]).map((x) => x.text)).toEqual(['a', 'b', 'a']);
	});
});
