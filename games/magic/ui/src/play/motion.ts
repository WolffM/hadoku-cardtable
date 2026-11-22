import { Stage } from '@hadoku/ui-shell/motion';

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
 * board's beats ends here (its stage's `whenUnlocked`) — a view's beats (`live/numbers.ts`), a die or a coin in
 * the air (`live/dice.ts`, `live/coin-flip.tsx`, `live/pace.ts`), the running animations
 * (the stage's `settled`) — while the beat itself still plays to its end, under whatever is drawn next.
 */
export const UNLOCK_AT = 0.9;

/*
 * What the board is drawing now, for what must wait until it is over (the operator, 2026-10-15: "the
 * game-loss trigger should also only happen after the fireball actually hits"; 2026-10-17: "the final
 * creature doesn't even get to attack because the game ends immediately"): the game's end is the last
 * beat — its result screen and its sound come once every beat drawn before it has played out (its stage's
 * `whenStill`). The pacer's frames go sooner, at each beat's {@link UNLOCK_AT} (`whenUnlocked`): a bolt's view
 * ends as it hits, so its 90% is still in the air. Each board has its own stage (`@hadoku/ui-shell/motion`'s
 * `Stage`), made by its pacer (`live/pace.ts`) and attached by `LiveBoard`, where what draws on it finds it
 * (`Stage.of`).
 */
export const boardStage = (): Stage => new Stage({ unlockAt: UNLOCK_AT });

/** When a beat `ms` long lets go of what waits on it: {@link UNLOCK_AT} of the way through. */
export const unlockAfter = (ms: number): number => Math.round(ms * UNLOCK_AT);

/**
 * The moments a view's sounds wait for, as the board's cues (`stage.cue(CUE.life, seq, at)`): a life
 * total's, until its first hit on a player lands; a creature's damage, until its first hit on a card; a
 * permanent leaving, until its first exit starts; a mill, until its first card leaves the library (the
 * operator, 2026-10-16, of the rams: "be careful with sound effects here"). `sounds` carries the
 * {@link BoardSound}s only the board's drawing knows the moment of. `effects`, keyed by the stack item that
 * resolved: when what it did is drawn by (epoch ms), for its spell to fade after (`live/placed.ts`).
 */
export const CUE = { life: 'life-impact', card: 'card-impact', exit: 'exit', mill: 'mill', sounds: 'sounds', effects: 'effects' } as const;

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

/**
 * How long a Room's door that just unlocked plays its beat (`Board.tsx`'s `RoomDoors`, `card.css`'s
 * `[data-unlocking]`): long enough to be seen as it happens, over before the next thing does.
 */
export const UNLOCK_BEAT_MS = 1_200;
