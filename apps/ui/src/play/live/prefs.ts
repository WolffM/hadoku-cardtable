/*
 * Item 6 (wave 30): *"@wolffm/prefs-client is already an apps/ui dependency
 * and is the fleet's preference service — prefer it over localStorage, which
 * does not follow a player to another browser."* This is the one client for
 * the settings panel's preferences — board layout (item 11),
 * the End step stop (on by default), and Fast Mode (wave 47) — persisted per
 * VIEWER (the API's `user` scope, `createPrefsClient`'s default `save`
 * scope), so a preference set on one browser is there the next time the same
 * player signs in on another. `@wolffm/prefs-client` DOES hold an app-scoped
 * preference — this is not a fallback file; it is the real integration.
 *
 * ## Fast Mode's default, and the one e2e seam (wave 47)
 *
 * Fast Mode is OFF by default everywhere — paced — EXCEPT inside the e2e
 * harness, where every spec but the one that tests pacing itself needs
 * frames to land the instant they arrive (the wave file's own rule: "e2e
 * runs in Fast Mode"). `e2e/play/browser.ts`'s `openFriend` sets
 * `globalThis[FAST_MODE_DEFAULT_GLOBAL] = true` via a Playwright
 * `addInitScript`, the same seam `e2e/prefsLocal.ts` already uses for
 * `__HADOKU_PREFS_API_BASE__` — a global read ONLY as the default, read here
 * once, at module scope, which is late enough: an init script runs before
 * any page script, and this module is not evaluated until the bundle's own
 * JS does (`LiveBoard`'s eager import graph), well after. Production code
 * never sets this global, so `fastModeDefaultOverride()` reads `false`
 * everywhere that matters. `pace.test.ts`'s own suite and this file's unit
 * tests both run under vitest/node, where the global is never set either.
 *
 * The one spec that tests pacing (`e2e/w47-pace.spec.ts`) turns Fast Mode
 * back OFF for the seat it is measuring, through the real settings UI — see
 * that file for why clicking the real control is the stronger proof.
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

import { GainSchema, SeqCursorSchema } from '@hadoku/shared';
import { CallIdSchema, ShowConfirmDialogReplySchema } from '@hadoku/forge-wire';

import type { BoardLayout } from '../Board.tsx';
import { UI_SCALE } from '../../settings/ui-scale.ts';

const borrowed = {
  /** A non-empty string: `CallIdSchema` is `z.string().min(1)`. */
  nonEmptyString: CallIdSchema,
  /** A boolean: `ShowConfirmDialogReplySchema` is `z.boolean()`. */
  boolean: ShowConfirmDialogReplySchema,
  /** An empty object schema to extend — `z.object({})` by another route. */
  emptyObject: SeqCursorSchema.pick({}),
  /** A finite number: `GainSchema` is `z.number().min(0).max(2)`, narrowed below. */
  number: GainSchema,
};

/** `'single' | 'type-separated'` — refined off a string, the same device `apps/server/src/play/transport.ts`'s `StopPreferenceSchema` uses for its own literal. */
const BoardLayoutPrefSchema = borrowed.nonEmptyString.refine(
  (v) => v === 'single' || v === 'type-separated',
  { message: "must be 'single' or 'type-separated'" },
);

/** The settings panel's whole persisted shape. Every field optional: a fresh viewer has none yet, and `defaults` below fills the gap. `.strict()`, like every other schema in this lane — a misspelled or retired field is an error, not silently dropped. */
export const PlayPrefsSchema = borrowed.emptyObject
  .extend({
    boardLayout: BoardLayoutPrefSchema.optional(),
    /** The opponent's End step held for a real play. On by default. */
    endStepStop: borrowed.boolean.optional(),
    /** Wave 47: "Fast Mode" in the settings panel. Off (paced) by default. */
    fastMode: borrowed.boolean.optional(),
    /** The UI scale (`../../settings/ui-scale.ts`), the whole app's, not only a match's. */
    uiScale: borrowed.number.refine((v) => v >= UI_SCALE.min && v <= UI_SCALE.max, { message: 'outside the UI scale range' }).optional(),
  })
  .strict();

export interface PlayPrefs {
  /** `usePrefs`'s own generic bound (`T extends Record<string, unknown>`) — no field of this app's is ever read off the index signature itself. */
  [key: string]: unknown;
  boardLayout?: BoardLayout;
  endStepStop?: boolean;
  fastMode?: boolean;
  uiScale?: number;
}

/**
 * e2e's own seam for Fast Mode's default — see this module's header. The key
 * is exported so `e2e/play/browser.ts` sets the exact string this file reads,
 * never a hand-typed copy of it.
 */
export const FAST_MODE_DEFAULT_GLOBAL = '__CARDTABLE_FAST_MODE_DEFAULT__';

function fastModeDefaultOverride(): boolean {
  return (globalThis as Record<string, unknown>)[FAST_MODE_DEFAULT_GLOBAL] === true;
}

/**
 * What the panel draws before the first read resolves, and what a field
 * defaults to once it has. `boardLayout` mirrors `Board`'s own default (item
 * 11: single, undivided). `fastMode` mirrors `pace.ts`'s own wrapper default
 * (paced) everywhere except inside the e2e harness — see this module's
 * header.
 */
export const PLAY_PREFS_DEFAULTS: { boardLayout: BoardLayout; endStepStop: boolean; fastMode: boolean; uiScale: number } = {
  boardLayout: 'single',
  endStepStop: true,
  fastMode: fastModeDefaultOverride(),
  uiScale: 1,
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

/**
 * `stopAtEndStep` was wave 30's unconditional End step stop, off by default. Its
 * successor, `endStepStop`, holds the End step only for a real play and is on by
 * default, so a saved `false` from the old checkbox must not switch the new one off:
 * the old field is dropped on read rather than renamed. The schema is `.strict()`,
 * so without this a blob that still carries it would fail to parse whole.
 */
export function dropRetiredStopAtEndStep(blob: Record<string, unknown>): Record<string, unknown> {
  const { stopAtEndStep: _retired, ...rest } = blob;
  return rest;
}

export function getPlayPrefsClient(): PrefsClient<PlayPrefs> {
  instance ??= createPrefsClient({
    appId: 'cardtable-play',
    schema: schemaAcrossZodInstances,
    defaults: PLAY_PREFS_DEFAULTS,
    migrations: [dropRetiredStopAtEndStep],
  }) as unknown as PrefsClient<PlayPrefs>;
  return instance;
}
