/*
 * One swept match, start to finish: a scenario match against Forge's AI on the running stack
 * (`./board.ts`), this seat joined over the real socket as the monkey joins, `driveSeat` under
 * `./policy.ts` until its cards have been played and followed for two turns, then a concede.
 *
 * A match plays one card or several. One result comes back per card either way; a match's flags and
 * the turns played on belong to the match, so every card of it carries them.
 */
import { mintTabId } from '@wolffm/rooms-protocol';

import { socketPath } from '@hadoku/game-ui/room/socket-options.ts';
import { startMatch, type LiveMatch, type MatchTrouble } from '../../../../../ui/src/play/live/match.ts';

import type { Flag } from '../report.ts';
import type { Rng } from '../rng.ts';
import { giveUp, isRefusal, jvmStderrLines, lastServerRows, logEnd, makeLogTail, serverFlagsOf, troubleEndsMatch } from '../run-match.ts';
import { driveSeat } from '../seat-driver.ts';
import { closeSocketTransport, socketTransport } from '../wire-transport.ts';

import { boardFor } from './board.ts';
import { sweeper, type CardTrace, type Variant } from './policy.ts';
import type { SetCard } from './set-cards.ts';

export interface RunCardsOptions {
  origin: string;
  prefix: string;
  cookie: string;
  seed: number;
  rng: Rng;
  /** The cards this match plays, in the order it casts them. */
  cards: readonly SetCard[];
  variant: Variant;
  stuckMs: number;
  /** The wall the match may take. */
  timeoutMs: number;
  serverLogFile: string;
  workDir: string;
}

/** What the server decided for the seat, off its own log: an answer it gave itself, a pick it made, a question nobody could answer. */
export interface ServerDecision {
  evt: string;
  method: string | null;
  why: string | null;
}

export interface CardResult {
  card: string;
  rarity: string;
  variant: Variant;
  matchId: string;
  /** The other cards the same match played, in order. Empty: the card had a match of its own. */
  with: string[];
  seed: number;
  cast: CardTrace['cast'];
  /** Where the card was when the run ended, on this seat's own view; null when it is in no zone the seat sees (a library, the other side). */
  endedIn: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | null;
  /** The board when the run ended, by card name: what the card did is the difference from `./board.ts`. */
  board: BoardSeen | null;
  asks: CardTrace['asks'];
  uses: number;
  attacked: boolean;
  server: ServerDecision[];
  turns: number | null;
  decisions: number;
  /** Why the match ended: the plan finished, the game ended, the wall, or a broken connection. */
  ended: 'done' | 'game-over' | 'timed-out' | 'crashed' | 'unstarted';
  ms: number;
  flags: Flag[];
}

export interface BoardSeen {
  life: [number, number];
  hand: string[];
  battlefield: string[];
  graveyard: string[];
  exile: string[];
  theirBattlefield: string[];
  theirHandCount: number;
}

/** The names in `cards` but the basic lands, sorted. */
function names(cards: readonly { card: { name: string } }[]): string[] {
  return cards.map((c) => c.card.name).filter((name) => !/^(Plains|Island|Swamp|Mountain|Forest)$/.test(name)).sort();
}

function boardOf(match: LiveMatch): BoardSeen | null {
  const me = match.view?.players.find((p) => p.isViewer);
  const them = match.view?.players.find((p) => !p.isViewer);
  if (me === undefined || them === undefined) return null;
  return { life: [me.life, them.life], hand: names(me.hand ?? []), battlefield: names(me.battlefield), graveyard: names(me.graveyard), exile: names(me.exile), theirBattlefield: names(them.battlefield), theirHandCount: them.handCount };
}

const SERVER_DECISIONS = new Set(['ask-auto-answered', 'auto-picked', 'auto-confirmed', 'ask-unanswerable', 'ask-unclassified']);

function zoneOf(match: LiveMatch, name: string): CardResult['endedIn'] {
  const view = match.view;
  const me = view?.players.find((p) => p.isViewer);
  if (view === null || me === undefined) return null;
  if (view.stack.some((s) => s.sourceName === name)) return 'stack';
  const zones = { hand: me.hand ?? [], battlefield: me.battlefield, graveyard: me.graveyard, exile: me.exile } as const;
  for (const [zone, cards] of Object.entries(zones)) if (cards.some((c) => c.card.name === name)) return zone as CardResult['endedIn'];
  return null;
}

export async function runCards(opts: RunCardsOptions): Promise<CardResult[]> {
  const startedAt = Date.now();
  const names = opts.cards.map((c) => c.name);
  const deck = { seat0: `${names.join(' + ')} (${opts.variant})`, seat1: 'Forge AI' };
  const traces: CardTrace[] = opts.cards.map(() => ({ cast: 'pending', asks: [], uses: 0, attacked: false }));
  const server: ServerDecision[][] = opts.cards.map(() => []);
  const flagOf = (matchId: string, detail: string, context: string[], match?: LiveMatch): Flag => ({
    kind: 'no-finish',
    matchId,
    seed: opts.seed,
    deck,
    seat: 0,
    turn: match?.view?.turn ?? null,
    phase: match?.view?.phase ?? null,
    detail,
    context,
    at: new Date().toISOString(),
  });
  const results = (matchId: string, match: LiveMatch | null, rest: Pick<CardResult, 'turns' | 'decisions' | 'ended' | 'flags'>): CardResult[] =>
    opts.cards.map((card, i) => ({
      card: card.name,
      rarity: card.rarity,
      variant: opts.variant,
      matchId,
      with: names.filter((_, j) => j !== i),
      seed: opts.seed,
      // A card the match ended before reaching was never offered.
      cast: traces[i]!.cast === 'pending' ? 'not-offered' : traces[i]!.cast,
      endedIn: match === null ? null : zoneOf(match, card.name),
      board: match === null ? null : boardOf(match),
      asks: traces[i]!.asks,
      uses: traces[i]!.uses,
      attacked: traces[i]!.attacked,
      server: server[i]!,
      ms: Date.now() - startedAt,
      ...rest,
    }));

  const logStart = logEnd(opts.serverLogFile);
  const res = await fetch(`${opts.origin}${opts.prefix}/api/play/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: opts.cookie },
    body: JSON.stringify({ opponent: 'ai', decks: [null, null], scenario: boardFor(opts.cards) }),
  });
  const body = (await res.json()) as { matchId?: string; error?: string };
  if (res.status !== 201 || body.matchId === undefined) {
    const detail = `POST /api/play/matches refused: ${body.error ?? ''} (HTTP ${res.status})`;
    return results('unstarted', null, { turns: null, decisions: 0, ended: 'unstarted', flags: [flagOf('unstarted', detail, [])] });
  }
  const matchId = body.matchId;

  let refusals = 0;
  let crashed: { what: MatchTrouble; detail: Record<string, unknown> } | null = null;
  const transport = socketTransport({
    url: opts.origin,
    path: socketPath(opts.prefix),
    cookie: opts.cookie,
    tap: {
      onServerFrame: (payload) => {
        if (isRefusal(payload)) refusals += 1;
      },
      onClientFrame: () => undefined,
    },
  });
  const match = startMatch({
    matchId,
    transport,
    tabId: mintTabId(),
    report: (what, detail) => {
      if (troubleEndsMatch(what)) crashed ??= { what, detail };
    },
  });

  const drainLog = makeLogTail(opts.serverLogFile, logStart);
  const seat = sweeper(names, opts.variant, traces);
  const serverRows = (): string[] => [...lastServerRows(opts.serverLogFile, matchId, logStart), ...jvmStderrLines(opts.serverLogFile, opts.workDir, matchId, logStart)];
  const deadline = startedAt + opts.timeoutMs;
  const { flags, decisions } = await driveSeat(
    match,
    opts.rng,
    {
      matchId,
      seed: opts.seed,
      deck,
      seat: 0,
      stuckMs: opts.stuckMs,
      refusals: () => refusals,
      drainServerFlags: () => {
        const rows = drainLog();
        // The server's rows name no card: one is the card's whose play was in flight when it was read.
        const playing = seat.playing();
        for (const row of rows) {
          if (playing === null || row.matchId !== matchId || row.seat !== 0 || !SERVER_DECISIONS.has(String(row.evt))) continue;
          server[playing]!.push({ evt: String(row.evt), method: typeof row.method === 'string' ? row.method : null, why: typeof row.why === 'string' ? row.why : null });
        }
        return serverFlagsOf(rows, matchId);
      },
      serverRows,
      policy: seat.policy,
    },
    () => seat.done() || crashed !== null || match.over || match.ended !== null || Date.now() >= deadline,
  );

  const lost = crashed as { what: MatchTrouble; detail: Record<string, unknown> } | null;
  const ended: CardResult['ended'] = lost !== null || (match.ended !== null && !match.over) ? 'crashed' : seat.done() ? 'done' : match.over ? 'game-over' : 'timed-out';
  const extra: Flag[] = [];
  if (ended === 'crashed') extra.push(flagOf(matchId, lost !== null ? `connection trouble: ${lost.what} ${JSON.stringify(lost.detail)}` : `the server ended the match: ${JSON.stringify(match.ended)}`, serverRows(), match));
  if (ended === 'timed-out') extra.push(flagOf(matchId, `${names.map((n, i) => `"${n}" (${traces[i]!.cast})`).join(', ')} not played and followed within ${opts.timeoutMs} ms`, serverRows(), match));
  const out = results(matchId, match, { turns: match.view?.turn ?? null, decisions, ended, flags: [...flags, ...extra] });
  if (!match.over && match.ended === null) await giveUp(match);
  transport.disconnect();
  closeSocketTransport(transport);
  return out;
}
