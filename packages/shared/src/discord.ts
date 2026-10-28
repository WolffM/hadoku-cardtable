/*
 * The cardtable Discord's general chat, as the front page's wildcard shows it: ArchiveBot's signed
 * `GET /api/messages/recent` (WolffM/ArchiveBot#37), relayed and cached by `apps/server/src/http/discord.ts`.
 * Plain text by ArchiveBot's own contract — no ids, avatars or links ever arrive.
 */

import { z } from 'zod';

export const DiscordMessageSchema = z.object({
  author: z.string(),
  text: z.string(),
  /** ISO, no milliseconds. */
  at: z.string(),
});
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;

/** Newest last. */
export const DiscordRecentSchema = z.object({ messages: z.array(DiscordMessageSchema) });
export type DiscordRecent = z.infer<typeof DiscordRecentSchema>;
