/*
 * `#/inventory` — the imported cubes, managed (AF305 §B). The operator,
 * 2026-10-22, on finding Refresh and Delete on a room's own cube card: "when
 * i'm in a room i wouldn't want to mess with the refresh state of the cube
 * … i would prefer if there was an 'inventory' button next to the 'my decks'
 * button where things like this can be handled." So cube MANAGEMENT moved
 * here, off the room's own picker (`PoolPicker.tsx`'s `CubeRow` is now just
 * art, name and a count — a choice, not a panel).
 *
 * Shortlist cubes are not listed here: they are `build-pool`'s own generated
 * output, read-only everywhere, including here. Only an IMPORTED (Cube
 * Cobra) cube has a refresh state or an owner to manage.
 *
 * Mirrors `DecksScreen.tsx`'s own chrome (`.shell.shell--fit`, the back link,
 * `.lobby.lobby--room` > `.lobby__card`) rather than inventing a second shell.
 */

import { useEffect, useState } from 'react';

import type { CubeListing, ImportCubeBody } from '@hadoku/shared';

import { cardsCount } from '../draft/PoolPicker.tsx';
import { CubeArt } from '../draft/CubeArt.tsx';
import { ImportCube } from '../draft/ImportCube.tsx';
import { poolsClient, type PoolsClient } from '../rooms/api.ts';
import { latestReads } from '../rooms/latest.ts';
import { HomeHead } from './HomeHead.tsx';
import { useChromeShell } from '@hadoku/ui-shell/chrome/shell';
import './InventoryScreen.css';
import '@hadoku/game-ui/components/Button.css';

const defaultPools = poolsClient();

/** "3 minutes ago", "4 hours ago", "5 days ago" — never the raw ISO string. `null` reads as "just now". */
function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '';
  const ms = now - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function InventoryCard({
  cube,
  busy,
  onRefresh,
  onDelete,
}: {
  cube: CubeListing;
  busy: boolean;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="inventory__card" data-testid={`inventory-cube-${cube.id}`}>
      <CubeArt artId={cube.artId} name={cube.name} />
      <div className="inventory__body">
        <span className="inventory__name">{cube.name}</span>
        <span className="inventory__meta" data-testid={`inventory-meta-${cube.id}`}>
          {cardsCount(cube.size)}
          {cube.importerName !== null ? ` · ${cube.importerName}` : ''}
          {cube.refreshedAt !== null ? ` · refreshed ${relativeTime(cube.refreshedAt)}` : ''}
        </span>
        <span className="inventory__actions">
          {cube.origin === 'cubecobra' && (
            <button type="button" className="inventory__action ct-action" data-testid={`inventory-refresh-${cube.id}`} disabled={busy} onClick={() => onRefresh(cube.id)}>
              Refresh
            </button>
          )}
          {cube.mine && (
            <button type="button" className="inventory__action ct-action" data-testid={`inventory-delete-${cube.id}`} disabled={busy} onClick={() => onDelete(cube.id)}>
              Delete
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function InventoryScreen({ pools = defaultPools }: { pools?: PoolsClient }) {
  const shellRef = useChromeShell('fit');
  const [cubes, setCubes] = useState<CubeListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The list's reads, latest-wins (`../rooms/latest.ts`): every write is followed by a fresh read, so a read is kept or dropped. */
  const [reads] = useState(latestReads);
  const load = (): void => {
    const landed = reads.read();
    pools.listCubes().then(
      (list) => {
        if (landed() !== 'keep') return;
        setCubes(list.filter((c) => c.origin !== 'shortlist'));
        setError(null);
      },
      (e: unknown) => {
        if (landed() === 'keep') setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  useEffect(() => void load(), []);

  const withWrite = (call: () => Promise<{ ok: true } | { ok: false; message: string }>): void => {
    setBusy(true);
    call().then((r) => {
      setBusy(false);
      if (r.ok) load();
      else setError(r.message);
    });
  };
  const importCube = (source: ImportCubeBody): void => withWrite(() => pools.importCube(source));
  const refreshCube = (id: string): void => withWrite(() => pools.refreshCube(id));
  const deleteCube = (id: string): void => withWrite(() => pools.deleteCube(id));

  return (
    <div ref={shellRef} className="shell shell--fit" data-testid="inventory">
      <HomeHead title="Inventory" />
      <main className="lobby lobby--room">
        {error !== null && (
          <p className="ct-error" role="alert" data-testid="inventory-error">
            {error}
          </p>
        )}
        <section className="lobby__card">
          <div className="inventory__gallery">
            {cubes?.map((cube) => (
              <InventoryCard key={cube.id} cube={cube} busy={busy} onRefresh={refreshCube} onDelete={deleteCube} />
            ))}
            <ImportCube busy={busy} onImport={importCube} />
          </div>
        </section>
      </main>
    </div>
  );
}
