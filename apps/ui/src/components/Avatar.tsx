/*
 * A player's watchparty character, or what stands in for it.
 *
 * `room/avatar.ts` says which image draws an id; this is the one place that
 * draws it, so every face falls back the same way: when there is no id, and
 * when the image will not load.
 */

import { useState, type ImgHTMLAttributes } from 'react';

import { avatarSquareUrl } from '../room/avatar.ts';
import { PlayerMark } from '../play/marks.tsx';

type AvatarProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'id' | 'src' | 'alt' | 'onError'> & {
  /** The watchparty avatar id; absent, blank or unreadable draws the fallback. */
  id: string | null | undefined;
  /**
   * Without an image: `mark` is our own silhouette (`PlayerMark`), `initial` the
   * first letter of `name`, `none` nothing at all.
   */
  fallback: 'mark' | 'initial' | 'none';
  /** The fallback's own class: `PlayerMark`'s, or the initial's box. */
  fallbackClassName?: string;
  /** Whose face: the initial's letter. */
  name?: string;
  'data-testid'?: string;
};

/** `alt=""` always: every face sits beside the name that says who it is. */
export function Avatar({ id, fallback, fallbackClassName, name = '', ...img }: AvatarProps) {
  const url = avatarSquareUrl(id);
  const [failed, setFailed] = useState<string | null>(null);
  if (url !== null && failed !== url) return <img {...img} src={url} alt="" onError={() => setFailed(url)} />;
  if (fallback === 'mark') return <PlayerMark className={fallbackClassName} />;
  if (fallback === 'initial') {
    return (
      <span className={fallbackClassName} aria-hidden="true">
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return null;
}
