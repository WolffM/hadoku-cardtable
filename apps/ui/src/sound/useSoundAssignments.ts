/*
 * The sound screens' one load: the catalogue and the assignments together, and the gate the
 * answer carries. `canView` answering at all is the friend gate, and nothing renders before
 * `loaded`; `canEdit` is the server's admin check.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SoundTake } from '@hadoku/shared';

import type { SoundsClient } from './builderClient.ts';

export function useSoundAssignments(client: SoundsClient) {
  const [loaded, setLoaded] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canView, setCanView] = useState(false);
  const [takes, setTakes] = useState<SoundTake[]>([]);
  const [cells, setCells] = useState<Record<string, string[]>>({});
  const [gains, setGains] = useState<Record<string, number>>({});

  const fetchAll = useCallback(async (alive: () => boolean = () => true): Promise<void> => {
    const [t, a] = await Promise.all([client.catalogue(), client.assignments()]);
    if (!alive()) return;
    setTakes(t);
    setCells(a.cells);
    setGains(a.gains);
    setCanEdit(a.canEdit);
    setCanView(a.canView);
    setLoaded(true);
  }, [client]);

  useEffect(() => {
    let alive = true;
    void fetchAll(() => alive);
    return () => {
      alive = false;
    };
  }, [fetchAll]);

  /** Fetch both again, after a change the server made beyond what this screen applied itself. */
  const reload = useCallback((): Promise<void> => fetchAll(), [fetchAll]);

  return { loaded, canEdit, canView, takes, setTakes, cells, setCells, gains, setGains, reload };
}
