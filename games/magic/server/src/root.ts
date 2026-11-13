/**
 * Where Magic's own tree is, and the files in it Magic reads at runtime: Forge's bridge and pool
 * service sources, the test scenarios, the cube shortlist (and its art map beside it) and the link
 * preview's fonts. Every such lookup starts here, and nowhere else.
 *
 * Run as source (tsx, vitest) this module is `games/magic/server/src/root.ts`. Bundled, it is part of
 * the site's `apps/server/dist/index.js` (the file PM2 runs), where `import.meta.url` is the site's
 * `dist/` and says nothing about Magic: from there Magic is `games/magic/server` in the same checkout.
 * The tree beside a built `dist/` is the checkout the bundle was built from, so its sources are there.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `games/magic/server`, from source or from the site's bundle. */
export const MAGIC_ROOT = basename(HERE) === 'dist' ? resolve(HERE, '../../../games/magic/server') : dirname(HERE);

/** This checkout's root. */
export const REPO_ROOT = resolve(MAGIC_ROOT, '../../..');

/** The match bridge every Forge JVM runs (`jvmHostConfig`'s `bridgeSource`). */
export const BRIDGE_SOURCE = join(MAGIC_ROOT, 'src', 'play', 'bridge', 'PlayBridge.java');

/** The draft pool service's own JVM (`pools/forge.ts`). */
export const POOL_SERVICE_SOURCE = join(MAGIC_ROOT, 'src', 'play', 'bridge', 'PoolService.java');

/** Forge `[state]` scenarios, `<name>.state` (`play/scenarios/README.md`). */
export const SCENARIOS_DIR = join(MAGIC_ROOT, 'src', 'play', 'scenarios');

/** The committed, generated cube shortlist; `cube-art.json` sits beside it (`pools/cubes.ts`). */
export const SHORTLIST_DIR = join(MAGIC_ROOT, 'pools', 'cubes');

/** Fonts and the like shipped beside the server, never image bytes. */
export const ASSETS_DIR = join(MAGIC_ROOT, 'assets');
