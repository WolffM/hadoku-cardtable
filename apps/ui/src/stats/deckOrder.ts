/*
 * The room's deck picker, best decks first — the operator, 2026-10-10: *"can
 * you make sure the decks are sorted by winrate?"*
 *
 * The record is everyone's, from the shared stats service: the `deckId` every
 * room match reports per seat (`apps/server/src/stats/report.ts`) is the
 * library deck's own id, which is exactly a picker option's `value`.
 *
 * Played decks come first, by win rate, then by games played (a 3-0 deck
 * above a 1-0 deck). A deck nobody has played has no win rate, so the unplayed
 * keep the library's own order after them: the selection's strongest finish
 * first (`docs/planning/deck-selection/tools/select_decks.py`).
 */
import { winRate, type OutcomeTotals } from '@wolffm/prefs-client/games';

export type DeckRecords = ReadonlyMap<string, OutcomeTotals>;

export function byWinRate<T extends { readonly value: string }>(options: readonly T[], records: DeckRecords): T[] {
  const played = (o: T): OutcomeTotals | undefined => {
    const r = records.get(o.value);
    return r !== undefined && r.games > 0 ? r : undefined;
  };
  return options
    .map((option, index) => ({ option, index, record: played(option) }))
    .sort((a, b) => {
      if (a.record === undefined || b.record === undefined) {
        if (a.record !== b.record) return a.record === undefined ? 1 : -1;
        return a.index - b.index;
      }
      return winRate(b.record) - winRate(a.record) || b.record.games - a.record.games || a.index - b.index;
    })
    .map(({ option }) => option);
}
