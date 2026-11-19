/**
 * The app's own pages and the rooms' API: the cover, the embed 404, the SPA fallback, the people
 * behind the avatars, the rooms, tournaments, card art, events (and their Discord mirror), Discord, sounds and the relays.
 */
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG, indexHtml } from '@hadoku/game-server/config';
import { MAGIC_CONFIG } from '../config.js';
import { serveCover } from '../cover.js';
import { attachCardArt } from '../http/card-art.js';
import { attachClientEvents } from '@hadoku/game-server/http/client-events';
import { attachDiscord } from '../http/discord.js';
import { eventDiscordShape } from '../http/event-discord.js';
import { attachEvents } from '../http/events.js';
import { createMusicReviewStore } from '../http/musicReviewStore.js';
import { attachPage } from '@hadoku/game-server/http/page';
import { attachPreview, previewFonts } from '../http/preview.js';
import { attachRooms } from '../http/rooms.js';
import { attachSounds } from '../http/sounds.js';
import { attachTournaments } from '../http/tournaments.js';
import { attachTrim } from '@hadoku/game-server/http/trim';
import { attachUsage } from '@hadoku/game-server/http/usage';
import { attachPeople, createPeople } from '@hadoku/game-server/people';
import { discordEvents, SWEEP_MS } from '@hadoku/game-server/room/discord-events';
import { createArtIds } from '../play/art-ids.js';
import { tableGamesOf, type TableGameSource } from '../play/table-game.js';
import type { CardtablePlugin } from './state.js';

export const routesPlugin: CardtablePlugin = {
	name: 'routes',
	phase: 'routes',
	setup(ctx) {
		const { app, api, state } = ctx;
		// The game picker's tile in watchparty: our own drawing of card backs.
		app.get('/cover', serveCover);
		// The embed bundle watchparty imports (D21): a path under `/embed/` that is not on disk is a
		// 404, never the SPA page, since an `import()` handed HTML fails with a MIME error that names nothing.
		app.use('/embed', (_req: Request, res: Response) => {
			res.status(404).type('text').send('no such embed file');
		});
		// Every client-routed path serves the same index.html, per caller within a limit (`http/page.ts`).
		attachPage(app, {
			indexHtml: indexHtml(),
			basePath: ctx.bundle,
			basePrefix: CONFIG.basePrefix,
			...(CONFIG.testNoRateLimits ? { rateLimit: null } : {}),
		});

		// Every member's avatar picture and cosmetics, from prefs-api (`people.ts`).
		state.people = createPeople({ baseUrl: CONFIG.prefsBaseUrl, serviceKey: CONFIG.serviceKey, keyless: CONFIG.testPeopleStandIn, log: state.roomsLog });
		const { lobby, people } = state;
		// Every member is named and dressed from their account, and the rooms a restart brought back once now.
		const accounts = attachPeople(lobby, people);
		void accounts.sweep();
		// A room's link preview, which only the edge reads (`http/preview.ts`).
		attachPreview(ctx.sealed, {
			rooms: lobby,
			people,
			watchpartyBase: CONFIG.watchpartyBaseUrl,
			fontFiles: previewFonts(),
			...(CONFIG.testNoRateLimits ? { rateLimit: null } : {}),
		});
		attachRooms(api, {
			lobby,
			challenges: state.challenges,
			checkPlan: state.checkDraftPlan,
			...(CONFIG.testNoRateLimits ? { createRateLimit: null } : {}),
			// Never the caller's own game: the front page joins the match it features, and a seat
			// holder's join takes their seat from the board they play on.
			featured: (caller) => {
				const pick = state.featured.current();
				return pick !== null && (state.play?.matches.get(pick.matchId)?.seatOf(caller) ?? null) !== null ? null : pick;
			},
			closed: state.roomClosed,
			forfeited: state.roomForfeited,
			// "Reset = Close": the testing room `/:id/close` just forgot is recreated fresh under the same name.
			reseedTesting: () => void state.runTestingRoomSeed(),
			arrived: (roomId, caller) => {
				if (caller.userId !== null) void accounts.arrived(roomId, caller.id, caller.userId);
			},
			// Each table's game for the table card (`play/table-game.ts`). `MatchRegistry.find`'s
			// `Match | EndedMatch` carry `.spec` as `MatchShell`'s own bare `MatchSpec` field or
			// (`EndedMatch`) as `ForgeMatchSpec` already; both are really Forge's (w120 §K).
			tableGames: (room) => tableGamesOf(room, (matchId) => state.play?.matches.find(matchId) as TableGameSource | undefined, state.deckCosts),
			// `POST …/start` fetches a realistic round's boosters and caches them on `draftRooms` BEFORE
			// `lobby.startDraft` runs, so the first socket `join`'s `draftRooms.open()` stays synchronous.
			realistic: {
				forge: state.forgePools,
				catalog: state.catalog,
				get draftRooms() {
					if (state.draftRooms === null) throw new Error('draftRooms is not wired — no shortlist cube loaded');
					return state.draftRooms;
				},
			},
		});
		attachTournaments(api, { tournaments: state.tournaments, people });
		attachCardArt(api, { art: createArtIds(state.catalog), keys: state.artKeys });
		// Every event also in the Discord server's Events tab, through ArchiveBot (prod only: it holds the secret).
		// The lobby restored its rooms in `stores`, so the boot sweep sees every event's room.
		const discordCalendar = discordEvents({
			service: 'cardtable',
			secret: state.archivebot.secret,
			archivebotUrl: state.archivebot.url,
			events: state.events,
			shape: eventDiscordShape({ lobby, people, appUrl: `https://hadoku.me${CONFIG.basePrefix}` }),
			log: jsonLogger('cardtable-discord'),
		});
		void discordCalendar.sweep();
		if (state.archivebot.secret !== '') setInterval(() => void discordCalendar.sweep(), SWEEP_MS).unref();
		// A set's name is known only once Forge answers after boot, so the boot sweep sent a draft's set as its code
		// ("BLB"): sync again the moment the names arrive, rather than leave the code in Discord until the next sweep.
		state.setsStore.onNamed(() => void discordCalendar.sweep());
		attachEvents(api, { events: state.events, lobby, people, checkPlan: state.checkDraftPlan, rally: { serviceKey: CONFIG.serviceKey }, log: state.roomsLog, closed: state.roomClosed, discord: discordCalendar, ...(CONFIG.testNoRateLimits ? { createRateLimit: null } : {}) });
		// The Discord's last few #general messages, through ArchiveBot (prod only: it holds the secret).
		attachDiscord(api, { secret: state.archivebot.secret, archivebotUrl: state.archivebot.url, log: jsonLogger('cardtable-discord') });

		// The sound-builder's catalogue, take audio and assignment matrix, read and written per request
		// in a gitignored data dir, so a redeploy keeps an admin's assignments.
		const soundsLog = jsonLogger('cardtable-sounds');
		attachSounds(api, {
			dir: MAGIC_CONFIG.soundsDir,
			log: soundsLog,
			reviews: createMusicReviewStore({
				baseUrl: CONFIG.prefsBaseUrl,
				serviceKey: CONFIG.serviceKey,
				onBadRow: (userId) => soundsLog({ event: 'sounds-music-review-bad-row', userId }),
			}),
		});
		attachTrim(api, { file: resolve(CONFIG.dataDir, 'trim.json') });
		// Client telemetry from a screen with no match: the front page's scroll smoothness.
		attachClientEvents(api);
		attachUsage(api);
		ctx.bootPhase('routes');
		return { erase: [{ what: 'people', erase: (p) => people.forget(p.userId) }] };
	},
};
