/**
 * How long a released card's placement is waited for — the row's reserved gap
 * (`Board.tsx`), the other seat's back standing in it (`live/presence.ts`) and
 * the stack layer's record of the release point (`live/placed.ts`) are one
 * fact, so one clock: none of them may give up while another still holds. A
 * cast that never resolves (countered, cancelled, a land) just ages out.
 * On the other seat's screen it runs from the LAST word that their card is
 * still parked (`presence.ts` restates a parked card), not from the release:
 * a target or a payment may take a player as long as they like.
 */
export const PLACEMENT_WAIT_MS = 15_000;

/**
 * The house glide — a float-back, a hand FLIP, the other seat's hand-move —
 * so both screens move in step. `gestures.css` and `presence.css` write the
 * same 300ms in their transitions.
 */
export const GLIDE_MS = 300;

/**
 * Runs `done` once `el`'s glide has come to rest: its running `left`/`top` transitions finished,
 * timed by the transitions themselves. A clock started when the style was set runs ahead of a
 * transition that only starts at the next style recalc — a frame or more later on a busy screen —
 * and a stand-in handed over on that clock was drawn short of its gap (w67-shaman's bears on a
 * claw: the other seat's back 2 px off at "306 ms, done"). A transition retargeted on the way is
 * waited for in turn. Nothing running (motion off, already there) is done on the next microtask;
 * a document that cannot list its animations (jsdom) falls back to `GLIDE_MS`. Returns a cancel.
 */
export function afterGlide(el: Element, done: () => void): () => void {
  let live = true;
  if (typeof el.getAnimations !== 'function') {
    const timer = setTimeout(done, GLIDE_MS);
    return () => clearTimeout(timer);
  }
  const wait = (): void => {
    if (!live) return;
    const running = el.getAnimations().filter((a) => 'transitionProperty' in a && (a.transitionProperty === 'left' || a.transitionProperty === 'top'));
    if (running.length > 0) {
      // Finished or cancelled (retargeted, or the element gone), it is looked at again: a cancel is not an arrival.
      void Promise.allSettled(running.map((a) => a.finished)).then(wait);
      return;
    }
    live = false;
    done();
  };
  queueMicrotask(wait);
  return () => {
    live = false;
  };
}

/*
 * A resolution's effects, as beats (the operator, 2026-10-14: Kalitas's Zombie and Sorin, Grim
 * Nemesis's reveal-then-drain were "too instant"). Forge applies a resolution in one frame; the
 * board draws it in Forge's order — a reveal is shown, then what it caused travels to its target;
 * a created permanent travels from what made it — each beat short, the whole ≲1.2 s. Nothing here
 * holds input: an ask that arrives meanwhile is drawn at once, over the motion.
 */

/** A revealed card's beat in the reveal notice, before anything it caused is drawn. */
export const REVEAL_BEAT_MS = 450;
/** A hit (damage, life lost or gained) travelling from its source to the player or creature it changes — on its arc, speeding up (`live/projectile.ts`). */
export const HIT_MS = 850;

/** The damage at which every effect is at its heaviest (the operator, 2026-10-16: "let's allow it to scale up to 20"). */
export const MAX_DAMAGE = 20;

/**
 * How much a hit of `amount` damage weighs, 0 to 1: one point is the lightest, `MAX_DAMAGE` and more
 * the heaviest, on a square-root curve so the first few points each count and the top still climbs
 * (a log curve flattened out near its cap, and 9 looked no lighter than 10). Every damage effect
 * scales with it — its size, its pace and its sound (the operator, 2026-10-16: "any animation
 * involving damage (spell or combat) must scale with how much damage it is").
 */
export function damagePower(amount: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, (amount - 1) / (MAX_DAMAGE - 1))));
}

/** An effect's size at `power`: four fifths for a point, about one and a half at ten, 1.9 times at twenty. */
export function powerSize(power: number): number {
  return 0.8 + 1.1 * power;
}

/**
 * The pace of a move at `power`, always the same length: a weak blow sets off quickly and barely speeds
 * up, a strong one starts slow and accelerates hard, so both arrive together and the strong one lands
 * harder (the operator, 2026-10-16: "weaker creatures can start faster but have less accelleration.
 * stronger creatures start slower with more accelleration. that way the time to complete the animation
 * is still the same"). At full power it is the bolts' own tuned ease.
 */
export function powerEase(power: number): string {
  // A punch (the operator: "a weak punch has more consistent speed and low accelleration. a strong punch
  // has very fast accelleration … the initial parts of the strong punch to be slower to give it more
  // weight"): at 0 nearly even (it sets off at half speed and ends at about one and a half), at 1 a
  // creep that ends at about nine times its average speed — its fastest moment the blow itself.
  const p = Math.min(1, Math.max(0, power));
  const x1 = 0.4 + 0.52 * p;
  const y1 = 0.2 * (1 - p);
  const x2 = 0.75 + 0.2 * p;
  const y2 = 0.6 - 0.05 * p;
  return `cubic-bezier(${x1.toFixed(3)}, ${y1.toFixed(3)}, ${x2.toFixed(3)}, ${y2.toFixed(3)})`;
}

/** The way home at `power`: the same length, setting off slower the heavier, always settling gently into place. */
export function homeEase(power: number): string {
  const p = Math.min(1, Math.max(0, power));
  return `cubic-bezier(${(0.3 + 0.45 * p).toFixed(3)}, 0, 0.25, 1)`;
}
/** Between two created permanents of one resolution. */
export const BEAT_STAGGER_MS = 120;
/** Between two bolts of one resolution: each slam, and the death it causes, on its own. */
export const BOLT_STAGGER_MS = 300;

/** The last reveal notice drawn: when, and its first card — the element while it is up, its box once it has gone. */
export interface RevealBeat {
  readonly at: number;
  card: Element | null;
  box: DOMRect | null;
}

let lastReveal: RevealBeat | null = null;

/** The reveal notice has just been drawn (`prompts/RevealNotice.tsx`): its beat starts now, from `card`. */
export function noteRevealShown(card: Element | null, at = Date.now()): void {
  lastReveal = { at, card, box: null };
}

/**
 * The reveal notice is going (a decision took its place, or it was clicked away) — still in the
 * document, so its card's box is kept: the resolution its reveal belongs to may be drawn after it.
 */
export function noteRevealGone(card: Element | null): void {
  if (lastReveal === null || card === null || lastReveal.card !== card) return;
  lastReveal.box = card.getBoundingClientRect();
  lastReveal.card = null;
}

/** The last reveal notice drawn, or null before any. */
export function lastRevealBeat(): RevealBeat | null {
  return lastReveal;
}

/**
 * When what the board is drawing now is over, and when the first hit on a player lands — for what
 * must wait for the hit (the operator, 2026-10-15: "the life-loss animation should occur when the
 * fireball actually makes the impact. the game-loss trigger should also only happen after the
 * fireball actually hits"): the result screen and its sound, a life total's sound.
 */
let busyUntil = 0;
let lifeImpact: { seq: number; at: number } | null = null;

/** `live/numbers.ts` has drawn beats that run until `until` (epoch ms). */
export function noteBoardBusy(until: number): void {
  busyUntil = Math.max(busyUntil, until);
}

/** When the board's drawn beats are over (epoch ms); in the past when it is still. */
export function boardBusyUntil(): number {
  return busyUntil;
}

/** The view numbered `seq` drew a hit on a player that lands at `at` (epoch ms), its first. */
export function noteLifeImpact(seq: number, at: number): void {
  lifeImpact = { seq, at };
}

/** When the view numbered `seq`'s first hit on a player lands, or null when it drew none. */
export function lifeImpactAt(seq: number): number | null {
  return lifeImpact !== null && lifeImpact.seq === seq ? lifeImpact.at : null;
}

/*
 * The same for the sounds of a creature's damage and of a permanent leaving: a bolt or a ram lands
 * first, a creature crumples first (the operator, 2026-10-16, of the rams: "be careful with sound
 * effects here").
 */
let cardImpact: { seq: number; at: number } | null = null;
let exitBeat: { seq: number; at: number } | null = null;

/** The view numbered `seq` drew a hit on a card that lands at `at` (epoch ms), its first. */
export function noteCardImpact(seq: number, at: number): void {
  cardImpact = { seq, at };
}

/** When the view numbered `seq`'s first hit on a card lands, or null when it drew none. */
export function cardImpactAt(seq: number): number | null {
  return cardImpact !== null && cardImpact.seq === seq ? cardImpact.at : null;
}

/** The view numbered `seq` drew a permanent leaving whose exit starts at `at` (epoch ms), its first. */
export function noteExitBeat(seq: number, at: number): void {
  exitBeat = { seq, at };
}

/** When the view numbered `seq`'s first permanent starts leaving, or null when none left. */
export function exitBeatAt(seq: number): number | null {
  return exitBeat !== null && exitBeat.seq === seq ? exitBeat.at : null;
}

/**
 * A sound only the board's own drawing knows to play: a ram's charge and blow, a creature cracking.
 * `at` is when (epoch ms), `intensity` how heavy (`damagePower`), `mine` whether the viewer's side did it.
 */
export interface BoardSound {
  readonly role: string;
  readonly at: number;
  readonly intensity: number;
  readonly mine: boolean;
}

let boardSounds: { seq: number; sounds: readonly BoardSound[] } | null = null;

/** The view numbered `seq` drew these sounds' moments. */
export function noteBoardSounds(seq: number, sounds: readonly BoardSound[]): void {
  boardSounds = { seq, sounds };
}

/** The sounds the view numbered `seq` drew the moments of; none for any other view. */
export function boardSoundsAt(seq: number): readonly BoardSound[] {
  return boardSounds !== null && boardSounds.seq === seq ? boardSounds.sounds : [];
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
