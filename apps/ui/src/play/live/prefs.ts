/*
 * Item 6 (wave 30): *"@wolffm/prefs-client is already an apps/ui dependency
 * and is the fleet's preference service — prefer it over localStorage, which
 * does not follow a player to another browser."* This is the one client for
 * both of the settings panel's preferences — board layout (item 11) and
 * always-stop-at-end-step (item 2/6) — persisted per VIEWER (the API's
 * `user` scope, `createPrefsClient`'s default `save` scope), so a preference
 * set on one browser is there the next time the same player signs in on
 * another. `@wolffm/prefs-client` DOES hold an app-scoped preference — this is
 * not a fallback file; it is the real integration.
 *
 * ## No direct `zod` import
 *
 * `@hadoku/ui` does not depend on `zod` directly, and pnpm's strict layout
 * will not resolve it from here — the exact constraint `./transport.ts`'s own
 * header already documents for the wire schemas. `createPrefsClient`'s
 * `schema` option only needs a SCHEMA VALUE, not the `zod` module, so this
 * borrows schema instances `@hadoku/forge-wire` and `@hadoku/shared` already
 * export (both real `apps/ui` dependencies) and builds the prefs shape by
 * extending them — the same device `./transport.ts` uses for every wire
 * schema in this lane.
 */

import { createPrefsClient, type PrefsClient } from '@wolffm/prefs-client';

import { SeqCursorSchema } from '@hadoku/shared';
import { CallIdSchema, ShowConfirmDialogReplySchema } from '@hadoku/forge-wire';

import type { BoardLayout } from '../Board.tsx';

const borrowed = {
  /** A non-empty string: `CallIdSchema` is `z.string().min(1)`. */
  nonEmptyString: CallIdSchema,
  /** A boolean: `ShowConfirmDialogReplySchema` is `z.boolean()`. */
  boolean: ShowConfirmDialogReplySchema,
  /** An empty object schema to extend — `z.object({})` by another route. */
  emptyObject: SeqCursorSchema.pick({}),
};

/** `'single' | 'type-separated'` — refined off a string, the same device `apps/server/src/play/transport.ts`'s `StopPreferenceSchema` uses for its own literal. */
const BoardLayoutPrefSchema = borrowed.nonEmptyString.refine(
  (v) => v === 'single' || v === 'type-separated',
  { message: "must be 'single' or 'type-separated'" },
);

/** The settings panel's whole persisted shape. Both fields optional: a fresh viewer has neither yet, and `defaults` below fills the gap. `.strict()`, like every other schema in this lane — a misspelled or retired field is an error, not silently dropped. */
export const PlayPrefsSchema = borrowed.emptyObject
  .extend({
    boardLayout: BoardLayoutPrefSchema.optional(),
    stopAtEndStep: borrowed.boolean.optional(),
  })
  .strict();

export interface PlayPrefs {
  /** `usePrefs`'s own generic bound (`T extends Record<string, unknown>`) — no field of this app's is ever read off the index signature itself. */
  [key: string]: unknown;
  boardLayout?: BoardLayout;
  stopAtEndStep?: boolean;
}

/** What the panel draws before the first read resolves, and what a field defaults to once it has. Mirrors `Board`'s own `boardLayout` default (item 11: single, undivided). */
export const PLAY_PREFS_DEFAULTS: { boardLayout: BoardLayout; stopAtEndStep: boolean } = {
  boardLayout: 'single',
  stopAtEndStep: false,
};

/**
 * `createPrefsClient<S extends z.ZodType>`'s `S` is bound to ITS OWN `zod`
 * import, resolved as its peer at `^4.0.0` — `4.6.5` in this lockfile, a
 * DIFFERENT physical copy from the `4.5.4` `@hadoku/forge-wire` and
 * `@hadoku/shared` build their schemas against (`apps/ui` has no direct `zod`
 * dependency to pin them to one copy). Zod v4's internal types are branded
 * per-instance, so two schema objects that are structurally and behaviourally
 * identical — both real `zod` v4 `ZodObject`s, both answering `.parse` /
 * `.safeParse` the same way — are still two DIFFERENT NOMINAL TYPES to
 * TypeScript, and there is no expression in this file that can name the
 * OTHER copy's type without a direct `zod` import this package cannot resolve.
 *
 * So `schema` is handed across as `any` — the one narrow, named escape hatch,
 * not a blanket loosening — and the client's own return type is recovered
 * immediately after with a cast to `PrefsClient<PlayPrefs>`, built from THIS
 * file's own plain interface rather than anything zod-shaped. Everything past
 * this line is fully typed again.
 *
 * This is the "fall back, with the reason in the code" the wave brief asked
 * for if the client cannot hold an app-scoped preference cleanly — except it
 * CAN hold one; the friction is a type-system artefact of two zod copies in
 * one lockfile, not a capability gap, and `prefs.test.ts` proves the schema
 * itself works: `PlayPrefsSchema.safeParse` accepts a valid blob and rejects
 * an invalid `boardLayout` on its own, with no client involved.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the block comment above: the two `any`s bridge two incompatible zod instances, not a loosened contract.
const schemaAcrossZodInstances = PlayPrefsSchema as any;

/**
 * One client for the whole app, built LAZILY rather than at module scope.
 *
 * `App.tsx` imports `MatchScreen` statically (no route-based code
 * splitting), so `LiveBoard.tsx` → this module is in the eager import graph
 * of every test that renders `<App>` at all — `apps/ui/src/chrome/header.test.ts`
 * among them, which mocks `@wolffm/prefs-client` down to its OWN one export
 * (`whoami`) because the header needs nothing else. A top-level
 * `createPrefsClient(...)` call threw `No "createPrefsClient" export is
 * defined on the "@wolffm/prefs-client" mock` there — a real regression,
 * caught by running the suite outside this lane's own directory, not
 * something `header.test.ts` (not this lane's file) could be expected to
 * anticipate. Lazy construction defers the call to the first render that
 * actually needs it — `LiveBoard`'s own `usePrefs` call, reached only from
 * the match route — so a header-only render never touches
 * `@wolffm/prefs-client` at all, and every other consumer still gets the
 * same ONE memoized instance `createPrefsClient`'s own contract promises
 * (one per app id, shared by every consumer, all reading and writing the
 * same cache and the same debounced PUT).
 */
let instance: PrefsClient<PlayPrefs> | null = null;

export function getPlayPrefsClient(): PrefsClient<PlayPrefs> {
  instance ??= createPrefsClient({
    appId: 'cardtable-play',
    schema: schemaAcrossZodInstances,
    defaults: PLAY_PREFS_DEFAULTS,
  }) as unknown as PrefsClient<PlayPrefs>;
  return instance;
}
