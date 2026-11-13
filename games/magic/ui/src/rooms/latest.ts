/*
 * Latest-wins for state a screen reads again and again — a room's record, its
 * table, its Gauntlet, a pod's context — on every ping of the room's feed
 * (`./feed.ts`). Two reads issued close together can answer out of order, and
 * an older answer landing last puts the older state back (CI run 39039465853,
 * `e2e/draft.spec.ts`). A read only lands if no newer read was issued after it.
 *
 * The screen's own writes answer with the same state, so a read issued before
 * a write's answer landed may hold the state from before the write: such a read
 * is asked again rather than landed (w48's spec, CI 2026-10-08).
 *
 * A dropped read decides NOTHING, opening a screen's body included: a dropped
 * room read that opened it drew the deck picker with no room record.
 */

/** What to do with a read's answer, asked when it lands. */
export type ReadVerdict = 'keep' | 'drop' | 'reread';

export interface LatestReads {
  /** A read is being sent: the returned function says, once it answers, what to do with the answer. */
  read(): () => ReadVerdict;
  /** A write's answer, carrying the same state, has just landed. */
  wrote(): void;
}

export function latestReads(): LatestReads {
  let issued = 0;
  let writes = 0;
  return {
    read() {
      const mine = (issued += 1);
      const sentAfter = writes;
      return () => (mine !== issued ? 'drop' : sentAfter !== writes ? 'reread' : 'keep');
    },
    wrote() {
      writes += 1;
    },
  };
}
