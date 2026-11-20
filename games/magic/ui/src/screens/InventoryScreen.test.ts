// @vitest-environment jsdom
/*
 * `#/inventory` (AF305 §B): the imported cubes, managed — refresh (any
 * friend), delete (the importer only), import — moved off the room's own
 * picker per the operator: "when i'm in a room i wouldn't want to mess with
 * the refresh state of the cube… i would prefer if there was an 'inventory'
 * button". Shortlist cubes are listed nowhere here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CubeListing } from '@hadoku/shared';

import { InventoryScreen } from './InventoryScreen.tsx';
import { currentRoute } from '@hadoku/game-ui/screens/route.ts';
import type { PoolsClient } from '../rooms/api.ts';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const cube = (over: Partial<CubeListing> = {}): CubeListing => ({
  id: 'cc-mine',
  name: 'My import',
  size: 100,
  origin: 'cubecobra',
  cubeCobraId: 'mine',
  importedBy: 'u-me',
  importedAt: new Date().toISOString(),
  refreshedAt: null,
  verdict: null,
  artId: null,
  importerName: 'Me',
  mine: true,
  ...over,
});

const shortlistCube = (over: Partial<CubeListing> = {}): CubeListing => ({
  id: 'vintage',
  name: 'A shortlist cube',
  size: 540,
  origin: 'shortlist',
  cubeCobraId: null,
  importedBy: null,
  importedAt: null,
  refreshedAt: null,
  verdict: null,
  artId: null,
  importerName: null,
  mine: false,
  ...over,
});

function stubPools(over: Partial<PoolsClient> = {}): PoolsClient {
  return {
    listCubes: vi.fn().mockResolvedValue([]),
    importCube: vi.fn(),
    refreshCube: vi.fn(),
    deleteCube: vi.fn(),
    cubeCards: vi.fn().mockResolvedValue(null),
    cubeArts: vi.fn().mockResolvedValue(null),
    listSets: vi.fn().mockResolvedValue([]),
    listPresets: vi.fn().mockResolvedValue([]),
    savePreset: vi.fn(),
    deletePreset: vi.fn(),
    ...over,
  };
}

describe('InventoryScreen', () => {
  it('has a page heading — a label, not explanatory text', () => {
    render(createElement(InventoryScreen, { pools: stubPools() }));
    expect(screen.getByRole('heading', { level: 1, name: 'Inventory' })).not.toBeNull();
  });

  it('its arrow goes home', () => {
    globalThis.location.hash = '#/inventory';
    render(createElement(InventoryScreen, { pools: stubPools() }));
    fireEvent.click(screen.getByTestId('back-to-lobby'));
    expect(currentRoute()).toEqual({ kind: 'lobby' });
  });

  it('lists imported cubes only — a shortlist cube is build-pool’s own output, never managed here', async () => {
    const mine = cube();
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([mine, shortlistCube()]) });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId(`inventory-cube-${mine.id}`)).not.toBeNull());
    expect(screen.queryByTestId('inventory-cube-vintage'), 'the shortlist cube is not listed').toBeNull();
  });

  it('refresh is open to any friend; delete only shows for the importer', async () => {
    const mine = cube({ id: 'cc-mine', importedBy: 'fk:alice', importerName: 'Alice', mine: true });
    const theirs = cube({ id: 'cc-theirs', importedBy: 'fk:bob', importerName: 'Bob', mine: false });
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([mine, theirs]) });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId(`inventory-refresh-${mine.id}`)).not.toBeNull());

    expect(screen.getByTestId(`inventory-refresh-${theirs.id}`), 'refresh: any friend').not.toBeNull();
    expect(screen.getByTestId(`inventory-delete-${mine.id}`), 'delete: the importer').not.toBeNull();
    expect(screen.queryByTestId(`inventory-delete-${theirs.id}`), 'delete: not another friend').toBeNull();
  });

  it('names a cube’s importer, never by an id, and says nothing for one nobody can name', async () => {
    const named = cube({ id: 'cc-named', importedBy: 'fk:9401c0fa727e95b0', importerName: 'Bob', mine: false });
    const unnamed = cube({ id: 'cc-unnamed', importedBy: 'fk:1f7da5749ef6d295', importerName: null, mine: false });
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([named, unnamed]) });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId('inventory-meta-cc-named')).not.toBeNull());
    expect(screen.getByTestId('inventory-meta-cc-named').textContent).toBe('100 cards · Bob');
    expect(screen.getByTestId('inventory-meta-cc-unnamed').textContent).toBe('100 cards');
  });

  it('refreshing calls the client and reloads the list', async () => {
    const mine = cube();
    const refreshCube = vi.fn().mockResolvedValue({ ok: true, cube: mine });
    const listCubes = vi.fn().mockResolvedValue([mine]);
    const pools = stubPools({ listCubes, refreshCube });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId(`inventory-refresh-${mine.id}`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`inventory-refresh-${mine.id}`));
    await waitFor(() => expect(refreshCube).toHaveBeenCalledWith(mine.id));
    await waitFor(() => expect(listCubes).toHaveBeenCalledTimes(2));
  });

  it('deleting calls the client and reloads the list', async () => {
    const mine = cube();
    const deleteCube = vi.fn().mockResolvedValue({ ok: true });
    const listCubes = vi.fn().mockResolvedValue([mine]);
    const pools = stubPools({ listCubes, deleteCube });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId(`inventory-delete-${mine.id}`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`inventory-delete-${mine.id}`));
    await waitFor(() => expect(deleteCube).toHaveBeenCalledWith(mine.id));
    await waitFor(() => expect(listCubes).toHaveBeenCalledTimes(2));
  });

  it('never shows the raw ISO refresh timestamp', async () => {
    const mine = cube({ refreshedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([mine]) });

    render(createElement(InventoryScreen, { pools }));
    const meta = await waitFor(() => screen.getByTestId(`inventory-meta-${mine.id}`));
    expect(meta.textContent).toContain('5m ago');
    expect(meta.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('a list read sent before a later write answers lands nothing once a newer read has: the deleted cube stays gone', async () => {
    const mine = cube({ id: 'cc-mine' });
    const theirs = cube({ id: 'cc-theirs', importedBy: 'u-bob' });
    let server = [mine, theirs];
    const held: (() => void)[] = [];
    // Each read answers with the list as it stood when it was asked, when the test says so.
    const listCubes = vi.fn(() => {
      const answer = server;
      return listCubes.mock.calls.length === 1 ? Promise.resolve(answer) : new Promise<CubeListing[]>((resolve) => held.push(() => resolve(answer)));
    });
    const refreshCube = vi.fn().mockResolvedValue({ ok: true, cube: theirs });
    const deleteCube = vi.fn(async () => {
      server = [theirs];
      return { ok: true as const };
    });
    render(createElement(InventoryScreen, { pools: stubPools({ listCubes, refreshCube, deleteCube }) }));
    await waitFor(() => expect(screen.getByTestId(`inventory-delete-${mine.id}`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`inventory-refresh-${theirs.id}`));
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.click(screen.getByTestId(`inventory-delete-${mine.id}`));
    await waitFor(() => expect(held).toHaveLength(2));

    await act(async () => held[1]!());
    await waitFor(() => expect(screen.queryByTestId(`inventory-cube-${mine.id}`)).toBeNull());
    await act(async () => held[0]!());
    expect(screen.queryByTestId(`inventory-cube-${mine.id}`), 'the older list lands nothing').toBeNull();
  });

  it('draws the shared import card', async () => {
    const pools = stubPools();
    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-import-link')).not.toBeNull());
  });

  it('importing a link calls the client and reloads the list', async () => {
    const mine = cube();
    const importCube = vi.fn().mockResolvedValue({ ok: true, cube: mine });
    const listCubes = vi.fn().mockResolvedValue([]);
    const pools = stubPools({ listCubes, importCube });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-import-link')).not.toBeNull());

    fireEvent.change(screen.getByTestId('pool-picker-import-link'), { target: { value: 'cubecobra.com/cube/x' } });
    fireEvent.click(screen.getByTestId('pool-picker-import-go'));
    await waitFor(() => expect(importCube).toHaveBeenCalledWith({ link: 'cubecobra.com/cube/x' }));
    await waitFor(() => expect(listCubes).toHaveBeenCalledTimes(2));
  });

  it('a pasted list asks its name, and is imported under it', async () => {
    const importCube = vi.fn().mockResolvedValue({ ok: true, cube: cube() });
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([]), importCube });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-import-link')).not.toBeNull());
    expect(screen.queryByTestId('pool-picker-import-name'), 'a link has a name of its own').toBeNull();

    fireEvent.change(screen.getByTestId('pool-picker-import-link'), { target: { value: '1 Forest\n1 Island\n' } });
    expect((screen.getByTestId('pool-picker-import-go') as HTMLButtonElement).disabled, 'no name yet').toBe(true);
    fireEvent.change(screen.getByTestId('pool-picker-import-name'), { target: { value: ' My cube ' } });
    fireEvent.click(screen.getByTestId('pool-picker-import-go'));
    await waitFor(() => expect(importCube).toHaveBeenCalledWith({ name: 'My cube', list: '1 Forest\n1 Island' }));
  });

  it('a pasted list has no refresh', async () => {
    const pasted = cube({ id: 'list-1', origin: 'list', cubeCobraId: null });
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([pasted]) });

    render(createElement(InventoryScreen, { pools }));
    await waitFor(() => expect(screen.getByTestId('inventory-cube-list-1')).not.toBeNull());
    expect(screen.queryByTestId('inventory-refresh-list-1')).toBeNull();
    expect(screen.getByTestId('inventory-delete-list-1')).not.toBeNull();
  });
});
