/*
 * The draft wire envelope, as Zod schemas.
 *
 * This is the contract the engine produces and the UI consumes. It supersedes
 * two placeholders that shipped with deletion conditions written on them:
 * `apps/ui/src/draft/types.ts` (which mirrored `@wolffm/rooms-protocol`'s seat
 * vocabulary because the registry could not be authenticated at the time) and
 * `apps/ui/src/draft/validate.ts` (a hand-written structural checker standing in
 * for exactly this file).
 *
 * ## Hidden information is a type, not a filter
 *
 * `ViewerView` is a discriminated union whose `spectator` arm is structurally
 * incapable of holding cards, and `DraftSeatView` carries `pickedCount` — a
 * number — rather than the picks. There is no field on this envelope that could
 * carry another seat's cards, so leaking one means *adding a field*, not
 * forgetting a filter. `apps/ui/src/draft/hiddenInfo.ts` asserts the same
 * property at runtime over whole serialised payloads, because JSON does not
 * typecheck.
 *
 * ## `epoch` is not decoration — see `SeqCursor`
 *
 * Every payload carries `{ epoch, seq }`, which is `@wolffm/rooms-protocol`'s
 * `SeqCursor` by another name, so `classifySeq` can be run over it directly.
 * The original envelope carried `seq` alone. That was a real bug: a sequence
 * number cannot distinguish "I missed events" from "the server restarted and
 * began counting again", and those need opposite responses — catch up versus
 * discard local state and refetch. Without an epoch, a client holding seq 500
 * meeting a restarted server counting from 1 reads every live event as a
 * duplicate and sits there discarding them forever.
 *
 * That second case is precisely our own P6 requirement ("a 45-minute draft
 * survives a server restart"), so the envelope as first committed could not
 * have met the thing it was written for.
 *
 * No images, ever (D13). `DraftCard` has no image field and must never grow one.
 */

import { z } from 'zod';
import { formatPath, semanticIssues, type ValidationFailure } from './semantics.ts';

/** Opaque id for one draft. */
export const DraftIdSchema = z.string().min(1);

/**
 * `fk:` / `dev:` / `eph:` — `@wolffm/rooms-protocol`'s tiered identity.
 *
 * Validated by prefix rather than re-implemented: the tier list belongs to that
 * package, and a copy here would drift the first time they add one.
 */
export const ParticipantIdSchema = z
  .string()
  .regex(/^(fk|dev|eph):.+/, 'ParticipantId must carry a fk:/dev:/eph: tier prefix');

/** Index into `seats`. Load-bearing order: the pack passes left, right, left. */
export const SeatIdSchema = z.number().int().nonnegative();

/** Mirrors `rooms-protocol`'s `SeatOccupant`. Bot ids are positional. */
export const SeatOccupantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), participantId: ParticipantIdSchema }),
  z.object({ kind: z.literal('bot'), botId: z.string().min(1) }),
]);

/** The five colours. Colourless and generic are not colours. */
export const ManaColorSchema = z.enum(['W', 'U', 'B', 'R', 'G']);

export const RaritySchema = z.enum(['common', 'uncommon', 'rare', 'mythic', 'special']);

/**
 * A card as the draft table needs it: enough to pick with, nothing more.
 *
 * `manaCost` is a list of symbol *tokens* (`['2','W','W']`, `['X','R']`,
 * `['W/U']`) rather than a rendered string, because we draw our own pips and a
 * renderer needs the pieces. Deliberately not a WotC symbol font.
 */
export const DraftCardSchema = z.object({
  /** Stable within one draft. Distinguishes two copies of the same card. */
  cardId: z.string().min(1),
  /**
   * Scryfall's own card id, carried ONLY so the browser can derive an image
   * URL for itself — see `apps/ui/src/draft/cardImage.ts`.
   *
   * The id, not a URL and not Scryfall's `image_uris` blob. Carrying the id
   * keeps the payload a *reference*: we never copy their image metadata, and
   * our server never learns an image URL, let alone fetches one. D13's rule is
   * "a link, not a host" (`docs/LICENSING.md` §Concrete rules 3), and an id is
   * the smallest thing that can be a link.
   *
   * Optional because the engine does not need it — a draft is playable from
   * text alone, and a card that failed to resolve has no id to carry.
   */
  scryfallId: z.string().uuid().optional(),
  name: z.string().min(1),
  manaCost: z.array(z.string()),
  manaValue: z.number().nonnegative(),
  colors: z.array(ManaColorSchema),
  typeLine: z.string(),
  oracleText: z.string(),
  power: z.string().optional(),
  toughness: z.string().optional(),
  loyalty: z.string().optional(),
  setCode: z.string(),
  collectorNumber: z.string(),
  rarity: RaritySchema,
});

/**
 * What everyone at the table may know about one seat.
 *
 * `pickedCount` is a count on purpose. Adding `picked: DraftCard[]` here is the
 * exact leak the hidden-information control exists to make impossible.
 */
export const DraftSeatViewSchema = z.object({
  id: SeatIdSchema,
  occupant: SeatOccupantSchema.nullable(),
  /** Presentational only. Never an identity. */
  displayName: z.string(),
  pickedCount: z.number().int().nonnegative(),
});

/** The recipient's own slice. The spectator arm carries no cards at all. */
export const ViewerViewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('seat'),
    seatId: SeatIdSchema,
    pack: z.array(DraftCardSchema),
    pool: z.array(DraftCardSchema),
  }),
  z.object({ kind: z.literal('spectator') }),
]);

/** Pack-pass direction for the current round. */
export const PassDirectionSchema = z.enum(['left', 'right']);

/**
 * One per-recipient draft payload.
 *
 * `epoch` + `seq` together are a `SeqCursor`: see the module header, and
 * `classifySeq` in `@wolffm/rooms-protocol`.
 */
export const DraftViewSchema = z.object({
  draftId: DraftIdSchema,
  /**
   * The draft INCARNATION. Changes when the draft is rebuilt and not otherwise,
   * so a restarted server counting `seq` from 1 again is distinguishable from a
   * gap. Any value works as long as it has that property.
   */
  epoch: z.string().min(1),
  /** Monotonic within an epoch, 1-based — a payload is never seq 0. */
  seq: z.number().int().positive(),
  /** 1-based. */
  packNumber: z.number().int().positive(),
  /** 1-based, within the current pack round. */
  pickNumber: z.number().int().positive(),
  packCount: z.number().int().positive(),
  /** Cards in a fresh pack, per the recipe. */
  packSize: z.number().int().positive(),
  passDirection: PassDirectionSchema,
  /** Pod size, or null for unbounded. Mirrors `SeatTable.capacity`. */
  capacity: z.number().int().positive().nullable(),
  /** Index === SeatId, same invariant as `rooms-protocol`'s `SeatTable`. */
  seats: z.array(DraftSeatViewSchema),
  /**
   * Seats still owing a pick this round — "whose turn it is", generalised.
   * A booster draft is simultaneous, so this is normally several seats.
   */
  waitingOn: z.array(SeatIdSchema),
  viewer: ViewerViewSchema,
});

export type DraftId = z.infer<typeof DraftIdSchema>;
export type ParticipantId = z.infer<typeof ParticipantIdSchema>;
export type SeatId = z.infer<typeof SeatIdSchema>;
export type SeatOccupant = z.infer<typeof SeatOccupantSchema>;
export type ManaColor = z.infer<typeof ManaColorSchema>;
export type Rarity = z.infer<typeof RaritySchema>;
export type DraftCard = z.infer<typeof DraftCardSchema>;
export type DraftSeatView = z.infer<typeof DraftSeatViewSchema>;
export type ViewerView = z.infer<typeof ViewerViewSchema>;
export type PassDirection = z.infer<typeof PassDirectionSchema>;
export type DraftView = z.infer<typeof DraftViewSchema>;

/** The seat arm of a viewer, or null for a spectator. */
export function viewerSeat(view: DraftView): Extract<ViewerView, { kind: 'seat' }> | null {
  return view.viewer.kind === 'seat' ? view.viewer : null;
}

/** Label for a seat: the human's name, or the bot's positional id. */
export function seatLabel(seat: DraftSeatView): string {
  if (seat.occupant === null) return `Seat ${seat.id} — empty`;
  return seat.displayName;
}

/** Whether this seat still owes a pick in the current round. */
export function isWaiting(view: DraftView, id: SeatId): boolean {
  return view.waitingOn.includes(id);
}

/**
 * Parse an unknown payload, throwing with the offending path.
 *
 * Replaces `apps/ui/src/draft/validate.ts`'s `expectDraftView`, which existed
 * only because this schema did not.
 */
export function parseDraftView(raw: unknown, label = 'payload'): DraftView {
  const result = safeParseDraftView(raw);
  if (result.ok) return result.value;
  const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  throw new Error(`${label} is not a valid DraftView:\n${detail}`);
}

/**
 * Non-throwing parse, reporting every failure at once.
 *
 * Runs BOTH checks: the structural schema, and `semanticIssues` over the raw
 * input. The second is not optional — Zod strips unknown keys, so a card that
 * grew an `image_uris` parses clean and the D13 violation is silently discarded
 * rather than reported. See `semantics.ts`.
 */
export function safeParseDraftView(
  raw: unknown,
): { ok: true; value: DraftView } | { ok: false; errors: ValidationFailure[] } {
  const structural = DraftViewSchema.safeParse(raw);
  const semantic = semanticIssues(raw);

  const errors: ValidationFailure[] = [];
  if (!structural.success) {
    for (const issue of structural.error.issues) {
      errors.push({ path: formatPath(issue.path as Array<string | number>), message: issue.message });
    }
  }
  errors.push(...semantic);

  if (errors.length > 0) return { ok: false, errors };
  // Safe: no errors means the structural parse succeeded.
  return { ok: true, value: (structural as { data: DraftView }).data };
}

/*
 * ── The deck HTTP contract ────────────────────────────────────────────────
 *
 * `GET /api/drafts/:podId/mine` and `PUT /api/drafts/:podId/deck` — the ONE
 * place a drafter's pool and built deck cross the wire outside the draft
 * socket itself. Stated here, matched by the server route
 * (`apps/server/src/http/drafts.ts`), so the UI and the server never drift on
 * the shape.
 *
 *   GET  …/mine   → 200 { pool, deck }            404 — caller drafted no seat
 *   PUT  …/deck   { dck }  → 200 { deck }          400 { issues } — not from your pool
 *
 * A save stores any build of the caller's own pool plus basics, finished or
 * not; deck size is the table's check, at ready and at start, never the save's.
 *
 * `issues` is a flat `string[]` — refusal MESSAGES, not `WireIssue` objects.
 * The editor has nothing to do with a card-shaped issue object beyond
 * displaying its sentence, and `WireIssue` is `apps/server/src/http/gate.ts`'s
 * own type, not this package's to mirror.
 */

/** `GET /api/drafts/:podId/mine`. */
export const DraftMineSchema = z.object({
  pool: z.array(DraftCardSchema),
  /** The caller's last saved build, `.dck` text — or null before the first save. */
  deck: z.string().nullable(),
});
export type DraftMine = z.infer<typeof DraftMineSchema>;

/** `PUT /api/drafts/:podId/deck` body. */
export const SaveDraftDeckBodySchema = z.object({ dck: z.string().min(1) });
export type SaveDraftDeckBody = z.infer<typeof SaveDraftDeckBodySchema>;

/** `PUT /api/drafts/:podId/deck`, 200: the `.dck` that was saved, byte for byte. */
export const SaveDraftDeckResponseSchema = z.object({ deck: z.string() });
export type SaveDraftDeckResponse = z.infer<typeof SaveDraftDeckResponseSchema>;

/** `PUT /api/drafts/:podId/deck`, 400: a card outside the pool, or a malformed `.dck`. */
export const SaveDraftDeckRefusalSchema = z.object({ issues: z.array(z.string()) });
export type SaveDraftDeckRefusal = z.infer<typeof SaveDraftDeckRefusalSchema>;

export type { ValidationFailure } from './semantics.ts';
