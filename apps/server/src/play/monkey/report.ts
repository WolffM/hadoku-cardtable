/*
 * The report shape — one JSON document per run, plus the short human summary
 * printed beside it. See `docs/MONKEY.md` for how to read one.
 */

/** The six flag kinds `AGENTS.md`'s brief named, by letter. */
export type FlagKind =
  | 'no-legal-answer' // (a) an ask offered nothing a reply could legally be
  | 'stuck' // (b) no progress for N seconds while holding priority or an ask open
  | 'click-refused' // (c) the server (or this client's own guard) refused an answer
  | 'loop' // (d) a declined optional ask came back unchanged
  | 'server-unclassified' // (e) `ask-unanswerable` / `ask-unclassified` in the server log
  | 'no-finish'; // (f) a crash, or the match did not end within its turn cap

export interface Flag {
  kind: FlagKind;
  matchId: string;
  seed: number;
  deck: { seat0: string; seat1: string };
  seat: number | null;
  turn: number | null;
  phase: string | null;
  /** The ask's method and prompt, when the flag is ask-shaped. */
  ask?: { method: string; prompt?: string };
  detail: string;
  /** The last few frames/decisions around the flag, newest last. */
  context: string[];
  at: string;
}

export interface MatchResult {
  matchId: string;
  deck: { seat0: string; seat1: string };
  seed: number;
  started: string;
  ended: string | null;
  turns: number | null;
  outcome: 'won' | 'lost' | 'drawn' | 'conceded' | 'timed-out' | 'crashed' | 'unknown';
  decisions: number;
  flags: Flag[];
}

export interface MonkeyReport {
  startedAt: string;
  finishedAt: string;
  seed: number;
  decksCovered: string[];
  matches: MatchResult[];
  flagged: Flag[];
  summary: {
    matches: number;
    flagged: number;
    byKind: Record<FlagKind, number>;
  };
}

export function emptyByKind(): Record<FlagKind, number> {
  return {
    'no-legal-answer': 0,
    stuck: 0,
    'click-refused': 0,
    loop: 0,
    'server-unclassified': 0,
    'no-finish': 0,
  };
}

export function buildReport(seed: number, decksCovered: string[], matches: MatchResult[], startedAt: string): MonkeyReport {
  const flagged = matches.flatMap((m) => m.flags);
  const byKind = emptyByKind();
  for (const f of flagged) byKind[f.kind] += 1;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    seed,
    decksCovered,
    matches,
    flagged,
    summary: { matches: matches.length, flagged: flagged.length, byKind },
  };
}

/** The human summary `cli.ts` prints alongside the JSON report. */
export function summaryText(report: MonkeyReport): string {
  const lines: string[] = [];
  lines.push(`monkey: seed ${report.seed}, ${report.summary.matches} match(es), ${report.summary.flagged} flag(s)`);
  for (const [kind, count] of Object.entries(report.summary.byKind)) {
    if (count > 0) lines.push(`  ${kind}: ${count}`);
  }
  for (const f of report.flagged) {
    lines.push(`  [${f.kind}] match ${f.matchId} seat ${f.seat ?? '-'} turn ${f.turn ?? '-'} ${f.phase ?? '-'}: ${f.detail}`);
  }
  const outcomes = new Map<string, number>();
  for (const m of report.matches) outcomes.set(m.outcome, (outcomes.get(m.outcome) ?? 0) + 1);
  lines.push(`outcomes: ${[...outcomes].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines.join('\n');
}
