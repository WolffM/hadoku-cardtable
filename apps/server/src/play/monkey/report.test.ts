import { describe, expect, it } from 'vitest';

import { buildReport, stopReason, summaryText, type MatchResult } from './report.ts';

const result = (over: Partial<MatchResult>): MatchResult => ({
  matchId: 'm1',
  deck: { seat0: 'A', seat1: 'B' },
  seed: 1,
  started: '2026-11-06T00:00:00Z',
  ended: '2026-11-06T00:01:00Z',
  turns: 5,
  outcome: 'won',
  decisions: 10,
  flags: [],
  ...over,
});

describe('stopReason', () => {
  it('stops the run on a 503: the server will refuse every later start the same way', () => {
    const refused = result({ matchId: 'unstarted', outcome: 'refused', refused: { status: 503, error: 'the server is already running 50 matches' } });
    expect(stopReason(refused)).toMatch(/HTTP 503: the server is already running 50 matches/);
  });

  it('plays on past a played match, and past a refusal about this deck (400)', () => {
    expect(stopReason(result({}))).toBeNull();
    expect(stopReason(result({ outcome: 'crashed', refused: { status: 400, error: 'seat 1: not legal' } }))).toBeNull();
  });

  it('says it stopped, first, in the summary', () => {
    const report = buildReport(1, ['a'], [result({})], '2026-11-06T00:00:00Z', 'the server refused to start a match');
    expect(report.stopped).toBe('the server refused to start a match');
    expect(summaryText(report).split('\n')[1]).toBe('STOPPED EARLY: the server refused to start a match');
  });
});
