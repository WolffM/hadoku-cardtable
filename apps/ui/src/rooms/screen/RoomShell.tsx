/*
 * The room screen's own chrome: the shell, the title, the header's tool row, the streamed/builtin
 * split, the password gate, and the one message a room that could not be read gets. Every room
 * has this, whatever it plays — a game type's own content is a slot (`children`), never something
 * this file knows the shape of.
 *
 * Nothing here is Magic's: no deck, no mode, no table. What a game type puts in the header
 * (Magic's own settings panel, say) arrives already built, as `headerTools`; what it puts in the
 * room's body arrives as `children`, rendered only once `resolved` is true and the room is not
 * streamed — a streamed room draws `streamedBody` instead, and neither draws until the room record
 * has answered.
 */
import type { ReactNode, RefCallback } from 'react';

export interface RoomShellProps {
  shellRef: RefCallback<HTMLElement>;
  /** `view.members.length` once the room record has one; the room screen's own `data-members`. */
  dataMembers: number | undefined;
  /** The room's own name, once either read has it. */
  roomTitle: string | undefined;
  /** The room answered with a refusal rather than useful data: nothing more to wait for, so the
   * title falls back to "Room" instead of staying a skeleton. */
  settled: boolean;
  /** Close, Settings, and whatever the game type's own settings panel wants beside them. */
  headerTools: ReactNode;
  streamed: boolean;
  /** A streamed room says so under its name; absent for a builtin one. */
  streamedSubLine: ReactNode;
  /** The room record has answered, success or failure. */
  resolved: boolean;
  /** Neither read has answered enough to draw anything real yet. */
  pending: boolean;
  /** What a loading room draws while `pending`. */
  pendingBody: ReactNode;
  /** A streamed room's own body — one container per seat, each a stream. */
  streamedBody: ReactNode;
  locked: 'need' | 'wrong' | 'rate-limited' | null;
  password: string;
  onPasswordChange: (value: string) => void;
  onPasswordSubmit: () => void;
  /** The table could not be read at all, and no password prompt is standing between here and it. */
  roomMissingMessage: string | null;
  /** The game type's own content: its setup, its game, in that order. */
  children: ReactNode;
}

export function RoomShell({
  shellRef,
  dataMembers,
  roomTitle,
  settled,
  headerTools,
  streamed,
  streamedSubLine,
  resolved,
  pending,
  pendingBody,
  streamedBody,
  locked,
  password,
  onPasswordChange,
  onPasswordSubmit,
  roomMissingMessage,
  children,
}: RoomShellProps) {
  return (
    <div ref={shellRef} className="shell shell--fit" data-testid="constructed" data-members={dataMembers}>
      <header className="shell__head">
        {/* The room's own name, never its id: until the room has answered, a
            skeleton line where the name will be. */}
        {roomTitle !== undefined ? (
          <h1 className="shell__title" data-testid="room-name">
            {roomTitle}
          </h1>
        ) : settled ? (
          <h1 className="shell__title">Room</h1>
        ) : (
          <span className="skeleton skeleton--title" />
        )}
        <div className="shell__tools">{headerTools}</div>
        {resolved && streamed && streamedSubLine}
      </header>

      <main className="lobby lobby--room" aria-busy={pending ? 'true' : undefined}>
        {pending && pendingBody}
        {streamed && streamedBody}
        {/* Everything below is the builtin room. It waits for the room record as well as the
            table so a streamed room never flashes a deck picker on its way in; both reads are in
            flight together, so this is not a second round trip. */}
        {!streamed && resolved && (
          <>
            {locked !== null && (
              <form
                className="lobby__locked ct-panel"
                data-testid="room-locked"
                onSubmit={(e) => {
                  e.preventDefault();
                  onPasswordSubmit();
                }}
              >
                <p role="alert">
                  {locked === 'need' ? 'This room needs a password.' : locked === 'wrong' ? 'Wrong password.' : 'Too many attempts.'}
                </p>
                <label htmlFor="room-password">Password</label>
                <input
                  id="room-password"
                  data-testid="room-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                />
                <button type="submit" data-testid="room-password-submit" disabled={locked === 'rate-limited'}>
                  Join
                </button>
              </form>
            )}
            {locked === null && roomMissingMessage !== null && (
              <p className="ct-error" role="alert" data-testid="room-missing">
                {roomMissingMessage}
              </p>
            )}
            {children}
          </>
        )}
      </main>
    </div>
  );
}
