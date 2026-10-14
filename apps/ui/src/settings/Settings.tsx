/*
 * Cardtable's own settings: one popover, opened from the game's own controls.
 *
 * The operator, 2026-10-10: *"our game settings are gonna have to move out of
 * the top settings menu. this doesn't work when imported as submodule … i dont
 * want watchparty's settings menu to get clogged up by our game settings. so we
 * need our own. i think we can expose it by making the avatar clickable
 * in-game. and make we can make a settings wheel outside of game"*.
 *
 * So nothing here reaches into a host's chrome. The two ways in:
 *
 *   - **In a match, your own avatar** (`play/Board.tsx`'s `PlayerFace`, given
 *     `onOpenSettings` by `play/live/LiveBoard.tsx`). The match adds its own
 *     section (`play/live/SettingsPanel.tsx`) under the sound one.
 *   - **Anywhere else, `SettingsGear`**, at the right end of each screen's own
 *     head row (lobby, room, pod, deck, stats): sound, and the game section
 *     (2026-10-10), saved to the same preferences a match reads on join. In the
 *     flow, not fixed to a corner: a corner sits over the room's chat.
 *
 * The popover sits beside whatever opened it, inside the app's own tree rather
 * than portalled to `<body>`: embedded, the theme is resolved on the embed's
 * root (`embed/EmbedApp.tsx`), and a node outside it would lose its tokens.
 * Escape, the close button and a press anywhere outside it close it.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@wolffm/themes';

import { usePrefs } from '@wolffm/prefs-client/react';

import { SettingsPanel } from '../play/live/SettingsPanel.tsx';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS } from '../play/live/prefs.ts';
import { SoundSettings } from './SoundSettings.tsx';
import './settings.css';

/** The gap between the popover and what opened it, and its distance from the viewport's edges. */
const GAP = 8;

export interface SettingsPopoverProps {
  /** What opened it: the popover is placed beside it, and a press on it is the trigger's to handle. */
  trigger: Element;
  onClose: () => void;
  /** Sections after the sound one: a match passes its own. */
  children?: ReactNode;
}

interface Placement {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** Above an anchor in the lower half, below one in the upper; aligned to the anchor's nearer side. */
function place(anchor: DOMRect): Placement {
  const vw = globalThis.innerWidth;
  const vh = globalThis.innerHeight;
  const vertical = anchor.top + anchor.height / 2 > vh / 2 ? { bottom: Math.max(GAP, vh - anchor.top + GAP) } : { top: anchor.bottom + GAP };
  const horizontal = anchor.left + anchor.width / 2 > vw / 2 ? { right: Math.max(GAP, vw - anchor.right) } : { left: Math.max(GAP, anchor.left) };
  return { ...vertical, ...horizontal };
}

export function SettingsPopover({ trigger, onClose, children }: SettingsPopoverProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>(() => place(trigger.getBoundingClientRect()));
  useLayoutEffect(() => setPlacement(place(trigger.getBoundingClientRect())), [trigger]);

  useEffect(() => {
    const doc = globalThis.document;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const onPress = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current === null) return;
      if (!ref.current.contains(target) && !trigger.contains(target)) onClose();
    };
    doc.addEventListener('keydown', onKey);
    // Capture, so a board gesture that stops propagation still closes it.
    doc.addEventListener('pointerdown', onPress, true);
    ref.current?.focus();
    return () => {
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('pointerdown', onPress, true);
    };
  }, [onClose, trigger]);

  return (
    <div
      ref={ref}
      className="ct-settings"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="settings"
      tabIndex={-1}
      style={placement}
    >
      <div className="ct-settings__head">
        <h2 id={titleId} className="ct-settings__title">
          Settings
        </h2>
        <button type="button" className="ct-settings__close" aria-label="Close settings" data-testid="settings-close" onClick={onClose}>
          <Icon name="close" size="1rem" />
        </button>
      </div>
      <SoundSettings />
      {children}
    </div>
  );
}

/** Which trigger has the popover open, if any. Pressing that trigger again closes it. */
export function useSettingsPopover(): { trigger: Element | null; toggle: (el: Element) => void; close: () => void } {
  const [trigger, setTrigger] = useState<Element | null>(null);
  const close = useCallback(() => setTrigger(null), []);
  const toggle = useCallback((el: Element) => setTrigger((open) => (open === null ? el : null)), []);
  return { trigger, toggle, close };
}

/**
 * The game section outside a match: the same controls, on the saved preferences
 * alone. Mounted only while the popover is open, so a screen that never opens
 * it never builds the preferences client.
 */
function SavedGameSettings() {
  const { prefs, save } = usePrefs(getPlayPrefsClient());
  const persist = (patch: Parameters<typeof save>[0]): void => void save(patch);
  return (
    <SettingsPanel
      boardLayout={prefs?.boardLayout ?? PLAY_PREFS_DEFAULTS.boardLayout}
      onBoardLayoutChange={() => undefined}
      fastMode={prefs?.fastMode ?? PLAY_PREFS_DEFAULTS.fastMode}
      onFastModeChange={() => undefined}
      endStepStop={prefs?.endStepStop ?? PLAY_PREFS_DEFAULTS.endStepStop}
      onSave={persist}
    />
  );
}

/** The way in outside a match: a gear in the screen's head row. */
export function SettingsGear() {
  const { trigger, toggle, close } = useSettingsPopover();
  return (
    <>
      <button
        type="button"
        className="ct-settings-gear"
        aria-label="Settings"
        aria-expanded={trigger !== null}
        data-testid="settings-gear"
        onClick={(event) => toggle(event.currentTarget)}
      >
        <Icon name="gear" size="1.15rem" />
      </button>
      {trigger !== null && (
        <SettingsPopover trigger={trigger} onClose={close}>
          <SavedGameSettings />
        </SettingsPopover>
      )}
    </>
  );
}
