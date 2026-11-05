/*
 * The front card's camera: which square of the board the card shows (`FeaturedMatch.tsx`).
 *
 * The operator, 2026-10-29: *"a default capture region in the bottom left corner, and then
 * temporary capture regions for when the cursor exits the default region"* — because *"the player
 * might have their mouse cursor parked somewhere outside of view of the bottom left box because they
 * are reading something or maybe are afk. in that case we should move the camera to center on their
 * cursor and eventually reset back to the standard box once the cursor spends time in there again"*.
 *
 * - The default capture region is the board's bottom-left {@link CORNER} square: the active player's
 *   avatar, life, graveyard and the near half of their hand and battlefield.
 * - The cursor outside the default region's inner square ({@link inDefaultRegion}: its outer
 *   {@link EDGE_BAND} counts as outside) for {@link TEMPORARY_AFTER_MS} straight: a temporary
 *   capture region opens, the same square centred on the cursor (kept on the board), and follows the
 *   cursor while it stays out. A stroke or a drag that comes back sooner opens none.
 * - The cursor back inside that inner square (or gone) for {@link DEFAULT_AFTER_MS} straight: the
 *   temporary region retires, and the camera returns to the default one.
 * - Every move is a pan ({@link panStep}): from rest, pulled toward its region harder the further it
 *   is, never past it — never a jump, except a turn change: the board flips to the new active player,
 *   and the camera starts on their default region.
 *
 * Board coordinates throughout: pixels of `LiveBoard`'s own 1280×800, origin top-left.
 */

export const BOARD_WIDTH = 1280;
export const BOARD_HEIGHT = 800;
/** The side of every capture region, in board pixels (the operator approved 540). */
export const CORNER = 540;

/**
 * How long the cursor must stay outside the default region before a temporary region opens. The
 * operator, 2026-11-05: *"let's try it with the camera moving immediately … however immediate is
 * probably too aggressive. maybe 0.5s timer for now"* — 1500 ms before.
 */
export const TEMPORARY_AFTER_MS = 500;
/** How long the cursor must be back in the default region (or gone) before the temporary region retires: a pass through it is not a return. */
export const DEFAULT_AFTER_MS = 1000;
/**
 * How long a pan takes to cover 95% of the way to a region it set off for from rest. The operator,
 * 2026-11-05: *"camera pan speed should be relative to how far it has to travel. it should
 * accelerate faster if the target is further away"*, after *"slow down the camera pan by 30%"*: the
 * exponential glide it replaces (time constant 250 ms) covered 95% in 750 ms at full speed from its
 * first frame; this one starts from rest and takes 1.3× as long.
 */
export const PAN_SETTLE_MS = 975;
/** The spring's natural frequency, per ms: a critically damped spring from rest covers 95% when ωt ≈ 4.744. */
const OMEGA = 4.744 / PAN_SETTLE_MS;

/**
 * The default region's outer band, as a share of its side, that counts as outside: the operator,
 * 2026-11-05, *"make it so the camera starts moving once it reaches the outer 20% of the default
 * camera area"*. The view the region shows is still the whole {@link CORNER} square.
 */
export const EDGE_BAND = 0.2;
/** The inner square's side: the part of the default region nearest the board's bottom-left corner. */
const INNER = CORNER * (1 - EDGE_BAND);

export interface Point {
  x: number;
  y: number;
}

/** The default capture region's top-left corner. */
export const DEFAULT_REGION: Point = { x: 0, y: BOARD_HEIGHT - CORNER };

export interface CameraState {
  /** Where the camera is now (its square's top-left): panning toward the region it captures. */
  at: Point;
  /** How fast it is moving, in board pixels per ms. */
  vel: Point;
  /** Which capture region it is on. */
  region: 'default' | 'temporary';
  /** Since when the cursor has been calling for the other region; null while it is not. */
  since: number | null;
  /** The player at the bottom when last stepped: a change is a turn change. */
  bottom: number | null;
  /** The last step's time. */
  now: number;
}

export function initialCamera(now: number, bottom: number | null): CameraState {
  return { at: DEFAULT_REGION, vel: { x: 0, y: 0 }, region: 'default', since: null, bottom, now };
}

/**
 * Whether `p` is home: inside the default capture region's inner square, the {@link EDGE_BAND} at its
 * open edges counting as outside. The same test both ways, so a cursor resting in the band never
 * swings the camera out and back.
 */
export const inDefaultRegion = (p: Point): boolean => p.x < INNER && p.y > BOARD_HEIGHT - INNER;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A temporary capture region: the square centred on `p`, kept on the board. */
export function temporaryRegion(p: Point): Point {
  return { x: clamp(p.x - CORNER / 2, 0, BOARD_WIDTH - CORNER), y: clamp(p.y - CORNER / 2, 0, BOARD_HEIGHT - CORNER) };
}

/**
 * One axis of a pan, `dt` ms on: a critically damped spring toward `target` (acceleration
 * ω²·(target − pos) − 2ω·vel), so it starts from rest, pulls harder the further it has to go, and
 * comes to rest on the target without passing it. Its exact solution over the step, not an
 * integration, so no frame rate can make it overshoot; a target that moves between steps keeps the
 * velocity it had, so a pan following a moving cursor never restarts.
 */
export function panStep(pos: number, vel: number, target: number, dt: number): { pos: number; vel: number } {
  const e = pos - target;
  const b = vel + OMEGA * e;
  const decay = Math.exp(-OMEGA * dt);
  return { pos: target + (e + b * dt) * decay, vel: (vel - OMEGA * b * dt) * decay };
}

/** One step: `cursor` is the active player's cursor as the board draws it now (null when none is drawn). */
export function stepCamera(state: CameraState, now: number, cursor: Point | null, bottom: number | null): CameraState {
  if (bottom !== state.bottom) return initialCamera(now, bottom);
  const outside = cursor !== null && !inDefaultRegion(cursor);
  const calling = state.region === 'default' ? outside : !outside;
  const since = calling ? (state.since ?? now) : null;
  let region = state.region;
  if (since !== null && now - since >= (region === 'default' ? TEMPORARY_AFTER_MS : DEFAULT_AFTER_MS)) region = region === 'default' ? 'temporary' : 'default';
  // A temporary region follows the cursor; with the cursor gone it holds where it is until it retires.
  const target = region === 'default' ? DEFAULT_REGION : cursor !== null ? temporaryRegion(cursor) : state.at;
  const dt = Math.max(0, now - state.now);
  const x = panStep(state.at.x, state.vel.x, target.x, dt);
  const y = panStep(state.at.y, state.vel.y, target.y, dt);
  return { at: { x: x.pos, y: y.pos }, vel: { x: x.vel, y: y.vel }, region, since: region === state.region ? since : null, bottom, now };
}
