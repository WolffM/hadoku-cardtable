/* Presence: each player's pointer, relayed seat to seat. What a point is anchored to is the game's;
 * the board's frame, the seat stamped on the echo and how often a seat may send are every game's. */
import { z } from 'zod';

/** A fraction across or down the WHOLE board: 0 at its left or top edge, 1 at its right or bottom. */
export const BoardFractionSchema = z.number().min(0).max(1);

/** Server → the match's other sockets: a game's presence message, stamped with the seat it came from. */
export const presenceEchoSchema = <Shape extends z.ZodRawShape, C extends z.core.$ZodObjectConfig>(message: z.ZodObject<Shape, C>) =>
  message.extend({ seat: z.number().int().min(0) }).strict();

/**
 * How often a seat may send: the sender throttles to `PRESENCE_SEND_MS`, and
 * the server drops anything past `PRESENCE_MAX_PER_SECOND` from one socket
 * (a client bug, not a game event; nothing is owed back for it).
 */
export const PRESENCE_SEND_MS = 60;
export const PRESENCE_MAX_PER_SECOND = 40;
