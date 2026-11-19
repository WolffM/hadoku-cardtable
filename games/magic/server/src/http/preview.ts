/**
 * A room's link preview: what Discord (or any app that unfurls a link) shows for
 * `hadoku.me/cardtable/room/<id>`.
 *
 *   GET /preview/room/<id>.html → og:title (the room's name), og:description ("Modern Gauntlet 1v1")
 *   GET /preview/room/<id>.png  → 1200×630: a 1v1 room's host vs the other seat's face, or a dashed
 *                                 "You?"; a tournament's or a draft's field, every seat a face
 *
 * The operator, 2026-11-08: *"something that looks inviting and fun to click on … maybe it shows 'my
 * avatar vs ?'"*, then *"just '[Constructed Format] [Mode] [Year] 1v1'"*, and a neutral card with the
 * VS in Cinzel (artifact S5Tz5GbsVUVPejvr8cnYtW, approved). And 2026-11-19: *"only … when it's a
 * construct 1v1 room (gauntlet/classic/random) not when it's a tournament room"*, which is not one
 * face against another: a room that plays a pod draws its whole field instead.
 *
 * ## Who can read it
 *
 * Mounted on the kernel's `sealed` router: only a request the edge proxied, at any tier, and a
 * direct hit on the tunnel is a 404 like any other. The edge reads the `.html` itself, server-side,
 * to fill the tags of the page a crawler gets (hadoku_site `link-preview.ts`), and serves the `.png`
 * publicly under `/cardtable/preview` (its `public-surface.ts`), because a crawler fetches og:image
 * with no cookies. So both say only what the card shows: the room's name, its format and mode, and
 * the seated players' names and faces. The operator chose to show those (2026-11-08). A room with a
 * password, a testing room, and a room that does not exist are the same 404.
 *
 * ## The picture
 *
 * An SVG drawn here and rasterised by resvg. A face is fetched server-side and inlined, from only the
 * hosts a member's picture may name (`PICTURE_HOSTS`) or watchparty's sprites, so the URL in a look
 * can never point this server anywhere else. A render is kept by what it draws, so a busy channel
 * costs one render; each new one is a costly act, limited like every other (`perCallerLimit`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";
import { avatarPortraitPath } from "@wolffm/rooms-protocol";
import type { RateLimitConfig } from "@wolffm/rooms-server";
import type { Request, Response, Router } from "express";
import { planDisplayName, ROOM_ID_RE, type DraftPlan, type RoomMember } from "@hadoku/shared";

import type { People, Person } from "@hadoku/game-server/people";
import { magicView } from "../room/magic-view.js";
import { POD_AI, POD_CLOSED } from "../room/pods.js";
import { ASSETS_DIR } from "../root.js";
import { UNNAMED } from "@hadoku/game-server/room/constants";
import { perCallerLimit } from "@hadoku/game-server/http/request";

export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;

/** Where a member's picture may come from: the hosts `look.picture` is ever set to (and hadoku.me's img-src). */
export const PICTURE_HOSTS: readonly string[] = [
  "cdn.discordapp.com",
  "avatars.steamstatic.com",
  "cdn.hadoku.me",
];

/** A new card a minute, sustained, for the whole edge (crawlers arrive as one public caller). */
export const PREVIEW_RENDER_LIMIT: RateLimitConfig = {
  capacity: 20,
  refillAmount: 1,
  refillIntervalMs: 3_000,
};

/** How long the edge and a crawler may keep an answer: a room changes, so not long. */
const MAX_AGE_S = 300;
const FACE_FETCH_MS = 3_000;
const FACE_MAX_BYTES = 2_000_000;
const KEPT_RENDERS = 64;

/** The part of a room this reads. */
export interface PreviewRoom {
  name: string;
  gameType: string;
  locked: boolean;
  testing: boolean;
  leader: string;
  creator: string;
  /** Magic's part of the room, the fields of it the card draws: absent for a room of another game. */
  game?: {
    format: string;
    mode?: unknown;
    modeOptions?: unknown;
    ai?: { name: string; avatarId: string };
    /**
     * The pod of a room that plays one (a draft, or a constructed tournament), null for a plain 1v1 room:
     * what a draft's three rounds draft and each round's bare name, and the field. `seats` are the lobby's
     * (an AI seat carries its own `avatarId`); past it the field is `drafters`, an AI entrant's face in `personas`.
     */
    pod?: {
      plan: DraftPlan | null;
      roundNames: readonly [string, string, string] | null;
      phase?: string;
      seats?: readonly ({ memberId: string; name: string; avatarId?: string } | null)[];
      drafters?: readonly string[];
      personas?: Readonly<Record<string, { name: string; avatarId: string }>>;
    } | null;
  };
  members: readonly RoomMember[];
  /** Each table's seated players: the first table's other player is the host's opponent. Absent for a room of another game. */
  tables?: readonly { players: readonly { memberId: string }[] }[];
}

export interface PreviewDeps {
  rooms: {
    get(roomId: string): PreviewRoom | undefined;
    usersOf(roomId: string): { memberId: string; userId: string }[];
  };
  people: Pick<People, "resolve">;
  /** Watchparty's own origin, whose portraits (`avatarPortraitPath`, `/media/sprites/square_<id>.png`) draw a character. */
  watchpartyBase: string;
  /** The OFL faces the card is set in (Cinzel), beside the system's sans. */
  fontFiles: readonly string[];
  /** `null` is no limit (the e2e stacks); omitted is {@link PREVIEW_RENDER_LIMIT}. */
  rateLimit?: RateLimitConfig | null;
  fetch?: typeof fetch;
}

/* ── the words ─────────────────────────────────────────────────────── */

const FAMILY_NAMES: Record<string, string> = {
  standard: "Standard",
  modern: "Modern",
  legacy: "Legacy",
};
const MODE_NAMES: Record<string, string> = {
  classic: "Classic",
  gauntlet: "Gauntlet",
  random: "All Random",
};

/** An era id is a bare date (Standard) or `<family>-<date>`; the free pool and a drafted one are neither. */
function eraParts(era: unknown): {
  family: string | null;
  year: string | null;
} {
  if (typeof era !== "string") return { family: null, year: null };
  const m = /^(?:(modern|legacy)-)?(\d{4})-\d{2}-\d{2}$/.exec(era);
  if (m === null) return { family: null, year: null };
  return { family: m[1] ?? "standard", year: m[2] };
}

function options(room: PreviewRoom): Record<string, unknown> {
  return typeof room.game?.modeOptions === "object" && room.game.modeOptions !== null
    ? (room.game.modeOptions as Record<string, unknown>)
    : {};
}

/** The family and year a room plays: a Gauntlet's own pick, All Random's pool, else the room's format. */
function formatOf(
  room: PreviewRoom,
  mode: string | null,
): { family: string | null; year: string | null } {
  const opts = options(room);
  if (mode === "gauntlet")
    return {
      family: typeof opts.family === "string" ? opts.family : null,
      year: typeof opts.year === "number" ? String(opts.year) : null,
    };
  if (mode === "random")
    return {
      family:
        typeof opts.pool === "string" && opts.pool !== "full"
          ? opts.pool
          : null,
      year: null,
    };
  return eraParts(room.game?.format);
}

/** Whether the room plays a pod, a draft or a constructed tournament, and not one table of two. */
export function playsPod(room: PreviewRoom): boolean {
  return room.gameType === "draft" || room.game?.pod != null;
}

/**
 * `[Format] [Mode] [Year] 1v1`, leaving out what the room has not chosen: a Gauntlet limited to Modern
 * with no year is "Modern Gauntlet 1v1", and its tournament "Modern Gauntlet Tournament". A draft room
 * names what its pod drafts ("Draft · Bloomburrow · Set-cube"), or is a Cube Draft before it has a plan.
 */
export function describeRoom(room: PreviewRoom): string {
  if (room.gameType === "draft") {
    const pod = room.game?.pod;
    return pod?.plan == null || pod.roundNames == null
      ? "Cube Draft"
      : `Draft · ${planDisplayName(pod.plan, pod.roundNames)}`;
  }
  const mode = typeof room.game?.mode === "string" ? room.game.mode : null;
  const { family, year } = formatOf(room, mode);
  return [
    family === null ? null : (FAMILY_NAMES[family] ?? null),
    mode === null ? null : (MODE_NAMES[mode] ?? null),
    year,
    playsPod(room) ? "Tournament" : "1v1",
  ]
    .filter((w): w is string => w !== null)
    .join(" ");
}

/* ── the faces ─────────────────────────────────────────────────────── */

/** One side of the card: a name and what draws it. A null `picture` is the name's initial. */
export interface CardFace {
  name: string;
  picture: string | null;
  /** Watchparty's pixel art: scaled without smoothing. */
  pixel: boolean;
}

function allowedPicture(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && PICTURE_HOSTS.includes(u.hostname)
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

function spriteUrl(base: string, id: string | null | undefined): string | null {
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(id)) return null;
  // The portrait's own revision rides in the URL (`avatarPortraitPath`): the edge caches the sprite for a year.
  return `${base.replace(/\/$/, "")}${avatarPortraitPath(id)}`;
}

function faceOf(
  name: string,
  picture: string | undefined,
  sprite: string | null | undefined,
  base: string,
): CardFace {
  const pic = allowedPicture(picture);
  if (pic !== null) return { name, picture: pic, pixel: false };
  const spr = spriteUrl(base, sprite);
  return { name, picture: spr, pixel: spr !== null };
}

/** The host, then whoever holds the other seat of the room's table: null is an open seat. */
export function seatsOf(room: PreviewRoom): {
  host: string;
  other: string | null;
} {
  const host = room.leader || room.creator;
  // A room of a game Magic does not play has no tables.
  const table = playsPod(room) ? undefined : magicView(room)?.tables[0];
  const other =
    table?.players.find((p) => p.memberId !== host)?.memberId ?? null;
  return { host, other };
}

/** One place in a pod's field: a member, an AI's own character, or (null) a seat still open. */
export type Entrant =
  | { memberId: string }
  | { ai: { name: string; avatarId: string } }
  | null;

/**
 * A pod room's field, in seat order: the lobby's seats, open ones included and closed ones left out, and
 * past the lobby everyone who entered. A room with no pod on it yet is its host alone.
 */
export function fieldOf(room: PreviewRoom): Entrant[] {
  const pod = room.game?.pod;
  const drafters = pod?.drafters ?? [];
  if (drafters.length > 0)
    return drafters.map((id) => {
      const ai = pod?.personas?.[id];
      return ai === undefined ? { memberId: id } : { ai };
    });
  const seats = (pod?.seats ?? []).filter((s) => s?.memberId !== POD_CLOSED);
  if (seats.length === 0) return [{ memberId: room.leader || room.creator }];
  return seats.map((s) =>
    s === null
      ? null
      : s.avatarId === undefined
        ? { memberId: s.memberId }
        : { ai: { name: s.name, avatarId: s.avatarId } },
  );
}

/** What the picture draws: a 1v1 room's two sides, or a pod room's field under its kind. */
export type Card =
  | { kind: "duel"; left: CardFace; right: CardFace | null }
  | {
      kind: "field";
      label: string;
      /** A null is an open seat. */
      faces: (CardFace | null)[];
      /** How many of the field the card has no room for. */
      more: number;
    };

/** The most places a field draws: two rows of eight. */
export const FIELD_FACES = 16;

/** The room's card, or null when it has nobody to draw. `complete` is whether every person on it was found. */
export async function cardOf(
  roomId: string,
  room: PreviewRoom,
  deps: PreviewDeps,
): Promise<{ card: Card; complete: boolean } | null> {
  const pod = playsPod(room);
  const { host, other } = seatsOf(room);
  const field = pod ? fieldOf(room) : [];
  const shown = new Set(
    pod
      ? field.flatMap((e) => (e !== null && "memberId" in e ? [e.memberId] : []))
      : [host, other],
  );
  const users = deps.rooms.usersOf(roomId);
  const wanted = users
    .filter((u) => shown.has(u.memberId))
    .map((u) => u.userId);
  // A saved room keeps no names (R12): a member a restart left unnamed is named from their account.
  let people = new Map<string, Person>();
  try {
    people = await deps.people.resolve(wanted);
  } catch {
    people = new Map();
  }
  // Whether every seated person was found: a card drawn without them is not kept (see the route).
  let complete = true;
  const aiFace = (ai: { name: string; avatarId: string }): CardFace =>
    faceOf(ai.name, undefined, ai.avatarId, deps.watchpartyBase);
  const face = (memberId: string): CardFace | null => {
    const member = room.members.find((m) => m.id === memberId);
    if (member === undefined) {
      const ai = room.game?.ai;
      return ai !== undefined && memberId === POD_AI ? aiFace(ai) : null;
    }
    const userId = users.find((u) => u.memberId === memberId)?.userId;
    const person = userId === undefined ? undefined : people.get(userId);
    if (person === undefined) complete = false;
    // The room's own word for a member it has no name for is never printed: no name is better.
    const name = person?.name ?? (member.name === UNNAMED ? "" : member.name);
    return faceOf(
      name,
      member.look?.picture ?? person?.look?.picture,
      member.avatarId ?? person?.sprite,
      deps.watchpartyBase,
    );
  };
  if (!pod) {
    const left = face(host);
    if (left === null) return null;
    const right = other === null ? null : face(other);
    return { card: { kind: "duel", left, right }, complete };
  }
  // An entrant who has left the room has no face to draw, and is not an open seat either.
  const faces = field.flatMap((e): (CardFace | null)[] => {
    if (e === null) return [null];
    const f = "ai" in e ? aiFace(e.ai) : face(e.memberId);
    return f === null ? [] : [f];
  });
  if (!faces.some((f) => f !== null)) return null;
  const more = faces.length > FIELD_FACES ? faces.length - (FIELD_FACES - 1) : 0;
  return {
    card: {
      kind: "field",
      label: room.gameType === "draft" ? "Draft" : "Tournament",
      faces: more === 0 ? faces : faces.slice(0, FIELD_FACES - 1),
      more,
    },
    complete,
  };
}

/* ── the picture ───────────────────────────────────────────────────── */

const INK = "#ebe7df";
const MUTE = "#7d808a";
const SANS = "Noto Sans";
const DISPLAY = "Cinzel";
const RADIUS = 150;
const CY = 280;
const LEFT_X = 300;
const RIGHT_X = 900;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A name that fits under its circle: long ones are cut with an ellipsis. */
function fit(name: string): string {
  const chars = [...name.trim()];
  return chars.length <= 16
    ? chars.join("")
    : `${chars.slice(0, 15).join("")}…`;
}

const px = (n: number): number => Math.round(n * 100) / 100;

/** One circle of radius `r`: a face's picture or its initial, or for a null face a dashed open seat. */
function drawFace(
  face: CardFace | null,
  cx: number,
  cy: number,
  r: number,
  clip: string,
  image: string | undefined,
): string {
  const k = r / RADIUS;
  if (face === null) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#26272c" stroke="${MUTE}" stroke-width="${px(Math.max(2, 4 * k))}" stroke-dasharray="${px(18 * k)} ${px(12 * k)}"/>
<text x="${cx}" y="${px(cy + 48 * k)}" text-anchor="middle" font-family="${DISPLAY}" font-size="${px(140 * k)}" fill="${MUTE}">?</text>`;
  }
  const inner =
    image === undefined
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#33353b"/><text x="${cx}" y="${px(cy + 40 * k)}" text-anchor="middle" font-family="${DISPLAY}" font-size="${px(110 * k)}" fill="${INK}">${esc([...face.name][0]?.toUpperCase() ?? "?")}</text>`
      : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#33353b"/><image x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" href="${image}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"${face.pixel ? ' image-rendering="optimizeSpeed"' : ""}/>`;
  return `<g filter="url(#shadow)"><circle cx="${cx}" cy="${cy}" r="${px(r + Math.max(3, 6 * k))}" fill="${INK}"/>${inner}</g>`;
}

interface Circle {
  face: CardFace | null;
  cx: number;
  cy: number;
  r: number;
  /** A field's last circle when it has more than fit: "+N" in place of a face. */
  more?: number;
}

const FIELD_ROW = 8;
const FIELD_WIDTH = 1040;
const FIELD_CY = 365;
const FIELD_MAX_R = 110;
/** Two rows share the height one has. */
const FIELD_TWO_ROW_R = 80;

/** A field's circles: one row up to eight, then two, as large as the row allows. */
function fieldCircles(faces: readonly (CardFace | null)[], more: number): Circle[] {
  const n = faces.length + (more > 0 ? 1 : 0);
  const rows = n > FIELD_ROW ? 2 : 1;
  const perRow = Math.ceil(n / rows);
  const pitch = Math.min(FIELD_WIDTH / perRow, (rows === 1 ? FIELD_MAX_R : FIELD_TWO_ROW_R) * 2.4);
  const r = Math.round(pitch / 2.4);
  const rowPitch = r * 2.5;
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / perRow);
    const inRow = row === rows - 1 ? n - perRow * row : perRow;
    return {
      face: faces[i] ?? null,
      cx: px(PREVIEW_WIDTH / 2 + (i - perRow * row - (inRow - 1) / 2) * pitch),
      cy: px(FIELD_CY + (row - (rows - 1) / 2) * rowPitch),
      r,
      ...(i >= faces.length ? { more } : {}),
    };
  });
}

/** The card, as SVG. `images` holds each face's picture as a data URI, by its URL; a missing one is drawn as an initial. */
export function cardSvg(
  card: Card,
  images: ReadonlyMap<string, string>,
): string {
  const img = (f: CardFace | null) =>
    f?.picture == null ? undefined : images.get(f.picture);
  const name = (text: string, cx: number, ink: string) =>
    `<text x="${cx}" y="${CY + RADIUS + 70}" text-anchor="middle" font-family="${SANS}" font-weight="600" font-size="38" fill="${ink}">${esc(fit(text))}</text>`;
  const circles: Circle[] =
    card.kind === "duel"
      ? [
          { face: card.left, cx: LEFT_X, cy: CY, r: RADIUS },
          { face: card.right, cx: RIGHT_X, cy: CY, r: RADIUS },
        ]
      : fieldCircles(card.faces, card.more);
  const drawn = circles.map((c, i) =>
    c.more === undefined
      ? drawFace(c.face, c.cx, c.cy, c.r, `clip-${i}`, img(c.face))
      : `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="#26272c"/><text x="${c.cx}" y="${px(c.cy + c.r * 0.22)}" text-anchor="middle" font-family="${SANS}" font-weight="600" font-size="${px(c.r * 0.62)}" fill="${MUTE}">+${c.more}</text>`,
  );
  const words =
    card.kind === "duel"
      ? `${name(card.left.name, LEFT_X, INK)}
${card.right === null ? name("You?", RIGHT_X, MUTE) : name(card.right.name, RIGHT_X, INK)}
<rect x="599" y="${CY - 175}" width="2" height="105" fill="url(#above)"/>
<rect x="599" y="${CY + 70}" width="2" height="105" fill="url(#below)"/>
<text x="600" y="${CY + 30}" text-anchor="middle" font-family="${DISPLAY}" font-size="88" fill="${INK}" letter-spacing="4">VS</text>`
      : `<rect x="110" y="109" width="190" height="2" fill="url(#toward)"/>
<rect x="900" y="109" width="190" height="2" fill="url(#away)"/>
<text x="600" y="132" text-anchor="middle" font-family="${DISPLAY}" font-size="64" fill="${INK}" letter-spacing="6">${esc(card.label)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}">
<defs>
<radialGradient id="ground" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#2e3035"/><stop offset="1" stop-color="#1c1d21"/></radialGradient>
<linearGradient id="above" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK}" stop-opacity="0"/><stop offset="1" stop-color="${INK}" stop-opacity="0.45"/></linearGradient>
<linearGradient id="below" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK}" stop-opacity="0.45"/><stop offset="1" stop-color="${INK}" stop-opacity="0"/></linearGradient>
<linearGradient id="toward" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${INK}" stop-opacity="0"/><stop offset="1" stop-color="${INK}" stop-opacity="0.45"/></linearGradient>
<linearGradient id="away" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${INK}" stop-opacity="0.45"/><stop offset="1" stop-color="${INK}" stop-opacity="0"/></linearGradient>
${circles.map((c, i) => `<clipPath id="clip-${i}"><circle cx="${c.cx}" cy="${c.cy}" r="${c.r}"/></clipPath>`).join("\n")}
<filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000" flood-opacity="0.45"/></filter>
</defs>
<rect width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" fill="url(#ground)"/>
${drawn.join("\n")}
${words}
</svg>`;
}

/**
 * Only the named font files are loaded: resvg builds its font database on every render, and a scan
 * of the system's fonts (thousands on a full host) blocked the event loop for 0.1–1 s a card.
 */
export function renderCard(svg: string, fontFiles: readonly string[]): Buffer {
  return new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: [...fontFiles],
      defaultFontFamily: SANS,
    },
  })
    .render()
    .asPng();
}

/** A face's picture as a data URI, or undefined when it cannot be had: the card then draws an initial. */
async function fetchImage(
  url: string,
  doFetch: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(FACE_FETCH_MS),
      redirect: "error",
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg|webp|gif)/.test(type)) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > FACE_MAX_BYTES) return undefined;
    return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/* ── the routes ────────────────────────────────────────────────────── */

export function previewHtml(title: string, description: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image:width" content="${PREVIEW_WIDTH}">
<meta property="og:image:height" content="${PREVIEW_HEIGHT}">
</head><body></body></html>
`;
}

/** The room a preview may show, or undefined: unknown, behind a password, or a testing room. */
function shown(deps: PreviewDeps, roomId: string): PreviewRoom | undefined {
  if (!ROOM_ID_RE.test(roomId)) return undefined;
  const room = deps.rooms.get(roomId);
  if (room === undefined || room.locked || room.testing) return undefined;
  return room;
}

export function attachPreview(router: Router, deps: PreviewDeps): void {
  const doFetch = deps.fetch ?? fetch;
  const fontFiles = deps.fontFiles.filter((f) => existsSync(f));
  const limit = perCallerLimit(
    deps.rateLimit === undefined ? PREVIEW_RENDER_LIMIT : deps.rateLimit,
    "too many previews; try again shortly",
    { act: "preview-render" },
  );
  const kept = new Map<string, Buffer>();

  const missing = (res: Response) =>
    void res.status(404).type("text").send("no such room");

  router.get("/preview/room/:file", async (req: Request, res: Response) => {
    const m = /^(.+)\.(html|png)$/.exec(String(req.params.file));
    const room = m === null ? undefined : shown(deps, m[1]);
    if (m === null || room === undefined) return missing(res);
    res.setHeader("Cache-Control", `public, max-age=${MAX_AGE_S}`);
    if (m[2] === "html") {
      res.type("html").send(previewHtml(room.name, describeRoom(room)));
      return;
    }
    const found = await cardOf(m[1], room, deps);
    if (found === null) return missing(res);
    const { card } = found;
    const key = JSON.stringify(card);
    let png = kept.get(key);
    if (png === undefined) {
      if (!limit(req, res)) return;
      const faces = card.kind === "duel" ? [card.left, card.right] : card.faces;
      const pictures = [
        ...new Set(faces.flatMap((f) => (f?.picture == null ? [] : [f.picture]))),
      ];
      const uris = await Promise.all(pictures.map((p) => fetchImage(p, doFetch)));
      const images = new Map<string, string>();
      let drawn = found.complete;
      pictures.forEach((p, i) => {
        const uri = uris[i];
        if (uri === undefined) drawn = false;
        else images.set(p, uri);
      });
      png = renderCard(cardSvg(card, images), fontFiles);
      // A card missing a person or a picture (prefs or a CDN slow or down) is sent, but not kept by
      // us or the edge: the next crawler gets the real one.
      if (drawn) {
        kept.set(key, png);
        if (kept.size > KEPT_RENDERS)
          kept.delete(kept.keys().next().value as string);
      } else res.setHeader("Cache-Control", "no-store");
    }
    res.type("png").send(png);
  });
}

const NOTO = "/usr/share/fonts/truetype/noto";
const NOTO_CJK = "/usr/share/fonts/opentype/noto";

/**
 * The faces the card is set in: Cinzel, shipped beside the server (`assets/fonts`, `root.ts`), and the host's
 * Noto Sans at the names' weight. A name with a character Noto Sans lacks is set whole in the first
 * font that has them all, so the CJK face is the bold one only (it also has the symbols).
 * `attachPreview` keeps only the files that exist.
 */
export function previewFonts(): string[] {
  return [
    join(ASSETS_DIR, "fonts", "Cinzel.ttf"),
    `${NOTO}/NotoSans-SemiBold.ttf`,
    `${NOTO_CJK}/NotoSansCJK-Bold.ttc`,
  ];
}
