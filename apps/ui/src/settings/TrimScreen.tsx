/*
 * `#/ui` — the trim composer (the operator, 2026-10-21: "the UI selection stuff should land behind
 * 'https://hadoku.me/cardtable/#/ui' not exposed to all players").
 *
 * Admin only, and linked from nowhere: anyone else who opens the hash is sent to the lobby. The tier
 * is the edge-stamped one `whoami` answers, so nothing a page could set. One choice per family,
 * saved on change into the play prefs (`trim`), so the page and every screen after redraw at once.
 */
import { useEffect } from 'react';
import { usePrefs } from '@wolffm/prefs-client/react';

import { getPlayPrefsClient } from '../play/live/prefs.ts';
import { useWhoami } from '../room/whoami.ts';
import { navigate } from '../screens/route.ts';
import { TRIM_FAMILIES, TRIM_FAMILY_IDS, type Trim } from './trim.ts';
import './trim-screen.css';

export function TrimScreen() {
  const who = useWhoami();
  const admin = who !== 'pending' && who !== null && who.tier === 'admin';
  useEffect(() => {
    if (who !== 'pending' && !admin) navigate({ kind: 'lobby' });
  }, [who, admin]);
  return admin ? <TrimComposer /> : null;
}

function TrimComposer() {
  const { prefs, save } = usePrefs(getPlayPrefsClient());
  const trim = prefs?.trim ?? {};
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
                void save({ trim: (value === '' ? rest : { ...rest, [family]: value }) as Trim });
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
