/**
 * The plugins `index.ts` boots, in order. A list of its own so a test can boot exactly what
 * production boots (`plugins/presence.test.ts`).
 */
import { fleetPlugin, stateDirPlugin } from '@hadoku/magic-server/plugins/boot';
import { bombermanPlugin } from './bomberman.js';
import { erasePlugin } from '@hadoku/magic-server/plugins/erase';
import { libraryPlugin } from '@hadoku/magic-server/plugins/library';
import { listenPlugin, warmPlugin } from '@hadoku/magic-server/plugins/listen';
import { playPlugin } from '@hadoku/magic-server/plugins/play';
import { poolsPlugin } from '@hadoku/magic-server/plugins/pools';
import { recordingsPlugin } from '@hadoku/magic-server/plugins/recordings';
import { relayPlugin } from '@hadoku/magic-server/plugins/relay';
import { roomPlugin } from '@hadoku/magic-server/plugins/room';
import { roomsPlugin } from '@hadoku/magic-server/plugins/rooms';
import { routesPlugin } from '@hadoku/magic-server/plugins/routes';
import type { CardtablePlugin } from '@hadoku/magic-server/plugins/state';
import { statsPlugin } from '@hadoku/magic-server/plugins/stats';
import { streamRoutesPlugin, streamSocketPlugin } from '@hadoku/magic-server/plugins/stream';
import { tablesPlugin } from '@hadoku/magic-server/plugins/tables';
import { tournamentsEventsPlugin } from '@hadoku/magic-server/plugins/tournaments-events';

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
	relayPlugin,
	roomPlugin,
	streamSocketPlugin,
	erasePlugin,
	listenPlugin,
	warmPlugin,
];
