/**
 * The chunks a build keeps apart because they change far less often than the app's own code: a
 * deploy changes the app's chunks, and a returning browser keeps these from its cache. Each is
 * content-hashed like every asset (served immutable), so a chunk's name changes only when what is
 * in it does. Shared by the page build (`vite.config.ts`) and the embed's (`vite.embed.config.ts`).
 *
 * - **The data tables** (`src/draft/*.json`). Each is imported only by the screens that draw cards,
 *   which are chunks of their own (`src/lazy.ts`), and each lands in its own chunk beside them
 *   rather than inside one of them.
 * - **Libraries** that move only when `package.json` does. Each group takes in what its package
 *   imports. JavaScript only: a stylesheet stays where its importer put it, since the order of the
 *   app's one stylesheet is the cascade.
 */

import { STYLESHEET_GROUP } from './stylesheet.ts';

const DATA = /[\\/]src[\\/]draft[\\/](pool|related|deck-art-traits)\.json$/;

const VENDOR: Record<string, RegExp> = {
  react: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/].*\.[cm]?js$/,
  zod: /[\\/]node_modules[\\/]zod[\\/].*\.[cm]?js$/,
  socket: /[\\/]node_modules[\\/]socket\.io-client[\\/].*\.[cm]?js$/,
};

/**
 * Vite's warning for a big chunk, in kB, above the one big chunk this app has on purpose: the
 * art-id table, ~1.1 MB of data in a chunk of its own. The largest code chunk, the board's, is
 * about half that, so a code chunk growing past this still warns.
 */
export const CHUNK_SIZE_WARNING_KB = 1200;

export const CHUNK_GROUPS = [
  STYLESHEET_GROUP,
  { name: (id: string) => DATA.exec(id)?.[1] ?? null, test: DATA },
  ...Object.entries(VENDOR).map(([name, test]) => ({ name: `vendor-${name}`, test })),
];
