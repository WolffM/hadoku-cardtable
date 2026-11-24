/*
 * The caller's own art rules, from the browser's side (`games/magic/server/src/http/me.ts`):
 *
 *   `GET /api/me/art`              → `{ oldest, picks }`
 *   `PUT /api/me/art`              `{ oldest, picks }` → `{ oldest, picks }`, the rules as stored
 *   `GET /api/cards/printings?name=` → `{ name, printings }`, oldest first (`server/src/http/cards.ts`)
 *
 * `picks` maps a card's normalised name (trimmed, lower case: `normaliseName`) to the Scryfall id of
 * the printing its owner picked; `oldest` is "Always use oldest art". The server resolves them at
 * match start, a pick before "oldest" before the default printing (`server/src/play/art-pins.ts`).
 *
 * The PUT replaces the whole document, so every change is a read, the change, then the write
 * (`changeArt`): a change made in another tab since this page last read is kept, not overwritten.
 * The server refuses the whole PUT when any pick is not a printing of its card, and the caller then
 * shows the rules as they were.
 */

import { z } from 'zod';

import { apiBase, bodyOf, getJson, pageFetch, sendJson, serverMessage, type Fetch } from '@hadoku/game-ui/http.ts';

const ArtRulesSchema = z.object({ oldest: z.boolean(), picks: z.record(z.string(), z.string()) });
export type ArtRules = z.infer<typeof ArtRulesSchema>;

const PrintingSchema = z.object({
  scryfallId: z.string(),
  set: z.string(),
  collectorNumber: z.string(),
  releasedAt: z.string().nullable(),
  artist: z.string().nullable(),
});
export type CardPrinting = z.infer<typeof PrintingSchema>;

export type ArtChange = { ok: true; rules: ArtRules } | { ok: false; message: string };

export interface ArtClient {
  getArt(): Promise<ArtRules>;
  putArt(rules: ArtRules): Promise<ArtChange>;
  /** A card's printings, oldest first. */
  printings(name: string): Promise<CardPrinting[]>;
}

/** The key a card's pick is stored under: the server's `normaliseName` (`@hadoku/carddata`, whose index reads files and stays out of the browser). */
export const pickKey = (name: string): string => name.trim().toLowerCase();

/** `rules` with `name`'s pick set to `scryfallId`, or cleared by `null`. */
export function withPick(rules: ArtRules, name: string, scryfallId: string | null): ArtRules {
  const { [pickKey(name)]: _dropped, ...picks } = rules.picks;
  return { ...rules, picks: scryfallId === null ? picks : { ...picks, [pickKey(name)]: scryfallId } };
}

async function read<T>(url: string, schema: z.ZodType<T>, what: string, fetchImpl: Fetch): Promise<T> {
  let res: Response;
  try {
    res = await getJson(url, fetchImpl);
  } catch {
    throw new Error('Could not reach the server.');
  }
  const body = await bodyOf(res);
  if (!res.ok) throw new Error(`Could not load ${what}: ${serverMessage(body, res.status)}.`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`The server sent something this app cannot read as ${what}.`);
  return parsed.data;
}

export function artClient(fetchImpl: Fetch = pageFetch, base: string = apiBase()): ArtClient {
  return {
    getArt: () => read(`${base}me/art`, ArtRulesSchema, 'your card art', fetchImpl),

    async putArt(rules) {
      let res: Response;
      try {
        res = await sendJson(`${base}me/art`, 'PUT', rules, fetchImpl);
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: serverMessage(body, res.status) };
      const stored = ArtRulesSchema.safeParse(body);
      return stored.success ? { ok: true, rules: stored.data } : { ok: false, message: 'The server sent something this app cannot read as your card art.' };
    },

    async printings(name) {
      const found = await read(`${base}cards/printings?${new URLSearchParams({ name }).toString()}`, z.object({ printings: z.array(PrintingSchema) }), 'its printings', fetchImpl);
      return found.printings;
    },
  };
}

/**
 * One change to the stored rules: read them fresh, apply `edit`, write the result. On a refusal the
 * answer carries the message, and the caller draws the rules it held before the change.
 */
export async function changeArt(client: ArtClient, edit: (rules: ArtRules) => ArtRules): Promise<ArtChange> {
  let current: ArtRules;
  try {
    current = await client.getArt();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  return client.putArt(edit(current));
}
