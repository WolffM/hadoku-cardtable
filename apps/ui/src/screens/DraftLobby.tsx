/*
 * The draft room's lobby — who is here, who is ready, and the Ready toggle
 * that becomes the pod once everyone has pressed it.
 *
 * Moved out of `ConstructedScreen.tsx` by wave 72 §Q, unchanged (a pure move,
 * per the wave file's "Ordering, not sharing"): `ConstructedScreen` still
 * renders this for a draft room whose `draftStartedAt` is null, and nothing
 * about what it draws or how it behaves changed in the move. From here on
 * lane R owns this file, and wave 72 §R.1 is where the 8 pod seats arrive —
 * this is deliberately still the 2-or-fewer-member room lobby until then.
 */

import type { RoomMember } from '../rooms/api.ts';
import { StatusPill } from './ConstructedScreen.tsx';

export function DraftLobby({
  members,
  leaderId,
  iAmReady,
  allReady,
  dealing,
  busy,
  error,
  onReady,
  onRetry,
}: {
  members: RoomMember[];
  leaderId: string;
  iAmReady: boolean;
  allReady: boolean;
  dealing: boolean;
  busy: boolean;
  error: string | null;
  onReady: (ready: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <section className="lobby__card" data-testid="draft-lobby">
      <h2>In the room</h2>
      <ul className="draft__members" data-testid="draft-members">
        {members.length === 0 ? (
          <li className="draft__member draft__member--empty" data-testid="draft-nobody">
            Nobody has joined yet.
          </li>
        ) : (
          members.map((member, i) => (
            <li key={member.id} className="draft__member" data-testid={`draft-member-${i}`}>
              <strong className="tables__who">{member.name}</strong>
              {member.id === leaderId && leaderId !== '' && (
                <StatusPill
                  kind="leader"
                  testId={`draft-member-${i}-leader`}
                  state="leader"
                  mark="crown"
                  label="leader"
                />
              )}
              <StatusPill
                kind="ready"
                testId={`draft-member-${i}-ready`}
                state={member.ready ? 'yes' : 'no'}
                mark={member.ready ? 'tick' : 'ring'}
                label={member.ready ? 'ready' : 'not ready'}
              />
            </li>
          ))
        )}
      </ul>

      <p className="lobby__note" data-testid="draft-state">
        {draftStateText(members, dealing)}
      </p>

      <button
        type="button"
        className="lobby__go"
        data-testid="ready-toggle"
        aria-pressed={iAmReady}
        disabled={busy || dealing || members.length === 0}
        onClick={() => onReady(!iAmReady)}
      >
        {iAmReady ? 'Stand down' : 'Ready'}
      </button>

      {error !== null && (
        <div className="lobby__error" role="alert" data-testid="draft-error">
          <p>{error}</p>
          {/* Only while everyone still is ready: a refusal because somebody
              stood down in the meantime fixes itself when they ready again, and
              the deal is asked for on its own then. */}
          {allReady && (
            <button type="button" data-testid="draft-retry" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

      <p className="lobby__note" data-testid="draft-rule">
        The draft deals when every member of this room is ready. Bots take whatever is left of the eight
        seats at that moment — never before, so nobody who has not readied is played for.
      </p>
      <p className="lobby__note" data-testid="draft-restart-note">
        A draft does not survive a restart of the server. The room comes back to this lobby, with its ready
        marks, rather than to an empty table.
      </p>
    </section>
  );
}

/** Who the draft is waiting on, in one line. Names, because none of them is "you". */
function draftStateText(members: RoomMember[], dealing: boolean): string {
  if (dealing) return 'Dealing the draft…';
  if (members.length === 0) return 'Waiting for someone to join.';
  const waiting = members.filter((m) => !m.ready).map((m) => m.name);
  if (waiting.length === 0) return 'Everyone is ready.';
  return `Waiting for ${listOf(waiting)}.`;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
