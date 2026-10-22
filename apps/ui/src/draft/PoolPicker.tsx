/*
 * The draft room's pool picker (wave 73 §B) — a Cube tab only; Set and Custom
 * follow in wave 74 and render nothing here yet (the brief: "do not render
 * placeholders for them").
 *
 * Imported cubes are pinned above the shortlist, newest first — the same
 * order `GET /api/pools/cubes` already answers in, kept rather than re-sorted.
 * Any friend may import or refresh; only the importer deletes (ruling 4).
 *
 * The leader edits; everyone else sees the same list, read-only and live —
 * the picker draws straight off the room's own feed (`pod.plan`), so a
 * change lands on every seated screen without a reload.
 *
 * Port of the room's own radio-card look (`components/RadioCards.css`) for
 * the choice itself, extended with each imported row's own meta line and
 * actions — `RadioCards` itself has no room for those, so this is its own
 * markup over the same classes rather than a forced fit.
 */
import { useState } from 'react';

import type { CubeSummary, PoolVerdict } from '@hadoku/shared';

import './PoolPicker.css';

/** A refused verdict only — the arm this picker ever shows the names of. */
export type Refusal = Extract<PoolVerdict, { ok: false }>;

export interface PoolPickerProps {
  cubes: readonly CubeSummary[];
  /** Could not load the cube list at all — a reachability problem, not a cube's own refusal. */
  cubesError: string | null;
  /**
   * The cube the picker shows chosen: the last attempted pick while it is
   * still refused (an ephemeral, local thing — the server never stores a
   * refused plan), else the room's own current plan.
   */
  selectedId: string | null;
  /** Only the leader edits; everyone else reads the same picker, disabled. */
  leader: boolean;
  /** A write (a pick, an import, a refresh, a delete) is in flight. */
  busy: boolean;
  /** The selected cube's verdict has not come back yet — the room's very first check, or one just asked for. */
  checking: boolean;
  /** The last attempted pick's own refusal, or null. */
  refusal: Refusal | null;
  /** The accepted plan's card count, once a verdict says ok. */
  readyCards: number | null;
  /** My own friend id — whose imports get a Delete button. */
  myId: string;
  onPick: (cubeId: string) => void;
  onImport: (link: string) => void;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}

export function PoolPicker({
  cubes,
  cubesError,
  selectedId,
  leader,
  busy,
  checking,
  refusal,
  readyCards,
  myId,
  onPick,
  onImport,
  onRefresh,
  onDelete,
}: PoolPickerProps) {
  const [link, setLink] = useState('');
  const disabled = !leader || busy;
  // Imported first (the server's own order), then the shortlist — never re-sorted here.
  const imported = cubes.filter((c) => c.origin === 'cubecobra');
  const shortlist = cubes.filter((c) => c.origin === 'shortlist');

  const verdictState = checking ? 'checking' : refusal !== null ? 'refused' : 'ready';

  return (
    <div className="pool-picker" data-testid="pool-picker">
      <div className="pool-picker__list radio-cards" role="radiogroup" aria-label="Cube" aria-disabled={disabled ? 'true' : undefined} data-testid="pool-picker-cubes">
        {[...imported, ...shortlist].map((cube) => (
          <div key={cube.id} className="pool-picker__row">
            <label className="radio-cards__card pool-picker__card">
              <input
                className="radio-cards__input"
                type="radio"
                name="pool-picker-cube"
                value={cube.id}
                data-testid={`pool-picker-cube-${cube.id}`}
                checked={selectedId === cube.id}
                disabled={disabled}
                onChange={() => onPick(cube.id)}
              />
              <span className="pool-picker__name">{cube.name}</span>
              <span className="pool-picker__size">{cube.size}</span>
              {cube.origin === 'cubecobra' && (
                <span className="pool-picker__meta" data-testid={`pool-picker-meta-${cube.id}`}>
                  {cube.importedBy}
                  {cube.refreshedAt !== null ? ` · refreshed ${cube.refreshedAt}` : ''}
                </span>
              )}
            </label>
            {cube.origin === 'cubecobra' && leader && (
              <span className="pool-picker__actions">
                <button type="button" className="pool-picker__action" data-testid={`pool-picker-refresh-${cube.id}`} disabled={busy} onClick={() => onRefresh(cube.id)}>
                  Refresh
                </button>
                {cube.importedBy === myId && (
                  <button type="button" className="pool-picker__action" data-testid={`pool-picker-delete-${cube.id}`} disabled={busy} onClick={() => onDelete(cube.id)}>
                    Delete
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>

      {cubesError !== null && (
        <p className="lobby__error" role="alert" data-testid="pool-picker-list-error">
          {cubesError}
        </p>
      )}

      {leader && (
        <form
          className="lobby__form pool-picker__import"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = link.trim();
            if (trimmed === '') return;
            onImport(trimmed);
            setLink('');
          }}
        >
          <label htmlFor="pool-picker-import-link">Cube Cobra link</label>
          <input
            id="pool-picker-import-link"
            type="text"
            data-testid="pool-picker-import-link"
            value={link}
            disabled={busy}
            onChange={(e) => setLink(e.target.value)}
          />
          <button type="submit" data-testid="pool-picker-import-go" disabled={busy || link.trim() === ''}>
            Import
          </button>
        </form>
      )}

      <p className="pool-picker__verdict" data-testid="pool-picker-verdict" data-state={verdictState}>
        {verdictState === 'checking' && 'Checking…'}
        {verdictState === 'ready' && readyCards !== null && `${readyCards} cards`}
        {verdictState === 'refused' && refusal !== null && [...refusal.unplayable, ...refusal.missingText].join(', ')}
      </p>
    </div>
  );
}
