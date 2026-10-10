/*
 * The match's section of cardtable's own settings (`../../settings/Settings.tsx`),
 * under the sound one. Opened from the viewer's own avatar: the operator,
 * 2026-10-10, *"i dont want watchparty's settings menu to get clogged up by our
 * game settings … we can expose it by making the avatar clickable in-game"*.
 * Before that it was portalled into the standalone header's gear (wave 32 Q15),
 * which a host's chrome does not have room for.
 *
 *   - **Board layout** — single (default) or type-separated. Client-only, and
 *     MINE only: it is `Board`'s `boardLayout` prop for the viewer's own side
 *     (*"my board preference should not change the opponent's board"*).
 *   - **Always stop at end step** — default off. This ONE control sends a
 *     message: `sendStopPreference` (`./match.ts`), on the shape
 *     `docs/planning/wave30-evidence/A-stop-pref-message.md` records.
 *   - **Fast Mode** (wave 47) — default off (paced). Client-only, like board
 *     layout: nothing about pacing crosses to the server (`./pace.ts` wraps
 *     the TRANSPORT, not the game), so this flips `LiveBoard`'s own paced
 *     transport through `isPacedTransport(match.transport).setFast` and
 *     nothing else. No explanatory text (operator, twice) — one plain toggle,
 *     same as the other two.
 *
 * **Fully controlled — no `usePrefs` call of its own.** The popover is closed
 * most of the time and this component is not mounted then, but a preference set
 * last match must still reach a seat that never opens it, so `LiveBoard` owns
 * the one `usePrefs(playPrefsClient)` call and the "apply on join/rejoin"
 * effect; this only draws the current values and calls back on a change.
 * `./prefs.ts` has the persistence integration.
 */

import type { BoardLayout } from '../Board.tsx';
import { sendStopPreference, type LiveMatch } from './match.ts';
import type { PlayPrefs } from './prefs.ts';

export interface SettingsPanelProps {
  match: LiveMatch;
  /** A watching window: the one setting that reaches the server is refused. */
  inert?: boolean;
  /** The board's CURRENT layout — `LiveBoard`'s own state, passed to `<Board>`. */
  boardLayout: BoardLayout;
  /** The whole seam back to `LiveBoard`: a choice here becomes `<Board boardLayout>`. */
  onBoardLayoutChange: (layout: BoardLayout) => void;
  /** Whether the viewer's own transport is paced — `LiveBoard`'s own state (wave 47). */
  fastMode: boolean;
  /** The whole seam back to `LiveBoard`: a toggle here flips the paced transport, if there is one. */
  onFastModeChange: (fast: boolean) => void;
  /** Persists a patch through `LiveBoard`'s own `usePrefs` client. */
  onSave: (patch: Partial<PlayPrefs>) => void;
}

const BOARD_LAYOUT_OPTIONS: readonly { value: BoardLayout; label: string }[] = [
  { value: 'single', label: 'Single board' },
  { value: 'type-separated', label: 'Type-separated (lands, artifacts, creatures, other)' },
];

export function SettingsPanel({
  match,
  inert = false,
  boardLayout,
  onBoardLayoutChange,
  fastMode,
  onFastModeChange,
  onSave,
}: SettingsPanelProps) {
  return (
    <fieldset className="ct-settings__section" data-testid="live-settings-panel">
      <legend>Match</legend>
      <div className="ct-settings__choices" role="radiogroup" aria-label="Board layout">
        {BOARD_LAYOUT_OPTIONS.map((opt) => (
          <label key={opt.value} className="ct-settings__option">
            <input
              type="radio"
              name="board-layout"
              value={opt.value}
              checked={boardLayout === opt.value}
              onChange={() => {
                onBoardLayoutChange(opt.value);
                onSave({ boardLayout: opt.value });
              }}
            />
            {opt.label}
          </label>
        ))}
      </div>
      <label className="ct-settings__option">
        <input
          type="checkbox"
          data-testid="live-settings-stop-end-step"
          checked={match.stopAtEndStep}
          disabled={inert}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            sendStopPreference(match, next);
            onSave({ stopAtEndStep: next });
          }}
        />
        Always stop at end step
      </label>
      <label className="ct-settings__option">
        <input
          type="checkbox"
          data-testid="live-settings-fast-mode"
          checked={fastMode}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            onFastModeChange(next);
            onSave({ fastMode: next });
          }}
        />
        Fast Mode
      </label>
    </fieldset>
  );
}
