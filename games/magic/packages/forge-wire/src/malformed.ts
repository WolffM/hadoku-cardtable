/*
 * The negative battery: how a valid frame is broken, systematically.
 *
 * A schema with no test that can fail it is decoration, and the cheap way to
 * get a test that can fail is to take a frame that parses and break it one
 * field at a time. Every malformed case in this package's tests is generated
 * here rather than hand-written, which is why loosening a schema — dropping a
 * `.strict()`, widening a scalar — shows up as a specific named failure
 * instead of a suite that stays green.
 *
 * Five mutations, each named after the rule it violates:
 *
 *   `method:<name>`   the discriminator is a method nobody models
 *   `kind:<name>`     the frame kind is wrong for this method — a `notify` for
 *                     a blocking ask, or an invented kind
 *   `extra:<key>`     one unrecognised key. Caught only by `strictObject`;
 *                     this is the mutation that dies first if strictness goes.
 *   `missing:<key>`   a required key deleted
 *   `wrongType:<key>` a required key given a value of a plainly wrong type
 *
 * `missing` and `wrongType` are generated per key, so a frame with eight fields
 * contributes sixteen negatives and a no-argument frame contributes none of
 * them. That is deliberate: the count tracks the surface area rather than the
 * number of methods.
 *
 * Not exported from `index.ts` — it is support for this package's own tests and
 * has no place in a bridge's runtime.
 */

export interface Malformed {
  /** Names the rule this input violates, for the test title. */
  readonly label: string;
  readonly input: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A value of a plainly different type from `value`.
 *
 * "Plainly" matters: swapping a number for a string is a type error every
 * schema here catches, whereas swapping `0` for `-1` is a range question and
 * belongs in a hand-written test next to the rule it checks.
 */
function wrongTypeFor(value: unknown): unknown {
  if (typeof value === 'string') return 42;
  if (typeof value === 'number') return 'not-a-number';
  if (typeof value === 'boolean') return 'not-a-boolean';
  if (Array.isArray(value)) return { notAnArray: true };
  // Covers both objects and `null`: no field in this package is nullable over a
  // number, so 42 is wrong for every one of them.
  return 42;
}

/** Every malformed variant of one valid frame. */
export function malformedVariants(valid: unknown): Malformed[] {
  if (!isRecord(valid)) {
    throw new Error('malformedVariants expects an object frame');
  }

  const out: Malformed[] = [
    {
      label: 'method:notAProtocolMethod',
      input: { ...valid, method: 'notAProtocolMethod' },
    },
    {
      label: 'kind:invented',
      input: { ...valid, kind: 'invented' },
    },
    {
      label: 'extra:unexpectedField',
      input: { ...valid, unexpectedField: 'surplus' },
    },
  ];

  for (const key of Object.keys(valid)) {
    if (key === 'method') continue; // covered by `method:` above
    if (key === 'kind') continue; // covered by `kind:` above

    const without: Record<string, unknown> = { ...valid };
    delete without[key];
    out.push({ label: `missing:${key}`, input: without });

    out.push({
      label: `wrongType:${key}`,
      input: { ...valid, [key]: wrongTypeFor(valid[key]) },
    });
  }

  return out;
}

/** The battery for a whole table of examples, flattened and labelled by method. */
export function malformedTable(
  examples: Readonly<Record<string, unknown>>,
): Array<{ method: string; label: string; input: unknown }> {
  const out: Array<{ method: string; label: string; input: unknown }> = [];
  for (const [method, valid] of Object.entries(examples)) {
    for (const variant of malformedVariants(valid)) {
      out.push({ method, label: variant.label, input: variant.input });
    }
  }
  return out;
}
