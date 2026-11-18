/*
 * The room a game's embed plays in, inside a host's room (watchparty's game slot).
 *
 * The game's own server answers which of its rooms a host room plays in (`POST /api/rooms/watchparty`,
 * `@hadoku/game-server`'s room-core route), deriving it from the host's room id, so every member's
 * bundle lands at the same table without any of them choosing it. The host's room id is opaque here:
 * the server hashes it, so its shape need not fit a game's room-id rules.
 *
 * A host that runs the match itself (a `MatchChannel` in the bundle context) needs no binding: its
 * room key IS the room (`skip`).
 */

import { useEffect, useState } from 'react';
import type { HadokuThemeValue } from '@wolffm/themes';
import { THEME_FAMILIES } from '@wolffm/themes';
import { ROOM_ID_RE } from '@hadoku/platform-wire/room-feed';

import { apiUrl, bodyOf, isRecord, pageFetch, sendJson, serverMessage, type Fetch } from '../http.ts';

export type BindOutcome = { ok: true; roomId: string } | { ok: false; message: string };

/** Which of this game's rooms a host room plays in. Never throws: a failure is an outcome the embed renders. */
export type BindRoom = (hostRoom: string) => Promise<BindOutcome>;

/** The game server's own answer, over `fetchImpl`. */
export function bindWatchpartyRoom(fetchImpl: Fetch = pageFetch): BindRoom {
  return async (hostRoom) => {
    let res: Response;
    try {
      res = await sendJson(apiUrl('rooms/watchparty'), 'POST', { room: hostRoom }, fetchImpl);
    } catch {
      return { ok: false, message: 'Could not reach the server.' };
    }
    const body = await bodyOf(res);
    if (!res.ok) return { ok: false, message: `Could not open this room’s table: ${serverMessage(body, res.status)}.` };
    const roomId = isRecord(body) ? body.id : undefined;
    if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) return { ok: false, message: 'The server answered with something that is not a room.' };
    return { ok: true, roomId };
  };
}

export type Binding = { state: 'binding' } | { state: 'bound'; roomId: string } | { state: 'failed'; message: string };

/**
 * The room `hostRoom` plays in, asked of `bind` whenever `hostRoom` changes. With `skip` the host's
 * room key IS the room: `bind` is never called, and the answer is derived rather than stored, so it
 * cannot drift from `skip` or `hostRoom` changing.
 */
export function useBoundRoom(hostRoom: string, bind: BindRoom, skip = false): Binding {
  const [binding, setBinding] = useState<Binding>({ state: 'binding' });
  useEffect(() => {
    if (skip) return;
    let live = true;
    setBinding({ state: 'binding' });
    void bind(hostRoom).then((outcome) => {
      if (!live) return;
      setBinding(outcome.ok ? { state: 'bound', roomId: outcome.roomId } : { state: 'failed', message: outcome.message });
    });
    return () => {
      live = false;
    };
  }, [hostRoom, bind, skip]);
  return skip ? { state: 'bound', roomId: hostRoom } : binding;
}

/**
 * A route that is not the bound room goes to it: `go` is the game's own navigation. An effect,
 * never a write during render. `go` should be stable (a module-level function).
 */
export function ToRoom({ roomId, go }: { roomId: string; go: (roomId: string) => void }) {
  useEffect(() => {
    go(roomId);
  }, [roomId, go]);
  return null;
}

/** Whether a fleet theme name is one of the dark ones. */
export function isDarkThemeName(theme: string): boolean {
  return theme === 'dark' || theme.endsWith('-dark');
}

/**
 * The theme context for a tree whose theme is the HOST's: anything below reading `useHadokuTheme()`
 * reads the host's theme rather than throwing. Changing it is the host's, so `setTheme` is inert and
 * there is no picker.
 */
export function hostThemeValue(theme: string): HadokuThemeValue {
  return {
    theme,
    setTheme: () => undefined,
    themeFamilies: [...THEME_FAMILIES],
    getThemeIcon: () => null,
    isDarkTheme: isDarkThemeName(theme),
    isThemeReady: true,
    isInitialThemeLoad: false,
  };
}
