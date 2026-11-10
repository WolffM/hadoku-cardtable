/**
 * Cardtable — loopback-UI tunnel server
 *
 *   browser ──► hadoku.me/cardtable/*
 *            ──► edge-router          tier gate + stripPrefix '/cardtable'
 *            ──► tunnel hostname      cloudflared
 *            ──► 127.0.0.1:9008    ◄── THIS process
 *
 * Because the edge strips the prefix, this server is handed ROOT paths: `/`, `/assets/…`,
 * `/api/…`, `/health`. The browser is not — see src/base-path.ts.
 *
 * An app that owns BOTH its front end and its back end in one repo: the bundle it builds is the
 * bundle it serves. It keeps three promises: `/health` answers unauthenticated, always;
 * everything else is refused below the tier floor, independently of the edge; and a bundle that
 * would render blank is replaced by a page that says why.
 *
 * This file is cardtable's config and its plugin list. `@hadoku/service-kernel/server` boots
 * them: it owns the express app, the HTTP and socket.io servers, the floor, `/health` and the
 * busy probe, telemetry and capacity, the erase route, listen and the shutdown, and runs each
 * plugin in its phase (`config → bundle → stores → routes → sockets → listen → warm`), in the
 * order listed. The plugins (`./plugins/`) stamp the boot clock with cardtable's own phase names.
 * The draft and play sockets re-apply the floor at the handshake, since engine.io takes it off
 * the raw HTTP server where no express middleware runs (`src/room/socket.ts`).
 *
 * ## Why this is not built with `tsc`
 *
 * `build` typechecks with `tsc --noEmit` and bundles with esbuild: `@hadoku/*` publish
 * TypeScript SOURCE with `.ts` imports, which `tsc` refuses to emit. The externals passed to
 * esbuild are this package's own `dependencies` minus the `@hadoku/*` ones; anything a workspace
 * package pulls in transitively must be BUNDLED, because pnpm's strict layout does not expose it
 * next to `dist/`. `dist/index.js` is still a plain file that plain `node` runs. The one other
 * entry is the catalog build's worker thread, `dist/catalog-build-worker.js` (`pools/refresh.ts`).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { createGameServer } from '@hadoku/service-kernel/server';
import { SERVER_RESTARTING_EVENT } from '@hadoku/shared';
import { EMBED_ENTRIES } from './base-path.js';
import { ART_REDIRECTS } from './capacity.js';
import { CONFIG, INDEX_HTML } from './config.js';
import { fkOf } from './erase/index.js';
import { edgeAuth, gate } from './kernel.js';
import { monitoringSink, siteOf } from './telemetry.js';
import { PLUGINS } from './plugins/index.js';
import type { Cardtable, CardtableEvents } from './plugins/state.js';

// `dist/index.js` and `src/index.ts` are both exactly one directory below the package root, which
// makes one expression right for the bundle and for `tsx`; a plugin a level deeper could not do
// this. REPO_ROOT is this instance's own checkout: prod and PPE each have one.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(PKG_ROOT, '../..');

await createGameServer<CardtableEvents, Cardtable>({
	id: 'cardtable',
	config: {
		host: CONFIG.host,
		port: CONFIG.port,
		log: jsonLogger('cardtable'),
		edgeAuth,
		gate,
		basePrefix: CONFIG.basePrefix,
		bundle: { indexHtml: INDEX_HTML, webDir: CONFIG.webDir, embedEntries: EMBED_ENTRIES },
		repoRoot: REPO_ROOT,
		restartEvent: SERVER_RESTARTING_EVENT,
		// Prod and PPE both post as `cardtable`; the base path says which one this is.
		telemetry: () => monitoringSink({ baseUrl: CONFIG.monitoringBaseUrl, serviceKey: CONFIG.serviceKey, site: siteOf(CONFIG.basePrefix), log: jsonLogger('cardtable-telemetry') }),
		firstSeen: { file: CONFIG.callersSeenFile, log: jsonLogger('cardtable-telemetry') },
		erase: { deriveParticipantId: fkOf },
		// Card images are counted by `capacity` (`artRedirects`), not logged one line each.
		uncounted: ART_REDIRECTS,
		// Cardtable's thirteen boot steps keep their names; the plugins stamp them.
		stampPhases: false,
	},
	state: { pkgRoot: PKG_ROOT, repoRoot: REPO_ROOT } as Cardtable,
	plugins: PLUGINS,
});
