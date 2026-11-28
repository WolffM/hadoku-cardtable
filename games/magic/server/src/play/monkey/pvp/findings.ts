/*
 * What a two-seat match found, one line each. A finding is something wrong with the product: a
 * driver flag (`stuck`, `click-refused`, `server-unclassified`, …), a restart whose restored turn is
 * not the turn it went back to, a pressed restart that never restored, a take-back the server refused
 * though it was offered, or a watcher that does not show what the seats show. A turn Restart turn was
 * not offered for is no finding: its snapshot could not hold the game, and the tally says why.
 */
import type { PvpResult } from './run-pvp.ts';

export function findingsOf(r: PvpResult): string[] {
  const out: string[] = [];
  for (const f of r.flags) out.push(`${f.kind} seat ${f.seat ?? '-'} turn ${f.turn ?? '?'} ${f.phase ?? ''}: ${f.detail}`);
  for (const x of r.report.restores) {
    if (x.missing) out.push(`restart of turn ${x.turn}: no restored snapshot of the turn`);
    else if (!x.same) out.push(`restart of turn ${x.turn}: the restored turn differs — ${x.diff.map((d) => `${d.key} lost [${d.before.join('; ')}] gained [${d.after.join('; ')}]`).join(' / ')}`);
  }
  const restored = new Set(r.report.restores.map((x) => x.turn));
  for (const t of r.restarts.asked) if (!restored.has(t) && r.outcome === 'over') out.push(`restart of turn ${t} was asked and allowed but never restored`);
  for (const x of r.report.refused) if (x.error !== 'rate-limited') out.push(`take-back refused at turn ${x.turn ?? '?'}: ${x.act} → ${x.error}`);
  const w = r.watcher;
  if (r.matchId !== 'unstarted') {
    if (!w.isWatcher) out.push('the third account was not made the watcher');
    else if (w.turn !== w.seatTurn || JSON.stringify(w.lives) !== JSON.stringify(w.seatLives)) out.push(`the watcher shows turn ${w.turn} lives ${JSON.stringify(w.lives)}, the seat turn ${w.seatTurn} lives ${JSON.stringify(w.seatLives)}`);
  }
  return out;
}
