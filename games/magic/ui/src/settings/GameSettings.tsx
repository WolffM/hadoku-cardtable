/*
 * The game's sections of cardtable's settings (`./Settings.tsx`): how a match plays for this
 * player, and the live match's own remembered triggers.
 *
 *   - **Board layout** — single (default) or by type (lands, artifacts, creatures, other). Mine only: the opponent's board keeps
 *     its own (*"my board preference should not change the opponent's board"*).
 *   - **End step** — default on: the opponent's End step holds this seat's priority when it has a
 *     real play there. **Always** (default off, 2026-11-05) holds it whatever the seat has; it
 *     covers the first, which then reads checked and cannot be unchecked. The only settings the
 *     server hears of; the board sends them (`sendStopPreference`, `../play/live/match.ts`).
 *   - **Game speed** (2026-11-21) — Normal (default), Fast (every beat and gap twice as quick,
 *     `../play/live/tempo.ts`) or Instant (wave 47's Fast Mode: the pacer let go,
 *     `../play/live/pace.ts`). Client-only. How much MOVES is the Display tab's motion switches,
 *     not this (`@hadoku/game-ui/settings/Settings.tsx`).
 *   - **"Say my mistakes"** (approved 2026-10-26) — default on. Client-only: the board draws the
 *     seat's own mistake bubble (`../play/live/MistakeBubble.tsx`).
 *   - **Always use oldest art** (wave 126) — default off. Not a preference: an art rule, kept on our
 *     server beside the art picks (`GET`/`PUT /api/me/art`, `../deck/artRules.ts`) and resolved at
 *     match start. A refused write draws the toggle as it was.
 *   - **Experimental features** (2026-11-10) — default off. Shows what is not ready for everyone:
 *     today Create room's Challenge (`../rooms/RoomList.tsx`). A Challenge room already made is
 *     listed and joinable either way.
 *
 * Each control only SAVES (2026-10-30). The board reads the same preferences and applies a change
 * the moment it lands — from here, from another tab, or from a host's popout this page did not draw
 * — so this section knows nothing of a match and is the same everywhere it is drawn. No
 * explanatory text (operator, twice): one plain control each.
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@wolffm/themes';
import { usePrefs } from '@wolffm/prefs-client/react';

import { artClient, changeArt, type ArtClient } from '../deck/artRules.ts';
import type { BoardLayout } from '../play/Board.tsx';
import { GAME_SPEEDS, getPlayPrefsClient, PLAY_PREFS_DEFAULTS, type GameSpeed, type PlayPrefs } from '../play/live/prefs.ts';
import { useLiveMatchSettings } from './liveMatchSettings.ts';
import { uiLength } from '@hadoku/ui-shell/settings';

const BOARD_LAYOUT_OPTIONS: readonly { value: BoardLayout; label: string }[] = [
  { value: 'single', label: 'Single' },
  { value: 'type-separated', label: 'By type' },
];

const SPEED_LABELS: Readonly<Record<GameSpeed, string>> = { normal: 'Normal', fast: 'Fast', instant: 'Instant' };

function Toggle({ testId, checked, label, onChange, disabled = false }: { testId: string; checked: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className="ct-settings__option">
      <input type="checkbox" data-testid={testId} checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

export function GameSettings() {
  const { prefs, save } = usePrefs(getPlayPrefsClient());
  const persist = (patch: Partial<PlayPrefs>): void => void save(patch);
  const boardLayout = prefs?.boardLayout ?? PLAY_PREFS_DEFAULTS.boardLayout;
  const endStepAlways = prefs?.endStepAlways ?? PLAY_PREFS_DEFAULTS.endStepAlways;
  const gameSpeed = prefs?.gameSpeed ?? PLAY_PREFS_DEFAULTS.gameSpeed;
  return (
    <fieldset className="ct-settings__section" data-testid="settings-game">
      <legend>Gameplay</legend>
      <div className="ct-settings__choices ct-settings__choices--row" role="radiogroup" aria-label="Board layout">
        <span>Board</span>
        {BOARD_LAYOUT_OPTIONS.map((opt) => (
          <label key={opt.value} className="ct-settings__option">
            <input
              type="radio"
              name="board-layout"
              value={opt.value}
              checked={boardLayout === opt.value}
              onChange={() => persist({ boardLayout: opt.value })}
            />
            {opt.label}
          </label>
        ))}
      </div>
      <div className="ct-settings__choices ct-settings__choices--row" role="radiogroup" aria-label="Game speed" data-testid="live-settings-speed">
        <span>Game speed</span>
        {GAME_SPEEDS.map((speed) => (
          <label key={speed} className="ct-settings__option">
            <input
              type="radio"
              name="game-speed"
              value={speed}
              data-testid={`live-settings-speed-${speed}`}
              checked={gameSpeed === speed}
              onChange={() => persist({ gameSpeed: speed })}
            />
            {SPEED_LABELS[speed]}
          </label>
        ))}
      </div>
      <Toggle
        testId="live-settings-stop-end-step-always"
        checked={endStepAlways}
        label="Always stop at their end step"
        onChange={(on) => persist({ endStepAlways: on })}
      />
      <Toggle
        testId="live-settings-stop-end-step"
        checked={endStepAlways || (prefs?.endStepStop ?? PLAY_PREFS_DEFAULTS.endStepStop)}
        disabled={endStepAlways}
        label="Stop at their end step when I can act"
        onChange={(on) => persist({ endStepStop: on })}
      />
      <Toggle
        testId="live-settings-mistake-bubbles"
        checked={prefs?.mistakeBubbles ?? PLAY_PREFS_DEFAULTS.mistakeBubbles}
        label="Say my mistakes"
        onChange={(on) => persist({ mistakeBubbles: on })}
      />
      <OldestArtToggle />
    </fieldset>
  );
}

/** "Always use oldest art": read from the server, written back whole (`changeArt`); off and still until it has answered. */
export function OldestArtToggle({ client: given }: { client?: ArtClient }) {
  const client = useMemo(() => given ?? artClient(), [given]);
  const [oldest, setOldest] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    client.getArt().then(
      (rules) => live && setOldest(rules.oldest),
      (err: unknown) => console.warn('[cardtable] art rules are unavailable', err),
    );
    return () => {
      live = false;
    };
  }, [client]);
  const change = (on: boolean): void => {
    const before = oldest;
    setOldest(on);
    void changeArt(client, (rules) => ({ ...rules, oldest: on })).then((r) => setOldest(r.ok ? r.rules.oldest : before));
  };
  return <Toggle testId="settings-art-oldest" checked={oldest ?? false} disabled={oldest === null} label="Always use oldest art" onChange={change} />;
}

/** Off by default: what is not ready for everyone stays out of sight until a player asks for it. */
export function ExperimentalSettings() {
  const { prefs, save } = usePrefs(getPlayPrefsClient());
  return (
    <fieldset className="ct-settings__section" data-testid="settings-experimental">
      <legend>Experimental</legend>
      <Toggle
        testId="settings-experimental-features"
        checked={prefs?.experimental ?? PLAY_PREFS_DEFAULTS.experimental}
        label="Experimental features"
        onChange={(on) => void save({ experimental: on })}
      />
    </fieldset>
  );
}

/** "This match": drawn only in a match, and only once this seat has a trigger remembered. */
export function MatchSettings() {
  const live = useLiveMatchSettings();
  if (live === null || live.triggers.length === 0) return null;
  return (
    <fieldset className="ct-settings__section" data-testid="settings-match">
      <legend>This match</legend>
      <ul className="ct-settings__triggers" aria-label="Remembered triggers">
        {live.triggers.map((t) => (
          <li key={t.key} className="ct-settings__trigger" data-testid="live-settings-trigger">
            <span>
              {t.name} — always {t.decision === 'ACCEPT' ? 'yes' : 'no'}
            </span>
            <button
              type="button"
              className="ct-settings__close"
              aria-label={`Clear ${t.name}`}
              data-testid="live-settings-trigger-clear"
              onClick={() => live.clear(t.key)}
            >
              <Icon name="close" size={uiLength('0.875rem')} />
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
