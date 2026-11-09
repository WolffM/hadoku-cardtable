/**
 * The game log panel: turns, each with both life totals; a row per thing that
 * happened, marked by what kind of thing and coloured by whose; a response
 * nested under what it answered and a resolution's results under its spell; the
 * mana that paid for a cast as symbols on its row; one combat block a turn.
 * `./model.ts` builds the tree; this draws it. The design is the canvas the
 * operator approved on 2026-11-09 ("Game Log Redesign").
 *
 * Every colour is a theme token (`./log.css`). Every line drawn is an element
 * with `data-log-line`, and a card name in it is a hover target for the one
 * inspector (`./names.ts`).
 *
 * The earlier turns fold to one line each (their cards and life totals); the
 * last two stay open, and any turn opens from its header or its number in the
 * strip along the top.
 */
import { memo, useCallback, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { ManaPip } from '../../../components/ManaPip.tsx';
import { plainRulesText } from '../../prompts/lookup.ts';
import type { BoardView } from '../../adapter.ts';
import type { Say } from '../match.ts';
import { buildLog, type LogItem, type LogNode, type LogPlayer, type LogRow, type LogTurn, type RowKind } from './model.ts';
import { cardIdsNamedInView, piecesOf } from './names.ts';

import './log.css';

/** How many of the newest turns are open by default. */
const OPEN_TURNS = 2;

/** A run of one mana symbol longer than this is drawn once with its count. */
const PIP_RUN = 3;

/* ── marks ─────────────────────────────────────────────────────────────── */

const MARK: Record<RowKind, ReactNode> = {
  cast: <path d="M10 2v5M10 13v5M2 10h5M13 10h5M5 5l2.5 2.5M12.5 12.5 15 15M15 5l-2.5 2.5M7.5 12.5 5 15" />,
  activate: (
    <>
      <path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M15 2.5v4h-4" />
    </>
  ),
  trigger: <path d="M11 2 4 11h5l-1 7 7-9h-5z" />,
  land: <path d="M2 16l5-8 3 4 2-3 6 7z" />,
  draw: (
    <>
      <rect x="5" y="3" width="10" height="14" rx="2" />
      <path d="M10 7v6M7.5 10.5 10 13l2.5-2.5" />
    </>
  ),
  discard: (
    <>
      <rect x="5" y="3" width="10" height="14" rx="2" />
      <path d="M8 8l4 4M12 8l-4 4" />
    </>
  ),
  attack: (
    <>
      <path d="M14 3h3v3l-9 9-3-3z" />
      <path d="M4 12l4 4M3 17l2-2" />
    </>
  ),
  block: <path d="M10 2l6 2.5v5c0 4-2.7 6.5-6 8.5-3.3-2-6-4.5-6-8.5v-5z" />,
  damage: <path d="M10 2l2 5 5 .5-4 3.5 1.5 5L10 13l-4.5 3 1.5-5-4-3.5 5-.5z" />,
  life: <path d="M10 16.5S3 12.4 3 7.6A3.6 3.6 0 0 1 10 6a3.6 3.6 0 0 1 7 1.6c0 4.8-7 8.9-7 8.9z" />,
  result: (
    <>
      <path d="M5 3v7a3 3 0 0 0 3 3h8" />
      <path d="M13 10l3 3-3 3" />
    </>
  ),
  outcome: <path d="M6 3h8v4a4 4 0 0 1-8 0zM10 11v3M7 17h6M6 5H3a3 3 0 0 0 3 3M14 5h3a3 3 0 0 1-3 3" />,
  said: <circle cx="10" cy="10" r="2" />,
};

function Mark({ kind }: { kind: RowKind }) {
  return (
    <svg className="game-log__mark" viewBox="0 0 20 20" aria-hidden="true">
      {MARK[kind]}
    </svg>
  );
}

/* ── pieces of a row ───────────────────────────────────────────────────── */

function Words({ row, ids }: { row: LogRow; ids: ReadonlyMap<string, readonly number[]> }) {
  return (
    <>
      {piecesOf(row.say, plainRulesText(row.text), ids).map((piece, i) =>
        typeof piece === 'string' ? (
          <span key={i}>{piece}</span>
        ) : (
          <span key={i} className="game-log__card" data-log-card={piece.name} data-inspect-ids={piece.ids.join(',')} tabIndex={0}>
            {piece.name}
          </span>
        ),
      )}
    </>
  );
}

/** "−3 → 19", in the colour of a loss or a gain. */
function LifeChange({ from, to }: { from: number; to: number }) {
  const delta = to - from;
  return (
    <span className="game-log__life" data-sign={delta < 0 ? 'down' : 'up'}>
      <b>{delta < 0 ? `−${-delta}` : `+${delta}`}</b> <span className="game-log__to">→ {to}</span>
    </span>
  );
}

/** The mana that paid, as symbols; a long run of one symbol drawn once with its count. */
function Cost({ mana }: { mana: readonly string[] }) {
  const runs: { token: string; n: number }[] = [];
  for (const token of mana) {
    const last = runs[runs.length - 1];
    if (last?.token === token) last.n++;
    else runs.push({ token, n: 1 });
  }
  return (
    <span className="game-log__cost">
      {runs.flatMap((r, i) =>
        r.n > PIP_RUN
          ? [<ManaPip key={i} token={r.token} />, <span key={`${i}x`} className="game-log__times">×{r.n}</span>]
          : Array.from({ length: r.n }, (_, j) => <ManaPip key={`${i}-${j}`} token={r.token} />),
      )}
    </span>
  );
}

interface RowProps {
  row: LogRow;
  ids: ReadonlyMap<string, readonly number[]>;
  names: ReadonlyMap<number, string>;
  mana?: readonly string[];
}

const Row = memo(function Row({ row, ids, names, mana }: RowProps) {
  const life = row.say.log?.life;
  return (
    <li className="game-log__row" data-log-line="" data-log-kind={row.kind} data-log-type={row.say.log?.type} data-log-who={row.seat}>
      <Mark kind={row.kind} />
      <span className="game-log__text">
        {life === undefined || row.life === null ? (
          <Words row={row} ids={ids} />
        ) : (
          <>
            <span>{names.get(life.player) ?? ''}</span> <LifeChange from={row.life.from} to={row.life.to} />
          </>
        )}
      </span>
      {mana !== undefined && mana.length > 0 && <Cost mana={mana} />}
    </li>
  );
});

/* ── the tree ──────────────────────────────────────────────────────────── */

interface NodesProps {
  nodes: readonly LogNode[];
  ids: ReadonlyMap<string, readonly number[]>;
  names: ReadonlyMap<number, string>;
}

function Item({ item, ids, names }: { item: LogItem } & Omit<NodesProps, 'nodes'>) {
  return (
    <>
      <Row row={item.row} ids={ids} names={names} mana={item.mana} />
      {item.responses.length > 0 && (
        <li className="game-log__nest">
          <ol>
            {item.responses.map((r) => (
              <Item key={r.stack} item={r} ids={ids} names={names} />
            ))}
          </ol>
        </li>
      )}
      {item.results.length > 0 && (
        <li className="game-log__results">
          <ol>
            <Nodes nodes={item.results} ids={ids} names={names} />
          </ol>
        </li>
      )}
    </>
  );
}

function Nodes({ nodes, ids, names }: NodesProps) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === 'item') return <Item key={`s${node.stack}`} item={node} ids={ids} names={names} />;
        if (node.kind === 'combat') {
          return (
            <li key={i} className="game-log__combat" data-testid="log-combat">
              <ol>
                <Nodes nodes={node.nodes} ids={ids} names={names} />
              </ol>
            </li>
          );
        }
        return <Row key={i} row={node.row} ids={ids} names={names} />;
      })}
    </>
  );
}

/* ── turns ─────────────────────────────────────────────────────────────── */

function Chevron() {
  return (
    <svg className="game-log__chevron" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8 5l5 5-5 5" />
    </svg>
  );
}

function TurnLives({ turn }: { turn: LogTurn }) {
  return (
    <span className="game-log__lives">
      {turn.life.map((l) => (
        <span key={l.player} className="game-log__total" data-seat={l.seat}>
          <span className="game-log__dot" aria-hidden="true" />
          {l.at}
          {l.delta !== 0 && (
            <small className="game-log__delta" data-sign={l.delta < 0 ? 'down' : 'up'}>
              {l.delta < 0 ? `−${-l.delta}` : `+${l.delta}`}
            </small>
          )}
        </span>
      ))}
    </span>
  );
}

interface TurnProps {
  turn: LogTurn;
  index: number;
  open: boolean;
  toggle: (index: number) => void;
  ids: ReadonlyMap<string, readonly number[]>;
  names: ReadonlyMap<number, string>;
}

function Turn({ turn, index, open, toggle, ids, names }: TurnProps) {
  return (
    <section className="game-log__turn" data-testid="log-turn" data-turn={turn.n ?? undefined} data-log-turn-index={index} data-open={open || undefined}>
      <h3 className="game-log__head">
        <button type="button" aria-expanded={open} onClick={() => toggle(index)}>
          <Chevron />
          <span className="game-log__n">{turn.n === null ? 'Start' : `Turn ${turn.n}`}</span>
          {turn.who !== null && (
            <span className="game-log__who" data-seat={turn.seat}>
              {turn.who}
            </span>
          )}
          <span className="game-log__summary">{open ? '' : turn.summary.join(', ')}</span>
          <TurnLives turn={turn} />
        </button>
      </h3>
      {open && (
        <ol className="game-log__rows">
          <Nodes nodes={turn.nodes} ids={ids} names={names} />
        </ol>
      )}
    </section>
  );
}

/* ── the panel ─────────────────────────────────────────────────────────── */

export interface GameLogProps {
  says: readonly Say[];
  view: BoardView | null;
  /** The scroll box, which the board keeps at the newest line. */
  listRef?: Ref<HTMLDivElement>;
}

export function GameLog({ says, view, listRef }: GameLogProps) {
  const players: LogPlayer[] = useMemo(() => (view?.players ?? []).map((p) => ({ id: p.id, name: p.name, life: p.life })), [view?.players]);
  const viewer = view?.players.find((p) => p.isViewer)?.id ?? null;
  const last = says[says.length - 1];
  // `says` is the match's own array, appended to in place: its length and newest line say when it changed.
  const count = says.length;
  const turns = useMemo(() => buildLog(says, players, viewer), [says, count, last, players, viewer]);
  const ids = useMemo(() => cardIdsNamedInView(view), [view]);
  const names = useMemo(() => new Map(players.map((p) => [p.id, p.name])), [players]);

  const [flipped, setFlipped] = useState<ReadonlySet<number>>(new Set());
  const isOpen = (index: number): boolean => (index >= turns.length - OPEN_TURNS) !== flipped.has(index);
  const toggle = useCallback((index: number) => {
    setFlipped((was) => {
      const next = new Set(was);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);
  const scrollBox = useRef<HTMLDivElement | null>(null);
  const jump = (index: number): void => {
    if (!isOpen(index)) toggle(index);
    requestAnimationFrame(() => scrollBox.current?.querySelector(`[data-log-turn-index="${index}"]`)?.scrollIntoView({ block: 'start' }));
  };
  const setBox = (el: HTMLDivElement | null): void => {
    scrollBox.current = el;
    if (typeof listRef === 'function') listRef(el);
    else if (listRef !== null && listRef !== undefined) (listRef as { current: HTMLDivElement | null }).current = el;
  };

  return (
    <div className="game-log">
      {turns.length > 1 && (
        <nav className="game-log__turns" aria-label="Turns">
          {turns.map((t, i) => (
            <button key={i} type="button" className="game-log__chip" data-seat={t.seat} data-testid="log-turn-chip" onClick={() => jump(i)}>
              {t.n ?? '·'}
            </button>
          ))}
        </nav>
      )}
      <div className="game-log__scroll" data-testid="live-log" aria-label="Said" ref={setBox}>
        {turns.map((t, i) => (
          <Turn key={i} turn={t} index={i} open={isOpen(i)} toggle={toggle} ids={ids} names={names} />
        ))}
      </div>
    </div>
  );
}
