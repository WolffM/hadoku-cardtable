/*
 * The wildcard's Discord chat (`./WildcardCard.tsx`), laid out the way Discord's own client lays out
 * a channel: consecutive messages from one author within seven minutes share a header, and each
 * header carries Discord's own timestamp wording. ArchiveBot sends no avatars (`@hadoku/shared`'s
 * `discord.ts`), so an author's avatar is their initial on one of Discord's default-avatar colours,
 * picked from their name so it stays the same between visits.
 */

import type { DiscordMessage } from '@hadoku/shared';

/** Discord starts a new header after this long, even for the same author. */
export const GROUP_GAP_MS = 7 * 60_000;

export interface ChatGroup {
  author: string;
  /** The first message's `at`, for the header's timestamp. */
  at: string;
  texts: string[];
}

/** `messages` (newest last) as Discord groups them. */
export function groupMessages(messages: readonly DiscordMessage[]): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let lastAt = Number.NaN;
  for (const m of messages) {
    const at = Date.parse(m.at);
    const prev = groups.at(-1);
    if (prev !== undefined && prev.author === m.author && at - lastAt < GROUP_GAP_MS) prev.texts.push(m.text);
    else groups.push({ author: m.author, at: m.at, texts: [m.text] });
    lastAt = at;
  }
  return groups;
}

/** `Today at 3:14 PM`, `Yesterday at 3:14 PM`, or `10/27/2026 3:14 PM` — Discord's header wording, in the viewer's own time zone. */
export function discordTime(at: string, now: Date = new Date(), locale?: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  const time = when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return `${when.toLocaleDateString(locale)} ${time}`;
}

/** How many default-avatar colours `.discord-chat__avatar--N` in `front.css` defines. */
export const AVATAR_COLOURS = 6;

/** Which default-avatar colour `author` gets: the same one every visit. */
export function avatarColour(author: string): number {
  let hash = 0;
  for (const ch of author) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % AVATAR_COLOURS;
}

/** The letter on the avatar: the name's first letter or digit, upper-cased; `?` for a name without one. */
export function avatarInitial(author: string): string {
  const first = /[\p{L}\p{N}]/u.exec(author);
  return first === null ? '?' : first[0].toUpperCase();
}
