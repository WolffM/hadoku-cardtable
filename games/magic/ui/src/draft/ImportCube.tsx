/*
 * The Cube Cobra import box — a dashed, link-plus-button card, shared by the
 * draft room's Cube tab/Custom picker and `#/inventory` (AF305 §B: the
 * operator picked a one-shared-component import over a second copy of the
 * same little form). It is always the LAST tile in whichever gallery grid
 * draws it — a sibling of the gallery's other cards, never a separate
 * section — so both call sites wrap it in their own `.pool-picker__gallery`/
 * `.inventory__gallery` and lay it out identically.
 */
import { useState } from 'react';

import './ImportCube.css';

export function ImportCube({ busy, onImport }: { busy: boolean; onImport: (link: string) => void }) {
  const [link, setLink] = useState('');
  return (
    <form
      className="import-cube"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = link.trim();
        if (trimmed === '') return;
        onImport(trimmed);
        setLink('');
      }}
    >
      <label htmlFor="import-cube-link">Cube Cobra</label>
      <div className="import-cube__row">
        <input
          id="import-cube-link"
          type="text"
          placeholder="cubecobra.com/cube/…"
          data-testid="pool-picker-import-link"
          value={link}
          disabled={busy}
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="submit" data-testid="pool-picker-import-go" disabled={busy || link.trim() === ''}>
          Import
        </button>
      </div>
    </form>
  );
}
