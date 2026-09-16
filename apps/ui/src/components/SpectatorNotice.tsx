/**
 * "You are spectating", said once, where a person will read it.
 *
 * ## Why a component for one sentence
 *
 * Because the alternative failure is specific and has a name. A spectator's
 * payload is structurally cardless — `ViewerView`'s spectator arm has no `pack`
 * and no `pool` at all (`packages/shared/src/draft.ts`) — so the draft screen
 * renders an empty pack area and no pool, which is CORRECT and looks exactly
 * like a draft that has broken. Someone watching a friend's pod would refresh,
 * then say the app is down.
 *
 * The status line already said it, buried in a sentence that also says how many
 * cards are in the pack. This says it as a labelled notice with its own testid,
 * so "a spectator payload renders with no cards and says so" is one assertion
 * rather than a substring match on a paragraph that changes.
 *
 * The wording names the reason, not just the state: the cards are not hidden by
 * this screen, they were never sent to this browser. That is the honest
 * description and it is the property `draft/hiddenInfo.ts` enforces over whole
 * serialised payloads.
 */

import './spectate.css';

export interface SpectatorNoticeProps {
  /** How many seats are at the table, for the sentence. */
  seatCount: number;
}

export function SpectatorNotice({ seatCount }: SpectatorNoticeProps) {
  return (
    <div className="spectate" data-testid="spectator-notice" role="note">
      <span className="spectate__tag">Spectating</span>
      <p className="spectate__text">
        You are watching this draft, not drafting in it. There is no pack and no pool
        because none was sent to this browser — a spectator&rsquo;s payload carries no
        cards at all. You can see all {seatCount} seats, whose turn it is, and how many
        cards each has taken.
      </p>
    </div>
  );
}
