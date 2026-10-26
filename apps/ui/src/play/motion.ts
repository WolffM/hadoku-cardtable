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

/**
 * Writes each `[name, ms]` on `el` as `<ms>ms`, for a sheet to read with `var()`: a length is written
 * once, by the module that times it. Never taken off again: each is a constant, and more than one
 * layer on a canvas writes the house ones.
 */
export function writeDurations(el: HTMLElement, durations: readonly (readonly [string, number])[]): void {
  for (const [name, ms] of durations) el.style.setProperty(name, `${ms}ms`);
}

/**
 * The viewer asked for less motion: every animated surface draws its end state instead. Fast Mode
 * is pacing, not motion, and never turns an animation off (the operator, 2026-10-08).
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
 * The damage at which every effect is at its heaviest. It was 20 (the operator, 2026-10-16: "let's allow
 * it to scale up to 20"); re-anchored 2026-10-17 on a survey of every loaded deck (ledger AF149: 1,459
 * decks, 21,361 creature copies — median power 2, p90 5, p99 10) after the operator found the growth
 * "too linear": "we should escalate the effects a bit faster". A ten is now the full blow; the shake
 * (`crash.ts`'s table) still climbs by amount past it.
 */
export const MAX_DAMAGE = 10;

/**
 * How much a hit of `amount` damage weighs, 0 to 1: one point is the lightest, `MAX_DAMAGE` and more
 * the heaviest, on a square-root curve so the first few points each count and the top still climbs
 * (a log curve flattened out near its cap, and 9 looked no lighter than 10): a two is a third of the
 * way, a three nearly half, a five two thirds, a seven over four fifths. Every damage effect
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

/*
 * What the board is drawing now, for what must wait until it is over (the operator, 2026-10-15: "the
 * game-loss trigger should also only happen after the fireball actually hits"; 2026-10-17: "the final
 * creature doesn't even get to attack because the game ends immediately"): the game's end is the last
 * beat — its result screen and its sound come once every beat drawn before it has played out.
 */
const drawing = new Set<Promise<void>>();
const stillWaiters = new Set<() => void>();

/** When a view last began drawing beats (epoch ms), for a held frame's report. */
let lastBeatAt: number | null = null;

/** `live/numbers.ts` is drawing a view's beats: the board is busy until `over` settles. */
export function noteBoardDrawing(over: Promise<unknown>): void {
  lastBeatAt = Date.now();
  const settled = over.then(
    () => undefined,
    () => undefined,
  );
  drawing.add(settled);
  void settled.then(() => {
    drawing.delete(settled);
    if (drawing.size > 0) return;
    for (const wake of [...stillWaiters]) {
      stillWaiters.delete(wake);
      wake();
    }
  });
}

/** How many views' beats the board is drawing now: the frame rate's reports read it (`live/frame-watch.ts`). */
export function boardDrawing(): number {
  return drawing.size;
}

/** What a frame the board held past the pacer's cap was waiting on: the views still drawing, the beats by name, and when the last view began. */
export interface BoardHold {
  drawing: number;
  waitingOn: string;
  lastBeatAt: number | null;
}

export function boardHold(): BoardHold {
  return { drawing: drawing.size, waitingOn: boardWaitingOn(), lastBeatAt };
}

/** Runs `done` once nothing the board is drawing is still playing — at once when it is still. Returns a cancel. */
export function whenBoardStill(done: () => void): () => void {
  if (drawing.size === 0) {
    done();
    return () => undefined;
  }
  stillWaiters.add(done);
  return () => {
    stillWaiters.delete(done);
  };
}

/**
 * The id every beat's own Web Animation carries (`live/ram.ts`, `live/crash.ts`, `live/projectile.ts`): what
 * {@link animationsSettled} waits for, beside the beats' stylesheet animations ({@link BEAT_KEYFRAMES}).
 */
export const BEAT_ANIMATION_ID = 'beat';

/**
 * The keyframes a beat draws with: a card leaving (`departures.css`), a floating number (`numbers.css`), a hit,
 * a crash or a bolt (`numbers.css`, `crash.css`, `projectile.css`), a spell resolving or countered (`placed.css`).
 */
const BEAT_KEYFRAMES = ['board-exit-', 'board-number-', 'effect-', 'placed-'] as const;

/** A running animation's name: its id, a stylesheet animation's keyframes, or the property a transition moves. */
function animationName(a: Animation): string {
  const named = a as Animation & { animationName?: string; transitionProperty?: string };
  if (typeof named.animationName === 'string' && named.animationName !== '') return named.animationName;
  if (typeof named.transitionProperty === 'string' && named.transitionProperty !== '') return `transition:${named.transitionProperty}`;
  return a.id === '' ? 'unnamed' : a.id;
}

function isBeat(a: Animation): boolean {
  const name = animationName(a);
  return name === BEAT_ANIMATION_ID || BEAT_KEYFRAMES.some((prefix) => name.startsWith(prefix));
}

/** What the board's beats are still waiting on, counted by name (`beat×2 board-number-rise×1`), for a held frame's report. */
let waitingOn: readonly Animation[] = [];

export function boardWaitingOn(): string {
  const counts = new Map<string, number>();
  for (const a of waitingOn) if (a.playState !== 'finished' && a.playState !== 'idle') counts.set(animationName(a), (counts.get(animationName(a)) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${name}×${n}`).join(' ');
}

/**
 * Settles once every finite BEAT running on `root` and inside it has finished — a ram, a crash, a crumble, a
 * floating number — looking again after each round, since one may start another. Anything else the board is
 * animating is not a beat and is not waited for: an endless one (a pulse, a shimmer), and a finite one that is
 * no beat (the turn's banner, the stack settling, a glide). Waiting on those held the next frame, and the
 * decision behind it, until the pacer's cap with nothing left to draw (the operator, 2026-10-23, of the holds
 * that idled past their last beat: "fix stray holds").
 */
export function animationsSettled(root: Element): Promise<void> {
  return new Promise((resolve) => {
    const look = (): void => {
      if (typeof root.getAnimations !== 'function') return resolve();
      const running = root
        .getAnimations({ subtree: true })
        .filter((a) => a.playState !== 'finished' && a.playState !== 'idle' && a.effect?.getComputedTiming().endTime !== Infinity && isBeat(a));
      waitingOn = running;
      if (running.length === 0) return resolve();
      void Promise.allSettled(running.map((a) => a.finished)).then(look);
    };
    look();
  });
}

/** When the first hit on a player lands — a life total's sound waits for it. */
let lifeImpact: { seq: number; at: number } | null = null;

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

/**
 * How long a Room's door that just unlocked plays its beat (`Board.tsx`'s `RoomDoors`, `card.css`'s
 * `[data-unlocking]`): long enough to be seen as it happens, over before the next thing does.
 */
export const UNLOCK_BEAT_MS = 1_200;
