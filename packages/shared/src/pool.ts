import { z } from 'zod';

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

export const CubeSummarySchema = z.strictObject({
  id: z.string(),                       // shortlist: file stem; imported: 'cc-' + Cube Cobra short id
  name: z.string(),
  size: z.number().int().nonnegative(),
  origin: z.enum(['shortlist', 'cubecobra']),
  cubeCobraId: z.string().nullable(),
  importedBy: z.string().nullable(),    // friend id; null for shortlist
  importedAt: z.string().nullable(),    // ISO
  refreshedAt: z.string().nullable(),   // ISO
  verdict: PoolVerdictSchema.nullable(),// null = not yet checked at this Forge pin
  // A scryfallId, never a URL (AGENTS.md: "a card's art is a lookup, not a
  // URL"). Shortlist: resolved server-side from `pools/cube-art.json`'s name
  // against the cube's own cards. Cube Cobra: `cubeJSON`'s top-level
  // `image.id` (never `image.uri`). `null` when none resolved.
  artId: z.string().uuid().nullable(),
});
export type CubeSummary = z.infer<typeof CubeSummarySchema>;

export const ImportCubeBodySchema = z.strictObject({ link: z.string().min(1).max(300) });
export const SetDraftPlanBodySchema = z.strictObject({ plan: DraftPlanSchema });

export const SetSummarySchema = z.strictObject({
  code: z.string(), name: z.string(), date: z.string(), type: z.string(),
  cards: z.number().int().nonnegative(),          // non-basic singletons (set-cube size)
  verdict: PoolVerdictSchema.nullable(),          // null = not yet checked at this Forge pin
});
export type SetSummary = z.infer<typeof SetSummarySchema>;

export const DraftPresetSchema = z.strictObject({
  id: z.string(), name: z.string().min(1).max(60), plan: DraftPlanSchema,
  createdBy: z.string(), createdAt: z.string(),
});
export type DraftPreset = z.infer<typeof DraftPresetSchema>;
export const SavePresetBodySchema = z.strictObject({ name: z.string().min(1).max(60), plan: DraftPlanSchema });
