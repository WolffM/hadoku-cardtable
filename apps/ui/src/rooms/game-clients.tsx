/*
 * The seam a room screen hands a game's own clients through: the room shell knows it has to
 * inject SOMETHING (a tables client, a feed, a transport factory, whatever the game's module
 * needs to talk to the server), but the SHAPE of that bundle is the game's own business, never
 * this file's. `platform`: this file names no game's own type. A game's module declares its own
 * clients interface and calls `useGameClients<ThatInterface>()`; the room shell that mounts it
 * provides the matching value with `<GameClientsProvider value={...}>`.
 *
 * One underlying React context, reused by every game type that wants this — not one context per
 * `T`, because nothing here needs to tell two games' providers apart; each game's own module is
 * the only thing that ever reads what it provided, under the type it asked for.
 */
import { createContext, useContext, type ReactNode } from 'react';

const GameClientsContext = createContext<unknown>(undefined);

export function GameClientsProvider<T>({ value, children }: { value: T; children: ReactNode }): ReactNode {
  return <GameClientsContext.Provider value={value}>{children}</GameClientsContext.Provider>;
}

/**
 * The clients the nearest `GameClientsProvider` above this component provided, typed as whatever
 * shape the caller names. Throws rather than hand back `undefined` silently: a game's `setup`/
 * `game` rendered outside the room shell that is supposed to wrap it is a wiring bug, not a state
 * to render through.
 */
export function useGameClients<T>(): T {
  const value = useContext(GameClientsContext);
  if (value === undefined) throw new Error('useGameClients: no room shell has provided its clients here');
  return value as T;
}
