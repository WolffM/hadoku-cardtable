import { z } from 'zod';

export const PoolSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cube'), cubeId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('set'), code: z.string().min(1), style: z.enum(['realistic', 'set-cube']) }),
]);
export type PoolSource = z.infer<typeof PoolSourceSchema>;

export const DraftPlanSchema = z.strictObject({
  rounds: z.tuple([PoolSourceSchema, PoolSourceSchema, PoolSourceSchema]),
});
export type DraftPlan = z.infer<typeof DraftPlanSchema>;

export const PoolVerdictSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), cards: z.number().int().nonnegative() }),
  z.strictObject({ ok: z.literal(false), unplayable: z.array(z.string()), missingText: z.array(z.string()) }),
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
});
export type CubeSummary = z.infer<typeof CubeSummarySchema>;

export const ImportCubeBodySchema = z.strictObject({ link: z.string().min(1).max(300) });
export const SetDraftPlanBodySchema = z.strictObject({ plan: DraftPlanSchema });
