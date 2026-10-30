/*
 * The game's sections of cardtable's settings (`./Settings.tsx`): how a match plays for this
 * player, and the live match's own remembered triggers.
 *
 *   - **Board layout** — single (default) or type-separated. Mine only: the opponent's board keeps
 *     its own (*"my board preference should not change the opponent's board"*).
 *   - **End step** — default on: the opponent's End step holds this seat's priority when it has a
 *     real play there. The one setting the server hears of; the board sends it
 *     (`sendStopPreference`, `../play/live/match.ts`).
 *   - **Fast Mode** (wave 47) — default off (paced). Client-only: the board flips its own paced
 *     transport (`../play/live/pace.ts`).
 *   - **"Say my mistakes"** (approved 2026-10-26) — default on. Client-only: the board draws the
 *     seat's own mistake bubble (`../play/live/MistakeBubble.tsx`).
 *
 * Each control only SAVES (2026-10-30). The board reads the same preferences and applies a change
 * the moment it lands — from here, from another tab, or from a host's popout this page did not draw
 * — so this section knows nothing of a match and is the same everywhere it is drawn. No
 * explanatory text (operator, twice): one plain control each.
 */

import { Icon } from '@wolffm/themes';
import { usePrefs } from '@wolffm/prefs-client/react';

import type { BoardLayout } from '../play/Board.tsx';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS, type PlayPrefs } from '../play/live/prefs.ts';
import { useLiveMatchSettings } from './liveMatch.ts';
import { uiLength } from './ui-scale.ts';

const BOARD_LAYOUT_OPTIONS: readonly { value: BoardLayout; label: string }[] = [
  { value: 'single', label: 'Single board' },
  { value: 'type-separated', label: 'Type-separated (lands, artifacts, creatures, other)' },
];

function Toggle({ testId, checked, label, onChange }: { testId: string; checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <label className="ct-settings__option">
      <input type="checkbox" data-testid={testId} checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

export function GameSettings() {
  const { prefs, save } = usePrefs(getPlayPrefsClient());
  const persist = (patch: Partial<PlayPrefs>): void => void save(patch);
  const boardLayout = prefs?.boardLayout ?? PLAY_PREFS_DEFAULTS.boardLayout;
  return (
    <fieldset className="ct-settings__section" data-testid="settings-game">
      <legend>Game</legend>
      <div className="ct-settings__choices" role="radiogroup" aria-label="Board layout">
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
      <Toggle
        testId="live-settings-stop-end-step"
        checked={prefs?.endStepStop ?? PLAY_PREFS_DEFAULTS.endStepStop}
        label="Stop at their end step when I can act"
        onChange={(on) => persist({ endStepStop: on })}
      />
      <Toggle
        testId="live-settings-fast-mode"
        checked={prefs?.fastMode ?? PLAY_PREFS_DEFAULTS.fastMode}
        label="Fast Mode"
        onChange={(on) => persist({ fastMode: on })}
      />
      <Toggle
        testId="live-settings-mistake-bubbles"
        checked={prefs?.mistakeBubbles ?? PLAY_PREFS_DEFAULTS.mistakeBubbles}
        label="Say my mistakes"
        onChange={(on) => persist({ mistakeBubbles: on })}
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
