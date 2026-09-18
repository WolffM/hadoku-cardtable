/*
 * `tempShowZones` and `openZones` — the two asks nobody answers by hand.
 *
 * Both block, but neither is a question for the player: Forge is asking the
 * GUI to open some zones and tell it which ones it opened, so that
 * `hideZones` / `restoreOldZones` can close exactly those later. Forge's
 * desktop answers them immediately (`CMatchUI.java:584-609,1362-1381`), and so
 * do these — on mount, once, with the zones `rules.ts` says this client shows.
 * What they draw is the notice that those zones are open.
 *
 * "Once" is held by a ref rather than trusted to the effect: React runs effects
 * twice under StrictMode in development, and a second reply to one `callId` is
 * a protocol error on the bridge.
 */

import { useEffect, useRef } from 'react';

import { PromptShell } from './PromptShell.tsx';
import { refName, type PromptLookup } from './lookup.ts';
import { zoneReplyProblems, zonesOpened, zonesShown } from './rules.ts';
import { assertAnswerable, checkedReply, type PromptMethod, type PromptProps, type ReplyOf } from './types.ts';

type ZoneUpdates = ReplyOf<'tempShowZones'>;

function useAnswerOnce(answer: () => void) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    answer();
    // Empty deps on purpose: the ask is fixed for this mount, and answering
    // again on a later render would be the double reply this hook prevents.
  }, []);
}

function OpenZonesNotice({
  method,
  updates,
  lookup,
}: {
  method: PromptMethod;
  updates: ZoneUpdates;
  lookup: PromptLookup;
}) {
  return (
    <PromptShell method={method} title="Zones opened">
      {updates.length === 0 ? (
        <p className="prompt__hint" data-testid="prompt-zones-none">
          Nothing extra to show.
        </p>
      ) : (
        <ul className="prompt__list" data-testid="prompt-zones">
          {updates.map((u) => (
            <li key={u.player.id}>
              {refName(lookup, u.player)}: {u.zones.join(', ')}
            </li>
          ))}
        </ul>
      )}
    </PromptShell>
  );
}

export function TempShowZonesPrompt({ ask, onAnswer, lookup }: PromptProps<'tempShowZones'>) {
  const shown = zonesShown(ask.controller.id, ask.zonesToUpdate);
  useAnswerOnce(() => {
    assertAnswerable('tempShowZones', zoneReplyProblems(ask.zonesToUpdate, shown));
    onAnswer(checkedReply('tempShowZones', shown));
  });
  return <OpenZonesNotice method="tempShowZones" updates={shown} lookup={lookup} />;
}

export function OpenZonesPrompt({ ask, onAnswer, lookup }: PromptProps<'openZones'>) {
  const opened = zonesOpened(ask);
  const requested = ask.players.map((player) => ({ player, zones: [...ask.zones] }));
  useAnswerOnce(() => {
    assertAnswerable('openZones', zoneReplyProblems(requested, opened));
    onAnswer(checkedReply('openZones', opened));
  });
  return <OpenZonesNotice method="openZones" updates={opened} lookup={lookup} />;
}
