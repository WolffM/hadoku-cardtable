/*
 * The cubes and sets a person starred (wave 127 §D), as the galleries hold them: read from their
 * own document on the server (`PoolsClient.poolFavourites`, `GET /api/me/library`), never from the
 * browser's storage, and changed one star at a time (`setPoolFavourite`,
 * `PUT /api/me/pool-favourites/:poolKey`).
 *
 * A star shows at once, then the server's answer is what stands; a refused star is taken back,
 * with the server's reason. A library that cannot be read leaves every pool unstarred and the
 * gallery still draws: a star is a garnish on a choice, never a reason the choice is missing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PoolKey } from '@hadoku/shared';

import { poolsClient, type PoolsClient } from '../rooms/api.ts';

export type PoolFavouritesClient = Pick<PoolsClient, 'poolFavourites' | 'setPoolFavourite'>;

export interface PoolFavourites {
  favourites: ReadonlySet<string>;
  toggle(poolKey: PoolKey): void;
  /** Why the last star did not hold, until the next one is pressed. */
  error: string | null;
}

const defaultClient = poolsClient();

/** The caller's starred pools, read once when the gallery mounts. */
export function usePoolFavourites(client: PoolFavouritesClient = defaultClient): PoolFavourites {
  const [favourites, setFavourites] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // `async` so a client that throws at once is read as one that could not answer.
    (async () => client.poolFavourites())().then(
      (keys) => {
        if (live) setFavourites(keys);
      },
      (err: unknown) => {
        // The gallery draws without stars, as the Library draws a deck at 0–0 without the stats service.
        console.warn('[cardtable] starred pools are unavailable', err);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const toggle = useCallback(
    (poolKey: PoolKey): void => {
      const on = !favourites.has(poolKey);
      const flip = (to: boolean) => (held: ReadonlySet<string>) => {
        const next = new Set(held);
        if (to) next.add(poolKey);
        else next.delete(poolKey);
        return next;
      };
      setError(null);
      setFavourites(flip(on));
      const undo = (message: string): void => {
        setFavourites(flip(!on));
        setError(message);
      };
      (async () => client.setPoolFavourite(poolKey, on))().then(
        (r) => {
          if (r.ok) setFavourites(r.poolFavourites);
          else undo(r.message);
        },
        (err: unknown) => undo(err instanceof Error ? err.message : String(err)),
      );
    },
    [client, favourites],
  );

  return useMemo(() => ({ favourites, toggle, error }), [favourites, toggle, error]);
}
