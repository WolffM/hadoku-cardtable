/*
 * The seat-filling bot.
 *
 * Scope, settled at planning: a simple heuristic — colour commitment plus a
 * rough curve. No rankings data file, no port of Forge's `CardRanker`. The job
 * is that an 8-seat pod works when four friends turn up, and that packs wheel
 * plausibly enough for signal-reading to mean something. It is not to draft
 * well.
 *
 * Deterministic: every choice comes from `botRng(state, seat)`, which is keyed
 * by (seed, seat, pack, pick). A bot's pick therefore depends only on where the
 * draft is, never on how many times anything else drew from a shared stream —
 * so a human picking in a different order cannot change what the bots do, and
 * the replay guarantee holds without replaying the humans identically.
 */

import type { DraftCard, ManaColor } from '@hadoku/shared';
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
 * Rough card quality with no external data.
 *
 * Rarity is the only quality signal a cube list carries — we have no rankings
 * file and deliberately did not port one — so it stands in for "is this card
 * good". It is a weak proxy: cubes are full of commons that outclass rares.
 * Good enough for a seat-filler, and the cost of being wrong is that a bot
 * takes the wrong card, which is also what human drafters do.
 */
function baseQuality(card: DraftCard): number {
  switch (card.rarity) {
    case 'mythic':
      return 4;
    case 'rare':
      return 3.5;
    case 'uncommon':
      return 2.5;
    case 'special':
      return 2.5;
    default:
      return 2;
  }
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
 */
export function botTurn(state: DraftState, log: BotLog = defaultBotLog): { state: DraftState; picks: number; stalled: boolean } {
  const owing = waitingOn(state).filter((s) => isBotSeat(state, s));
  let current = state;
  let picks = 0;
  for (const seatId of owing) {
    const card = choosePick(packOf(current, seatId), current.pools[seatId] as DraftCard[], botRng(current, seatId));
    if (card === null) continue;
    const result: PickResult = pick(current, seatId, card.cardId);
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
