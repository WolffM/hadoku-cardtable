/*
 * The hop that carries a viewer's watchparty character onto their row in our
 * room. Mounted by the standalone `RoomShell` and, since 2026-10-12, by the
 * watchparty embed (`EmbedApp`) — the embed renders no `RoomShell`, so until
 * then nobody in a watchparty room ever asserted an avatar and every member
 * wore the one `room/lobby.ts`'s pool handed them on joining ("cardtable did
 * not properly load avatars, it assigned default ones").
 */

import { useEffect } from 'react';

import { accountAvatarId, selectedAvatarId } from './avatar.ts';
import { watchAvatar } from './avatarWatch.ts';
import type { RoomIdentityClient } from '../rooms/api.ts';

/**
 * Tell our own room which avatar this viewer is wearing, once per room.
 *
 * This is the hop the operator's *"why not?"* was about. The id is watchparty's,
 * read from their prefs cache (`avatar.ts` says why there is no accessor to ask);
 * the row it lands on is decided by the server from the edge's headers, so this
 * can only ever set the caller's own.
 *
 * **A refusal is ignored, deliberately.** `roomId` here is whatever the route
 * carries, which for `#/match/<id>` is a MATCH id. The server resolves that to
 * the lobby room that started the match (`roomOfMatch`); it used to answer 404
 * for both players at every match start (wave 31 P3b). A viewer with no avatar sends nothing at all and keeps the
 * character the room handed them on joining; the server's "clear it"
 * case exists for a viewer who HAD one and dropped it, which only the chrome can
 * tell us about, and it cannot yet.
 */
export function useAvatarAssert(roomId: string | null, userId: string | null, client: RoomIdentityClient): void {
  useEffect(() => {
    if (roomId === null || userId === null) return;
    let live = true;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (avatarId: string, n: number, mine: number = generation): void => {
      // A refusal is the server saying this viewer is not in that room YET: a
      // joiner's first screen asserts before the room screen has joined them,
      // and an avatar that never lands is a seat with no face when the match
      // starts. Try again a few times, then give up; it is a cosmetic.
      const retry = (): void => {
        const delay = AVATAR_RETRY_MS[n];
        if (live && mine === generation && delay !== undefined) timer = setTimeout(() => attempt(avatarId, n + 1, mine), delay);
      };
      // `setAvatar` resolves an outcome rather than rejecting on a refusal.
      client.setAvatar(roomId, avatarId).then((outcome) => {
        if (!outcome.ok) retry();
      }, retry);
    };
    // Watched, not read once: a pick made in watchparty's chrome while the match
    // is open must reach the board (Q6). A newer id supersedes an older id's retries.
    const stop = watchAvatar({
      readAccount: () => accountAvatarId(userId),
      readCache: () => selectedAvatarId(userId),
      assert: (avatarId) => {
        clearTimeout(timer);
        generation += 1;
        attempt(avatarId, 0);
      },
    });
    return () => {
      live = false;
      stop();
      clearTimeout(timer);
    };
  }, [roomId, userId, client]);
}

/** Waits between re-asserts after a refusal: the joiner's first screen can beat their own join. */
const AVATAR_RETRY_MS = [1500, 3000, 6000, 12000] as const;
