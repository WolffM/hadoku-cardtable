/**
 * The path the app is served under, resolved at CONFIG TIME (this runs in node).
 *
 * `CARDTABLE_BASE_PREFIX` is the server's variable too (`apps/server/src/config.ts`),
 * so one value names the prefix for both halves of a deploy: prod leaves it unset
 * (`/cardtable`), PPE builds and runs with `/cardtable-ppe`
 * (`docs/planning/release-process.md`). Vite wants the trailing slash; the server's
 * form has none.
 */
const prefix = process.env.CARDTABLE_BASE_PREFIX || '/cardtable';

if (!/^\/[a-z0-9-]+$/.test(prefix)) {
  throw new Error(`CARDTABLE_BASE_PREFIX must look like /cardtable (one lowercase segment, no trailing slash); got ${JSON.stringify(prefix)}`);
}

export const APP_BASE = `${prefix}/`;
