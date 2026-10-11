/*
 * A reveal Forge has already been answered for, drawn as what it is: the
 * revealed cards, never a question. Nothing waits on it — the game has moved
 * on before it draws (the operator, 2026-10-09, on Dark Confidant's top card:
 * *"why is it necessary for this to require an 'ok' press at all?"*).
 *
 * It stays until the seat has seen it: its OK closes it, and nothing is sent
 * (the operator, 2026-10-10, on Ghost Quarter's fail to find, a whole library
 * shown: *"i would expect at least some kind of decision to be there like
 * 'cancel' or 'ok' to acknowledge it"*). A clock would take a forty-card
 * library away mid-read. The seat's next real decision still takes its place
 * (`../live/match.ts`).
 *
 * It is not a `.live__prompt`, so the inspector enlarges its tiles the way it
 * does the board's (one expanded card view), and nothing that gates on an
 * open question sees it. Its cards scroll inside it; the box never runs off
 * the table.
 *
 * Its cards are drawn as they were when it was shown. The lookup can lose a
 * revealed card while the notice is up, and a tile rebuilt from it then lost
 * its printing: the art turned into another printing's under the seat's eyes
 * (prompts.jvm's reveal, a TRK Forest redrawn as SOI's).
 */

import { useState } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { nameFromForgeLabel, promptTileFor } from './PromptShell.tsx';
import type { PromptLookup } from './lookup.ts';
import { RulesText } from './RulesText.tsx';
import type { AskOf } from './types.ts';

export function RevealNotice({ reveal, lookup, onDone }: { reveal: AskOf<'getChoices'>; lookup: PromptLookup; onDone: () => void }) {
  const [rows] = useState(() =>
    reveal.choices.map((c) => ({
      key: c.key,
      label: c.label,
      card: c.ref?.kind === 'card' ? { id: c.ref.id, tile: promptTileFor(lookup, c.ref.id, nameFromForgeLabel(c.label, c.ref.id)) } : null,
    })),
  );
  return (
    <div className="reveal-notice" data-testid="live-reveal" data-call-id={reveal.callId} role="status">
      <ul className="reveal-notice__cards">
        {rows.map((c) =>
          c.card !== null ? (
            <li key={c.key} data-card-id={c.card.id}>
              <CardTile card={c.card.tile} />
            </li>
          ) : (
            <li key={c.key}>
              <RulesText text={c.label} />
            </li>
          ),
        )}
      </ul>
      <button type="button" className="prompt__submit" data-testid="live-reveal-ok" onClick={onDone}>
        OK
      </button>
    </div>
  );
}
