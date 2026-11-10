/* Events, Magic's part (the frame and Rally forms are `@hadoku/platform-wire/events`): the tournament
 * room an event plays, as Create event sets it up and the calendar reads it (`apps/server/src/room/events.ts`). */

import { eventListSchema, eventTitleSchema, eventViewSchema, rallyCreateUrl as rallyCreateUrlFor, RallyFormIdSchema, StartsAtSchema, strictBody, updateEventBodySchema } from '@hadoku/platform-wire/events';
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
const TournamentRoomSchema = strictBody({
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
export const CreateEventBodySchema = strictBody({
  title: eventTitleSchema(ROOM_NAME_MAX),
  startsAt: StartsAtSchema,
  room: TournamentRoomSchema.prefault({}),
  /** The Rally sign-up form it was made from: its count of who can make it shows as the event's `signedUp`. */
  formId: RallyFormIdSchema.optional(),
}).transform(({ title, startsAt, formId, room: { format, settings, plan, ...fields } }, ctx) => {
  const room = CreateRoomBodySchema.safeParse({ ...fields, name: title });
  if (!room.success) {
    for (const issue of room.error.issues) ctx.addIssue({ code: 'custom', path: ['room', ...issue.path.map(String)], message: issue.message });
    return z.NEVER;
  }
  const draft = room.data.gameType === 'draft';
  if (draft && format !== undefined) ctx.addIssue({ code: 'custom', path: ['room', 'format'], message: 'a draft room drafts its pool: send plan, not format' });
  if (!draft && plan !== undefined) ctx.addIssue({ code: 'custom', path: ['room', 'plan'], message: 'only a draft room has a plan' });
  return { title, startsAt, formId, room: room.data, format, settings: settings ?? {}, plan };
});
export type CreateEventBody = z.output<typeof CreateEventBodySchema>;

/** `PATCH /api/events/:id`: a new start, and the room's own name unchanged if sent. */
export const UpdateEventBodySchema = updateEventBodySchema(ROOM_NAME_MAX);
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

export const EventViewSchema = eventViewSchema(EventKindSchema, EventRoomSchema);
export type EventView = z.infer<typeof EventViewSchema>;

export const EventListSchema = eventListSchema(EventViewSchema);

/** Where "Create a form" sends the organizer: Rally's builder, returning to `returnUrl` with the new form. */
export const rallyCreateUrl = (ref: string, returnUrl: string): string => rallyCreateUrlFor('cardtable', ref, returnUrl);
