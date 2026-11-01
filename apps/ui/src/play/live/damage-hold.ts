/*
 * A creature's damage is drawn when what hits it lands, never when Forge marks it. Forge marks a wipe's damage on
 * every creature in the frame the spell resolves in, and the P/T badge (`Board.tsx`'s `CreaturePT`) read it at
 * once: thirteen creatures read `2/-12` while Blasphemous Act's fireballs were still in the air (the operator,
 * 2026-11-01, trailer cut 4: "the crack shouldn't appear until the death animation actually starts, after the
 * fireball animation from the card actually hits").
 *
 * `live/numbers.ts` holds a card's damage as it was when it schedules a hit at it, and lets it go as that hit lands;
 * the badge draws the held number meanwhile. One hold per hit: a card hit twice in one view keeps its old damage
 * until the last of them lands. One store per board, so two boards on a page never share a card's hold.
 */

export interface DamageHold {
  /** A hit is on its way to `cardId`: keep drawing `damage` (its damage before the hit) until it lands. */
  hold(cardId: number, damage: number): void;
  /** That hit has landed. */
  release(cardId: number): void;
  /** Every hold, gone: the board's effects are being torn down. */
  clear(): void;
  /** The damage to draw on `cardId` while a hit is on its way, else `undefined` (draw Forge's). */
  shown(cardId: number): number | undefined;
  subscribe(listener: () => void): () => void;
}

export function damageHold(): DamageHold {
  const held = new Map<number, { damage: number; hits: number }>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    hold(cardId, damage) {
      const was = held.get(cardId);
      held.set(cardId, { damage: was?.damage ?? damage, hits: (was?.hits ?? 0) + 1 });
      if (was === undefined) changed();
    },
    release(cardId) {
      const was = held.get(cardId);
      if (was === undefined) return;
      if (was.hits > 1) {
        held.set(cardId, { ...was, hits: was.hits - 1 });
        return;
      }
      held.delete(cardId);
      changed();
    },
    clear() {
      if (held.size === 0) return;
      held.clear();
      changed();
    },
    shown(cardId) {
      return held.get(cardId)?.damage;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
