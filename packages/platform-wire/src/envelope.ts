/* The server → client envelope around one frame of a match's stream: which match, the stream's
 * cursor, and the game's `Frame`. A game adds its own flags with `.extend`. */
import { z } from 'zod';

/** `{ epoch, seq }` — structurally `@wolffm/rooms-protocol`'s `SeqCursor`, which is deliberately zod-free. */
export const SeqCursorSchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().positive(),
});

export type WireCursor = z.infer<typeof SeqCursorSchema>;

export const serverEnvelopeSchema = <F extends z.ZodType>(frame: F) => z.object({ matchId: z.string().min(1), cursor: SeqCursorSchema, frame });

export interface ServerEnvelope<Frame> {
  matchId: string;
  cursor: WireCursor;
  frame: Frame;
}
