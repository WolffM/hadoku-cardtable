/**
 * The game log, as something to read: a match's says grouped into turns, a
 * response nested under what it answered, and what a resolution did under the
 * spell that did it.
 *
 * The operator, 2026-11-09: *"the game log is quite ugly and it drops several
 * decisions. players often want to go back and check the log to see what
 * happened. some things like what was targeted or damage dealt or what a
 * resolution did is not visible."* The design they approved is the canvas
 * "Game Log Redesign" (artifact Qh1meBmybKw23kjDqoLMAP): turns with both life
 * totals, a verb mark in the seat's colour, payment as mana symbols on the cast,
 * one combat block a turn, results under their spell.
 *
 * Everything here is read off a line's public half (`GameLogMeta`, which the
 * bridge's `GameLogForward` fills in): who did it (`actor`), the stack item a
 * cast put on the stack and the one it answered (`stack`, `parent`), the item a
 * line was written while resolving (`of`) or that it finishes (`resolves`), the
 * mana that paid (`mana`), a life change (`life`), the turn and the step. The
 * words stay the bridge's, each seat's own, so nothing here can name a card the
 * seat may not see. A line from before those fields existed (an old recording's
 * replay) has none of them, and still reads: it is a row of its turn, its actor
 * found by the name it opens with.
 */
import type { GameLogLine } from '@hadoku/forge-wire';

import type { Say } from '../match.ts';

/** Whose line it is, from the viewer's side. */
export type Seat = 'you' | 'them' | 'none';

/** What a row reports, which picks its mark. */
export type RowKind =
  | 'cast'
  | 'activate'
  | 'trigger'
  | 'land'
  | 'draw'
  | 'discard'
  | 'attack'
  | 'block'
  | 'damage'
  | 'life'
  | 'result'
  | 'outcome'
  | 'said';

export interface LogRow {
  say: Say;
  /** The words as drawn: Forge's internal brackets and reminder text taken out. */
  text: string;
  kind: RowKind;
  seat: Seat;
  /** A life change, when the line is one. */
  life: { seat: Seat; from: number; to: number } | null;
}

export interface LogItem {
  kind: 'item';
  row: LogRow;
  /** The stack item's id. */
  stack: number;
  /** The mana that paid for it, as tokens (`['G','G','U']`). */
  mana: string[];
  /** What answered it, in the order they were put on the stack. */
  responses: LogItem[];
  /** What its resolution did, and the resolution's own line. */
  results: LogNode[];
  resolved: boolean;
}

export type LogNode = LogItem | { kind: 'row'; row: LogRow } | { kind: 'combat'; nodes: LogNode[] };

export interface TurnLife {
  player: number;
  seat: Seat;
  /** Life at the end of the turn (now, for the turn still going). */
  at: number;
  /** The change over the turn; 0 when it did not change. */
  delta: number;
}

export interface LogTurn {
  /** The turn's number; null for lines before any turn line. */
  n: number | null;
  seat: Seat;
  /** Whose turn, by name, when the log said. */
  who: string | null;
  nodes: LogNode[];
  life: TurnLife[];
  /** The cards played and cast in it, for the turn's one line when it is folded. */
  summary: string[];
}

/** A player as the board view has them: Forge's id, the name, the life now. */
export interface LogPlayer {
  id: number;
  name: string;
  life: number;
}

/* ── the words ─────────────────────────────────────────────────────────── */

/** Forge's own bookkeeping on a trigger's line: "[Zone Changer: Doomed Traveler]", "[Attacker: Varolz]". */
const BRACKETS = /\s*\[[A-Z][A-Za-z ]*: [^\]]*\]/g;
/** "([Prime Speaker Zegana])", a delayed trigger's echo of its card. */
const ECHO = /\s*\(\[[^\]]*\]\)/g;
/** Reminder text: a parenthesis with words in it, but not "(X=6)" and not a target. */
const REMINDER = /\s*\((?!Targeting:|X=)[^()]*\s[^()]*\)/g;
/** "(Targeting: [[TeaW1thRum]])" on a resolution: the target, said as an arrow. */
const TARGETING = /\s*\(Targeting: \[*([^\]()]*)\]*\)/g;
/** "targeting [Prognostic Sphinx]" on a cast: the target, said as an arrow. */
const TARGETING_CAST = / targeting \[([^\]]*)\]/;

/** A line's words as drawn. Brace notation is said by the caller (`plainRulesText`). */
export function cleanText(text: string): string {
  return text
    .replace(BRACKETS, '')
    .replace(ECHO, '')
    .replace(REMINDER, '')
    .replace(TARGETING, ' → $1')
    .replace(TARGETING_CAST, ' → $1')
    .replace(/\b1 card\(s\)/g, '1 card')
    .replace(/card\(s\)/g, 'cards')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim();
}

/** A resolution line that only says the ability again ("When Temple of Deceit enters, scry 1.", "Persist"). */
function restates(text: string): boolean {
  return /^(When|Whenever|At|As)\b/.test(text) || !/\s/.test(text);
}

/** "Thought Scour - bob mills two cards." under Thought Scour reads "bob mills two cards.". */
function withoutOwnName(text: string, name: string | null): string {
  if (name === null || !text.startsWith(`${name} - `)) return text;
  return text.slice(name.length + 3).trim();
}

/** `{G}{G}{U}` as tokens. */
export function manaTokens(mana: string | undefined): string[] {
  if (mana === undefined) return [];
  return [...mana.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/* ── who ───────────────────────────────────────────────────────────────── */

function seatOf(actor: number | undefined, text: string, players: readonly LogPlayer[], viewer: number | null): Seat {
  let id = actor;
  if (id === undefined) {
    const lower = text.toLowerCase();
    id = players.find((p) => lower.startsWith(`${p.name.toLowerCase()} `))?.id;
  }
  if (id === undefined) return 'none';
  if (viewer === null) return 'none';
  return id === viewer ? 'you' : 'them';
}

function kindOf(say: Say): RowKind {
  const log = say.log;
  if (log === null) return 'said';
  switch (log.type) {
    case 'STACK_ADD':
      return / triggered /.test(say.text) ? 'trigger' : / activated /.test(say.text) ? 'activate' : 'cast';
    case 'LAND':
      return 'land';
    case 'DISCARD':
      return 'discard';
    case 'DAMAGE':
      return 'damage';
    case 'LIFE':
      return 'life';
    case 'COMBAT':
      // "alice assigned Grizzly Bears to attack bob." is the attack; a block, or none, is the defender's.
      return / to attack /.test(say.text) ? 'attack' : 'block';
    case 'ZONE_CHANGE':
      return / draws /.test(say.text) ? 'draw' : 'result';
    case 'GAME_OUTCOME':
    case 'MATCH_RESULTS':
      return 'outcome';
    default:
      return 'result';
  }
}

/** The name of the card a cast line puts on the stack: "alice cast Opt" → "Opt". */
function castName(text: string): string | null {
  const m = / (?:cast|activated|triggered) (.+?)(?: targeting \[.*\])?$/.exec(text);
  return m === null ? null : m[1]!.replace(/'s Effect$/, '');
}

function isCombat(log: GameLogLine | null): boolean {
  return log?.phase?.startsWith('COMBAT_') === true || log?.type === 'COMBAT';
}

/* ── the build ─────────────────────────────────────────────────────────── */

const TURN_LINE = /^Turn (\d+) \((.*)\)$/;

/**
 * The says, as turns. `players` and `viewer` (the viewer's Forge player id; null
 * for nobody's) decide whose each line is; `players`' life is what a turn's
 * totals start from when no line has said a life yet.
 */
export function buildLog(says: readonly Say[], players: readonly LogPlayer[], viewer: number | null): LogTurn[] {
  const turns: LogTurn[] = [];
  const items = new Map<number, LogItem>();
  const names = new Map<number, string | null>();
  /** Where each stack item was put, so a player's next spell over their own goes beside it. */
  const placedIn = new Map<number, LogNode[]>();
  /** Each turn's life changes in the order they happened (the tree's order is the stack's, not time's). */
  const lifeChanges = new Map<LogTurn, NonNullable<GameLogLine['life']>[]>();
  let turn: LogTurn | null = null;
  const open = (n: number | null, seat: Seat, who: string | null): LogTurn => {
    const t: LogTurn = { n, seat, who, nodes: [], life: [], summary: [] };
    turns.push(t);
    return t;
  };

  for (const say of says) {
    const log = say.log;
    const turnLine = log?.type === 'TURN' ? TURN_LINE.exec(say.text) : null;
    if (log !== null && log.type === 'TURN') {
      const n = log.turn ?? (turnLine === null ? null : Number(turnLine[1]));
      turn = open(n, seatOf(log.actor, turnLine?.[2] ? `${turnLine[2]} ` : '', players, viewer), turnLine?.[2] ?? null);
      continue;
    }
    turn ??= open(null, 'none', null);
    if (log?.life !== undefined) lifeChanges.set(turn, [...(lifeChanges.get(turn) ?? []), log.life]);
    const text = cleanText(say.text);
    const seat = seatOf(log?.actor, say.text, players, viewer);
    const life = log?.life === undefined ? null : { seat: seatOf(log.life.player, '', players, viewer), from: log.life.from, to: log.life.to };
    const row: LogRow = { say, text, kind: kindOf(say), seat, life };

    // Where it goes: under the stack item it came of, else in the turn (in its combat, during combat).
    const into = (node: LogNode): LogNode[] => {
      const owner = log?.resolves ?? log?.of;
      const item = owner === undefined ? undefined : items.get(owner);
      if (item !== undefined) {
        item.results.push(node);
        return item.results;
      }
      const nodes = turn!.nodes;
      if (isCombat(log)) {
        const last = nodes[nodes.length - 1];
        if (last?.kind === 'combat') {
          last.nodes.push(node);
          return last.nodes;
        }
        const block: LogNode = { kind: 'combat', nodes: [node] };
        nodes.push(block);
        return block.nodes;
      }
      nodes.push(node);
      return nodes;
    };

    if (log?.type === 'STACK_ADD' && log.stack !== undefined) {
      const item: LogItem = { kind: 'item', row, stack: log.stack, mana: manaTokens(log.mana), responses: [], results: [], resolved: false };
      items.set(log.stack, item);
      const name = castName(say.text);
      names.set(log.stack, name);
      const parent = log.parent === undefined ? undefined : items.get(log.parent);
      if (parent !== undefined && !parent.resolved) {
        // An answer is the other player's spell, or a trigger; a player stacking their own spells is not answering
        // themselves, and those go side by side.
        const answers = row.kind === 'trigger' || parent.row.say.log?.actor !== log.actor;
        const beside = placedIn.get(parent.stack);
        if (answers || beside === undefined) {
          parent.responses.push(item);
          placedIn.set(log.stack, parent.responses);
        } else {
          beside.push(item);
          placedIn.set(log.stack, beside);
        }
      } else {
        placedIn.set(log.stack, into(item));
      }
      if (name !== null && row.kind === 'cast') turn.summary.push(name);
      continue;
    }
    if (log?.resolves !== undefined) {
      const item = items.get(log.resolves);
      if (item !== undefined) {
        item.resolved = true;
        const own = withoutOwnName(text, names.get(log.resolves) ?? null);
        const others = item.results.length > 0 || item.responses.length > 0;
        if (own === '' || (others && restates(own))) continue;
        item.results.push({ kind: 'row', row: { ...row, text: own } });
        continue;
      }
    }
    if (row.kind === 'land') {
      const name = /played (.+)$/.exec(say.text)?.[1];
      if (name !== undefined) turn.summary.push(name);
    }
    into({ kind: 'row', row });
  }

  // The first turn line Forge writes is often after the game began (the first turn's own is written before
  // the bridge listens): the lines before it are the turn before.
  const [first, second] = turns;
  if (first !== undefined && first.n === null && second?.n !== null && second?.n !== undefined && second.n > 1) first.n = second.n - 1;
  fillLife(turns, (t) => lifeChanges.get(t) ?? [], players, viewer);
  return turns;
}

/** Each turn's life totals at its end, and their change over it, from its life changes in the order they happened. */
function fillLife(
  turns: LogTurn[],
  changesOf: (turn: LogTurn) => readonly NonNullable<GameLogLine['life']>[],
  players: readonly LogPlayer[],
  viewer: number | null,
): void {
  // The life each player had before the log's first word of it: its first change's `from`, else now.
  const start = new Map<number, number>(players.map((p) => [p.id, p.life]));
  const seen = new Set<number>();
  for (const t of turns) {
    for (const c of changesOf(t)) {
      if (seen.has(c.player)) continue;
      seen.add(c.player);
      start.set(c.player, c.from);
    }
  }
  const now = new Map(start);
  for (const t of turns) {
    const before = new Map(now);
    for (const c of changesOf(t)) now.set(c.player, c.to);
    t.life = players.map((p) => ({
      player: p.id,
      seat: viewer === null ? 'none' : p.id === viewer ? 'you' : 'them',
      at: now.get(p.id) ?? p.life,
      delta: (now.get(p.id) ?? p.life) - (before.get(p.id) ?? p.life),
    }));
  }
}
