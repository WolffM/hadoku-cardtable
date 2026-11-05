/*
 * The table messages one seat's screen relays to the others through the play server, never through
 * Forge: where a played card goes (`placement.ts`), a seat's row order (`arrangement.ts`) and a stack
 * card's place (`placed.ts`). A live board hears each on its socket; a replay hears the same echoes
 * from its recording (`apps/server/src/play/recording/`), at the moment they were relayed, so it lays
 * the table out as the players saw it. Each schema refuses a hidden card, so a recording of them
 * holds nothing a watcher could not see.
 */
import { z } from 'zod';

import { ARRANGEMENT_EVENT, ArrangementEchoSchema } from './arrangement.ts';
import { PLACED_EVENT, PlacedEchoSchema } from './placed.ts';
import { PLACEMENT_EVENT, PlacementEchoSchema } from './placement.ts';

export const RELAYED_ECHO_SCHEMAS = {
  [PLACEMENT_EVENT]: PlacementEchoSchema,
  [ARRANGEMENT_EVENT]: ArrangementEchoSchema,
  [PLACED_EVENT]: PlacedEchoSchema,
} as const satisfies Record<string, z.ZodType>;

export type RelayedEvent = keyof typeof RELAYED_ECHO_SCHEMAS;

export const isRelayedEvent = (v: unknown): v is RelayedEvent => typeof v === 'string' && Object.hasOwn(RELAYED_ECHO_SCHEMAS, v);
