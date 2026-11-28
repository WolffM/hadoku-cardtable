/*
 * The Restart turn report off a match's own log: a restore checked against the turn it went back to,
 * a lossy turn charged to what arrived, a refusal kept.
 */
import { describe, expect, it } from 'vitest';

import { lossyTally, publicCards, restartReport, type Row } from './restarts.ts';

const M = 'm-1';
/** A snapshot text: seat 0's battlefield and hand, as Forge writes them (card ids in `Id:`). */
const state = (battlefield: string[], hand: string[] = []): string =>
  [`p0life=20`, `p0battlefield=${battlefield.join(';')}`, `p0hand=${hand.join(';')}`, `p1life=20`, `p1battlefield=`].join('\n');
const snap = (turn: number, s: string, epoch = 'e1'): Row => ({ evt: 'turn-snapshot', matchId: M, turn, state: s, epoch });

describe('restartReport — each Restart turn against the turn it went back to', () => {
  it('is right when the restored snapshot names the same cards, whatever ids Forge gave them', () => {
    const rows = [snap(4, state(['Forest|Id:10', 'Grizzly Bears|Id:11'], ['Shock|Id:12'])), { evt: 'restart-turn', matchId: M, turn: 4 }, snap(4, state(['Grizzly Bears|Id:40', 'Forest|Id:41'], ['Shock|Id:42']), 'e2')];
    expect(restartReport(rows, M).restores).toEqual([{ turn: 4, same: true, diff: [], missing: false }]);
  });

  it('names what the restore lost or gained, key by key', () => {
    const rows = [snap(4, state(['Forest|Id:10', 'Grizzly Bears|Id:11'])), { evt: 'restart-turn', matchId: M, turn: 4 }, snap(4, state(['Forest|Id:41']), 'e2')];
    const [r] = restartReport(rows, M).restores;
    expect(r).toMatchObject({ turn: 4, same: false, missing: false });
    expect(r!.diff).toEqual([{ key: 'p0battlefield', before: ['Grizzly Bears|Id:Grizzly Bears'], after: [] }]);
  });

  it('says when no restored snapshot of the turn ever came', () => {
    const rows = [snap(4, state(['Forest|Id:10'])), { evt: 'restart-turn', matchId: M, turn: 4 }, snap(5, state(['Forest|Id:41']), 'e2')];
    expect(restartReport(rows, M).restores).toEqual([{ turn: 4, same: false, diff: [], missing: true }]);
  });

  it('reads only its own match', () => {
    expect(restartReport([{ ...snap(4, state([])), matchId: 'm-2' }, { evt: 'restart-turn', matchId: 'm-2', turn: 4 }], M).restores).toEqual([]);
  });
});

describe('restartReport — a turn Restart turn was not offered for', () => {
  it('charges a kind, the turn it first appears, to the cards that arrived since the snapshot before', () => {
    const rows = [
      snap(3, state(['Forest|Id:1'])),
      snap(4, state(['Forest|Id:1', 't:Rabbit|Id:5', 'Hop to It|Id:6'])),
      { evt: 'snapshot-lossy', matchId: M, turn: 4, kinds: ['effect'] },
      snap(5, state(['Forest|Id:1', 't:Rabbit|Id:5', 'Hop to It|Id:6', 'Mountain|Id:7'])),
      { evt: 'snapshot-lossy', matchId: M, turn: 5, kinds: ['effect'] },
    ];
    const { lossy } = restartReport(rows, M);
    expect(lossy).toEqual([
      { turn: 4, kinds: ['effect'], fresh: ['effect'], arrived: ['Hop to It', 'Rabbit'] },
      { turn: 5, kinds: ['effect'], fresh: [], arrived: [] },
    ]);
    expect(lossyTally(lossy)).toEqual({ kinds: [['effect', 1]], cards: [['Hop to It', 1], ['Rabbit', 1]] });
  });

  it('reads public zones only: a card drawn is not one that arrived', () => {
    expect(publicCards(state(['t:Fish|Id:3'], ['Shock|Id:4']))).toEqual(['Fish']);
  });
});

describe('restartReport — a take-back the server refused', () => {
  it('keeps the act and the error, at the turn it was asked in', () => {
    const rows = [snap(6, state([])), { evt: 'restart-refused', matchId: M, seat: 1, act: 'ask', error: 'not-restorable' }];
    expect(restartReport(rows, M).refused).toEqual([{ turn: 6, act: 'ask', error: 'not-restorable' }]);
  });
});
