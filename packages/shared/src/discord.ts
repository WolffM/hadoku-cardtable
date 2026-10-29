/*
 * The cardtable Discord's general chat, as the front page's wildcard shows it: ArchiveBot's signed
 * `GET /api/messages/recent` (WolffM/ArchiveBot#37), relayed and cached by `apps/server/src/http/discord.ts`.
 * Plain text by ArchiveBot's own contract — no ids or links ever arrive. The avatar comes as the
 * image itself, a `data:` URI (hadoku.me's CSP admits those, not Discord's CDN).
 */

import { z } from 'zod';

/** A malformed avatar or colour costs only itself (it draws Discord's way without one), never the whole snapshot. */
export const DiscordMessageSchema = z.object({
  author: z.string(),
  /** The author's avatar as Discord draws it in the server, a 64px `data:` URI; null when ArchiveBot could not read it. */
  avatar: z
    .string()
    .regex(/^data:image\/(?:png|webp|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/)
    .nullable()
    .catch(null),
  /** Their name's role colour, `#rrggbb`; null for Discord's default. */
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable()
    .catch(null),
  text: z.string(),
  /** ISO, no milliseconds. */
  at: z.string(),
});
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;

/** Newest last. */
export const DiscordRecentSchema = z.object({ messages: z.array(DiscordMessageSchema) });
export type DiscordRecent = z.infer<typeof DiscordRecentSchema>;
