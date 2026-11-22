/*
 * Cardtable's own settings: one panel, drawn by whichever host is around the game.
 *
 * The operator, 2026-10-30, after two players could not find the settings mid-match (they were
 * behind your own avatar): *"the right way to do this is to have hadoku_site prefs handle as much
 * as possible … we can utilize the generic 'site settings' section that already exists in that
 * settings modal and shove everything in there."* So:
 *
 *   - **Standalone**, `CARDTABLE_SETTINGS_TABS` are the `appTabs` of the fleet's `AppHeader`: tabs
 *     of their own after the site's Profile, Content and Account, in the one gear at the top of
 *     every screen, a match included (`../App.tsx`). `HostDrawsSettings` tells the screens so, and
 *     their own gear draws nothing.
 *   - **Inside a watchparty room** there is no fleet header yet, so `SettingsGear` draws our own,
 *     in each screen's head row and beside the board's Log button, with the same tabs' contents
 *     one under another (`CardtableSettings`), as watchparty's own popout draws a game's settings:
 *     one panel in its App tab.
 *     `docs/requests/SETTINGS_WATCHPARTY_SLOT.md` asks watchparty for a popout and a
 *     `mountSettings` hook that will put this same panel in it.
 *
 * Every value is a preference in the fleet's service (`../play/live/prefs.ts`,
 * `../sound/mute.ts`), so whichever host draws a control, the board reads the change from the
 * service and applies it. Only "This match" is not a preference: the board publishes it
 * (`./liveMatch.ts`). The Gameplay and Sound tabs' sections are the game's own, handed in by `../composition.tsx`;
 * Display (the UI scale and the motion switches) is drawn here, for every game.
 */

import { createContext, createElement, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { Icon } from '@wolffm/themes';
import type { AppSettingsTab } from '@wolffm/task-ui-components';

import type { PrefsClient } from '@wolffm/prefs-client';
import { usePrefs } from '@wolffm/prefs-client/react';
import { applyUiScale, clampUiScale, rememberedUiScale, rememberUiScale, UI_SCALE, uiLength } from '@hadoku/ui-shell/settings';
import { appId } from '@hadoku/ui-shell/app-id';
import { applyMotion, clearMotion, motionState, rememberedMotion, rememberMotion, setMotionChoices, systemReducesMotion, type MotionChoices } from '@hadoku/ui-shell/motion';

import { Popover, usePopover } from '../components/Popover.tsx';
import { registered } from '../registered.ts';
import './settings.css';

/**
 * What the Display tab saves in the game's own preferences: the UI scale, the motion switches
 * (`@hadoku/ui-shell/motion`, each unset until the player chooses, following the system until then) and
 * whether the front page plays its featured match (unset, it follows card motion's default).
 */
export interface DisplayPrefs extends MotionChoices {
  /** `usePrefs`'s own bound; nothing is read off it. */
  [key: string]: unknown;
  uiScale?: number;
  frontMatch?: boolean;
}

/** The game's own sections, where its UI scale is saved (and the scale before anything is), and what a new scale makes stale. */
export interface SettingsParts {
  Game: ComponentType;
  Sound: ComponentType;
  prefs: () => PrefsClient<DisplayPrefs>;
  defaultScale: number;
  onScaled: () => void;
}
const parts = registered<SettingsParts>('settings');
export const registerSettings = parts.set;

/**
 * The settings as tabs, in the order a player looks for them (operator, 2026-11-21): how the game plays,
 * how the page looks and moves, then sound.
 */
export const CARDTABLE_SETTINGS_TABS: AppSettingsTab[] = [
  { id: 'game', label: 'Gameplay', render: () => <div className="ct-settings__tab">{createElement(parts.get().Game)}</div> },
  {
    id: 'display',
    label: 'Display',
    render: () => (
      <div className="ct-settings__tab">
        <DisplaySettings />
        <MotionSettings />
      </div>
    ),
  },
  { id: 'sound', label: 'Sound', render: () => <div className="ct-settings__tab">{createElement(parts.get().Sound)}</div> },
];

/** Every tab's sections one under another, for a popout with no tabs of its own. */
export function CardtableSettings() {
  return (
    <>
      {CARDTABLE_SETTINGS_TABS.map((tab) => (
        <Fragment key={tab.id}>{tab.render()}</Fragment>
      ))}
    </>
  );
}

/** True where the page's host draws `CardtableSettings` itself: the screens then draw no gear of their own. */
const HostDrawsSettings = createContext(false);
export const HostDrawsSettingsProvider = HostDrawsSettings.Provider;

/**
 * Reads the same flag `SettingsGear` itself reads — exported for a screen that needs the FACT (not
 * just a gear it can toggle), rather than sniffing the DOM for whatever visible proxy the host's own
 * gear happens to be today. Wave 89 §B: `LiveBoard.tsx` hides the fleet header in portrait during a
 * match, and reads this to know whether that header WOULD have drawn the gear, so it can put a second
 * `SettingsGear` (under its own `HostDrawsSettingsProvider value={false}` override) in its menu only
 * where the header held the only route to one.
 */
export function useHostDrawsSettings(): boolean {
  return useContext(HostDrawsSettings);
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
  const { prefs: client, defaultScale } = parts.get();
  const { prefs, save } = usePrefs(client());
  const saved = clampUiScale(prefs?.uiScale ?? defaultScale);
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

/** Whether the front page plays its featured match: the player's choice, else on unless the system asks for less motion. */
export function frontMatchShown(prefs: DisplayPrefs | null): boolean {
  return prefs?.frontMatch ?? !systemReducesMotion();
}

function MotionToggle({ testId, checked, label, onChange }: { testId: string; checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <label className="ct-settings__option">
      <input type="checkbox" data-testid={testId} checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

/**
 * Each motion switch on its own (operator, 2026-11-21: "make sure that each of them can be individually
 * toggled"), each drawn as the page applies it now: a switch nobody set shows the system's answer.
 */
function MotionSettings() {
  const { prefs: client } = parts.get();
  const { prefs, save } = usePrefs(client());
  const state = motionState(prefs ?? {});
  return (
    <fieldset className="ct-settings__section" data-testid="settings-motion">
      <legend>Motion</legend>
      <MotionToggle testId="settings-card-motion" checked={state.cardMotion} label="Card animations" onChange={(on) => void save({ cardMotion: on })} />
      <MotionToggle testId="settings-screen-shake" checked={state.screenShake} label="Screen shake" onChange={(on) => void save({ screenShake: on })} />
      <MotionToggle testId="settings-ambient-motion" checked={state.ambientMotion} label="Looping animations" onChange={(on) => void save({ ambientMotion: on })} />
      <MotionToggle testId="settings-front-match" checked={frontMatchShown(prefs)} label="Front page match" onChange={(on) => void save({ frontMatch: on })} />
    </fieldset>
  );
}

/** Per game: the motion switches this browser applied last. */
const motionKey = (): string => `${appId()}:motion`;

/**
 * The motion switches, applied: for every reader of `prefersReducedMotion()` / `screenShakeAllowed()`, and
 * as attributes on `root`, where the sheets look for them (`@hadoku/ui-shell/motion`'s `css.ts`). Called once
 * per app, as `useUiScale` is. Until prefs answer, the switches this browser applied last; a system that
 * changes its mind mid-visit is followed by every switch the player has not set.
 */
export function useMotion(root: () => HTMLElement | null): void {
  const { prefs: client } = parts.get();
  const { prefs } = usePrefs(client());
  const [remembered] = useState(() => rememberedMotion(motionKey()));
  const [systemTick, setSystemTick] = useState(0);
  const choices: MotionChoices = prefs === null ? (remembered ?? {}) : { cardMotion: prefs.cardMotion, screenShake: prefs.screenShake, ambientMotion: prefs.ambientMotion };
  const { cardMotion, screenShake, ambientMotion } = choices;
  useLayoutEffect(() => {
    const el = root();
    setMotionChoices({ cardMotion, screenShake, ambientMotion });
    if (el === null) return undefined;
    applyMotion(el);
    return () => clearMotion(el);
  }, [root, cardMotion, screenShake, ambientMotion, systemTick]);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    // The shake is written whatever the player set, so it is rewritten here, in the change itself.
    const changed = (): void => {
      const el = root();
      if (el !== null) applyMotion(el);
      setSystemTick((t) => t + 1);
    };
    query.addEventListener?.('change', changed);
    return () => query.removeEventListener?.('change', changed);
  }, [root]);
  useEffect(() => {
    if (prefs !== null) rememberMotion(motionKey(), { cardMotion, screenShake, ambientMotion });
  }, [prefs, cardMotion, screenShake, ambientMotion]);
}

/**
 * The saved UI scale, written where the stylesheet's tokens resolve (shell's `ui-scale.ts`). Called
 * once per app — the standalone page's and the embed's — with the element that is. Until prefs
 * answer, the scale this browser applied last: a layout effect, so the first frame is drawn at it.
 */
export function useUiScale(root: () => HTMLElement | null): void {
  const { prefs: client, defaultScale, onScaled } = parts.get();
  const { prefs } = usePrefs(client());
  const [remembered] = useState(rememberedUiScale);
  const scale = prefs?.uiScale ?? remembered ?? defaultScale;
  useLayoutEffect(() => {
    const el = root();
    if (el === null) return undefined;
    applyUiScale(el, scale);
    // Every card width the board kept was measured at the old scale.
    onScaled();
    return () => applyUiScale(el, 1);
  }, [root, scale, onScaled]);
  useEffect(() => {
    if (prefs !== null) rememberUiScale(scale);
  }, [prefs, scale]);
}

/** Our own way in, where no host draws the settings: a gear in a screen's head row, or beside the board's Log button. */
export function SettingsGear({ className }: { className?: string }) {
  return useContext(HostDrawsSettings) ? null : <OwnSettingsGear className={className} />;
}

function OwnSettingsGear({ className }: { className: string | undefined }) {
  const { trigger, toggle, close } = usePopover();
  return (
    <>
      <button
        type="button"
        className={className === undefined ? 'ct-round-button' : `ct-round-button ${className}`}
        aria-label="Settings"
        aria-expanded={trigger !== null}
        data-testid="settings-gear"
        onClick={(event) => toggle(event.currentTarget)}
      >
        <Icon name="gear" size={uiLength('1.15rem')} />
      </button>
      {trigger !== null && (
        <Popover trigger={trigger} onClose={close} title="Settings" testId="settings">
          <CardtableSettings />
        </Popover>
      )}
    </>
  );
}
