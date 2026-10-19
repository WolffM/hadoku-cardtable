/*
 * The invariants a Zod schema cannot express.
 *
 * `draft.ts` gives the envelope its *shape*. This file gives it its *rules* —
 * the cross-field facts that make a payload coherent, and the ones that make it
 * safe. They are checked over the RAW input rather than the parsed value on
 * purpose: Zod strips unknown keys by default, so by the time a payload has
 * been parsed, an `image_uris` smuggled onto a card is already gone and there
 * is nothing left to reject. Stripping is exactly the wrong behaviour for a
 * rule whose entire job is to notice an added field.
 *
 * These rules were written as a hand-rolled validator in `apps/ui` while the
 * schema did not exist, and porting them here rather than dropping them was not
 * optional: the first run of the schema against the existing UI tests failed
 * ten of them, every one a rule Zod's structural check is simply blind to.
 * That is the regression this file exists to prevent.
 *
 * Failures accumulate with a JSON path. A validator that stops at the first
 * problem tells you one thing per run about a payload with fifteen cards in it.
 */

export interface ValidationFailure {
  path: string;
  message: string;
}

/** `['seats', 4, 'pool']` -> `$.seats[4].pool`. Array indices are bracketed. */
export function formatPath(parts: ReadonlyArray<string | number>): string {
  let out = '$';
  for (const part of parts) {
    out += typeof part === 'number' ? `[${part}]` : `.${part}`;
  }
  return out;
}

/** Fields a card may carry. Anything else is a failure; see `IMAGE_HINT`. */
const CARD_FIELDS = new Set([
  'cardId',
  // Scryfall's id. Permitted, and deliberately NOT an image field: it is an
  // identifier the browser turns into a URL itself. See draft.ts.
  'scryfallId',
  'name',
  'manaCost',
  'manaValue',
  'colors',
  'typeLine',
  'oracleText',
  'power',
  'toughness',
  'loyalty',
  'setCode',
  'collectorNumber',
  'rarity',
  // The card's other faces (`CardFaceSchema`): each is checked as a card is, below.
  'faces',
]);

/** Fields one of a card's other faces may carry: a card's, less its own identity and faces. */
const FACE_FIELDS = new Set([...CARD_FIELDS].filter((f) => f !== 'cardId' && f !== 'faces'));

/**
 * What an image reference looks like, however it is spelled.
 *
 * **D13's image clause was repealed by D15 on 2026-09-15** — card art is now
 * hosted on `cdn.hadoku.me`. This control did NOT go away with it, because what
 * it guards changed rather than ended: the *payload* must stay a reference.
 *
 * A card carries `scryfallId`, and a URL is built in the browser at render time
 * (`apps/ui/src/draft/cardImage.ts`). A URL or an `image_uris` blob appearing on
 * a payload would mean we had started copying image metadata into the thing that
 * gets persisted, snapshotted and sent over a wire — which is the step before
 * caching bytes, and the step D15 did not license.
 *
 * Matched by shape rather than by an exact field name, because the next leak
 * will not be called `image_uris`.
 */
const IMAGE_FIELD_HINT = /image|imgur|img_|artcrop|picture|thumbnail/i;
/** A URL pointing at a picture, whatever the field is called. */
const IMAGE_URL_HINT = /https?:\/\/\S*(\.(jpe?g|png|webp|gif)|scryfall\.io)/i;

const SEAT_FIELDS = new Set(['id', 'occupant', 'displayName', 'pickedCount']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkCard(card: unknown, path: Array<string | number>, out: ValidationFailure[], fields: ReadonlySet<string> = CARD_FIELDS): void {
  if (!isRecord(card)) return;
  if (fields === CARD_FIELDS && Array.isArray(card.faces)) card.faces.forEach((face, i) => checkCard(face, [...path, 'faces', i], out, FACE_FIELDS));
  for (const key of Object.keys(card)) {
    if (fields.has(key)) continue;
    // Field NAME or URL-shaped value only — never free text. "image" is a
    // substring of real card names (Mirror Image, Nissa's Pilgrimage), and a
    // control that fires on those is one somebody turns off.
    if (IMAGE_FIELD_HINT.test(key) || IMAGE_URL_HINT.test(String(card[key]))) {
      out.push({
        path: formatPath([...path, key]),
        message: `a card carries an image reference (D13): "${key}"`,
      });
    } else {
      out.push({
        path: formatPath([...path, key]),
        message: `unexpected field "${key}" on a card`,
      });
    }
  }
}

function checkCards(
  cards: unknown,
  path: Array<string | number>,
  out: ValidationFailure[],
  seen: Map<string, string>,
): void {
  if (!Array.isArray(cards)) return;
  cards.forEach((card, i) => {
    checkCard(card, [...path, i], out);
    if (isRecord(card) && typeof card.cardId === 'string') {
      const where = formatPath([...path, i]);
      const prior = seen.get(card.cardId);
      if (prior !== undefined) {
        out.push({
          path: where,
          message: `duplicate cardId "${card.cardId}" — already at ${prior}. The same physical card cannot be in two places.`,
        });
      } else {
        seen.set(card.cardId, where);
      }
    }
  });
}

/**
 * Every rule the schema cannot state, checked over the raw payload.
 *
 * Runs independently of the structural parse so that a payload with both a
 * shape error and a semantic one reports both.
 */
export function semanticIssues(raw: unknown): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  if (!isRecord(raw)) return out;

  // A draft's counters are 1-based. Zod's `.positive()` covers this too, but
  // the message is stated here so the two agree on wording.
  for (const field of ['seq', 'packNumber', 'pickNumber', 'packCount', 'packSize'] as const) {
    const value = raw[field];
    if (typeof value === 'number' && value < 1) {
      out.push({ path: formatPath([field]), message: `expected >= 1, got ${value}` });
    }
  }

  const seats = raw.seats;
  const seatIds = new Set<number>();

  if (Array.isArray(seats)) {
    seats.forEach((seat, i) => {
      if (!isRecord(seat)) return;

      if (typeof seat.id === 'number') {
        seatIds.add(seat.id);
        if (seat.id !== i) {
          out.push({
            path: formatPath(['seats', i, 'id']),
            message: `seats[] index IS the SeatId: expected ${i}, got ${seat.id}`,
          });
        }
      }

      for (const key of Object.keys(seat)) {
        if (SEAT_FIELDS.has(key)) continue;
        out.push({
          path: formatPath(['seats', i, key]),
          message:
            `a seat summary carries a count, never cards — "${key}" is how another ` +
            `seat's hidden information leaks into everyone's payload`,
        });
      }

      // Bot ids are positional (`bot:<seat>`), which is what makes a re-pad
      // deterministic. A bot id that does not match its seat means the table
      // and the payload disagree about who is sitting where.
      const occupant = seat.occupant;
      if (isRecord(occupant) && occupant.kind === 'bot' && typeof occupant.botId === 'string') {
        const expected = `bot:${i}`;
        if (occupant.botId !== expected) {
          out.push({
            path: formatPath(['seats', i, 'occupant', 'botId']),
            message: `bot ids are positional: expected ${expected}, got ${occupant.botId}`,
          });
        }
      }
    });
  }

  if (Array.isArray(raw.waitingOn)) {
    raw.waitingOn.forEach((id, i) => {
      if (typeof id === 'number' && !seatIds.has(id)) {
        out.push({
          path: formatPath(['waitingOn', i]),
          message: `seat ${id} does not exist in this payload`,
        });
      }
    });
  }

  const viewer = raw.viewer;
  if (isRecord(viewer)) {
    if (viewer.kind === 'spectator') {
      for (const key of Object.keys(viewer)) {
        if (key === 'kind') continue;
        out.push({
          path: formatPath(['viewer', key]),
          message: `a spectator payload carries no "${key}" — it is structurally cardless`,
        });
      }
    } else if (viewer.kind === 'seat') {
      // One `seen` map across pack and pool: a card in both at once is the same
      // physical card in two places, which is exactly the bug worth catching.
      const seen = new Map<string, string>();
      checkCards(viewer.pack, ['viewer', 'pack'], out, seen);
      checkCards(viewer.pool, ['viewer', 'pool'], out, seen);

      const seatId = viewer.seatId;
      if (typeof seatId === 'number' && Array.isArray(viewer.pool) && Array.isArray(seats)) {
        const own = seats[seatId];
        if (isRecord(own) && typeof own.pickedCount === 'number' && own.pickedCount !== viewer.pool.length) {
          out.push({
            path: formatPath(['viewer', 'pool']),
            message: `pool has ${viewer.pool.length} cards but seats[${seatId}].pickedCount is ${own.pickedCount}`,
          });
        }
      }
    }
  }

  return out;
}
