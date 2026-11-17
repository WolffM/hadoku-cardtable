/*
 * How a Magic event reads in the Discord server's Events tab (`@hadoku/game-server/room/discord-events`):
 * its room's name, the room's line from its link preview ("Modern Gauntlet 1v1", "Cube Draft"), who
 * organized it, and the room's link, which Discord unfurls as that preview.
 *
 * Only what the room's public link preview already shows goes to Discord. A room with a password or a
 * testing room is kept off it, as the preview refuses them, and so is an event whose room has closed.
 */
import type { DiscordEventShape } from '@hadoku/game-server/room/discord-events';
import type { EventRecord } from '@hadoku/game-server/room/events';
import type { People } from '@hadoku/game-server/people';
import { UNNAMED } from '@hadoku/game-server/room/constants';

import type { Lobby } from '../room/lobby.js';
import { magicView } from '../room/magic-view.js';
import { describeRoom } from './preview.js';

export interface EventDiscordDeps {
	lobby: Pick<Lobby, 'get'>;
	people: Pick<People, 'resolve'>;
	/** Where the app is served, e.g. `https://hadoku.me/cardtable`, without a trailing slash. */
	appUrl: string;
}

export function eventDiscordShape(deps: EventDiscordDeps): (event: EventRecord) => Promise<DiscordEventShape | null> {
	return async (event) => {
		const room = magicView(deps.lobby.get(event.roomId));
		if (room === undefined || room.locked || room.testing) return null;
		const organizer = event.organizerUserId == null ? undefined : (await deps.people.resolve([event.organizerUserId])).get(event.organizerUserId)?.name;
		const link = `${deps.appUrl}/room/${encodeURIComponent(room.id)}`;
		return {
			name: room.name,
			description: `${describeRoom(room)}, organized by ${organizer ?? event.organizerName ?? UNNAMED}.\n${link}`,
			location: link.replace(/^https:\/\//, ''),
		};
	};
}
