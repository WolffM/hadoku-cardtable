/*
 * Scheduled events: the front page's Upcoming card and its calendar (`apps/server/src/room/events.ts`).
 *
 * An event of a room kind makes its room the moment it is created, with the organizer as its
 * leader, so players can sit and pick decks ahead of time; a casual event is a calendar entry only.
 * Only the organizer edits or cancels one, and cancelling closes a room that has not started.
 */

import { z } from 'zod';

import { CreateRoomBodySchema, ROOM_NAME_MAX } from './room-requests.ts';

/**
 * `draft-pod`: a cube draft pod. `constructed-tournament`: a constructed room in tournament mode.
 * `room`: any room the Create room form makes, with its own fields. `casual`: no room at all.
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

/**
 * `POST /api/events`. `room` is the Create room form's own body, for a `room` event only; a
 * `draft-pod` or `constructed-tournament` room is named after the event and set up in the room.
 */
export const CreateEventBodySchema = strict({
  kind: EventKindSchema,
  title: titleField,
  startsAt: startsAtField,
  room: z.unknown().optional(),
}).transform(({ room, ...event }, ctx) => {
  if (event.kind !== 'room') {
    if (room !== undefined) ctx.addIssue({ code: 'custom', path: ['room'], message: 'only a room event takes room fields' });
    return { ...event, room: undefined };
  }
  const parsed = CreateRoomBodySchema.safeParse({ ...(typeof room === 'object' && room !== null ? room : {}), name: event.title });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['room', ...issue.path.map(String)], message: issue.message });
    return z.NEVER;
  }
  return { ...event, room: parsed.data };
});
export type CreateEventBody = z.output<typeof CreateEventBodySchema>;

/** `PATCH /api/events/:id`, organizer only: a new title, a new start, or both. */
export const UpdateEventBodySchema = strict({ title: titleField.optional(), startsAt: startsAtField.optional() }).refine(
  (b) => b.title !== undefined || b.startsAt !== undefined,
  { error: 'nothing to change: send title, startsAt or both' },
);
export type UpdateEventBody = z.output<typeof UpdateEventBodySchema>;

/** One event as `GET /api/events` sends it, scoped to the caller (`mine`). */
export const EventViewSchema = z.object({
  id: z.string(),
  kind: EventKindSchema,
  title: z.string(),
  startsAt: z.string(),
  organizer: z.string(),
  /** Whether the caller organized it: only they may edit or cancel it. */
  mine: z.boolean().catch(false),
  /** The room it made, while that room is still there; null for a casual event or a room since closed. */
  roomId: z.string().nullable().catch(null),
});
export type EventView = z.infer<typeof EventViewSchema>;

export const EventListSchema = z.object({ events: z.array(EventViewSchema).catch([]) });
