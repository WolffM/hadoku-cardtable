/*
 * A player's avatar, or what stands in for it.
 *
 * One avatar per person, everywhere (the operator, 2026-11-05): the picture they
 * chose (Discord, Steam or an upload) when they have one, else their watchparty
 * character, with the overlay they wear on it (`room/look.tsx`). This is the one
 * place a face is drawn, so every face falls back the same way: when there is
 * nothing to draw, and when the image will not load.
 */

import { createContext, useState, type ImgHTMLAttributes } from 'react';
import type { Look } from '@hadoku/shared';

import { avatarSquareUrl } from '../room/avatar.ts';
import { FaceDecor } from '../room/look.tsx';
import { PlayerMark } from '../play/marks.tsx';

/** Everything a face is drawn from: spread it into `<Avatar>` (`<Avatar {...face} … />`). */
export interface Face {
  id: string | null | undefined;
  look?: Look | undefined;
}

/** Nobody's face: the fallback. */
export const NO_FACE: Face = { id: null };

/**
 * Every room member's face, by member id, for a screen that names people by id
 * and was not handed their faces: the draft's seat bar, under the pod screen.
 */
export const MemberFaces = createContext<Readonly<Record<string, Face>>>({});

/** A room member's face: their character and their look. */
export function faceOf(member: { avatarId?: unknown; look?: Look | undefined } | undefined): Face {
  if (member === undefined) return NO_FACE;
  return { id: typeof member.avatarId === 'string' ? member.avatarId : null, ...(member.look === undefined ? {} : { look: member.look }) };
}

type AvatarProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'id' | 'src' | 'alt' | 'onError'> & {
  /** The watchparty character id; absent, blank or unreadable draws the fallback. */
  id: string | null | undefined;
  /** Their picture and what they wear. A picture is drawn instead of the character. */
  look?: Look | undefined;
  /**
   * Without an image: `mark` is our own silhouette (`PlayerMark`), `initial` the
   * first letter of `name`, `none` nothing at all.
   */
  fallback: 'mark' | 'initial' | 'none';
  /** The fallback's own class: `PlayerMark`'s, or the initial's box. A mark with none stands in the image's place, with its class. */
  fallbackClassName?: string;
  /** Whose face: the initial's letter. */
  name?: string;
  'data-testid'?: string;
};

/** The images a face may draw, in the order it tries them: their picture first, then their character. */
export function facePictures({ id, look }: Face): string[] {
  return [look?.picture ?? null, avatarSquareUrl(id)].filter((u): u is string => u !== null);
}

/** `alt=""` always: every face sits beside the name that says who it is. */
export function Avatar({ id, look, fallback, fallbackClassName, name = '', ...img }: AvatarProps) {
  const avatarId = id ?? undefined;
  const [failed, setFailed] = useState<readonly string[]>([]);
  // The picture first; a picture that will not load falls back to the character.
  const url = facePictures({ id, look }).find((u) => !failed.includes(u)) ?? null;
  const decor = <FaceDecor avatarId={avatarId} look={look} />;
  if (url !== null) {
    return (
      <>
        <img {...img} src={url} alt="" onError={() => setFailed((f) => [...f, url])} />
        {decor}
      </>
    );
  }
  if (fallback === 'mark') {
    return (
      <>
        <PlayerMark className={fallbackClassName ?? img.className} />
        {decor}
      </>
    );
  }
  if (fallback === 'initial') {
    return (
      <>
        <span className={fallbackClassName} aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
        {decor}
      </>
    );
  }
  return null;
}
