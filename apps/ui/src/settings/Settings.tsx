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
import { useDismiss } from '../popover.ts';
import { applyUiScale, clampUiScale, UI_SCALE, uiLength } from './ui-scale.ts';
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

  useDismiss(onClose, useCallback((target: Node) => ref.current?.contains(target) !== false || trigger.contains(target), [trigger]));
  useEffect(() => ref.current?.focus(), []);

  return (
    <div
      ref={ref}
      className="ct-settings ct-surface"
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
          <Icon name="close" size={uiLength('1rem')} />
        </button>
      </div>
      <DisplaySettings />
      <SoundSettings />
      {children}
    </div>
  );
}

/**
 * The UI scale, the slider the sound levels' own design is (`ct-settings__level`), with no number
 * beside it as they have none (the operator, 2026-10-21). Saved once the
 * thumb is let go, not on every step of a drag: the whole page re-scales on a save, and a slider
 * that moves under the pointer while it is held is a slider that cannot be aimed.
 *
 * Let go is the input's own `change`, not `pointerup`: `pointerup` is dispatched before the
 * browser has finished the press, and a save there re-scaled the slider while the browser was
 * still reading the pointer against it — a click on 110% came back as 90%.
 */
function DisplaySettings() {
  const { prefs, save } = usePrefs(getPlayPrefsClient());
  const saved = clampUiScale(prefs?.uiScale ?? PLAY_PREFS_DEFAULTS.uiScale);
  const [held, setHeld] = useState<number | null>(null);
  const shown = held ?? saved;
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = slider.current;
    if (el === null) return undefined;
    // The native `change` is the one sent on let go; React's onChange also runs for every `input`.
    const commit = (): void => {
      setHeld(null);
      const chosen = clampUiScale(Number(el.value) / 100);
      if (chosen !== saved) void save({ uiScale: chosen });
    };
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, [saved, save]);
  return (
    <fieldset className="ct-settings__section" data-testid="settings-display">
      <legend>Display</legend>
      <label className="ct-settings__level">
        <span>UI scale</span>
        <input
          type="range"
          min={UI_SCALE.min * 100}
          max={UI_SCALE.max * 100}
          step={UI_SCALE.step * 100}
          value={Math.round(shown * 100)}
          data-testid="settings-ui-scale"
          ref={slider}
          onChange={(event) => {
            // React runs this for the let-go `change` too, after it has been saved; only a step is held.
            if (event.nativeEvent.type === 'input') setHeld(clampUiScale(Number(event.currentTarget.value) / 100));
          }}
        />
      </label>
    </fieldset>
  );
}

/**
 * The saved UI scale, written where the stylesheet's tokens resolve (`./ui-scale.ts`). Called
 * once per app — the standalone page's and the embed's — with the element that is.
 */
export function useUiScale(root: () => HTMLElement | null): void {
  const { prefs } = usePrefs(getPlayPrefsClient());
  const scale = prefs?.uiScale ?? PLAY_PREFS_DEFAULTS.uiScale;
  useLayoutEffect(() => {
    const el = root();
    if (el === null) return undefined;
    applyUiScale(el, scale);
    return () => applyUiScale(el, 1);
  }, [root, scale]);
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
        <Icon name="gear" size={uiLength('1.15rem')} />
      </button>
      {trigger !== null && (
        <SettingsPopover trigger={trigger} onClose={close}>
          <SavedGameSettings />
        </SettingsPopover>
      )}
    </>
  );
}
