import { z } from 'zod';

import type { DraftCard } from './draft.ts';

export const PoolSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cube'), cubeId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('set'), code: z.string().min(1), style: z.enum(['realistic', 'set-cube']) }),
]);
export type PoolSource = z.infer<typeof PoolSourceSchema>;

export const DraftPlanSchema = z.strictObject({
  rounds: z.tuple([PoolSourceSchema, PoolSourceSchema, PoolSourceSchema]),
  // Card names the deal leaves out of every round: a refused pool's cards, when the leader chose to
  // draft without them (the operator, 2026-10-22: "Draft without them" and "Cancel").
  without: z.array(z.string().min(1).max(200)).max(2000).optional(),
});
export type DraftPlan = z.infer<typeof DraftPlanSchema>;

/** Two sources are the SAME round, for display: an exact match, not the server's `sourceKey` grouping (which puts a set's two styles on one verdict); a display name must not conflate the two styles. */
function sameSource(a: PoolSource, b: PoolSource): boolean {
  if (a.kind === 'cube') return b.kind === 'cube' && a.cubeId === b.cubeId;
  return b.kind === 'set' && a.code === b.code && a.style === b.style;
}

/** One source's label from its bare name: a cube's name as it is, a set's with its style, e.g. "Innistrad · Realistic". */
export function sourceLabel(source: PoolSource, name: string): string {
  return source.kind === 'cube' ? name : `${name} · ${source.style === 'realistic' ? 'Realistic' : 'Set-cube'}`;
}

/**
 * A plan's display name from its rounds' bare names (`PodView.roundNames`): three equal rounds give
 * that source's label, otherwise the three labels are joined with ' / ', e.g. "Shards of Alara ·
 * Realistic / Shards of Alara · Realistic / Alara Reborn · Realistic".
 */
export function planDisplayName(plan: DraftPlan, roundNames: readonly [string, string, string]): string {
  const [first, second, third] = plan.rounds;
  if (sameSource(first, second) && sameSource(second, third)) return sourceLabel(first, roundNames[0]);
  return plan.rounds.map((source, i) => sourceLabel(source, roundNames[i]!)).join(' / ');
}

export const PoolVerdictSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), cards: z.number().int().nonnegative() }),
  // `message`: why no card could be checked at all (the pool service down), in place of a card list.
  z.strictObject({ ok: z.literal(false), unplayable: z.array(z.string()), missingText: z.array(z.string()), message: z.string().optional() }),
]);
export type PoolVerdict = z.infer<typeof PoolVerdictSchema>;

/**
 * How much a cube or a set is played: drafts recorded from it (the server's own draft record) and
 * matches played from it (game-stats, counted per match, never per seat), and when it was last
 * either. `lastPlayedAt` is ms since epoch, null when it never was.
 */
export const PoolUsageSchema = z.strictObject({ drafts: z.number().int(), matches: z.number().int(), lastPlayedAt: z.number().nullable() });
export type PoolUsage = z.infer<typeof PoolUsageSchema>;

/** One pool's key wherever a pool is counted or starred: `cube:<cubeId>` or `set:<code>`. */
export type PoolKey = `cube:${string}` | `set:${string}`;
export const cubePoolKey = (cubeId: string): PoolKey => `cube:${cubeId}`;
export const setPoolKey = (code: string): PoolKey => `set:${code}`;
/** A well-formed pool key, as `PUT /api/me/pool-favourites/:poolKey` takes it. */
export const POOL_KEY_PATTERN = /^(?:cube:[^\s/]{1,200}|set:[A-Za-z0-9_-]{1,32})$/;

export const CubeSummarySchema = z.strictObject({
  id: z.string(),                       // shortlist: file stem; Cube Cobra: 'cc-' + its short id; a pasted list: 'list-' + random
  name: z.string(),
  size: z.number().int().nonnegative(),
  origin: z.enum(['shortlist', 'cubecobra', 'list']),
  cubeCobraId: z.string().nullable(),   // null unless origin is 'cubecobra'
  importedBy: z.string().nullable(),    // friend id; null for shortlist
  importedAt: z.string().nullable(),    // ISO
  refreshedAt: z.string().nullable(),   // ISO
  verdict: PoolVerdictSchema.nullable(),// null = not yet checked at this Forge pin
  // A scryfallId, never a URL (AGENTS.md: "a card's art is a lookup, not a
  // URL"). Shortlist: resolved server-side from `pools/cube-art.json`'s name
  // against the cube's own cards. Cube Cobra: `cubeJSON`'s top-level
  // `image.id` (never `image.uri`). `null` when none resolved.
  artId: z.string().uuid().nullable(),
  usage: PoolUsageSchema.optional(),    // the listing's own join (`pools/usage.ts`); absent from a single cube's answer
});
export type CubeSummary = z.infer<typeof CubeSummarySchema>;

/** A cube as one viewer is shown it: who imported it, by the name they go by now, and whether that is the viewer. */
export const CubeListingSchema = CubeSummarySchema.extend({
  importerName: z.string().nullable(),  // null: the shortlist, an account that is gone, or an import older than the account on it
  mine: z.boolean(),
});
export type CubeListing = z.infer<typeof CubeListingSchema>;

/** The most art ids `GET /api/pools/cubes/:id/arts` draws at once. */
export const CUBE_ARTS_MAX = 12;
/** `GET /api/pools/cubes/:id/arts?n=`: a few of a cube's own cards' art ids, drawn at random. */
export const CubeArtsSchema = z.strictObject({ arts: z.array(z.string()).max(CUBE_ARTS_MAX) });

/** Up to `n` distinct cards' art ids from a cube's own cards, drawn at random. */
export function sampleArt(cards: readonly DraftCard[], n: number, random: () => number = Math.random): string[] {
  const ids = [...new Set(cards.map((c) => c.scryfallId).filter((id): id is string => id !== undefined))];
  const out: string[] = [];
  while (out.length < n && ids.length > 0) out.push(ids.splice(Math.floor(random() * ids.length), 1)[0]!);
  return out;
}

/** The most characters a pasted card list may hold: a 2,000-card list with set codes is well under it. */
export const CUBE_LIST_MAX_CHARS = 200_000;
/** A Cube Cobra link or id, or a named card list (one card a line; `pools/cube-list.ts` reads the formats). */
export const ImportCubeBodySchema = z.union([
  z.strictObject({ link: z.string().min(1).max(300) }),
  z.strictObject({ name: z.string().trim().min(1).max(60), list: z.string().min(1).max(CUBE_LIST_MAX_CHARS) }),
]);
export type ImportCubeBody = z.infer<typeof ImportCubeBodySchema>;
export const SetDraftPlanBodySchema = z.strictObject({ plan: DraftPlanSchema });

export const SetSummarySchema = z.strictObject({
  code: z.string(), name: z.string(), date: z.string(), type: z.string(),
  cards: z.number().int().nonnegative(),          // non-basic singletons (set-cube size)
  verdict: PoolVerdictSchema.nullable(),          // null = not yet checked at this Forge pin
  usage: PoolUsageSchema.optional(),              // the listing's own join (`pools/usage.ts`)
});
export type SetSummary = z.infer<typeof SetSummarySchema>;

export const DraftPresetSchema = z.strictObject({
  id: z.string(), name: z.string().min(1).max(60), plan: DraftPlanSchema,
  createdBy: z.string(), createdAt: z.string(),
});
export type DraftPreset = z.infer<typeof DraftPresetSchema>;
export const SavePresetBodySchema = z.strictObject({ name: z.string().min(1).max(60), plan: DraftPlanSchema });
