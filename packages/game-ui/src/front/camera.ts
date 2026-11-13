/*
 * The front card's camera: which square of the board the card shows (`FeaturedMatch.tsx`).
 *
 * The operator, 2026-10-29: *"a default capture region in the bottom left corner, and then
 * temporary capture regions for when the cursor exits the default region"* — because *"the player
 * might have their mouse cursor parked somewhere outside of view of the bottom left box because they
 * are reading something or maybe are afk. in that case we should move the camera to center on their
 * cursor and eventually reset back to the standard box once the cursor spends time in there again"*.
 *
 * - The default capture region is the board's bottom-left {@link CameraConfig.corner} square: the active player's
 *   avatar, life, graveyard and the near half of their hand and battlefield.
 * - The cursor outside the default region's inner square ({@link inDefaultRegion}: its outer
 *   {@link CameraConfig.edgeBand} counts as outside) for {@link CameraConfig.temporaryAfterMs} straight: a temporary
 *   capture region opens, the same square centred on the cursor (kept on the board), and follows the
 *   cursor while it stays out. A stroke or a drag that comes back sooner opens none.
 * - The cursor back inside that inner square (or gone) for {@link CameraConfig.defaultAfterMs} straight: the
 *   temporary region retires, and the camera returns to the default one.
 * - Every move is a pan ({@link panStep}): from rest, pulled toward its region harder the further it
 *   is, never past it — never a jump, except a turn change: the board flips to the new active player,
 *   and the camera starts on their default region.
 *
 * Every number above is a field of {@link CAMERA}, and a viewer can override it from the hash.
 *
 * Board coordinates throughout: pixels of `LiveBoard`'s own 1280×800, origin top-left.
 */

export const BOARD_WIDTH = 1280;
export const BOARD_HEIGHT = 800;

/**
 * Every tunable of the camera, in one place. **Change a default for good here.** A viewer can try
 * other values without a deploy through the front page's hash ({@link cameraConfigFromHash}).
 */
export interface CameraConfig {
  /**
   * How long the cursor must stay outside the default region before a temporary region opens, in
   * ms. The operator, 2026-11-05: *"let's try it with the camera moving immediately … however
   * immediate is probably too aggressive. maybe 0.5s timer for now"* — 1500 before.
   */
  temporaryAfterMs: number;
  /** How long the cursor must be back in the default region (or gone) before the temporary region retires, in ms: a pass through it is not a return. */
  defaultAfterMs: number;
  /**
   * The default region's outer band, as a share of its side, that counts as outside: the operator,
   * 2026-11-05, *"make it so the camera starts moving once it reaches the outer 20% of the default
   * camera area"*. The view the region shows is still the whole {@link CameraConfig.corner} square.
   */
  edgeBand: number;
  /**
   * How long a pan from rest takes to cover 95% of the way to its region, in ms: the spring's
   * stiffness. The operator, 2026-11-05: *"camera pan speed should be relative to how far it has to
   * travel. it should accelerate faster if the target is further away"*, after *"slow down the camera
   * pan by 30%"*: the exponential glide it replaced covered 95% in 750 ms; this takes 1.3× as long.
   */
  panSettleMs: number;
  /** The side of every capture region, in board pixels: how far the card is zoomed in (the operator approved 540). */
  corner: number;
}

export const CAMERA: Readonly<CameraConfig> = Object.freeze({
  temporaryAfterMs: 500,
  defaultAfterMs: 1000,
  edgeBand: 0.2,
  panSettleMs: 975,
  corner: 540,
});

/**
 * The hash keys a viewer can set, each with its config field and the range it is clamped to:
 * `#cam=after:400,back:800,band:0.25,t95:900,corner:600` (any subset, any order).
 */
const HASH_KEYS: Record<string, { field: keyof CameraConfig; min: number; max: number }> = {
  after: { field: 'temporaryAfterMs', min: 0, max: 10_000 },
  back: { field: 'defaultAfterMs', min: 0, max: 10_000 },
  band: { field: 'edgeBand', min: 0, max: 0.45 },
  t95: { field: 'panSettleMs', min: 50, max: 10_000 },
  corner: { field: 'corner', min: 300, max: BOARD_HEIGHT },
};

/**
 * {@link CAMERA}, with whatever the page's hash overrides for this viewer only: `cam=` followed by
 * `key:value` pairs joined by commas, anywhere in the hash (`#cam=…`, `#/?cam=…`). Unknown keys and
 * values that are not numbers are ignored; the rest are clamped to their range.
 */
export function cameraConfigFromHash(hash: string): CameraConfig {
  const config: CameraConfig = { ...CAMERA };
  const spec = /(?:^|[#?&/])cam=([^&#]*)/.exec(hash)?.[1];
  if (spec === undefined) return config;
  for (const pair of decodeURIComponent(spec).split(',')) {
    const [key, raw] = pair.split(':').map((part) => part.trim());
    const known = key === undefined ? undefined : HASH_KEYS[key];
    const value = raw === undefined || raw === '' ? NaN : Number(raw);
    if (known === undefined || !Number.isFinite(value)) continue;
    config[known.field] = clamp(value, known.min, known.max);
  }
  return config;
}

/** A critically damped spring from rest covers 95% of the way when ωt ≈ 4.744. */
const SPRING_95 = 4.744;

export interface Point {
  x: number;
  y: number;
}

/** The default capture region's top-left corner. */
export const defaultRegion = (config: CameraConfig = CAMERA): Point => ({ x: 0, y: BOARD_HEIGHT - config.corner });

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

export function initialCamera(now: number, bottom: number | null, config: CameraConfig = CAMERA): CameraState {
  return { at: defaultRegion(config), vel: { x: 0, y: 0 }, region: 'default', since: null, bottom, now };
}

/**
 * Whether `p` is home: inside the default capture region's inner square, the {@link CameraConfig.edgeBand} at its
 * open edges counting as outside. The same test both ways, so a cursor resting in the band never
 * swings the camera out and back.
 */
export function inDefaultRegion(p: Point, config: CameraConfig = CAMERA): boolean {
  const inner = config.corner * (1 - config.edgeBand);
  return p.x < inner && p.y > BOARD_HEIGHT - inner;
}

/** A temporary capture region: the square centred on `p`, kept on the board. */
export function temporaryRegion(p: Point, config: CameraConfig = CAMERA): Point {
  const side = config.corner;
  return { x: clamp(p.x - side / 2, 0, BOARD_WIDTH - side), y: clamp(p.y - side / 2, 0, BOARD_HEIGHT - side) };
}

/**
 * One axis of a pan, `dt` ms on: a critically damped spring toward `target` (acceleration
 * ω²·(target − pos) − 2ω·vel), so it starts from rest, pulls harder the further it has to go, and
 * comes to rest on the target without passing it. Its exact solution over the step, not an
 * integration, so no frame rate can make it overshoot; a target that moves between steps keeps the
 * velocity it had, so a pan following a moving cursor never restarts.
 */
export function panStep(pos: number, vel: number, target: number, dt: number, settleMs: number = CAMERA.panSettleMs): { pos: number; vel: number } {
  const omega = SPRING_95 / settleMs;
  const e = pos - target;
  const b = vel + omega * e;
  const decay = Math.exp(-omega * dt);
  return { pos: target + (e + b * dt) * decay, vel: (vel - omega * b * dt) * decay };
}

/** One step: `cursor` is the active player's cursor as the board draws it now (null when none is drawn). */
export function stepCamera(state: CameraState, now: number, cursor: Point | null, bottom: number | null, config: CameraConfig = CAMERA): CameraState {
  if (bottom !== state.bottom) return initialCamera(now, bottom, config);
  const outside = cursor !== null && !inDefaultRegion(cursor, config);
  const calling = state.region === 'default' ? outside : !outside;
  const since = calling ? (state.since ?? now) : null;
  let region = state.region;
  if (since !== null && now - since >= (region === 'default' ? config.temporaryAfterMs : config.defaultAfterMs)) region = region === 'default' ? 'temporary' : 'default';
  // A temporary region follows the cursor; with the cursor gone it holds where it is until it retires.
  const target = region === 'default' ? defaultRegion(config) : cursor !== null ? temporaryRegion(cursor, config) : state.at;
  const dt = Math.max(0, now - state.now);
  const x = panStep(state.at.x, state.vel.x, target.x, dt, config.panSettleMs);
  const y = panStep(state.at.y, state.vel.y, target.y, dt, config.panSettleMs);
  return { at: { x: x.pos, y: y.pos }, vel: { x: x.vel, y: y.vel }, region, since: region === state.region ? since : null, bottom, now };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
