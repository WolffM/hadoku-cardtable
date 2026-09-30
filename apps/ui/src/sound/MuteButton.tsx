/*
 * The mute, and the only UI this module has.
 *
 * ## Where it is, and where it should eventually be
 *
 * It is rendered in the room list's header (`../rooms/RoomList.tsx`) — the front
 * page, which every player passes through and which is the one screen the
 * operator described as *"all they see on the front page"*. That makes it
 * findable, which is §F.3's requirement.
 *
 * It is not where it belongs long term. A sound toggle belongs beside the theme
 * picker in the app header, so it is reachable from a match as well as from the
 * lobby. That header is `chrome/AppChrome.tsx` and `chrome/chrome.css`, which
 * are owned by NOBODY in wave 27 — so putting it there would mean taking a file
 * outside this lane, which the protocol forbids and which is how two lanes end
 * up in one file. Moving it is a two-line change for whichever wave owns the
 * chrome next: render `<MuteButton />` there and delete it from `RoomList`.
 *
 * ## Why `useSyncExternalStore`
 *
 * Mute is a module global outside React (`../sound/mute.ts`), because `playCue`
 * is called from places that are not components and must not need a hook. React
 * 19 will tear if a component reads a mutable external value during render
 * without subscribing to it, and two mute buttons on one page must agree. That
 * is exactly what `useSyncExternalStore` is for, and it is three lines.
 *
 * The server snapshot is `false` — unmuted — because there is no `localStorage`
 * during a server render and the default is on. This app does not server-render
 * today; the argument is required and a wrong one is a hydration mismatch.
 */

import { useSyncExternalStore } from 'react';

import { playCue } from './index.ts';
import { isMuted, subscribeMuted, toggleMuted } from './mute.ts';
import './sound.css';

export interface MuteButtonProps {
  /** Extra classes from the surface that places it. */
  className?: string;
}

export function MuteButton({ className }: MuteButtonProps) {
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);

  return (
    <button
      type="button"
      className={className === undefined ? 'sound-mute' : `sound-mute ${className}`}
      data-testid="sound-mute"
      data-muted={muted ? 'true' : 'false'}
      // `aria-pressed` rather than a label that changes meaning: the control IS
      // the mute, and its state is pressed-or-not. A screen reader gets "Mute
      // sounds, pressed" instead of having to infer from the word.
      aria-pressed={muted}
      // The name lives here, not in visible text: the control is a speaker icon
      // (wave 31 P20, *"the sound on control is an icon, not the words"*). The
      // icon is drawn below as plain SVG, because Keyrune and Mana are Magic
      // symbols and not UI icons.
      aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
      title={muted ? 'Sounds are off' : 'Sounds are on'}
      onClick={() => {
        // Flip first, then cue, so the sound you hear matches the state you are
        // now in: unmuting makes a noise, muting is silent. `toggleMuted` returns
        // the new value so this needs one call, not a read and a write.
        // There is no import cycle to dodge: `index.ts` deliberately does not
        // re-export this component, so the edge only runs one way.
        if (!toggleMuted()) playCue('select');
      }}
    >
      <svg
        className="sound-mute__icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
        {muted ? (
          <path d="M17 9l5 6M22 9l-5 6" />
        ) : (
          <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
        )}
      </svg>
    </button>
  );
}
