/*
 * The seat-filling bot.
 *
 * Card quality comes from Forge's cube pick order (`ranking.ts`), the same
 * CubeCobra list Forge's own `CardRanker` drafts cubes with; a card the order
 * does not rank is judged by its rarity instead. On top of quality sit colour
 * commitment and a rough curve: a bot takes the best card until its pool names
 * two colours, then stays in them unless a much better card comes by.
 *
 * Deterministic: every choice comes from `botRng(state, seat)`, which is keyed
 * by (seed, seat, pack, pick). A bot's pick therefore depends only on where the
 * draft is, never on how many times anything else drew from a shared stream —
 * so a human picking in a different order cannot change what the bots do, and
 * the replay guarantee holds without replaying the humans identically.
 */

import type { DraftCard, ManaColor } from '@hadoku/shared';
import { cubeRank, CUBE_RANKING_SIZE } from './ranking.ts';
import type { SeatId } from '@wolffm/rooms-protocol';
import { botRng, isBotSeat, packOf, pick, pickNumberOf, waitingOn, type DraftState, type PickResult } from './engine.ts';

/** How much a card already in our colours is worth over one that is not. */
const ON_COLOUR_BONUS = 3.0;
/** Per-pip penalty for a colour we have not committed to. */
const OFF_COLOUR_PENALTY = 1.6;
/** Cheap cards are marginally preferred; a curve, not a rule. */
const CURVE_WEIGHT = 0.12;
/** Enough jitter to break ties without overriding the heuristic. */
const JITTER = 0.4;

/** Pips of each colour in a pool, which is what "our colours" means here. */
export function colourCounts(pool: readonly DraftCard[]): Record<ManaColor, number> {
  const counts: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const card of pool) {
    for (const colour of card.colors) counts[colour] += 1;
  }
  return counts;
}

/**
 * The colours this pool is committed to.
 *
 * Two, once there is enough evidence to name two. Early picks commit to
 * nothing, which is what makes the first few picks look like raw card quality
 * rather than a bot forcing an archetype from pick one.
 */
export function committedColours(pool: readonly DraftCard[]): ManaColor[] {
  if (pool.length < 3) return [];
  const counts = colourCounts(pool);
  return (Object.keys(counts) as ManaColor[])
    .filter((c) => counts[c] > 0)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 2);
}

/**
 * Quality of the best-ranked card. Ranked cards fall linearly from here to 0 at
 * the last rank, as Forge's own `100 − 100·rank/size` does. Six sits against
 * the colour weights so that, once a pool is committed, an off-colour card wins
 * only over on-colour cards from the bottom quarter of the order: the top card off
 * colour (6 − 1.6) beats an on-colour card worth less than 1.4 (+3), that is
 * ranked below about 3100 of 4000. Before commitment it is the whole score.
 */
const QUALITY_SPAN = 6;

/**
 * Where an unranked card sits on that scale, by rarity: a common as a card
 * ranked three quarters of the way down, a mythic as one ranked 40% down.
 * Unranked is not the same as bad — the order leaves out cube staples — so the
 * band is the lower middle, not the floor.
 */
const UNRANKED_FLOOR = 0.25;
const UNRANKED_CEILING = 0.6;

/** Rarity as a stand-in for quality, 0 (common) to 1 (mythic). */
const RARITY_STANDING: Record<DraftCard['rarity'], number> = {
  common: 0,
  uncommon: 0.25,
  special: 0.25,
  rare: 0.75,
  mythic: 1,
};

/** Card quality from 0 to `QUALITY_SPAN`. */
function baseQuality(card: DraftCard): number {
  const rank = cubeRank(card.name);
  const standing =
    rank === null
      ? UNRANKED_FLOOR + RARITY_STANDING[card.rarity] * (UNRANKED_CEILING - UNRANKED_FLOOR)
      : 1 - rank / CUBE_RANKING_SIZE;
  return QUALITY_SPAN * standing;
}

/** Score one card for a pool. Exported so the tests can pin the heuristic. */
export function scoreCard(card: DraftCard, pool: readonly DraftCard[]): number {
  const colours = committedColours(pool);
  let score = baseQuality(card);

  // Colourless cards are always castable, so they are never punished.
  if (card.colors.length === 0) {
    score += 0.5;
  } else if (colours.length === 0) {
    // Uncommitted: take the best card and let it decide our colours.
  } else {
    const onColour = card.colors.filter((c) => colours.includes(c));
    const offColour = card.colors.filter((c) => !colours.includes(c));
    if (offColour.length === 0) score += ON_COLOUR_BONUS;
    else score -= OFF_COLOUR_PENALTY * offColour.length;
    if (onColour.length > 0 && offColour.length > 0) score += ON_COLOUR_BONUS / 2;
  }

  score -= card.manaValue * CURVE_WEIGHT;
  return score;
}

/** The card this bot would take from a pack. Null only for an empty pack. */
export function choosePick(
  pack: readonly DraftCard[],
  pool: readonly DraftCard[],
  rng: { next(): number },
): DraftCard | null {
  if (pack.length === 0) return null;
  let best: DraftCard | null = null;
  let bestScore = -Infinity;
  for (const card of pack) {
    const score = scoreCard(card, pool) + rng.next() * JITTER;
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return best;
}

/** A structured log line, same shape `apps/server/src/log.ts`'s `jsonLogger` callers already pass everywhere else — this package stays Node-and-server-agnostic, so the default just goes to `console.error`, loud on purpose. */
export type BotLog = (entry: Record<string, unknown>) => void;

const defaultBotLog: BotLog = (entry) => console.error(JSON.stringify(entry));

/**
 * One pick for every bot seat holding a pack — a bot's turn at the table.
 *
 * One each, not as many as they can: a bot that drained its whole queue in one
 * go would hand a pod's every pack to the next human at once. The server paces
 * these (`room/socket.ts`); `runBots` repeats them until no bot can pick.
 *
 * A pass where some bot held a pack and none could take a card used to break
 * silently — the production incident this caught (main 705e2468: every seat
 * frozen, no error, no log, for 120s). `log` is called once, loud, with exactly
 * what a report needs: every holding bot seat's pick, pack and pool size.
 *
 * `chosen` is a card id per bot seat picked by something else (the server's
 * draftbot); a seat it does not name, or names a card its pack no longer
 * holds, takes the heuristic's pick.
 */
export function botTurn(
  state: DraftState,
  log: BotLog = defaultBotLog,
  chosen: ReadonlyMap<SeatId, string> = new Map(),
): { state: DraftState; picks: number; stalled: boolean } {
  const owing = waitingOn(state).filter((s) => isBotSeat(state, s));
  let current = state;
  let picks = 0;
  for (const seatId of owing) {
    const other = chosen.get(seatId);
    let result: PickResult | null = other === undefined ? null : pick(current, seatId, other);
    if (result === null || !result.ok) {
      const card = choosePick(packOf(current, seatId), current.pools[seatId] as DraftCard[], botRng(current, seatId));
      if (card === null) continue;
      result = pick(current, seatId, card.cardId);
    }
    if (!result.ok) continue;
    current = result.state;
    picks += 1;
  }
  const stalled = owing.length > 0 && picks === 0;
  if (stalled) {
    log({
      evt: 'bots-stalled',
      draftId: current.draftId,
      packNumber: current.packNumber,
      seats: owing.map((seatId) => ({
        seatId,
        pickNumber: pickNumberOf(current, seatId),
        packSize: packOf(current, seatId).length,
        poolSize: (current.pools[seatId] as DraftCard[]).length,
      })),
    });
  }
  return { state: current, picks, stalled };
}

/** Whether any bot seat holds a pack to pick from. */
export function botsOwe(state: DraftState): boolean {
  return waitingOn(state).some((s) => isBotSeat(state, s));
}

/**
 * Bot turns until no bot holds a pack: a pod of eight bots drafts to completion
 * in one call. The guard is the pick count, not a `while (true)`; a stalled
 * turn ends it rather than spinning.
 */
export function runBots(state: DraftState, log: BotLog = defaultBotLog): { state: DraftState; picks: number } {
  let current = state;
  let picks = 0;
  const limit = state.seatCount * state.packCount * state.packSize + 1;
  while (picks < limit && botsOwe(current)) {
    const turn = botTurn(current, log);
    current = turn.state;
    picks += turn.picks;
    if (turn.stalled) break;
  }
  return { state: current, picks };
}
