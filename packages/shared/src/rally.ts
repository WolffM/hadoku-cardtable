/*
 * Rally's pick catalogues (cardtable#24, hadoku-rally `docs/requests/CARDTABLE_PICK_CATALOGUES.md`).
 *
 * A Rally form's "Pick from a catalogue" question can offer Cardtable's drafts: the organizer picks
 * a catalogue (`RallyCatalogue`), searches it, and every option Rally stores is a snapshot of one
 * `RallySuggestion`. A respondent then opens that option's two view pages in a frame, which read
 * `RallyCardsView` and `RallyPackView`.
 *
 * Rally checks `RallySource` and `RallySuggestion` against its own rules, so the patterns and caps
 * here are Rally's, copied: a kind or view id is `^[a-z][a-z0-9-]{0,31}$`, an option id
 * `^[A-Za-z0-9._:-]{1,64}$`, a label at most 200 characters. An image must be null, same-origin,
 * or under one of `RALLY_IMAGE_HOSTS`, because the site's CSP draws nothing else and Rally refuses
 * a form that names anything else.
 */

import { z } from 'zod';

import { DraftCardSchema } from './draft.ts';

/** The three catalogues Cardtable offers (the operator, 2026-11-01: "any of these"). */
export const RALLY_CATALOGUES = ['draft-preset', 'set', 'cube'] as const;
export const RallyCatalogueSchema = z.enum(RALLY_CATALOGUES);
export type RallyCatalogue = z.infer<typeof RallyCatalogueSchema>;

/** Each catalogue's two pages, `#/embed/{kind}/{id}/{view}`. */
export const RALLY_VIEWS = ['cards', 'pack'] as const;
export const RallyViewSchema = z.enum(RALLY_VIEWS);
export type RallyView = z.infer<typeof RallyViewSchema>;

/** An option id as Rally stores it, and as it rides in a view page's address. */
export const RALLY_OPTION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Where an option's cover may come from: what the site CSP's `img-src` allows. */
export const RALLY_IMAGE_HOSTS = ['https://cards.scryfall.io/', 'https://cdn.hadoku.me/'] as const;

export const RallySourceSchema = z.strictObject({
  kind: RallyCatalogueSchema,
  label: z.string().min(1).max(200),
  views: z
    .array(z.strictObject({ id: RallyViewSchema, label: z.string().min(1).max(40) }))
    .min(1)
    .max(4),
});
export type RallySource = z.infer<typeof RallySourceSchema>;

export const RallySuggestionSchema = z.strictObject({
  id: z.string().regex(RALLY_OPTION_ID),
  label: z.string().min(1).max(200),
  detail: z.string().max(200).nullable(),
  image: z
    .string()
    .refine((url) => RALLY_IMAGE_HOSTS.some((host) => url.startsWith(host)), 'an image Rally can draw')
    .nullable(),
});
export type RallySuggestion = z.infer<typeof RallySuggestionSchema>;

/** One labelled run of cards: a round's pool on the cards page, a pack on the pack page. */
export const RallyCardGroupSchema = z.strictObject({
  /** Null when the option has only the one group, so there is nothing to tell apart. */
  label: z.string().nullable(),
  cards: z.array(DraftCardSchema),
});
export type RallyCardGroup = z.infer<typeof RallyCardGroupSchema>;

/** `GET /api/rally/views/{kind}/{id}/cards`: every card the option drafts from, one group per distinct pool. */
export const RallyCardsViewSchema = z.strictObject({
  name: z.string(),
  groups: z.array(RallyCardGroupSchema).min(1),
});
export type RallyCardsView = z.infer<typeof RallyCardsViewSchema>;

/** `GET /api/rally/views/{kind}/{id}/pack`: a fresh pack, or one per round when the rounds draw from different pools. */
export const RallyPackViewSchema = z.strictObject({
  name: z.string(),
  packs: z.array(RallyCardGroupSchema).min(1),
});
export type RallyPackView = z.infer<typeof RallyPackViewSchema>;

/** Every Rally route answers in Rally's own wrapper. */
export function rallyEnvelope<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('success', [
    z.strictObject({ success: z.literal(true), data }),
    z.strictObject({ success: z.literal(false), error: z.string() }),
  ]);
}
