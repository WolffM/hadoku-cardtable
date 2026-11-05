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
 * - Every move is a glide ({@link GLIDE_TAU_MS}), never a jump — except a turn change: the board flips
 *   to the new active player, and the camera starts on their default region.
 *
 * Board coordinates throughout: pixels of `LiveBoard`'s own 1280×800, origin top-left.
 */

export const BOARD_WIDTH = 1280;
export const BOARD_HEIGHT = 800;
/** The side of every capture region, in board pixels (the operator approved 540). */
export const CORNER = 540;

/**
 * How long the cursor must stay outside the default region before a temporary region opens. The
 * operator, 2026-11-05: *"have the camera movement react faster to when the cursor exits the camera
 * space. shorten the time for it to be outside of the 'default space' by 40%"* — 1500 ms before.
 */
export const TEMPORARY_AFTER_MS = 900;
/** How long the cursor must be back in the default region (or gone) before the temporary region retires: a pass through it is not a return. */
export const DEFAULT_AFTER_MS = 1000;
/**
 * The glide's time constant: 95% of the way in three of these (~1.07 s). The operator, 2026-11-05:
 * *"slow down the camera pan by 30%, so it doesn't move around so quickly when the mouse is moving
 * fast"* — 250 ms before, so 250 / 0.7.
 */
export const GLIDE_TAU_MS = 357;

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
  /** Where the camera is now (its square's top-left): gliding toward the region it captures. */
  at: Point;
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
  return { at: DEFAULT_REGION, region: 'default', since: null, bottom, now };
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
  const k = 1 - Math.exp(-Math.max(0, now - state.now) / GLIDE_TAU_MS);
  const at = { x: state.at.x + (target.x - state.at.x) * k, y: state.at.y + (target.y - state.at.y) * k };
  return { at, region, since: region === state.region ? since : null, bottom, now };
}
