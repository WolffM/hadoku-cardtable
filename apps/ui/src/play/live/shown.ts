/*
 * The dice rolls and coin flips `match.ts` keeps, as the table draws them: `./dice.ts` draws a
 * {@link ShownRoll}, `./coin-flip.tsx` a {@link ShownFlip}.
 *
 * They live apart from the drawings on purpose. `match.ts` is the match's state, and the server's
 * monkey runs it under plain Node, where a drawing's `import './dice.css'` is an
 * ERR_UNKNOWN_FILE_EXTENSION (hadoku-cardtable#17). So this module imports no component and no
 * stylesheet; `apps/server/src/no-css.test.ts` keeps everything the server runs that way.
 */

import type { CoinFlip, DieRoll } from '@hadoku/forge-wire';

/** A roll as the board draws it: numbered once for the page's life, and when it arrived. */
export interface ShownRoll {
  readonly id: number;
  readonly at: number;
  readonly player: number;
  /** Null: the bridge could not read the die's sides. */
  readonly sides: number | null;
  readonly results: readonly number[];
  readonly ignored: readonly number[];
  readonly source: number | null;
}

let lastRollId = 0;

/** The wire's roll, numbered and stamped as it arrives. */
export function shownRoll(roll: DieRoll, at: number = Date.now()): ShownRoll {
  lastRollId += 1;
  return {
    id: lastRollId,
    at,
    player: roll.player.id,
    sides: roll.sides,
    results: roll.results,
    ignored: roll.ignored ?? [],
    source: roll.source?.id ?? null,
  };
}

/** A flip as the table draws it: numbered once for the page's life, when it arrived, and the words Forge said it in. */
export interface ShownFlip {
  readonly id: number;
  readonly at: number;
  readonly player: number;
  /** Null: the flip was called by a player whose call the bridge never saw. */
  readonly outcome: 'heads' | 'tails' | null;
  /** Null: nobody called it. */
  readonly won: boolean | null;
  readonly source: number | null;
  readonly text: string;
}

let lastFlipId = 0;

/** The wire's flip, numbered and stamped as it arrives, with the message that said it. */
export function shownFlip(flip: CoinFlip, text: string, at: number = Date.now()): ShownFlip {
  lastFlipId += 1;
  return { id: lastFlipId, at, player: flip.player.id, outcome: flip.outcome, won: flip.won, source: flip.source?.id ?? null, text };
}
