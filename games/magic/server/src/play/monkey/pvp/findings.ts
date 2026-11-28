/*
 * What a two-seat match found, one line each. A finding is something wrong with the product: a
 * driver flag (`stuck`, `click-refused`, `server-unclassified`, …), a restart whose restored turn is
 * not the turn it went back to, an allowed restart that never restored, a take-back the server refused
 * for a reason other than the seat's view being a frame behind, or a watcher that does not show what the seats show. A turn Restart turn was
 * not offered for is no finding: its snapshot could not hold the game, and the tally says why.
 */
import type { PvpResult } from './run-pvp.ts';

/**
 * Refusals that are the server right about a seat a frame behind: the turn had passed, the ask had closed,
 * or the press was rate limited. A seat that saw Restart turn offered and was told the turn cannot be
 * restored (`not-restorable`) is not one of them.
 */
const STALE_VIEW = new Set(['rate-limited', 'not-your-turn', 'already-asked', 'no-ask', 'turn-moved-on', 'declined-this-turn']);

export function findingsOf(r: PvpResult): string[] {
  const out: string[] = [];
  for (const f of r.flags) out.push(`${f.kind} seat ${f.seat ?? '-'} turn ${f.turn ?? '?'} ${f.phase ?? ''}: ${f.detail}`);
  for (const x of r.report.restores) {
    if (x.missing) out.push(`restart of turn ${x.turn}: no restored snapshot of the turn`);
    else if (!x.same) out.push(`restart of turn ${x.turn}: the restored turn differs — ${x.diff.map((d) => `${d.key} lost [${d.before.join('; ')}] gained [${d.after.join('; ')}]`).join(' / ')}`);
  }
  const restored = new Set(r.report.restores.map((x) => x.turn));
  // An allow the server turned away because the turn had already moved on (`no-ask`, `turn-moved-on`) is the race, not a lost restart.
  const outrun = (t: number): boolean => r.report.refused.some((x) => x.act === 'allow' && STALE_VIEW.has(x.error) && (x.turn ?? -1) >= t);
  for (const t of r.restarts.allowed) if (!restored.has(t) && !outrun(t) && r.outcome === 'over') out.push(`restart of turn ${t} was allowed but never restored`);
  for (const x of r.report.refused) if (!STALE_VIEW.has(x.error)) out.push(`take-back refused at turn ${x.turn ?? '?'}: ${x.act} → ${x.error}`);
  const w = r.watcher;
  if (r.matchId !== 'unstarted') {
    if (!w.isWatcher) out.push('the third account was not made the watcher');
    else if (w.turn !== w.seatTurn || JSON.stringify(w.lives) !== JSON.stringify(w.seatLives)) out.push(`the watcher shows turn ${w.turn} lives ${JSON.stringify(w.lives)}, the seat turn ${w.seatTurn} lives ${JSON.stringify(w.seatLives)}`);
  }
  return out;
}
