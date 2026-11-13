/**
 * The constructed table's HTTP surface. `attachTables` is the one call
 * `src/index.ts` makes, and it must come BEFORE `attachPlay` — see
 * `routes.ts`'s header and `README.md` for the edit.
 */

export { attachTables, type TablesDeps, type TablesHandle, type TablesLog } from './routes.js';
export { loadTablesLibrary, type TablesLibrary } from './library.js';
