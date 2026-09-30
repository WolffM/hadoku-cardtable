/*
 * The settings surface (items 4-7, wave 30) — the operator's own instruction,
 * 2026-09-30: *"i think by default this should be off, but can be turned on
 * in settings (always stop at endstep). same place that we should allow the
 * board config to show differently."*
 *
 * Ours, holding exactly two things this wave:
 *
 *   - **Board layout** — single (default, item 11) or type-separated.
 *     Client-only: nothing crosses the wire, the same way `Board`'s own
 *     `boardLayout` prop is client-only. `onBoardLayoutChange` is the whole
 *     seam back to `LiveBoard`, which holds the value and passes it to
 *     `<Board>`.
 *   - **Always stop at end step** — default off (item 2/6). This ONE control
 *     sends a message: `sendStopPreference` (`./match.ts`), on the shape
 *     `docs/planning/wave30-evidence/A-stop-pref-message.md` records and lane
 *     B's server handler (`apps/server/src/play/socket.ts`) already reads.
 *
 * **Fully controlled — no `usePrefs` call of its own.** Reading the persisted
 * blob and applying it to a FRESH match has to happen whether or not this
 * panel is ever opened (a preference set last match must reach a seat that
 * never opens Settings this match), so `LiveBoard` owns the one
 * `usePrefs(playPrefsClient)` call and the one "apply on join/rejoin" effect;
 * this component only draws the current values and calls back on a change.
 * `./prefs.ts` has the whole persistence integration, including why it needs
 * a cross-zod-instance type cast to compile (`apps/ui` has no direct `zod`
 * dependency and `@wolffm/prefs-client`'s peer resolves a different physical
 * copy than `@hadoku/forge-wire`'s). The client library IS able to hold this
 * app's preferences; nothing here fell back to `localStorage`.
 *
 * **Reachable without a fourth floating thing (item 7).** This panel's own
 * TRIGGER is a button inside the control cluster — `Settings`, in the slot
 * item 5 vacated by deleting `Leave` — not a new floating box beside the
 * rail, the cluster and the log button. The panel itself, while OPEN, is a
 * centred overlay over the match, the same device `ConcedeAsk` already uses;
 * while CLOSED it draws nothing and covers nothing.
 */

import { useId } from 'react';

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
  /** Persists a patch through `LiveBoard`'s own `usePrefs` client. */
  onSave: (patch: Partial<PlayPrefs>) => void;
  onClose: () => void;
}

const BOARD_LAYOUT_OPTIONS: readonly { value: BoardLayout; label: string }[] = [
  { value: 'single', label: 'Single board' },
  { value: 'type-separated', label: 'Type-separated (lands, artifacts, creatures, other)' },
];

export function SettingsPanel({ match, inert = false, boardLayout, onBoardLayoutChange, onSave, onClose }: SettingsPanelProps) {
  const titleId = useId();
  const layoutLegendId = useId();

  return (
    <div
      className="live__ask"
      data-testid="live-settings-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <section className="confirm live__settings-body" role="dialog" aria-labelledby={titleId}>
        <h2 className="confirm__title" id={titleId}>
          Settings
        </h2>
        <fieldset className="live__settings-field">
          <legend id={layoutLegendId}>Board layout</legend>
          {BOARD_LAYOUT_OPTIONS.map((opt) => (
            <label key={opt.value} className="live__settings-option">
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
        </fieldset>
        <label className="live__settings-option">
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
        <div className="confirm__actions">
          <button type="button" className="button confirm__button" data-default autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
