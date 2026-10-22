/*
 * `#/ui` — the trim composer (the operator, 2026-10-21: "the UI selection stuff should land behind
 * 'https://hadoku.me/cardtable/#/ui' not exposed to all players", then "make it set the look for
 * every player").
 *
 * The site's trim, for everyone (`./siteTrim.ts`). Linked from nowhere, and drawn only for a viewer
 * the server says may edit it (`canEdit`, the admin tier it reads from the edge); anyone else is
 * sent to the lobby. Each choice saves at once, and this page and every player's screens redraw.
 */
import { useEffect } from 'react';

import { navigate } from '../screens/route.ts';
import { saveSiteTrim, useSiteTrim } from './siteTrim.ts';
import { TRIM_FAMILIES, TRIM_FAMILY_IDS, type Trim } from './trim.ts';
import './trim-screen.css';

export function TrimScreen() {
  const { loaded, canEdit, trim } = useSiteTrim();
  useEffect(() => {
    if (loaded && !canEdit) navigate({ kind: 'lobby' });
  }, [loaded, canEdit]);
  if (!canEdit) return null;
  return (
    <div className="shell" data-testid="trim-screen">
      <section className="ui-trim ct-panel" aria-labelledby="ui-trim-title">
        <h2 id="ui-trim-title" className="ui-trim__title ct-panel__title">
          Trim
        </h2>
        {TRIM_FAMILY_IDS.map((family) => (
          <label key={family} className="ui-trim__row">
            <span>{TRIM_FAMILIES[family].label}</span>
            <select
              value={trim[family] ?? ''}
              data-testid={`trim-${family}`}
              onChange={(event) => {
                const { [family]: _was, ...rest } = trim;
                const value = event.currentTarget.value;
                void saveSiteTrim((value === '' ? rest : { ...rest, [family]: value }) as Trim);
              }}
            >
              <option value="">None</option>
              {Object.entries(TRIM_FAMILIES[family].options).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </section>
    </div>
  );
}
