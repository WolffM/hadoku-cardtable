/**
 * A room's link preview: what Discord (or any app that unfurls a link) shows for
 * `hadoku.me/cardtable/room/<id>`.
 *
 *   GET /preview/room/<id>.html → og:title (the room's name), og:description ("Modern Gauntlet 1v1")
 *   GET /preview/room/<id>.png  → 1200×630: the host's face vs the other seat's, or a dashed "You?"
 *
 * The operator, 2026-11-08: *"something that looks inviting and fun to click on … maybe it shows 'my
 * avatar vs ?'"*, then *"just '[Constructed Format] [Mode] [Year] 1v1'"*, and a neutral card with the
 * VS in Cinzel (artifact S5Tz5GbsVUVPejvr8cnYtW, approved).
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
import type { RateLimitConfig } from "@wolffm/rooms-server";
import type { Request, Response, Router } from "express";
import { ROOM_ID_RE, type RoomMember } from "@hadoku/shared";

import type { People, Person } from "../people.js";
import { POD_AI } from "../room/pods.js";
import { UNNAMED } from "../room/constants.js";
import { perCallerLimit } from "./request.js";

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
  /** Magic's part of the room, the fields of it the card draws. */
  game: { format: string; mode?: unknown; modeOptions?: unknown };
  members: readonly RoomMember[];
  /** Each table's seated players: the first table's other player is the host's opponent. */
  tables: readonly { players: readonly { memberId: string }[] }[];
  ai?: { name: string; avatarId: string };
}

export interface PreviewDeps {
  rooms: {
    get(roomId: string): PreviewRoom | undefined;
    usersOf(roomId: string): { memberId: string; userId: string }[];
  };
  people: Pick<People, "resolve">;
  /** Watchparty's own origin, whose `/media/sprites/square_<id>.png` draws a character. */
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
  return typeof room.game.modeOptions === "object" && room.game.modeOptions !== null
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
  return eraParts(room.game.format);
}

/**
 * `[Format] [Mode] [Year] 1v1`, leaving out what the room has not chosen: a Gauntlet limited to Modern
 * with no year is "Modern Gauntlet 1v1". A draft room is a Cube Draft.
 */
export function describeRoom(room: PreviewRoom): string {
  if (room.gameType === "draft") return "Cube Draft";
  const mode = typeof room.game.mode === "string" ? room.game.mode : null;
  const { family, year } = formatOf(room, mode);
  return [
    family === null ? null : (FAMILY_NAMES[family] ?? null),
    mode === null ? null : (MODE_NAMES[mode] ?? null),
    year,
    "1v1",
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
  return `${base.replace(/\/$/, "")}/media/sprites/square_${encodeURIComponent(id)}.png`;
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
  const table = room.gameType === "draft" ? undefined : room.tables[0];
  const other =
    table?.players.find((p) => p.memberId !== host)?.memberId ?? null;
  return { host, other };
}

export async function facesOf(
  roomId: string,
  room: PreviewRoom,
  deps: PreviewDeps,
): Promise<{
  left: CardFace;
  right: CardFace | null;
  complete: boolean;
} | null> {
  const { host, other } = seatsOf(room);
  const users = deps.rooms.usersOf(roomId);
  const wanted = users
    .filter((u) => u.memberId === host || u.memberId === other)
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
  const face = (memberId: string): CardFace | null => {
    const member = room.members.find((m) => m.id === memberId);
    if (member === undefined) {
      if (room.ai !== undefined && memberId === POD_AI)
        return faceOf(
          room.ai.name,
          undefined,
          room.ai.avatarId,
          deps.watchpartyBase,
        );
      return null;
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
  const left = face(host);
  if (left === null) return null;
  const right = other === null ? null : face(other);
  return { left, right, complete };
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

function drawFace(
  face: CardFace | null,
  cx: number,
  clip: string,
  image: string | undefined,
): string {
  if (face === null) {
    return `<circle cx="${cx}" cy="${CY}" r="${RADIUS}" fill="#26272c" stroke="${MUTE}" stroke-width="4" stroke-dasharray="18 12"/>
<text x="${cx}" y="${CY + 48}" text-anchor="middle" font-family="${DISPLAY}" font-size="140" fill="${MUTE}">?</text>`;
  }
  const inner =
    image === undefined
      ? `<circle cx="${cx}" cy="${CY}" r="${RADIUS}" fill="#33353b"/><text x="${cx}" y="${CY + 40}" text-anchor="middle" font-family="${DISPLAY}" font-size="110" fill="${INK}">${esc([...face.name][0]?.toUpperCase() ?? "?")}</text>`
      : `<circle cx="${cx}" cy="${CY}" r="${RADIUS}" fill="#33353b"/><image x="${cx - RADIUS}" y="${CY - RADIUS}" width="${RADIUS * 2}" height="${RADIUS * 2}" href="${image}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"${face.pixel ? ' image-rendering="optimizeSpeed"' : ""}/>`;
  return `<g filter="url(#shadow)"><circle cx="${cx}" cy="${CY}" r="${RADIUS + 6}" fill="${INK}"/>${inner}</g>`;
}

/** The card, as SVG. `images` holds each face's picture as a data URI, by its URL; a missing one is drawn as an initial. */
export function cardSvg(
  left: CardFace,
  right: CardFace | null,
  images: ReadonlyMap<string, string>,
): string {
  const img = (f: CardFace | null) =>
    f?.picture == null ? undefined : images.get(f.picture);
  const name = (text: string, cx: number, ink: string) =>
    `<text x="${cx}" y="${CY + RADIUS + 70}" text-anchor="middle" font-family="${SANS}" font-weight="600" font-size="38" fill="${ink}">${esc(fit(text))}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}">
<defs>
<radialGradient id="ground" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#2e3035"/><stop offset="1" stop-color="#1c1d21"/></radialGradient>
<linearGradient id="above" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK}" stop-opacity="0"/><stop offset="1" stop-color="${INK}" stop-opacity="0.45"/></linearGradient>
<linearGradient id="below" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK}" stop-opacity="0.45"/><stop offset="1" stop-color="${INK}" stop-opacity="0"/></linearGradient>
<clipPath id="clip-left"><circle cx="${LEFT_X}" cy="${CY}" r="${RADIUS}"/></clipPath>
<clipPath id="clip-right"><circle cx="${RIGHT_X}" cy="${CY}" r="${RADIUS}"/></clipPath>
<filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000" flood-opacity="0.45"/></filter>
</defs>
<rect width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" fill="url(#ground)"/>
${drawFace(left, LEFT_X, "clip-left", img(left))}
${drawFace(right, RIGHT_X, "clip-right", img(right))}
${name(left.name, LEFT_X, INK)}
${right === null ? name("You?", RIGHT_X, MUTE) : name(right.name, RIGHT_X, INK)}
<rect x="599" y="${CY - 175}" width="2" height="105" fill="url(#above)"/>
<rect x="599" y="${CY + 70}" width="2" height="105" fill="url(#below)"/>
<text x="600" y="${CY + 30}" text-anchor="middle" font-family="${DISPLAY}" font-size="88" fill="${INK}" letter-spacing="4">VS</text>
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
    const faces = await facesOf(m[1], room, deps);
    if (faces === null) return missing(res);
    const key = JSON.stringify([faces.left, faces.right]);
    let png = kept.get(key);
    if (png === undefined) {
      if (!limit(req, res)) return;
      const images = new Map<string, string>();
      let drawn = faces.complete;
      for (const f of [faces.left, faces.right]) {
        if (f?.picture == null || images.has(f.picture)) continue;
        const uri = await fetchImage(f.picture, doFetch);
        if (uri === undefined) drawn = false;
        else images.set(f.picture, uri);
      }
      png = renderCard(cardSvg(faces.left, faces.right, images), fontFiles);
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
 * The faces the card is set in: Cinzel, shipped beside the server (`assets/fonts`), and the host's
 * Noto Sans at the names' weight. A name with a character Noto Sans lacks is set whole in the first
 * font that has them all, so the CJK face is the bold one only (it also has the symbols).
 * `attachPreview` keeps only the files that exist.
 */
export function previewFonts(pkgRoot: string): string[] {
  return [
    join(pkgRoot, "assets/fonts/Cinzel.ttf"),
    `${NOTO}/NotoSans-SemiBold.ttf`,
    `${NOTO_CJK}/NotoSansCJK-Bold.ttc`,
  ];
}
