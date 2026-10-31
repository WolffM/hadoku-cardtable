/*
 * Scheduled events and attached Rally forms: the front page's calendar and polls
 * (`apps/server/src/room/events.ts`, `apps/server/src/http/events.ts`).
 *
 * An event is a tournament room with a start time. Creating one makes its room at once, with the
 * organizer as its leader and every setting the form chose, so players can sit and pick decks
 * ahead of time. The event keeps only that room's id and its schedule: its title, what it plays and
 * how are read from the room each time, so the organizer's edits in the room show on the calendar
 * at once (the operator, 2026-10-30: "the room is the source of truth").
 *
 * A form is a Rally form on schema `event-signup@1`, made on Rally with a return trip back here or
 * loaded by its link, and listed while Rally says it is open (WolffM/hadoku-cardtable#22).
 */

import { z } from 'zod';

import { PodPhaseSchema } from './pod.ts';
import { DraftPlanSchema } from './pool.ts';
import { ConstructedModeSchema, GameTypeSchema } from './room-modes.ts';
import { CreateRoomBodySchema, DEFAULT_ROOM_SETTINGS, DRAFT_POOL_PREFIX, ROOM_NAME_MAX, RoomSettingsSchema, type RoomSettings } from './room-requests.ts';

/**
 * What an event's room plays, read live from the room: `draft-pod` for a draft room,
 * `constructed-tournament` for a constructed room in tournament mode, `room` for a constructed
 * room its organizer has since taken out of tournament mode. `casual` is never sent: no event is
 * made without a room any more. It stays only while the front page's labels name it.
 */
export const EVENT_KINDS = ['draft-pod', 'constructed-tournament', 'room', 'casual'] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const titleField = z
  .string({ error: 'title must be a string' })
  .trim()
  .min(1, { error: `title must be 1–${ROOM_NAME_MAX} characters` })
  .max(ROOM_NAME_MAX, { error: `title must be 1–${ROOM_NAME_MAX} characters` })
  .refine((title) => !CONTROL.test(title), { error: 'title must not contain control characters' });

const startsAtField = z.iso.datetime({ offset: true, error: 'startsAt must be an ISO date-time' });

const strict = <S extends z.ZodRawShape>(shape: S) =>
  z.strictObject(shape, {
    error: (iss) => (iss.code === 'unrecognized_keys' ? `unknown field(s): ${iss.keys.join(', ')}` : 'body must be a JSON object'),
  });

/** Some of a room's settings, each in its own shape. `tournament` is the event's to set, not the form's. */
const TournamentSettingsSchema = z.strictObject(RoomSettingsSchema.omit({ tournament: true }).partial().shape, {
  error: (iss) => (iss.code === 'unrecognized_keys' ? `unknown setting(s): ${iss.keys.join(', ')}` : 'settings must be an object'),
});

const formatField = z
  .string({ error: 'format must be a format id' })
  .refine((v) => v.trim() !== '' && !v.startsWith(DRAFT_POOL_PREFIX), { error: 'format must be a format id' });

/**
 * The tournament's room, as Create event's form sets it up: every setting a room has. A
 * constructed room may name its mode (with its options) and its format; a draft room its pool
 * (`plan`). `settings` holds the rest — deck rule, clock, pick timer, hand smoothing.
 */
const TournamentRoomSchema = strict({
  gameType: z.unknown().optional(),
  clientMode: z.unknown().optional(),
  mode: z.unknown().optional(),
  modeOptions: z.unknown().optional(),
  password: z.unknown().optional(),
  format: formatField.optional(),
  settings: TournamentSettingsSchema.optional(),
  plan: DraftPlanSchema.optional(),
});

/**
 * `POST /api/events`: a tournament, its start, and its room's settings. The room is named after
 * the event. A format belongs to a constructed room and a plan to a draft room; each is refused
 * on the other.
 */
export const CreateEventBodySchema = strict({
  title: titleField,
  startsAt: startsAtField,
  room: TournamentRoomSchema.prefault({}),
}).transform(({ title, startsAt, room: { format, settings, plan, ...fields } }, ctx) => {
  const room = CreateRoomBodySchema.safeParse({ ...fields, name: title });
  if (!room.success) {
    for (const issue of room.error.issues) ctx.addIssue({ code: 'custom', path: ['room', ...issue.path.map(String)], message: issue.message });
    return z.NEVER;
  }
  const draft = room.data.gameType === 'draft';
  if (draft && format !== undefined) ctx.addIssue({ code: 'custom', path: ['room', 'format'], message: 'a draft room drafts its pool: send plan, not format' });
  if (!draft && plan !== undefined) ctx.addIssue({ code: 'custom', path: ['room', 'plan'], message: 'only a draft room has a plan' });
  return { title, startsAt, room: room.data, format, settings: settings ?? {}, plan };
});
export type CreateEventBody = z.output<typeof CreateEventBodySchema>;

/**
 * `PATCH /api/events/:id`, organizer only: a new start. `title` is accepted only as the room's
 * own name unchanged — an event is named after its room — so a form that sends its whole state
 * still saves.
 */
export const UpdateEventBodySchema = strict({ title: titleField.optional(), startsAt: startsAtField });
export type UpdateEventBody = z.output<typeof UpdateEventBodySchema>;

/** An event's room as it is now: what the calendar draws and what Sign up joins. */
export const EventRoomSchema = z.object({
  gameType: GameTypeSchema,
  /** A constructed room's mode, or null for a draft room and one whose leader has not chosen. */
  mode: ConstructedModeSchema.nullable().catch(null),
  /** A constructed room's pool: a frozen era's id, or `free`. */
  format: z.string().catch(''),
  settings: z
    .object(RoomSettingsSchema.partial().shape)
    .transform((s): RoomSettings => ({ ...DEFAULT_ROOM_SETTINGS, ...s }))
    .catch(() => ({ ...DEFAULT_ROOM_SETTINGS })),
  /** A draft room's three rounds by name (`PodView.roundNames`); null for a constructed room. */
  pool: z.tuple([z.string(), z.string(), z.string()]).nullable().catch(null),
  /** Whether joining takes a password. */
  locked: z.boolean().catch(false),
  /** The pod's phase, or null for a room with no pod. */
  phase: PodPhaseSchema.nullable().catch(null),
  /** Everybody in the room. */
  members: z.number().int().min(0).catch(0),
  /** Members sitting in the pod (in `lobby`), or drafting it (past `lobby`). */
  entrants: z.number().int().min(0).catch(0),
});
export type EventRoom = z.infer<typeof EventRoomSchema>;

/** One event as `GET /api/events` sends it, scoped to the caller (`mine`). */
export const EventViewSchema = z.object({
  id: z.string(),
  /** What the room plays now (`EVENT_KINDS`). */
  kind: EventKindSchema,
  /** The room's name. */
  title: z.string(),
  startsAt: z.string(),
  organizer: z.string(),
  /** Whether the caller organized it: only they may move or cancel it. */
  mine: z.boolean().catch(false),
  /** The event's room. An event whose room has closed is not listed. */
  roomId: z.string().nullable().catch(null),
  /** The room as it is now. Always sent; optional only so a reader's fixture may leave it out. */
  room: EventRoomSchema.nullable().catch(null).optional(),
});
export type EventView = z.infer<typeof EventViewSchema>;

export const EventListSchema = z.object({ events: z.array(EventViewSchema).catch([]) });

/* ── Rally forms ─────────────────────────────────────────────────────── */

/** The one Rally schema an event form may carry: a required availability grid (#22 §3). */
export const RALLY_EVENT_SCHEMA = { name: 'event-signup', version: 1 } as const;

export const RallyFormIdSchema = z.string({ error: 'formId must be a Rally form id' }).regex(/^[A-Za-z0-9_-]{1,64}$/, { error: 'formId must be a Rally form id' });

/** Rally's `GET /rally/api/forms/{id}/summary`, its `data`. */
export const RallyFormSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['open', 'closed']),
  closesAt: z.string().nullable(),
  url: z.string(),
  createdBy: z.string().nullable(),
  schema: z.object({ name: z.string(), version: z.number().int() }),
});
export type RallyFormSummary = z.infer<typeof RallyFormSummarySchema>;

/** Whether a form makes the promise an event form needs. */
export function isEventSignupForm(summary: Pick<RallyFormSummary, 'schema'>): boolean {
  return summary.schema.name === RALLY_EVENT_SCHEMA.name && summary.schema.version === RALLY_EVENT_SCHEMA.version;
}

/** `POST /api/events/forms`: attach a Rally form, checked through its summary. */
export const AttachFormBodySchema = strict({ formId: RallyFormIdSchema });
export type AttachFormBody = z.output<typeof AttachFormBodySchema>;

/** An attached form as `GET /api/events/forms` and `POST /api/events/forms` send it: Rally's summary, and who attached it. */
export const AttachedFormSchema = RallyFormSummarySchema.extend({
  attachedBy: z.string(),
  /** Whether the caller attached it: only they may detach it. */
  mine: z.boolean().catch(false),
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

/** Where "Create a form" sends the organizer: Rally's builder, returning to `returnUrl` with the new form (#22 §1). */
export function rallyCreateUrl(ref: string, returnUrl: string): string {
  const q = new URLSearchParams({ origin: 'cardtable', ref, return: returnUrl });
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
