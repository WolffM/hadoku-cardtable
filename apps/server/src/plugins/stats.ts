/**
 * Match stats' keys, and the stats themselves. Every api request and every play-socket handshake
 * leaves its player's key in an in-memory book, so a finished room match can name BOTH players to
 * the game-stats store by their own keys (the store resolves and discards them). See src/stats/.
 */
import type { Request, Response } from 'express';
import { recordMatch } from '@wolffm/prefs-client/games';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '@hadoku/game-server/config';
import { tierOf, userIdOf, verifiedOf } from '@hadoku/game-server/edge-auth';
import { createKeyBook, createMatchStats, createStatsReporter } from '../stats/index.js';
import type { CardtablePlugin } from './state.js';

export const statsPlugin: CardtablePlugin = {
	name: 'stats',
	phase: 'stores',
	setup(ctx) {
		const { state, api } = ctx;
		state.statsKeys = createKeyBook();
		api.use(state.statsKeys.remember);
		api.get('/whoami', (req: Request, res: Response) => {
			// Handed straight through from the edge, post-sanitize: the first thing to curl when wiring
			// the tunnel up, since it proves provenance end to end.
			res.json({ userId: userIdOf(req), tier: tierOf(req), verified: verifiedOf(req) });
		});

		// A finished room match is reported with this server's service key; without one, nothing is
		// recorded. Its start is read from the room and the match at game over (`tables.matchStart`),
		// so a match taken back after a restart is reported too. Built before the lobby, which reports
		// every series result (`onSeriesEnd`) from its first sweep on.
		const statsLog = jsonLogger('cardtable-stats');
		state.matchStats = createMatchStats({
			keys: state.statsKeys,
			log: statsLog,
			startOf: (match) => state.tables.matchStart(match),
			reporter: createStatsReporter({
				log: statsLog,
				record:
					CONFIG.serviceKey === ''
						? null
						: (report) => recordMatch({ gameId: 'cardtable', baseUrl: CONFIG.statsBaseUrl, serviceKey: CONFIG.serviceKey }, report),
			}),
		});
		return { erase: [{ what: 'statsKeys', erase: (p) => state.statsKeys.forget(p.participantId) }] };
	},
};
