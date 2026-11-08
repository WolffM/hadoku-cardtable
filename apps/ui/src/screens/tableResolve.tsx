/*
 * A table's ways to resolve its match, wherever a table is drawn: the table card (`TableCard.tsx`) lays
 * them out in its foot, a bracket's live match (`pod/PodBracket.tsx`) behind one ⋯. One set of rules for
 * both. A seated player's own: Concede game (any room), Abandon (a constructed room: the series ends with
 * no result) and Drop match (a pod or tournament: the match is forfeited). The room leader's, seated or
 * watching (the operator, 2026-10-30: *"the room leader is the admin"*): Reset game (the game in play
 * starts again, the score stands) and DQ a player (their match is forfeited and they are out of the
 * rounds). Each is confirmed with the score it leaves.
 *
 * Behind the ⋯ they open in a modal over the page (the operator, 2026-11-07: *"a popout modal, not
 * awkwardly expand the bracket view inline"*), the confirm and a refusal in the same one.
 */
import { useState, type ReactNode } from 'react';

import { Modal } from '../components/Modal.tsx';
import type { TableCardSeries, TablePhase } from './TableCard.tsx';

export interface TableResolveHandlers {
  /** My own game in play: concede it (the server's sentence on a refusal). Absent: none offered. */
  onConcede?: (() => Promise<string | null>) | undefined;
  /** A constructed room's series of mine: abandon it, no result. */
  onAbandon?: (() => Promise<string | null>) | undefined;
  /** A pod's or tournament's match of mine: drop it, a forfeit. */
  onDrop?: (() => Promise<string | null>) | undefined;
  /** The leader's: restart the game in play. */
  onReset?: (() => Promise<string | null>) | undefined;
  /** The leader's: disqualify the player at a seat. Offered for a human seat of a match still under way. */
  onDq?: ((memberId: string) => Promise<string | null>) | undefined;
  /** Whether a seat's player can be disqualified (a human, not yet out). Absent: every seat. */
  dqable?: ((memberId: string) => boolean) | undefined;
}

export interface TableResolveInput extends TableResolveHandlers {
  testId: string;
  /** By table seat. */
  players: readonly [string, string];
  nameOf: (memberId: string) => string;
  myMemberId: string | null;
  series: TableCardSeries;
  matchId: string | null;
  phase: TablePhase;
  /** Behind one ⋯ (`more`, opening `panel`'s modal), or laid out as `offers`. */
  menu: boolean;
}

export interface TableResolve {
  /** The offers, laid out (`menu: false`); none while one is being confirmed. */
  offers: ReactNode[];
  /** The ⋯ that opens them (`menu: true`), or `null` when there is nothing to offer. */
  more: ReactNode;
  /** The confirm and a refusal, drawn under whatever holds the offers; with `menu`, the modal holding them all. */
  panel: ReactNode;
}

type Resolve = 'concede' | 'abandon' | 'drop' | 'reset' | 'dq0' | 'dq1';

const RESOLVES: readonly Resolve[] = ['concede', 'abandon', 'drop', 'reset', 'dq0', 'dq1'];

const score = (wins: readonly [number, number]): string => `${wins[0]}–${wins[1]}`;

export function useTableResolve({ testId, players, nameOf, myMemberId, series, matchId, phase, menu, onConcede, onAbandon, onDrop, onReset, onDq, dqable }: TableResolveInput): TableResolve {
  const [confirming, setConfirming] = useState<Resolve | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finished = series.phase === 'done';
  const mySeat = myMemberId === null ? -1 : players.indexOf(myMemberId);
  const seated = mySeat === 0 || mySeat === 1;
  const under = seated && !finished && (matchId !== null || series.played > 0);
  const run: Partial<Record<Resolve, () => Promise<string | null>>> = {};
  if (onConcede !== undefined && seated && matchId !== null && !finished && phase !== 'sideboard') run.concede = onConcede;
  if (onAbandon !== undefined && under) run.abandon = onAbandon;
  if (onDrop !== undefined && seated && !finished) run.drop = onDrop;
  if (onReset !== undefined && matchId !== null && !finished && series.phase === 'playing') run.reset = onReset;
  if (onDq !== undefined && !finished) {
    for (const seat of [0, 1] as const) if (dqable?.(players[seat]) ?? true) run[seat === 0 ? 'dq0' : 'dq1'] = () => onDq(players[seat]);
  }
  const label: Readonly<Record<Resolve, { offer: string; confirm: string }>> = {
    concede: { offer: 'Concede game', confirm: 'Concede' },
    abandon: { offer: 'Abandon', confirm: 'Abandon' },
    drop: { offer: 'Drop match', confirm: 'Drop match' },
    reset: { offer: 'Reset game', confirm: 'Reset game' },
    dq0: { offer: `DQ ${nameOf(players[0])}`, confirm: 'DQ' },
    dq1: { offer: `DQ ${nameOf(players[1])}`, confirm: 'DQ' },
  };
  const offered = RESOLVES.filter((r) => run[r] !== undefined);
  // The score each leaves: a conceded game is the other seat's; a forfeited match (dropped, or its player DQ'd) is the other seat's by the majority, the loser's won games standing below it.
  const needed = Math.floor(series.length / 2) + 1;
  const forfeitBy = (loser: 0 | 1): [number, number] => {
    const wins: [number, number] = [0, 0];
    const other = loser === 0 ? 1 : 0;
    wins[other] = Math.max(series.wins[other] ?? 0, needed);
    wins[loser] = Math.min(series.wins[loser] ?? 0, needed - 1);
    return wins;
  };
  const conceded: [number, number] = mySeat === 0 ? [series.wins[0], series.wins[1] + 1] : [series.wins[0] + 1, series.wins[1]];
  const after: Readonly<Record<Resolve, string>> = {
    concede: score(conceded),
    abandon: 'No result',
    drop: score(forfeitBy(mySeat === 0 ? 0 : 1)),
    reset: score(series.wins),
    dq0: score(forfeitBy(0)),
    dq1: score(forfeitBy(1)),
  };
  const offers = offered.map((r) => (
    <button
      key={r}
      type="button"
      className="table-card__resolve"
      role={menu ? 'menuitem' : undefined}
      data-testid={`${testId}-${r}`}
      onClick={() => {
        setOpen(false);
        setConfirming(r);
      }}
    >
      {label[r].offer}
    </button>
  ));
  const shown = open || confirming !== null || error !== null;
  const more =
    menu && offered.length > 0 ? (
      <button type="button" className="table-card__more" data-testid={`${testId}-more`} aria-label="Table options" aria-haspopup="dialog" aria-expanded={shown} onClick={() => setOpen(true)}>
        ⋯
      </button>
    ) : null;
  const body = (
    <>
      {menu && confirming === null && (
        <div className="table-card__menu" role="menu">
          {offers}
        </div>
      )}
      {confirming !== null && run[confirming] !== undefined && (
        <div className="table-card__confirm" role="group" aria-label={label[confirming].offer} data-testid={`${testId}-${confirming}-confirm`}>
          <span className="table-card__change">
            <span>{score(series.wins)}</span>
            <span aria-hidden="true">→</span>
            <strong>{after[confirming]}</strong>
          </span>
          <button type="button" className="table-card__resolve" data-testid={`${testId}-${confirming}-keep`} onClick={() => setConfirming(null)}>
            {confirming === 'reset' || confirming === 'dq0' || confirming === 'dq1' ? 'Cancel' : 'Keep playing'}
          </button>
          <button
            type="button"
            className="table-card__resolve table-card__resolve--danger"
            data-testid={`${testId}-${confirming}-yes`}
            onClick={() => {
              void run[confirming]!().then((refused) => {
                setConfirming(null);
                setError(refused);
              });
            }}
          >
            {label[confirming].confirm}
          </button>
        </div>
      )}
      {error !== null && (
        <p className="ct-error table-card__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
  const close = (): void => {
    setOpen(false);
    setConfirming(null);
    setError(null);
  };
  const panel = !menu ? (
    body
  ) : shown ? (
    <Modal title={`${nameOf(players[0])} vs ${nameOf(players[1])}`} testId={`${testId}-tools`} onClose={close}>
      <div className="table-card__tools">{body}</div>
    </Modal>
  ) : null;
  return { offers: menu || confirming !== null ? [] : offers, more, panel };
}
