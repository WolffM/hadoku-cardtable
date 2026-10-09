/*
 * A reveal Forge has already been answered for, drawn as what it is: the
 * revealed cards, on both screens, for a moment — never a question. The
 * operator, 2026-10-09, on Dark Confidant's top card: *"why is it necessary for
 * this to require an 'ok' press at all?"*
 *
 * It holds no button and takes no slot a decision uses: it is not a
 * `.live__prompt`, so the inspector enlarges its tiles the way it does the
 * board's (one expanded card view), and nothing that gates on an open question
 * sees it. It goes when its time runs out, when the seat's next real decision
 * replaces it (`../live/match.ts`), or on a click — whichever is first. The
 * time stands still while the pointer is on it, so a card being read does not
 * vanish under the inspector.
 */

import { useEffect, useEffectEvent, useState } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { nameFromForgeLabel, promptTileFor } from './PromptShell.tsx';
import type { PromptLookup } from './lookup.ts';
import { RulesText } from './RulesText.tsx';
import type { AskOf } from './types.ts';

/** How long a reveal stays up when nothing else takes its place. */
export const REVEAL_NOTICE_MS = 4000;

export function RevealNotice({ reveal, lookup, onDone }: { reveal: AskOf<'getChoices'>; lookup: PromptLookup; onDone: () => void }) {
  const [held, setHeld] = useState(false);
  // The board re-renders on every frame and hands a fresh `onDone` each time;
  // the clock belongs to this reveal, not to the latest render.
  const expire = useEffectEvent(onDone);
  useEffect(() => {
    if (held) return undefined;
    const timer = setTimeout(() => expire(), REVEAL_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [held, reveal.callId]);

  return (
    <div
      className="reveal-notice"
      data-testid="live-reveal"
      data-call-id={reveal.callId}
      role="status"
      onClick={onDone}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
    >
      <ul className="reveal-notice__cards">
        {reveal.choices.map((c) =>
          c.ref?.kind === 'card' ? (
            <li key={c.key} data-card-id={c.ref.id}>
              <CardTile card={promptTileFor(lookup, c.ref.id, nameFromForgeLabel(c.label, c.ref.id))} />
            </li>
          ) : (
            <li key={c.key}>
              <RulesText text={c.label} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
