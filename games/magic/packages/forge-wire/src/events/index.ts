/*
 * The events arm of Tier C: what rides in `DeltaPacket.events`.
 *
 * A `DeltaPacket` carries two things. Its state maps are lane A's problem
 * (`../tier-c.ts`). Its `events` list is this directory's: every item is a
 * `TrackableSerializer.WrappedEvent(byte[])` — a `GameEvent` already
 * Java-serialized on the server — and a browser that base64-decodes those bytes
 * holds a Java object stream it cannot read. So the bridge must decode each one
 * in the JVM and forward JSON; this is the schema for that JSON.
 *
 *   modelled.ts  — 41 schemas, one per class a real match was captured firing
 *   refused.ts   — the other 17 of Forge's 58, refused by name
 *   common.ts    — the shared vocabulary (event card refs, enums, inline views)
 *   capture/     — the Java decoder that produced the fixtures, and its runner
 *   fixtures/    — decoded real instances, and the census of the capture run
 *
 * One JSON object per event, discriminated by `event` (the record's simple
 * class name). A card inside an event is an `EventCard` — `refs.ts`'s `CardRef`
 * plus the name/image-key snapshot the server attaches in event mode; a player
 * is `refs.ts`'s `PlayerRef` unchanged.
 */

import { z } from 'zod';

import { MODELLED_EVENTS } from './modelled.ts';
import { REFUSED_EVENT_SCHEMAS } from './refused.ts';

const MODELLED_SCHEMAS = Object.values(MODELLED_EVENTS);

/**
 * Any one event: 41 modelled arms and 17 refusing ones, on the `event` key.
 * An `event` name outside the 58 fails as an invalid discriminator.
 */
export const GameEventSchema = z.discriminatedUnion('event', [
  ...MODELLED_SCHEMAS,
  ...REFUSED_EVENT_SCHEMAS,
] as unknown as readonly [
  (typeof MODELLED_SCHEMAS)[number],
  ...Array<(typeof MODELLED_SCHEMAS)[number] | (typeof REFUSED_EVENT_SCHEMAS)[number]>,
]);

/** `DeltaPacket.events`, decoded: an ordered list, in the order the server fired them. */
export const GameEventListSchema = z.array(GameEventSchema);

export type GameEvent = z.infer<typeof GameEventSchema>;

export {
  MODELLED_EVENTS,
  MODELLED_EVENT_NAMES,
  EVENTS_NEEDING_JAVA_HELP,
  type ModelledEventName,
} from './modelled.ts';
export {
  REFUSED_EVENTS,
  REFUSED_EVENT_NAMES,
  EVENTS_CAPTURE,
  eventRefusal,
  type RefusedEventName,
} from './refused.ts';
export {
  EventCardSchema,
  EventEntitySchema,
  ZoneViewSchema,
  InlineSpellAbilitySchema,
  InlineStackItemSchema,
  CounterNameSchema,
  GAME_LOG_ENTRY_TYPES,
  GameLogEntryTypeSchema,
  EVENT_VALUE_CHANGE_TYPES,
  EventValueChangeTypeSchema,
  MAGIC_COLORS,
  MagicColorSchema,
  DAMAGE_TYPES,
  DamageTypeSchema,
  GAME_TYPES,
  GameTypeSchema,
  type EventCard,
  type EventEntity,
  type InlineSpellAbility,
  type InlineStackItem,
} from './common.ts';
