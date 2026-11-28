/*
 * What a two-seat match's server log says about Restart turn: each restart checked against the turn
 * it went back to, each turn the restart was not offered for, and each take-back the server refused.
 *
 * The rows are the probe stack's own (`play/match.ts` logs a `turn-snapshot`'s text behind
 * `CARDTABLE_PLAY_PROBE=1`). A restart is right when the restored game's own first snapshot of that
 * turn (the restore begins the same upkeep, so the bridge writes one) says what the snapshot it came
 * from said, card ids read through the cards they name (`normalizedSnapshot`), as
 * `restore.jvm.test.ts` checks a restore.
 *
 * A turn whose snapshot cannot hold the whole game (`snapshot-lossy`) greys Restart turn for that
 * turn. The kinds name what the text cannot write, not the card that put it there, so each kind is
 * charged, the turn it first appears, to the cards that arrived since the snapshot before.
 */
import { normalizedSnapshot } from '../../snapshot-text.ts';

export type Row = Record<string, unknown>;

export interface RestoreCheck {
  turn: number;
  /** The restored game's own snapshot of the turn matched the one it came from. */
  same: boolean;
  /** Keys whose entries differ, each side's entries that the other lacks. Empty when `same`. */
  diff: { key: string; before: string[]; after: string[] }[];
  /** No restored snapshot of the turn was seen in the log. */
  missing: boolean;
  /** Both snapshots' own text, when they differ: the cards a stale id once named are only there. */
  texts?: { before: string; after: string };
}

export interface LossyTurn {
  turn: number;
  kinds: string[];
  /** The kinds this turn holds that the snapshot before it did not. */
  fresh: string[];
  /** Cards (and tokens) in a public zone now that were not in the snapshot before: who brought `fresh` in. */
  arrived: string[];
}

export interface RestartReport {
  restores: RestoreCheck[];
  lossy: LossyTurn[];
  /** `restart-refused` / `undo-refused` rows: the act and the server's error. */
  refused: { turn: number | null; act: string; error: string }[];
}

const PUBLIC = /^p\d(battlefield|graveyard|exile|command)$/;

/** Every card in a public zone of the snapshot, by name, tokens by their token name, one entry a copy. */
export function publicCards(state: string): string[] {
  const zones = normalizedSnapshot(state);
  return Object.entries(zones)
    .filter(([key]) => PUBLIC.test(key))
    .flatMap(([, entries]) => entries.map((e) => e.split('|')[0]!.replace(/^t:/, '')))
    .sort();
}

/** `a` without `b`, as multisets. */
function without(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

function snapshotDiff(before: string, after: string): RestoreCheck['diff'] {
  const a = normalizedSnapshot(before);
  const b = normalizedSnapshot(after);
  const out: RestoreCheck['diff'] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[key] ?? [];
    const y = b[key] ?? [];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    out.push({ key, before: without(x, y), after: without(y, x) });
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** The Restart turn report of one match, from its server log rows in the order they were written. */
export function restartReport(rows: readonly Row[], matchId: string): RestartReport {
  const mine = rows.filter((r) => r.matchId === matchId);
  const restores: RestoreCheck[] = [];
  const lossy: LossyTurn[] = [];
  const refused: RestartReport['refused'] = [];
  let lastSnapshot: { turn: number; state: string; kinds: string[] } | null = null;
  let previous: { turn: number; state: string; kinds: string[] } | null = null;
  for (const [i, row] of mine.entries()) {
    const evt = row.evt;
    if (evt === 'turn-snapshot' && typeof row.state === 'string') {
      const turn = num(row.turn) ?? -1;
      // A restored game's snapshot of the same turn replaces the one it came from, not the turn before.
      if (lastSnapshot !== null && lastSnapshot.turn !== turn) previous = lastSnapshot;
      lastSnapshot = { turn, state: row.state, kinds: [] };
    } else if (evt === 'snapshot-lossy' && lastSnapshot !== null) {
      const kinds = Array.isArray(row.kinds) ? row.kinds.map(String) : [];
      lastSnapshot.kinds = kinds;
      const before = previous?.kinds ?? [];
      const fresh = kinds.filter((k) => !before.includes(k));
      lossy.push({ turn: lastSnapshot.turn, kinds, fresh, arrived: fresh.length === 0 || previous === null ? [] : [...new Set(without(publicCards(lastSnapshot.state), publicCards(previous.state)))] });
    } else if (evt === 'restart-turn') {
      const turn = num(row.turn) ?? -1;
      const from = lastSnapshot !== null && lastSnapshot.turn === turn ? lastSnapshot : null;
      const again = mine.slice(i + 1).find((r) => r.evt === 'turn-snapshot' && r.turn === turn && typeof r.state === 'string');
      if (from === null || again === undefined) {
        restores.push({ turn, same: false, diff: [], missing: true });
        continue;
      }
      const diff = snapshotDiff(from.state, again.state as string);
      restores.push({ turn, same: diff.length === 0, diff, missing: false, ...(diff.length === 0 ? {} : { texts: { before: from.state, after: again.state as string } }) });
    } else if (evt === 'restart-refused' || evt === 'undo-refused') {
      refused.push({ turn: lastSnapshot?.turn ?? null, act: String(row.act ?? row.reason ?? ''), error: String(row.error ?? row.reason ?? '') });
    }
  }
  return { restores, lossy, refused };
}

/** Lossy turns as a tally across matches: each fresh kind, and each card charged with it, by count. */
export function lossyTally(turns: readonly LossyTurn[]): { kinds: [string, number][]; cards: [string, number][] } {
  const kinds = new Map<string, number>();
  const cards = new Map<string, number>();
  for (const t of turns) {
    for (const k of t.fresh) kinds.set(k, (kinds.get(k) ?? 0) + 1);
    if (t.fresh.length > 0) for (const c of t.arrived) cards.set(c, (cards.get(c) ?? 0) + 1);
  }
  const sorted = (m: Map<string, number>): [string, number][] => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { kinds: sorted(kinds), cards: sorted(cards) };
}
