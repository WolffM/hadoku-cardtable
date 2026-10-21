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
 *   - **End step** — default on: the opponent's End step holds this seat's
 *     priority when it has a real play there. This ONE control sends a
 *     message: `sendStopPreference` (`./match.ts`), on the shape
 *     `docs/planning/wave30-evidence/A-stop-pref-message.md` records.
 *   - **Fast Mode** (wave 47) — default off (paced). Client-only, like board
 *     layout: nothing about pacing crosses to the server (`./pace.ts` wraps
 *     the TRANSPORT, not the game), so this flips `LiveBoard`'s own paced
 *     transport through `isPacedTransport(match.transport).setFast` and
 *     nothing else. No explanatory text (operator, twice) — one plain toggle,
 *     same as the other two.
 *   - **Remembered triggers** — every optional trigger this seat ticked
 *     "Always" on, as the server reports Forge holds them
 *     (`match.triggerDecisions`), each with a clear that sends `ASK` back to
 *     Forge (`setTriggerDecision`). Drawn only when there is one.
 *
 * **Fully controlled — no `usePrefs` call of its own.** The popover is closed
 * most of the time and this component is not mounted then, but a preference set
 * last match must still reach a seat that never opens it, so `LiveBoard` owns
 * the one `usePrefs(playPrefsClient)` call and the "apply on join/rejoin"
 * effect; this only draws the current values and calls back on a change.
 * `./prefs.ts` has the persistence integration.
 */

import type { BoardLayout } from '../Board.tsx';
import { Icon } from '@wolffm/themes';
import { sendStopPreference, setTriggerDecision, type LiveMatch } from './match.ts';
import type { PlayPrefs } from './prefs.ts';
import { uiLength } from '../../settings/ui-scale.ts';

export interface SettingsPanelProps {
  /**
   * The live match, or absent outside one (the operator, 2026-10-10: the gear's
   * menu has the game settings too). Outside a match a choice is only saved,
   * and `LiveBoard` applies it on the next join; the remembered triggers are a
   * match's own and are not drawn.
   */
  match?: LiveMatch;
  /** Outside a match, the saved End step checkbox; inside, the match's own value is the truth. */
  endStepStop?: boolean;
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
  endStepStop = true,
  inert = false,
  boardLayout,
  onBoardLayoutChange,
  fastMode,
  onFastModeChange,
  onSave,
}: SettingsPanelProps) {
  return (
    <fieldset className="ct-settings__section" data-testid="live-settings-panel">
      <legend>Game</legend>
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
          checked={match === undefined ? endStepStop : match.stopAtEndStep}
          disabled={inert}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            if (match !== undefined) sendStopPreference(match, next);
            onSave({ endStepStop: next });
          }}
        />
        Stop at their end step when I can act
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
      {match !== undefined && match.triggerDecisions.length > 0 && (
        <ul className="ct-settings__triggers" aria-label="Remembered triggers">
          {match.triggerDecisions.map((t) => (
            <li key={t.key} className="ct-settings__trigger" data-testid="live-settings-trigger">
              <span>
                {t.name} — always {t.decision === 'ACCEPT' ? 'yes' : 'no'}
              </span>
              <button
                type="button"
                className="ct-settings__close"
                aria-label={`Clear ${t.name}`}
                data-testid="live-settings-trigger-clear"
                disabled={inert}
                onClick={() => setTriggerDecision(match, t.key, 'ASK')}
              >
                <Icon name="close" size={uiLength('0.875rem')} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
