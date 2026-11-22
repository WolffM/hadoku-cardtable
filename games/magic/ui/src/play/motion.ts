import { afterGlide as glideDone, animationName, Stage, type StageHold, type TrackOptions } from '@hadoku/ui-shell/motion';

export { writeDurations } from '@hadoku/ui-shell/motion';

/**
 * How long a released card's placement is waited for — the row's reserved gap
 * (`Board.tsx`), the other seat's back standing in it (`live/presence.ts`) and
 * the stack layer's record of the release point (`live/placed.ts`) are one
 * fact, so one clock: none of them may give up while another still holds. It is
 * a safety clock: a cast that is cancelled ends its wait itself (the card back in
 * its owner's hand, or their screen saying it is no longer parked — `presence.ts`).
 * On the other seat's screen it runs from the LAST word that their card is
 * still parked (`presence.ts` restates a parked card), not from the release:
 * a target or a payment may take a player as long as they like.
 */
export const PLACEMENT_WAIT_MS = 15_000;

/** The house glide — a float-back, a hand FLIP, the other seat's hand-move — so both screens move in step. */
export const GLIDE_MS = 300;

/** The other seat's pointer, and whatever moves with it, gliding between the samples presence sends about sixteen times a second. */
export const FOLLOW_MS = 90;

/** The lengths every layer on the board animates over, as the `--*-ms` their sheets read. */
export const HOUSE_DURATIONS = [
  ['--glide-ms', GLIDE_MS],
  ['--follow-ms', FOLLOW_MS],
] as const;

/** `el`'s glide has come to rest (`@hadoku/ui-shell/motion`'s `afterGlide`), or `GLIDE_MS` where the page cannot list its animations. Returns a cancel. */
export function afterGlide(el: Element, done: () => void): () => void {
  return glideDone(el, done, GLIDE_MS);
}

/*
 * A resolution's effects, as beats (the operator, 2026-10-14: Kalitas's Zombie and Sorin, Grim
 * Nemesis's reveal-then-drain were "too instant"). Forge applies a resolution in one frame; the
 * board draws it in Forge's order — a reveal is shown, then what it caused travels to its target;
 * a created permanent travels from what made it — each beat short, the whole ≲1.2 s. Nothing here
 * holds input: an ask that arrives meanwhile is drawn at once, over the motion.
 */

/** A revealed card's beat — in the reveal notice, or where the board draws it — before anything it caused is drawn. */
export const REVEAL_BEAT_MS = 450;
/**
 * The other seat's attackers, drawn attacking, before anything after them is drawn — their blow above
 * all: as long as a spell stands on the stack before it resolves (`live/pace.ts`'s resolve gap). A
 * person's attack is seen one declaration at a time and its blow seconds later; the Forge AI's came in
 * the same moment as its blow (the operator, 2026-10-19: "they attack me and i dont even see their
 * creatures do the attack because everything happens so fast").
 */
export const ATTACK_BEAT_MS = 600;
/** A hit (damage, life lost or gained) travelling from its source to the player or creature it changes — on its arc, speeding up (`live/projectile.ts`). */
export const HIT_MS = 850;

/**
 * The damage at which every effect is at its heaviest — one scale, for every damage effect, creature
 * combat blows included (AF420: the spell-damage preview, approved 2026-10-27, "looks great. i can
 * approve that animation"; asked whether combat should share a spell's cap, the recommendation taken
 * was yes, kept as this one constant so it can be changed back on its own). It was 20 (the operator,
 * 2026-10-16: "let's allow it to scale up to 20"), then 10 (re-anchored 2026-10-17 on a survey of every
 * loaded deck — ledger AF149: 1,459 decks, 21,361 creature copies — median power 2, p90 5, p99 10 —
 * after the operator found the growth "too linear"), and 20 again from AF420's preview, which found the
 * ten-point scale left a spell's biggest hits looking the same size.
 */
export const MAX_DAMAGE = 20;

/**
 * How much a hit of `amount` damage weighs, 0 to 1: one point is the lightest, `MAX_DAMAGE` and more
 * the heaviest, on a square-root curve so the first few points each count and the top still climbs
 * (a log curve flattened out near its cap, and 9 looked no lighter than 10): a two is a sixth of the
 * way, a three a bit over a fifth, a five nearly half, a ten two thirds. Every damage effect
 * scales with it — its size, its pace and its sound (the operator, 2026-10-16: "any animation
 * involving damage (spell or combat) must scale with how much damage it is").
 */
export function damagePower(amount: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, (amount - 1) / (MAX_DAMAGE - 1))));
}

/** An effect's size at `power`: four fifths for a point, about one and a half at five, 1.9 times at ten and beyond. */
export function powerSize(power: number): number {
  return 0.8 + 1.1 * power;
}

/**
 * A DAMAGE effect's size at `power`: a spell's ball and burst (`live/projectile.ts`), a combat blow's
 * crash (`live/crash.ts`) — the bigger scale AF420 gave damage once its cap reached 20 (0.8 to 2.5,
 * `powerSize`'s own 0.8 to 1.9). Kept apart from `powerSize` on purpose: a creature's own LANDING
 * weight (`live/entries.ts`, out of scope for AF420) reuses `powerSize` too, at a scale the operator
 * approved the same day (AF413) — raising `powerSize` itself would have grown its debris along with
 * every spell, with nobody having looked at that.
 */
export function damageSize(power: number): number {
  return 0.8 + 1.7 * power;
}

/** A move's pace and its way home at `power` (the operator, 2026-10-16: "weaker creatures can start faster but have less accelleration. stronger creatures start slower with more accelleration. that way the time to complete the animation is still the same"). */
export { weightEase as powerEase, homeEase } from '@hadoku/ui-shell/motion';

/** Between two created permanents of one resolution. */
export const BEAT_STAGGER_MS = 120;
/** Between two bolts of one resolution: each slam, and the death it causes, on its own. */
export const BOLT_STAGGER_MS = 300;

/**
 * How far through its beats the board is when what waits on them may go (the operator, 2026-10-28: "let's
 * "unlock" the game state when it's waiting on the last ~10% of an animation"). The pacer's every wait on the
 * board's beats ends here ({@link whenBoardUnlocked}) — a view's beats (`live/numbers.ts`), a die or a coin in
 * the air (`live/dice.ts`, `live/coin-flip.tsx`, `live/pace.ts`), the running animations
 * ({@link animationsSettled}) — while the beat itself still plays to its end, under whatever is drawn next.
 */
export const UNLOCK_AT = 0.9;

/** The id every beat's own Web Animation carries (`live/ram.ts`, `live/crash.ts`, `live/projectile.ts`), beside the beats' stylesheet animations ({@link BEAT_KEYFRAMES}). */
export const BEAT_ANIMATION_ID = 'beat';

/**
 * The keyframes a beat draws with: a card leaving (`departures.css`), a floating number (`numbers.css`), a hit,
 * a crash or a bolt (`numbers.css`, `crash.css`, `projectile.css`), a spell resolving or countered (`placed.css`).
 */
const BEAT_KEYFRAMES = ['board-exit-', 'board-number-', 'effect-', 'placed-'] as const;

/*
 * What the board is drawing now, for what must wait until it is over (the operator, 2026-10-15: "the
 * game-loss trigger should also only happen after the fireball actually hits"; 2026-10-17: "the final
 * creature doesn't even get to attack because the game ends immediately"): the game's end is the last
 * beat — its result screen and its sound come once every beat drawn before it has played out
 * ({@link whenBoardStill}). The pacer's frames go sooner, at each beat's {@link UNLOCK_AT}
 * ({@link whenBoardUnlocked}): a bolt's view ends as it hits, so its 90% is still in the air. Every board on
 * the page shares this one stage (`@hadoku/ui-shell/motion`'s `Stage`).
 */
export const defaultStage = new Stage({
  unlockAt: UNLOCK_AT,
  isBeat: (a) => {
    const name = animationName(a);
    return name === BEAT_ANIMATION_ID || BEAT_KEYFRAMES.some((prefix) => name.startsWith(prefix));
  },
});

/** When a beat `ms` long lets go of what waits on it: {@link UNLOCK_AT} of the way through. */
export const unlockAfter = (ms: number): number => defaultStage.unlockAfter(ms);

/**
 * `live/numbers.ts` is drawing a view's beats (or `live/dice.ts` a roll, `live/coin-flip.tsx` a coin): the board
 * is busy until `over` settles, and locked until it is {@link UNLOCK_AT} through `unlocks.endsInMs` — or `over`
 * settles first. Without `unlocks` it is locked until `over`.
 */
export function noteBoardDrawing(over: Promise<unknown>, unlocks?: TrackOptions & { endsInMs: number }): void {
  const finished = over.then(() => undefined, () => undefined);
  defaultStage.track({ finished, cancel: () => undefined, endsInMs: unlocks?.endsInMs ?? Infinity }, unlocks);
}

/*
 * The board's stage as its readers know it: the frame rate's reports (`boardDrawing`, `live/frame-watch.ts`), a held
 * frame's (`boardHold`), the result screen's wait (`whenBoardStill`), the pacer's (`whenBoardUnlocked`, `live/pace.ts`)
 * and a view's wait on its beats (`animationsSettled`).
 */
export type BoardHold = StageHold;
export const boardDrawing = (): number => defaultStage.drawingCount;
export const boardHold = (): BoardHold => defaultStage.held();
export const whenBoardStill = (done: () => void): (() => void) => defaultStage.whenStill(done);
export const whenBoardUnlocked = (done: () => void): (() => void) => defaultStage.whenUnlocked(done);
export const animationsSettled = (root: Element, through = 1): Promise<void> => defaultStage.settled(root, through);

/**
 * The moments a view's sounds wait for, as the board's cues (`defaultStage.cue(CUE.life, seq, at)`): a life
 * total's, until its first hit on a player lands; a creature's damage, until its first hit on a card; a
 * permanent leaving, until its first exit starts; a mill, until its first card leaves the library (the
 * operator, 2026-10-16, of the rams: "be careful with sound effects here"). `sounds` carries the
 * {@link BoardSound}s only the board's drawing knows the moment of.
 */
export const CUE = { life: 'life-impact', card: 'card-impact', exit: 'exit', mill: 'mill', sounds: 'sounds' } as const;

/**
 * A sound only the board's own drawing knows to play: a ram's charge and blow, a spell's ball slamming in,
 * a creature cracking. `at` is when (epoch ms), `intensity` how heavy (`damagePower`), `mine` whether the
 * viewer's side did it, `colourCell` a colour cell to layer on top.
 */
export interface BoardSound {
  readonly role: string;
  readonly at: number;
  readonly intensity: number;
  readonly mine: boolean;
  readonly colourCell?: string | null;
}

/** When each resolved stack item's drawn effects end (epoch ms), so its spell fades after them. */
const effectsUntil = new Map<number, number>();

/** `live/numbers.ts` has scheduled what stack item `itemId` did: the last of it is drawn by `until`. */
export function noteResolutionEffects(itemId: number, until: number): void {
  effectsUntil.set(itemId, until);
}

/** When what `itemId` did is drawn by, once — `live/placed.ts` reads it as the item leaves; null when it did nothing drawn. */
export function takeResolutionEffects(itemId: number): number | null {
  const until = effectsUntil.get(itemId);
  effectsUntil.delete(itemId);
  return until ?? null;
}

/**
 * How long a Room's door that just unlocked plays its beat (`Board.tsx`'s `RoomDoors`, `card.css`'s
 * `[data-unlocking]`): long enough to be seen as it happens, over before the next thing does.
 */
export const UNLOCK_BEAT_MS = 1_200;
