/*
 * The import box — a dashed card holding one field and a button, shared by the
 * draft room's Cube tab/Custom picker and `#/inventory` (AF305 §B: the
 * operator picked a one-shared-component import over a second copy of the
 * same little form). It is always the LAST tile in whichever gallery grid
 * draws it — a sibling of the gallery's other cards, never a separate
 * section — so both call sites wrap it in their own `.pool-picker__gallery`/
 * `.inventory__gallery` and lay it out identically.
 *
 * The one field takes either import: a single line is a Cube Cobra link or
 * id; several lines are a card list, which grows the field and asks its name
 * (a list has none of its own; a Cube Cobra cube brings one).
 */
import { useState } from 'react';

import type { ImportCubeBody } from '@hadoku/shared';

import './ImportCube.css';

/** The most lines the field grows to before it scrolls. */
const MAX_ROWS = 6;

export function ImportCube({ busy, onImport }: { busy: boolean; onImport: (source: ImportCubeBody) => void }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const trimmed = text.trim();
  const isList = trimmed.includes('\n');
  const ready = trimmed !== '' && (!isList || name.trim() !== '');

  const submit = (): void => {
    if (!ready) return;
    onImport(isList ? { name: name.trim(), list: trimmed } : { link: trimmed });
    setText('');
    setName('');
  };

  return (
    <form
      className="import-cube"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="import-cube-source">Import</label>
      <div className="import-cube__row">
        <textarea
          id="import-cube-source"
          rows={Math.min(Math.max(text.split('\n').length, 1), MAX_ROWS)}
          placeholder="Cube Cobra link or card list"
          data-testid="pool-picker-import-link"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends a link, as it did when this was a one-line field; in anything with a space it is a list's next line.
            if (e.key !== 'Enter' || e.shiftKey || isList || /\s/.test(trimmed) || trimmed === '') return;
            e.preventDefault();
            submit();
          }}
        />
        {isList && (
          <input
            type="text"
            aria-label="Name"
            placeholder="Name"
            maxLength={60}
            data-testid="pool-picker-import-name"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <button type="submit" data-testid="pool-picker-import-go" disabled={busy || !ready}>
          Import
        </button>
      </div>
    </form>
  );
}
