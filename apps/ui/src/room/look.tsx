/*
 * A person's look on our screens: their avatar picture, the overlay they wear
 * on it, and their name's effect, gradient and font.
 *
 * The operator, 2026-11-05: *"picture/character are the same thing and all
 * over the entire site it's the same avatar. we must display all
 * customizations everywhere."* So this is drawn with the fleet's own renderer
 * (`@wolffm/prefs-client/cosmetics`), the one watchparty's chat and the avatar
 * dialog use, and every face (`components/Avatar.tsx`) and name
 * (`PlayerName`) goes through it.
 *
 * - What someone wears arrives with their face, resolved by our server
 *   (`packages/game-server/src/people.ts`), and is cleaned again here (`cleanWorn`), so
 *   an id this build's catalogue does not know draws nothing.
 * - Colours derive from the person's own colour in `--hc-base`: their
 *   picture's average colour, else their character's (watchparty's
 *   `/api/characters`, the table they publish for code outside watchparty).
 * - Every loop pauses while it is off screen (`hc-idle`): a standings list
 *   would otherwise keep animating rows nobody can see.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { cleanWorn, decorHtml, nameHtml, onPictureColour, pictureColour, readPictureColour, type AvatarCosmetics } from '@wolffm/prefs-client/cosmetics';
import type { Look } from '@hadoku/platform-wire/look';

import { watchpartyOrigin } from './avatar.ts';
import './look.css';

/** What a person wears, safe to draw, or undefined. */
export function wornOf(look: Look | undefined): AvatarCosmetics | undefined {
  return cleanWorn(look?.cosmetics);
}

// ── Pausing what is off screen ───────────────────────────────────────────────

let observer: IntersectionObserver | null = null;
function idleWhenHidden(el: HTMLElement): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => undefined;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) (e.target as HTMLElement).classList.toggle('hc-idle', !e.isIntersecting);
    },
    { rootMargin: '64px' },
  );
  observer.observe(el);
  return () => observer?.unobserve(el);
}

// ── A person's colour ────────────────────────────────────────────────────────

const characterColours = new Map<string, string>();
const colourListeners = new Set<() => void>();
let charactersAsked = false;

/** Watchparty's character table, asked once per page: its `color` is the character's name colour. */
function askCharacters(): void {
  if (charactersAsked || typeof fetch === 'undefined') return;
  charactersAsked = true;
  fetch(`${watchpartyOrigin()}/api/characters`).then(
    async (res) => {
      if (!res.ok) return;
      const table = (await res.json()) as { sets?: { characters?: { id?: unknown; color?: unknown }[] }[] };
      for (const set of table.sets ?? []) {
        for (const c of set.characters ?? []) if (typeof c.id === 'string' && typeof c.color === 'string') characterColours.set(c.id, c.color);
      }
      for (const l of [...colourListeners]) l();
    },
    // No table: names draw in the colour around them (`--hc-base` falls back to currentColor).
    () => undefined,
  );
}

function onColours(listener: () => void): () => void {
  colourListeners.add(listener);
  const stopPicture = onPictureColour(listener);
  return () => {
    colourListeners.delete(listener);
    stopPicture();
  };
}

/** Their picture's colour once it has been read, else their character's; undefined when neither is known. */
function personColour(avatarId: string | undefined, picture: string | undefined): string | undefined {
  return (picture === undefined ? null : pictureColour(picture)) ?? (avatarId === undefined ? undefined : characterColours.get(avatarId));
}

/** `--hc-base` for someone, re-rendering once their colour is known. */
export function usePersonColour(avatarId: string | undefined, look: Look | undefined): CSSProperties {
  const picture = look?.picture;
  useEffect(() => {
    askCharacters();
    if (picture !== undefined) void readPictureColour(picture);
  }, [picture]);
  const colour = useSyncExternalStore(onColours, () => personColour(avatarId, picture), () => undefined);
  return colour === undefined ? {} : ({ '--hc-base': colour } as CSSProperties);
}

// ── The overlay on a face ────────────────────────────────────────────────────

/**
 * Where an overlay is drawn: beside its face, or, when the face sits in a
 * face-sized box that clips (a seat's round ring), just outside that box, so
 * a crown above the head is not cut off. A clipping box larger than the face
 * (a scrolling list, a card) is the page's own edge and is kept.
 */
function decorHost(face: Element): Element | null {
  const size = Math.max(face.getBoundingClientRect().width, 1);
  let host: Element | null = null;
  for (let box = face.parentElement; box !== null && box.parentElement !== null; box = box.parentElement) {
    if (box.getBoundingClientRect().width > size * 1.6) break;
    const style = getComputedStyle(box);
    // A face that turns away (a coin's sides) hides what it holds: its overlay stays inside it.
    if (style.backfaceVisibility === 'hidden') break;
    if ([style.overflow, style.overflowX, style.overflowY].some((o) => o !== '' && o !== 'visible')) host = box.parentElement;
  }
  return host;
}

/**
 * The overlay a person wears, laid over the face drawn just before it.
 *
 * Every face keeps its own `<img>` and the class that sizes it, so the overlay
 * is placed on that image rather than wrapped around it: a hidden anchor marks
 * the face, and the overlay is drawn beside it or outside its clipping ring
 * (`decorHost`). The renderer places an overlay against a box of `--hc-sz`
 * pixels; that is set from the face's laid-out size, again whenever it or the
 * box around it resizes.
 */
export const FaceDecor = memo(function FaceDecor({ avatarId, look }: { avatarId: string | undefined; look: Look | undefined }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<Element | null>(null);
  const worn = wornOf(look);
  const html = worn?.overlay === undefined ? '' : decorHtml(worn);
  const colour = usePersonColour(avatarId, look);
  useLayoutEffect(() => {
    const face = anchor.current?.previousElementSibling;
    setHost(html === '' || !(face instanceof Element) ? null : decorHost(face));
  }, [html]);
  useLayoutEffect(() => {
    const el = ref.current;
    const face = anchor.current?.previousElementSibling;
    if (el === null || !(face instanceof Element)) return;
    // From boxes, not `offsetLeft`: the fallback mark is an SVG, which has none,
    // and a scaled board (UI scale, the portrait fit) scales both boxes alike.
    const fit = (): void => {
      const parent = el.offsetParent instanceof HTMLElement ? el.offsetParent : document.documentElement;
      const pr = parent.getBoundingClientRect();
      const fr = face.getBoundingClientRect();
      const scale = parent.offsetWidth > 0 ? pr.width / parent.offsetWidth : 1;
      if (scale <= 0) return;
      el.style.left = `${(fr.left - pr.left) / scale - parent.clientLeft + parent.scrollLeft}px`;
      el.style.top = `${(fr.top - pr.top) / scale - parent.clientTop + parent.scrollTop}px`;
      el.style.setProperty('--hc-sz', `${fr.width / scale}px`);
    };
    fit();
    const stopIdle = idleWhenHidden(el);
    if (typeof ResizeObserver === 'undefined') return stopIdle;
    const ro = new ResizeObserver(fit);
    ro.observe(face);
    if (face.parentElement !== null) ro.observe(face.parentElement);
    if (host !== null) ro.observe(host);
    return () => {
      ro.disconnect();
      stopIdle();
    };
  }, [html, host]);
  if (html === '') return null;
  const decor = <span ref={ref} className="hc-av face-decor" style={colour} aria-hidden="true" data-testid="face-decor" dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <>
      <span ref={anchor} hidden />
      {host === null ? decor : createPortal(decor, host)}
    </>
  );
});

// ── A name ───────────────────────────────────────────────────────────────────

/**
 * A person's name, wearing their name effect, gradient and font. Someone who
 * wears none of the three is plain text, in the colour and weight around it.
 */
export const PlayerName = memo(function PlayerName({ name, face, className, testId }: { name: string; face: { id: string | null | undefined; look?: Look | undefined }; className?: string; testId?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const worn = wornOf(face.look);
  const dressed = worn !== undefined && (worn.effect !== undefined || worn.gradient !== undefined || worn.font !== undefined);
  const colour = usePersonColour(face.id ?? undefined, face.look);
  useEffect(() => {
    const el = ref.current;
    return el === null || !dressed ? undefined : idleWhenHidden(el);
  }, [dressed]);
  if (!dressed) {
    return className === undefined && testId === undefined ? (
      <>{name}</>
    ) : (
      <span className={className} data-testid={testId}>
        {name}
      </span>
    );
  }
  return <span ref={ref} className={className} style={colour} data-testid={testId} data-dressed="" dangerouslySetInnerHTML={{ __html: nameHtml(name, worn) }} />;
});
