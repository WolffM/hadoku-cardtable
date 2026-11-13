/*
 * Envelope validation — now delegated to `@hadoku/shared`'s Zod schema.
 *
 * This file used to be a hand-written structural checker, and said why:
 *
 *   > The wave plan gives lane B `packages/shared` and a Zod schema for this
 *   > envelope. Lane B was not dispatched (its registry prerequisite failed),
 *   > so the schema does not exist and these fixtures have nothing to validate
 *   > against. Shipping unvalidated JSON and calling the done-when satisfied
 *   > would be exactly the vacuous gate this project's tracker keeps catching.
 *
 *   > **This is a placeholder with a deletion condition.** When lane B lands
 *   > its schema, replace `parseDraftView` with that schema's `parse` and keep
 *   > the tests.
 *
 * The schema landed. The 200 lines of hand-rolled field checks are gone; the
 * two functions below keep their names and signatures so the callers and their
 * tests are untouched, which is what "keep the tests" meant.
 *
 * The error shape is preserved deliberately: failures still accumulate with a
 * JSON path rather than throwing on the first one, because a validator that
 * stops at the first problem tells you one thing per run about a file with
 * fifteen cards in it.
 */

import { safeParseDraftView, type DraftView } from '@hadoku/shared';

export interface ValidationFailure {
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationFailure[] };

/** Validate an unknown payload, accumulating every failure with its path. */
export function parseDraftView(raw: unknown): ParseResult<DraftView> {
  return safeParseDraftView(raw);
}

/** Validate or throw, naming the file so a bad fixture is findable. */
export function expectDraftView(raw: unknown, label: string): DraftView {
  const result = parseDraftView(raw);
  if (result.ok) return result.value;
  const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  throw new Error(`${label} is not a valid draft payload:\n${detail}`);
}
