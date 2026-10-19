/**
 * A card's other faces, and the art each one draws — the one rule both the art-id table
 * (`scripts/art/build-art-ids.ts`) and the draft pool (`./cli/build-pool.ts`) read, so a face the
 * table keys and a face the pool carries are the same face with the same art.
 *
 * No node builtins: the art-id builder and the pool builder are both node programs, but nothing here
 * needs to be.
 */

import { BACK_FACE } from './art/ids.ts';
import type { GameplayCard } from './scryfall/project.ts';

/** One face Forge can name that is not the name a row was keyed by, and the art id it draws. */
export interface OtherFace {
  readonly name: string;
  readonly artId: string;
}

/** Layouts that print a second image on the card's back. */
const TWO_IMAGE_LAYOUTS = new Set(['transform', 'modal_dfc', 'reversible_card']);
/** Layouts whose faces all share the card's one image. */
const ONE_IMAGE_LAYOUTS = new Set(['flip', 'split', 'adventure']);

function str(card: GameplayCard, field: string): string | null {
  const value = card[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Every face of `card` Forge can put a name on, with the art each one draws:
 *
 *   - transform / modal DFC: the back face draws the card's back image
 *     (`<id>#back`, `BACK_FACE`);
 *   - flip, split, adventure: one printed image holds every face, so each
 *     face draws the card's own image (a flipped Kamigawa card shows it as
 *     printed, not turned over);
 *   - meld: the melded permanent is a card of its own on Scryfall, named in
 *     the half's `all_parts` as its `meld_result`, and draws that card.
 *
 * A token printing gets nothing here: its wire name is `"<name> Token"`,
 * which the art-id table's token section keys on its own.
 */
export function otherFaces(card: GameplayCard): OtherFace[] {
  const id = str(card, 'id');
  const layout = str(card, 'layout');
  if (id === null || layout === null || str(card, 'set_type') === 'token') return [];
  if (layout === 'meld') {
    const parts = Array.isArray(card['all_parts']) ? (card['all_parts'] as Record<string, unknown>[]) : [];
    return parts
      .filter((p) => p['component'] === 'meld_result' && typeof p['name'] === 'string' && typeof p['id'] === 'string')
      .map((p) => ({ name: p['name'] as string, artId: p['id'] as string }));
  }
  const twoImages = TWO_IMAGE_LAYOUTS.has(layout);
  if (!twoImages && !ONE_IMAGE_LAYOUTS.has(layout)) return [];
  const faces = Array.isArray(card['card_faces']) ? (card['card_faces'] as Record<string, unknown>[]) : [];
  // A split card's halves are both names Forge uses (each half on the stack);
  // every other layout's first face is the card's own name, already keyed.
  const named = layout === 'split' ? faces : faces.slice(1);
  return named.flatMap((face) => (typeof face['name'] === 'string' ? [{ name: face['name'], artId: twoImages ? `${id}${BACK_FACE}` : id }] : []));
}
