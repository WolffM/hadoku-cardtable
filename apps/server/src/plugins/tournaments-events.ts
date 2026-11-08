/** The pods kept past their rooms, and the front page's calendar. */
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '../config.js';
import { openEvents } from '../room/events.js';
import { openTournaments } from '../room/tournaments.js';
import type { CardtablePlugin } from './state.js';

export const tournamentsEventsPlugin: CardtablePlugin = {
	name: 'tournaments-events',
	phase: 'stores',
	async setup(ctx) {
		const { state } = ctx;
		state.roomsLog = jsonLogger('cardtable-rooms');
		// Every pod that played a round, kept past its room for the stats popout's Tournaments tab.
		state.tournaments = await openTournaments(CONFIG.tournamentsFile, state.roomsLog);
		// The front page's calendar; an event's room is the lobby's own.
		state.events = await openEvents(CONFIG.eventsFile, state.roomsLog);
		ctx.bootPhase('tournaments-events');
	},
};
