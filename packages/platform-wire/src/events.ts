/*
 * Scheduled events and attached Rally forms: the front page's calendar and polls. An event is a
 * room with a start time, read from the room each time (the operator, 2026-10-30: "the room is the
 * source of truth"); what the room plays is the game's, `eventViewSchema`'s type parameters. A form
 * is a Rally form on schema `event-signup@1`, listed while Rally says it is open (#22).
 */

import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** An event's title, which is its room's name: 1 to `max` characters, no control characters. */
export const eventTitleSchema = (max: number) =>
  z
    .string({ error: 'title must be a string' })
    .trim()
    .min(1, { error: `title must be 1–${max} characters` })
    .max(max, { error: `title must be 1–${max} characters` })
    .refine((title) => !CONTROL.test(title), { error: 'title must not contain control characters' });

export const StartsAtSchema = z.iso.datetime({ offset: true, error: 'startsAt must be an ISO date-time' });

/** A request body that names its unknown fields. */
export const strictBody = <S extends z.ZodRawShape>(shape: S) =>
  z.strictObject(shape, {
    error: (iss) => (iss.code === 'unrecognized_keys' ? `unknown field(s): ${iss.keys.join(', ')}` : 'body must be a JSON object'),
  });

/**
 * `PATCH /api/events/:id`, organizer only: a new start. `title` is accepted only as the room's
 * own name unchanged — an event is named after its room — so a form that sends its whole state
 * still saves.
 */
export const updateEventBodySchema = (titleMax: number) => strictBody({ title: eventTitleSchema(titleMax).optional(), startsAt: StartsAtSchema });

/** One event as `GET /api/events` sends it, scoped to the caller (`mine`): the game's `kind` and `room`. */
export const eventViewSchema = <K extends z.ZodType, R extends z.ZodType>(kind: K, room: R) =>
  z.object({
    id: z.string(),
    /** What the room plays now. */
    kind,
    /** The room's name. */
    title: z.string(),
    startsAt: z.string(),
    organizer: z.string(),
    /** Whether the caller organized it: only they may move or cancel it. */
    mine: z.boolean().catch(false),
    /** The event's room. An event whose room has closed is not listed. */
    roomId: z.string().nullable().catch(null),
    /** The room as it is now. Always sent; optional only so a reader's fixture may leave it out. */
    room: room.nullable().catch(null).optional(),
    /**
     * How many said on the event's Rally form that they can make it: respondents free for the
     * form's whole length from `startsAt`. Null for an event made without a form, or while Rally
     * cannot say.
     */
    signedUp: z.number().int().min(0).nullable().catch(null).optional(),
  });

export const eventListSchema = <V extends z.ZodType>(view: V) => z.object({ events: z.array(view).catch([]) });

/* ── Rally forms ─────────────────────────────────────────────────────── */

/** The one Rally schema an event form may carry: a required availability grid (#22 §3). */
export const RALLY_EVENT_SCHEMA = { name: 'event-signup', version: 1 } as const;

export const RallyFormIdSchema = z.string({ error: 'formId must be a Rally form id' }).regex(/^[A-Za-z0-9_-]{1,64}$/, { error: 'formId must be a Rally form id' });

/** One of a form's best windows: when, how many can make all of it, and the pick those people would play (an option ref). */
export const RallyWindowSchema = z.object({
  at: z.string(),
  endsAt: z.string(),
  free: z.number().int().min(0),
  pick: z.string().nullable(),
});
export type RallyWindow = z.infer<typeof RallyWindowSchema>;

/**
 * What Rally tells a service caller of a form's time question with a length: for each start that
 * anyone can make, how many can make the whole length; and the best windows. Counts, never names.
 */
export const RallyAvailabilitySchema = z.object({
  lengthMin: z.number().int(),
  starts: z.array(z.object({ at: z.string(), free: z.number().int().min(0) })),
  best: z.array(RallyWindowSchema),
});
export type RallyAvailability = z.infer<typeof RallyAvailabilitySchema>;

/** Rally's `GET /rally/api/forms/{id}/summary`, its `data`. `availability` comes to a service caller only. */
export const RallyFormSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['open', 'closed']),
  closesAt: z.string().nullable(),
  url: z.string(),
  createdBy: z.string().nullable(),
  schema: z.object({ name: z.string(), version: z.number().int() }),
  availability: RallyAvailabilitySchema.optional().catch(undefined),
});
export type RallyFormSummary = z.infer<typeof RallyFormSummarySchema>;

/** Whether a form makes the promise an event form needs. */
export function isEventSignupForm(summary: Pick<RallyFormSummary, 'schema'>): boolean {
  return summary.schema.name === RALLY_EVENT_SCHEMA.name && summary.schema.version === RALLY_EVENT_SCHEMA.version;
}

/** `POST /api/events/forms`: attach a Rally form, checked through its summary. */
export const AttachFormBodySchema = strictBody({ formId: RallyFormIdSchema });
export type AttachFormBody = z.output<typeof AttachFormBodySchema>;

/** An attached form as `GET /api/events/forms` and `POST /api/events/forms` send it: Rally's summary, and who attached it. */
export const AttachedFormSchema = RallyFormSummarySchema.omit({ availability: true }).extend({
  attachedBy: z.string(),
  /** Whether the caller attached it: only they may detach it, or make an event from it. */
  mine: z.boolean().catch(false),
  /** Its best windows, best first, for an event made from it (`RallyWindow`); empty when its time question has no length. */
  windows: z.array(RallyWindowSchema).catch([]),
});
export type AttachedForm = z.infer<typeof AttachedFormSchema>;

export const FormListSchema = z.object({ forms: z.array(AttachedFormSchema).catch([]) });

const RALLY_ORIGIN = 'https://hadoku.me';

/**
 * A form id from what an organizer pastes: the bare id, or its Rally link
 * (`https://hadoku.me/rally?e=<id>`). Null for anything else.
 */
export function rallyFormIdOf(text: string): string | null {
  const trimmed = text.trim();
  if (RallyFormIdSchema.safeParse(trimmed).success) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.origin !== RALLY_ORIGIN || !/^\/rally\/?$/.test(url.pathname)) return null;
  const id = url.searchParams.get('e');
  return id !== null && RallyFormIdSchema.safeParse(id).success ? id : null;
}

/** Where "Create a form" sends the organizer: Rally's builder, from the app `origin`, returning to `returnUrl` with the new form (#22 §1). */
export function rallyCreateUrl(origin: string, ref: string, returnUrl: string): string {
  const q = new URLSearchParams({ origin, ref, return: returnUrl });
  return `${RALLY_ORIGIN}/rally?${q.toString()}`;
}

/** Rally's return trip, read from `location.search` (before any `#/` route): the new form and our ref, or null. */
export function rallyReturnOf(search: string): { formId: string; ref: string } | null {
  const q = new URLSearchParams(search);
  const formId = q.get('form');
  const ref = q.get('ref');
  if (formId === null || ref === null || ref === '' || ref.length > 200) return null;
  return RallyFormIdSchema.safeParse(formId).success ? { formId, ref } : null;
}