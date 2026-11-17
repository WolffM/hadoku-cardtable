/*
 * L3a, shared: the seat chip — one seat's own avatar, name, ready ring, leader crown and actions
 * (sit, bot on/off, close/open) — lifted from `games/magic/ui/src/screens/pod/PodSeats.tsx`
 * (wave 119 §U). Platform: knows nothing of a draft pod, a Magic match or any other game's own
 * seat semantics — the caller classifies each seat into a `SeatOccupant` first (Magic's own
 * `PodSeats.tsx` still owns that classification, reading `isPodAi`/`POD_CLOSED` from its own
 * `./wire.ts`; a future game classifies its own seats the same way, into the same four shapes).
 *
 * `PodSeats.tsx` keeps its own markup's every class name and `data-testid` — `pod-seats`,
 * `pod-seats__seat`, `pod-seat-<n>`, … — unchanged: cardtable's existing CSS (`PodSeats.css`) and
 * its own extensive DOM-contract tests (`PodSeats.test.ts`) both key off them, and the DOM a
 * caller already had must stay byte-identical after this lift (wave 119 §U.2's own "done when").
 * A future caller styling this chip under a different block name does so with its own CSS; this
 * file draws the shapes, never the paint.
 */

import { ActionButton } from '../components/ActionButton.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { PlayerName } from '../room/look.tsx';
import { StatusPill } from '../components/StatusPill.tsx';
import type { Look } from '@hadoku/platform-wire/look';

/** The same crown `magic-room-ui.tsx` draws for its own direct uses — duplicated, not imported, so this file pulls in nothing of Magic's. */
export const SEAT_CROWN_PATH = 'M2 9V3.5l2.2 2L6 2.6l1.8 2.9L10 3.5V9Z';

/**
 * What one seat holds, already classified by the caller: nobody (open), the room's leader closed
 * it, the game's own bot, or a real member. A caller with no bot or close concept at all simply
 * never produces those two kinds.
 */
export type SeatOccupant =
  | { kind: 'open' }
  | { kind: 'closed' }
  | { kind: 'bot'; name: string; avatarId?: string }
  | { kind: 'member'; id: string; name: string; avatarId?: string; look?: Look; ready: boolean; leader: boolean; mine: boolean };

export interface SeatSlot {
  seat: number;
  occupant: SeatOccupant;
}

export interface SeatListProps {
  slots: readonly SeatSlot[];
  /**
   * Whether the viewer leads the room: gates every seat-shaping control — AI/Remove-AI on an open
   * or bot-held seat, Close/Open, and Remove/Bot on a member's seat — and an open seat's Close
   * past `realSeatCount`. Before this field gated AI and Remove-AI too, bm1 saw the AI button
   * offered to, and clickable by, a non-leader (a no-op server-side, but a control nobody but the
   * leader should ever see at all — Close/Open and the member Remove/Bot were already gated).
   */
  iLead: boolean;
  /** An event's room before its seats open: nobody sits, nor gives a seat to the bot. */
  shut?: boolean;
  /** A fixed field (a Challenge's): no seat is grown, given to the bot, taken from it or closed. */
  fieldFixed?: boolean;
  /** How many of `slots` are seats the room has today — the rest are one caller-grown "+1" slot. An open seat at or past this index offers Sit to nobody already seated, and Close to nobody at all. */
  realSeatCount: number;
  /** The viewer's own seat index, or null before they sit. */
  mySeat: number | null;
  onSit?: (seat: number) => void;
  onBotOn?: (seat: number) => void;
  onBotOff?: (seat: number) => void;
  onCloseSeat?: (seat: number) => void;
  onOpenSeat?: (seat: number) => void;
  /**
   * The leader removes a SEATED human (never a bot — that is `onBotOff`), landing them a
   * spectator (`rooms-protocol`'s seat op, wave 119 §P/§S, wave 120 §S2's wiring). Absent: no
   * Remove button is drawn on anyone's seat, which keeps a caller wired only up to
   * `onCloseSeat`/`onBotOn` (today's `PodSeats.tsx`) byte-identical to before this lift. Gated on
   * `iLead` same as Close/Open, and never offered on the viewer's own seat (`occupant.mine`):
   * standing is `onSit` elsewhere, not a self-removal.
   */
  onRemoveMember?: (seat: number, memberId: string) => void;
  /**
   * The leader puts the bot in a SEATED human's place, in one action (wave 120 §S2) — the
   * generic `seats/bot` op, addressed by seat; distinct from `onBotOn`, which only ever offers
   * the bot an OPEN seat (today's one add-bot affordance for an empty one). Absent: no Bot
   * button is drawn on a member's seat. Gated on `iLead`, never offered on the viewer's own seat.
   */
  onBotReplace?: (seat: number, memberId: string) => void;
}

/** A strip of seats, one `<li>` each: dashed-open / "×"-closed / the bot's own look / a member's avatar, a label underneath, every action its own always-visible button. */
export function SeatList({ slots, iLead, shut = false, fieldFixed = false, realSeatCount, mySeat, onSit, onBotOn, onBotOff, onCloseSeat, onOpenSeat, onRemoveMember, onBotReplace }: SeatListProps) {
  return (
    <ul className="pod-seats" data-testid="pod-seats">
      {slots.map(({ seat, occupant }) => {
        if (occupant.kind === 'open') {
          return (
            <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`}>
              <ActionButton
                action="sit"
                className="pod-seats__avatar pod-seats__avatar--open"
                data-testid="pod-seat-sit"
                data-seat={seat}
                aria-label={`Sit in seat ${seat + 1}`}
                disabled={shut || (mySeat !== null && seat >= realSeatCount)}
                onPress={() => onSit?.(seat)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </ActionButton>
              <span className="pod-seats__label">Open</span>
              {!fieldFixed && iLead && (
                <span className="pod-seats__actions">
                  <ActionButton action="ai" className="pod-seats__action" data-testid="pod-seat-ai" data-seat={seat} aria-label={`Fill seat ${seat + 1} with AI`} disabled={shut} onPress={() => onBotOn?.(seat)}>
                    AI
                  </ActionButton>
                  {seat < realSeatCount && (
                    <ActionButton action="close" className="pod-seats__action" data-testid="pod-seat-close" data-seat={seat} aria-label={`Close seat ${seat + 1}`} onPress={() => onCloseSeat?.(seat)}>
                      Close
                    </ActionButton>
                  )}
                </span>
              )}
            </li>
          );
        }
        if (occupant.kind === 'closed') {
          return (
            <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`} data-closed="">
              <span className="pod-seats__avatar pod-seats__avatar--closed" aria-hidden="true">
                ×
              </span>
              <span className="pod-seats__label">Closed</span>
              {iLead && (
                <span className="pod-seats__actions">
                  <ActionButton action="open" className="pod-seats__action" data-testid="pod-seat-open" data-seat={seat} aria-label={`Open seat ${seat + 1}`} onPress={() => onOpenSeat?.(seat)}>
                    Open
                  </ActionButton>
                </span>
              )}
            </li>
          );
        }
        if (occupant.kind === 'bot') {
          return (
            <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`} data-ai="">
              <span className="pod-seats__avatar pod-seats__avatar--ai">
                {/* The seat's own character; the mark only for a server that sends none. */}
                <Avatar id={occupant.avatarId} fallback="mark" className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
              </span>
              <span className="pod-seats__label">{occupant.name}</span>
              {!fieldFixed && iLead && (
                <span className="pod-seats__actions">
                  <ActionButton action="ai-remove" className="pod-seats__action" data-testid="pod-seat-ai-remove" data-seat={seat} aria-label={`Remove AI from seat ${seat + 1}`} onPress={() => onBotOff?.(seat)}>
                    Remove
                  </ActionButton>
                </span>
              )}
            </li>
          );
        }
        const { id, name, avatarId, look, ready, leader, mine } = occupant;
        const face = { id: avatarId ?? null, look };
        return (
          <li key={seat} className="pod-seats__seat" data-testid={`pod-seat-${seat}`} data-mine={mine ? '' : undefined}>
            <span className="pod-seats__avatar-wrap">
              <span className="pod-seats__avatar" data-ready={ready ? 'true' : 'false'}>
                <Avatar {...face} fallback="initial" name={name} className="pod-seats__avatar-img" fallbackClassName="pod-seats__avatar-fallback" />
              </span>
              {leader && (
                <svg className="pod-seats__crown" data-testid={`pod-seat-${seat}-leader`} viewBox="0 0 12 12" role="img" aria-label="Room owner">
                  <title>Room owner</title>
                  <path d={SEAT_CROWN_PATH} />
                </svg>
              )}
            </span>
            <PlayerName name={name} face={face} className="pod-seats__label" />
            <StatusPill testId={`pod-seat-${seat}-ready`} state={ready ? 'yes' : 'no'} mark={ready ? 'tick' : 'ring'} label={ready ? 'ready' : 'not ready'} />
            {iLead && !mine && (onRemoveMember !== undefined || onBotReplace !== undefined) && (
              <span className="pod-seats__actions">
                {onRemoveMember !== undefined && (
                  <ActionButton action="remove" className="pod-seats__action" data-testid="pod-seat-remove" data-seat={seat} aria-label={`Remove ${name} from the table`} onPress={() => onRemoveMember(seat, id)}>
                    Remove
                  </ActionButton>
                )}
                {onBotReplace !== undefined && (
                  <ActionButton action="bot-replace" className="pod-seats__action" data-testid="pod-seat-bot-replace" data-seat={seat} aria-label={`Put the bot in ${name}'s seat`} onPress={() => onBotReplace(seat, id)}>
                    Bot
                  </ActionButton>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
