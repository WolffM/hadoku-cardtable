/*
 * Where the board's own elements are, by the attributes `Board.tsx` draws: the one place a layer
 * over the board spells a selector for one.
 */

/** The overlay the layers draw into: it covers the board exactly and takes no pointer. */
export function overlayOf(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-board-overlay]');
}

/**
 * A card's box on the board: its `data-board-card` `<li>`. Never `data-card-id`
 * alone — the board's `<li>` carries both, and every other element with a bare
 * `data-card-id` is a picture of the card somewhere else: a decision sheet's
 * face of the spell it asks for (`promptThumb`), a selection's tile, a reveal.
 * An arrow drawn from one of those leaves from the sheet, not the card.
 */
export function cardBox(root: ParentNode, id: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-board-card="${id}"]`);
}

/** A player's face. Lane A's `data-player-face`, with the seat section as the fallback. */
export function faceBox(root: ParentNode, id: number): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(`[data-player-face][data-player-id="${id}"]`) ??
    root.querySelector<HTMLElement>(`[data-testid="player"][data-player-id="${id}"]`)
  );
}

/** One side's zone: `you` is the seat drawn at the bottom, `them` the one across. */
export function zoneOf(root: ParentNode, owner: 'you' | 'them', zone: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-zone="${zone}"][data-owner="${owner}"]`);
}

/** A card on a battlefield: either side's, or `owner`'s alone. */
export function battlefieldCard(root: ParentNode, id: number, owner?: 'you' | 'them'): HTMLElement | null {
  const zone = owner === undefined ? '[data-zone="battlefield"]' : `[data-zone="battlefield"][data-owner="${owner}"]`;
  return root.querySelector<HTMLElement>(`${zone} [data-board-card="${id}"]`);
}
