/**
 * The plugins `index.ts` boots, in order. A list of its own so a test can boot exactly what
 * production boots (`plugins/presence.test.ts`).
 */
import { fleetPlugin, stateDirPlugin } from './boot.js';
import { bombermanPlugin } from './bomberman.js';
import { erasePlugin } from './erase.js';
import { libraryPlugin } from './library.js';
import { listenPlugin, warmPlugin } from './listen.js';
import { playPlugin } from './play.js';
import { poolsPlugin } from './pools.js';
import { recordingsPlugin } from './recordings.js';
import { roomPlugin } from './room.js';
import { roomsPlugin } from './rooms.js';
import { routesPlugin } from './routes.js';
import type { CardtablePlugin } from './state.js';
import { statsPlugin } from './stats.js';
import { streamRoutesPlugin, streamSocketPlugin } from './stream.js';
import { tablesPlugin } from './tables.js';
import { tournamentsEventsPlugin } from './tournaments-events.js';

export const PLUGINS: CardtablePlugin[] = [
	stateDirPlugin,
	bombermanPlugin,
	fleetPlugin,
	libraryPlugin,
	tournamentsEventsPlugin,
	statsPlugin,
	poolsPlugin,
	roomsPlugin,
	streamRoutesPlugin,
	routesPlugin,
	tablesPlugin,
	recordingsPlugin,
	playPlugin,
	roomPlugin,
	streamSocketPlugin,
	erasePlugin,
	listenPlugin,
	warmPlugin,
];
