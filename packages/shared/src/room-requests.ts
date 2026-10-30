/**
 * What `/api/rooms` accepts: one strict schema per route, with the limits the
 * room screen's form enforces before it sends. Every refusal's text lives on
 * the schema that raises it, because the screen shows `error` as it arrives;
 * the server answers the first one (`http/request.ts`'s `parseBody`).
 *
 * A body field nobody named is refused, never dropped: `{ clientMode }` on a
 * PATCH is a client that meant something this route does not do.
 */

import { z } from 'zod';

import { POD_SEATS } from './pod.ts';
import { CONSTRUCTED_MODES, DEFAULT_GAME_TYPE, GAME_TYPES, GameTypeSchema, RoomModeSchema, type RoomMode } from './room-modes.ts';

export const ROOM_NAME_MAX = 60;
export const ROOM_PASSWORD_MAX = 200;
/**
 * Watchparty's own bound on an avatar id (`sprite: z.string().min(1).max(32)` in
 * `@wolffm/watchparty-ui@0.39.8`'s bundled `room-chrome.js`).
 */
export const AVATAR_ID_MAX = 32;
/** Watchparty's room id is opaque to us; this only bounds what is hashed. */
export const WATCHPARTY_ROOM_MAX = 200;

/**
 * Which client the room's players sit in front of: our own React table
 * (`builtin`), or Forge's full client streamed from a per-seat container
 * (`streamed`). Chosen at create and never again: the mode decides what the
 * server provisions for a room, so PATCH refuses the field outright.
 */
export const CLIENT_MODES = ['builtin', 'streamed'] as const;
export const ClientModeSchema = z.enum(CLIENT_MODES);
export type ClientMode = z.infer<typeof ClientModeSchema>;
export const DEFAULT_CLIENT_MODE: ClientMode = 'builtin';

/**
 * A room's match settings and the same-shaped per-room toggles that ride with
 * them. Most are booleans with a default; `tournamentDecks` is the one
 * exception (see below), which is why `SettingsPatchSchema` (this file) and
 * `isStoredSettings`/`storedSettings` (`room/lobby.ts`) read each field's OWN
 * schema off `RoomSettingsSchema.shape` rather than assuming every value is a
 * boolean.
 *
 * `handSmoothing` (on by default): the opening hand is the closer of two to the
 * deck's land ratio, and each mulligan's redraw is weighted toward it —
 * `MatchSpec.handSmoothing`, and Forge's `HandSmoothing` in our fork.
 *
 * `tournament` (off by default, `docs/planning/tournament-mode-plan.md`):
 * a Constructed room plays a Swiss pod of its own mode, the same seats/rounds
 * machinery a `draft` room's pod uses (`room/lobby.ts`'s `PodRecord`). The
 * leader's to flip, and only while the pod is still in its `lobby` phase —
 * once seats lock it is frozen along with everything else about the field.
 *
 * `tournamentDecks` (`'locked'` by default): only meaningful with `tournament`
 * on. `'locked'`: Classic and All Random fix each entrant's deck once (at the
 * lock for Classic/All Random; after a Gauntlet entrant's first match's own
 * draft, for Gauntlet — see `room/lobby.ts`'s locked-deck store) and replay it
 * every round. `'per-round'`: each round deals or re-picks fresh, as a normal
 * table already does.
 *
 * `clock` (`'auto'` by default): the chess clock, {@link MATCH_CLOCK_MS} per
 * player for a whole series. `'auto'` is on exactly when the room plays a
 * pod — a tournament, or a draft; `'on'`/`'off'` are the leader's word either
 * way ({@link clockOn}).
 *
 * `pickTimer` (off by default): a draft's per-pick timer, the MTR's times by
 * cards left in the pack divided by `speed` (2 is twice as fast).
 *
 * How long a series runs is not a setting: it is the room's game type, mode
 * and `tournament` flag (`room/series.ts`'s `seriesFormatOf`).
 */
export const TOURNAMENT_DECK_POLICIES = ['locked', 'per-round'] as const;
export const TournamentDecksSchema = z.enum(TOURNAMENT_DECK_POLICIES);
export type TournamentDecks = z.infer<typeof TournamentDecksSchema>;

export const CLOCK_SETTINGS = ['auto', 'on', 'off'] as const;
export const ClockSettingSchema = z.enum(CLOCK_SETTINGS);
export type ClockSetting = z.infer<typeof ClockSettingSchema>;
/** Each player's time for a whole series (operator, 2026-10-30: "20 minutes per player per match"). */
export const MATCH_CLOCK_MS = 20 * 60_000;

export const PICK_TIMER_SPEED_MIN = 0.25;
export const PICK_TIMER_SPEED_MAX = 4;
export const PickTimerSchema = z.strictObject({
	on: z.boolean(),
	speed: z.number().min(PICK_TIMER_SPEED_MIN).max(PICK_TIMER_SPEED_MAX),
});
export type PickTimer = z.infer<typeof PickTimerSchema>;

export const RoomSettingsSchema = z.strictObject({
	handSmoothing: z.boolean(),
	tournament: z.boolean(),
	tournamentDecks: TournamentDecksSchema,
	clock: ClockSettingSchema,
	pickTimer: PickTimerSchema,
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;
export const DEFAULT_ROOM_SETTINGS: Readonly<RoomSettings> = Object.freeze({
	handSmoothing: true,
	tournament: false,
	tournamentDecks: 'locked',
	clock: 'auto',
	pickTimer: Object.freeze({ on: false, speed: 1 }),
});

/** Whether a room's games run the chess clock: `'auto'` is on in a room that plays a pod (a tournament, or a draft). */
export function clockOn(settings: Pick<RoomSettings, 'clock' | 'tournament'>, gameType: string): boolean {
	return settings.clock === 'on' || (settings.clock === 'auto' && (settings.tournament || gameType === 'draft'));
}

/**
 * What makes a room's pool a DRAFTED pool rather than a frozen era.
 *
 * A colon, because a frozen era id is a date and `ROOM_ID_RE` allows no colon —
 * so no pod id and no era id can ever be mistaken for the other, and the
 * discrimination needs no version field.
 */
export const DRAFT_POOL_PREFIX = 'draft:';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A request body: a JSON object naming only the fields its route reads. */
function body<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(shape, {
    error: (iss) => (iss.code === 'unrecognized_keys' ? `unknown field(s): ${iss.keys.join(', ')}` : 'body must be a JSON object'),
  });
}

const oneOf = (field: string, values: readonly string[]): string => `${field} must be one of: ${values.join(', ')}`;
const gameTypeField = z.enum(GAME_TYPES, { error: oneOf('gameType', GAME_TYPES) });
const seatField = z.int({ error: `seat must be an integer 0..${POD_SEATS - 1}` }).min(0).max(POD_SEATS - 1);

/**
 * `undefined`, `null` and `""` all mean "no password": a blank form field is
 * an open room, not an error. The messages never echo the value.
 */
const passwordField = z
  .string({ error: 'password must be a string' })
  .max(ROOM_PASSWORD_MAX, { error: `password must be at most ${ROOM_PASSWORD_MAX} characters` })
  .nullish()
  .transform((v) => (v === null || v === '' ? undefined : v));

/**
 * A constructed room's mode with its options (`RoomModeSchema`): Classic and
 * Gauntlet may leave `modeOptions` out, All Random may not. Options that belong
 * to another mode are refused, never dropped.
 */
function roomMode(mode: unknown, modeOptions: unknown): { ok: true; value: RoomMode } | { ok: false; error: string } {
  if (!(CONSTRUCTED_MODES as readonly unknown[]).includes(mode)) return { ok: false, error: oneOf('mode', CONSTRUCTED_MODES) };
  const parsed = RoomModeSchema.safeParse(modeOptions === undefined ? { mode } : { mode, modeOptions });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `modeOptions are not ${String(mode)}'s options` };
}

const refuse = (ctx: z.core.$RefinementCtx, input: unknown, message: string): typeof z.NEVER => {
  ctx.issues.push({ code: 'custom', message, input });
  return z.NEVER;
};

/** `POST /api/rooms`. A mode belongs to a constructed room only. */
export const CreateRoomBodySchema = body({
  name: z
    .string({ error: 'name must be a string' })
    .trim()
    .min(1, { error: `name must be 1–${ROOM_NAME_MAX} characters` })
    .max(ROOM_NAME_MAX, { error: `name must be 1–${ROOM_NAME_MAX} characters` })
    .refine((name) => !CONTROL.test(name), { error: 'name must not contain control characters' }),
  gameType: gameTypeField.default(DEFAULT_GAME_TYPE),
  clientMode: z.enum(CLIENT_MODES, { error: oneOf('clientMode', CLIENT_MODES) }).default(DEFAULT_CLIENT_MODE),
  password: passwordField,
  mode: z.unknown().optional(),
  modeOptions: z.unknown().optional(),
}).transform(({ mode, modeOptions, ...room }, ctx) => {
  if (mode === undefined && modeOptions === undefined) return { ...room, mode: undefined };
  if (room.gameType !== 'constructed-1v1') return refuse(ctx, mode, 'only a constructed room has a mode');
  const parsed = roomMode(mode, modeOptions);
  return parsed.ok ? { ...room, mode: parsed.value } : refuse(ctx, mode, parsed.error);
});
export type CreateRoomBody = z.output<typeof CreateRoomBodySchema>;

/** `POST /api/rooms/:id/join`. No body at all is a join with no password. */
export const JoinRoomBodySchema = body({ password: passwordField }).prefault({});

/** `POST /api/rooms/watchparty`: the watchparty room whose game slot this is. */
export const WatchpartyBindBodySchema = body({
  room: z
    .string({ error: `room must be 1–${WATCHPARTY_ROOM_MAX} characters` })
    .min(1, { error: `room must be 1–${WATCHPARTY_ROOM_MAX} characters` })
    .max(WATCHPARTY_ROOM_MAX, { error: `room must be 1–${WATCHPARTY_ROOM_MAX} characters` })
    .refine((room) => !CONTROL.test(room), { error: 'room must not contain control characters' }),
});

/**
 * `POST /api/rooms/:id/identity`: `{ avatarId }`, where the field is REQUIRED
 * and may be null. A string is "this is my character", `null` is "I have none
 * any more", and ABSENT is neither, so it is a 400 rather than a write that
 * changed nothing. `''` is refused rather than folded into `null`: on this
 * route it is a client bug, and telling it so is cheaper than it finding out
 * from a face that will not draw.
 */
export const SetAvatarBodySchema = body({
  avatarId: z
    .string({ error: 'avatarId must be a string or null' })
    .trim()
    .min(1, { error: `avatarId must be 1–${AVATAR_ID_MAX} characters, or null to clear it` })
    .max(AVATAR_ID_MAX, { error: `avatarId must be 1–${AVATAR_ID_MAX} characters, or null to clear it` })
    .nullable(),
});

/** `POST /api/rooms/:id/ready`: the caller's own readiness in the room. */
export const ReadyBodySchema = body({ ready: z.boolean({ error: 'ready must be a boolean' }) });

/** A request that carries nothing: leave, close, start, stand, play. No body at all is the same as `{}`. */
export const EmptyBodySchema = body({}).prefault({});

/** `POST /api/rooms/:id/pod/sit`: `{}` takes the first free seat, `{ seat }` that one. */
export const SitBodySchema = body({ seat: seatField.optional() }).prefault({});

/** `POST /api/rooms/:id/pod/ai`: an AI in this seat, or not. */
export const PodAiBodySchema = body({ seat: seatField, on: z.boolean({ error: 'on must be true or false' }) });

/** `POST /api/rooms/:id/pod/close`: close an empty seat, or open a closed one. */
export const PodCloseBodySchema = body({ seat: seatField, closed: z.boolean({ error: 'closed must be true or false' }) });

/**
 * Each setting's own PATCH schema and refusal text, keyed by name so a PATCH
 * validates `tournamentDecks` as the enum it is rather than the boolean every
 * OTHER setting happens to be. Add a setting here, not as a one-off special
 * case below.
 */
const SETTINGS_FIELD_SCHEMAS: { [K in keyof RoomSettings]: z.ZodType<RoomSettings[K]> } = {
  handSmoothing: z.boolean({ error: 'settings.handSmoothing must be a boolean' }),
  tournament: z.boolean({ error: 'settings.tournament must be a boolean' }),
  tournamentDecks: z.enum(TOURNAMENT_DECK_POLICIES, { error: oneOf('settings.tournamentDecks', TOURNAMENT_DECK_POLICIES) }),
  clock: z.enum(CLOCK_SETTINGS, { error: oneOf('settings.clock', CLOCK_SETTINGS) }),
  pickTimer: z.custom<PickTimer>((v) => PickTimerSchema.safeParse(v).success, {
    error: `settings.pickTimer must be { on: boolean, speed: ${PICK_TIMER_SPEED_MIN}–${PICK_TIMER_SPEED_MAX} }`,
  }),
};

/**
 * Some of the room's settings. An empty object is refused: a PATCH that
 * changes nothing is a client that meant something else.
 */
const SettingsPatchSchema = z
  .strictObject(
    Object.fromEntries(Object.entries(SETTINGS_FIELD_SCHEMAS).map(([k, schema]) => [k, schema.optional()])),
    { error: (iss) => (iss.code === 'unrecognized_keys' ? `unknown setting(s): ${iss.keys.join(', ')}` : 'settings must be an object') },
  )
  .refine((o) => Object.keys(o).length > 0, { error: 'settings names no setting' })
  .transform((o) => o as Partial<RoomSettings>);

/**
 * A format id is any non-blank string; whether it names a pool the server has
 * is the tables layer's answer (a 409 about the room, not a 400 about the body).
 * A drafted pool is refused at the door: a drafted deck is played on Free pick,
 * from "My decks", as its saved `.dck`.
 */
const FormatFieldSchema = z
  .string({ error: 'format must be a format id' })
  .refine((v) => v.trim() !== '', { error: 'format must be a format id' })
  .refine((v) => !v.startsWith(DRAFT_POOL_PREFIX), { error: 'format must be a format id: a drafted deck is played on Free pick' });

/**
 * `PATCH /api/rooms/:id`: one field, one mutation. Two fields are refused
 * rather than applied in some order, because each has its own refusal and a
 * body whose halves disagree must not half-land. `modeOptions` rides with `mode`.
 */
export const PatchRoomBodySchema = body({
  gameType: z.unknown().optional(),
  format: z.unknown().optional(),
  settings: z.unknown().optional(),
  mode: z.unknown().optional(),
  modeOptions: z.unknown().optional(),
}).transform(
  (
    o,
    ctx,
  ): { gameType: z.infer<typeof GameTypeSchema> } | { format: string } | { settings: Partial<RoomSettings> } | { mode: RoomMode } => {
    const modeField = o.mode !== undefined || o.modeOptions !== undefined ? true : undefined;
    if ([o.gameType, o.format, o.settings, modeField].filter((v) => v !== undefined).length > 1) {
      return refuse(ctx, o, 'patch one field at a time: gameType, format, settings or mode');
    }
    const first = (r: z.ZodSafeParseError<unknown>): typeof z.NEVER => refuse(ctx, o, r.error.issues[0]?.message ?? 'body is not a room patch');
    if (modeField) {
      const mode = roomMode(o.mode, o.modeOptions);
      return mode.ok ? { mode: mode.value } : refuse(ctx, o.mode, mode.error);
    }
    if (o.settings !== undefined) {
      const settings = SettingsPatchSchema.safeParse(o.settings);
      return settings.success ? { settings: settings.data } : first(settings);
    }
    if (o.format !== undefined) {
      const format = FormatFieldSchema.safeParse(o.format);
      return format.success ? { format: format.data } : first(format);
    }
    const gameType = gameTypeField.safeParse(o.gameType);
    return gameType.success ? { gameType: gameType.data } : first(gameType);
  },
);
export type PatchRoomBody = z.output<typeof PatchRoomBodySchema>;
