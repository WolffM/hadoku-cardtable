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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CubeSummary } from '@hadoku/shared';

import { InventoryScreen } from './InventoryScreen.tsx';
import type { PoolsClient } from '../rooms/api.ts';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const cube = (over: Partial<CubeSummary> = {}): CubeSummary => ({
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
  ...over,
});

const shortlistCube = (over: Partial<CubeSummary> = {}): CubeSummary => ({
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
  ...over,
});

function stubPools(over: Partial<PoolsClient> = {}): PoolsClient {
  return {
    listCubes: vi.fn().mockResolvedValue([]),
    importCube: vi.fn(),
    refreshCube: vi.fn(),
    deleteCube: vi.fn(),
    cubeCards: vi.fn().mockResolvedValue(null),
    listSets: vi.fn().mockResolvedValue([]),
    listPresets: vi.fn().mockResolvedValue([]),
    savePreset: vi.fn(),
    deletePreset: vi.fn(),
    ...over,
  };
}

describe('InventoryScreen', () => {
  it('has a page heading — a label, not explanatory text', () => {
    render(createElement(InventoryScreen, { pools: stubPools(), myId: 'u-me' }));
    expect(screen.getByRole('heading', { name: 'Inventory' })).not.toBeNull();
  });

  it('lists imported cubes only — a shortlist cube is build-pool’s own output, never managed here', async () => {
    const mine = cube();
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([mine, shortlistCube()]) });

    render(createElement(InventoryScreen, { pools, myId: 'u-me' }));
    await waitFor(() => expect(screen.getByTestId(`inventory-cube-${mine.id}`)).not.toBeNull());
    expect(screen.queryByTestId('inventory-cube-vintage'), 'the shortlist cube is not listed').toBeNull();
  });

  it('refresh is open to any friend; delete only shows for the importer', async () => {
    const mine = cube({ id: 'cc-mine', importedBy: 'u-alice' });
    const theirs = cube({ id: 'cc-theirs', importedBy: 'u-bob' });
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([mine, theirs]) });

    render(createElement(InventoryScreen, { pools, myId: 'u-alice' }));
    await waitFor(() => expect(screen.getByTestId(`inventory-refresh-${mine.id}`)).not.toBeNull());

    expect(screen.getByTestId(`inventory-refresh-${theirs.id}`), 'refresh: any friend').not.toBeNull();
    expect(screen.getByTestId(`inventory-delete-${mine.id}`), 'delete: the importer').not.toBeNull();
    expect(screen.queryByTestId(`inventory-delete-${theirs.id}`), 'delete: not another friend').toBeNull();
  });

  it('refreshing calls the client and reloads the list', async () => {
    const mine = cube();
    const refreshCube = vi.fn().mockResolvedValue({ ok: true, cube: mine });
    const listCubes = vi.fn().mockResolvedValue([mine]);
    const pools = stubPools({ listCubes, refreshCube });

    render(createElement(InventoryScreen, { pools, myId: 'u-me' }));
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

    render(createElement(InventoryScreen, { pools, myId: 'u-me' }));
    await waitFor(() => expect(screen.getByTestId(`inventory-delete-${mine.id}`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`inventory-delete-${mine.id}`));
    await waitFor(() => expect(deleteCube).toHaveBeenCalledWith(mine.id));
    await waitFor(() => expect(listCubes).toHaveBeenCalledTimes(2));
  });

  it('never shows the raw ISO refresh timestamp', async () => {
    const mine = cube({ refreshedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    const pools = stubPools({ listCubes: vi.fn().mockResolvedValue([mine]) });

    render(createElement(InventoryScreen, { pools, myId: 'u-me' }));
    const meta = await waitFor(() => screen.getByTestId(`inventory-meta-${mine.id}`));
    expect(meta.textContent).toContain('5m ago');
    expect(meta.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('draws the shared import card', async () => {
    const pools = stubPools();
    render(createElement(InventoryScreen, { pools, myId: 'u-me' }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-import-link')).not.toBeNull());
  });

  it('importing a link calls the client and reloads the list', async () => {
    const mine = cube();
    const importCube = vi.fn().mockResolvedValue({ ok: true, cube: mine });
    const listCubes = vi.fn().mockResolvedValue([]);
    const pools = stubPools({ listCubes, importCube });

    render(createElement(InventoryScreen, { pools, myId: 'u-me' }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-import-link')).not.toBeNull());

    fireEvent.change(screen.getByTestId('pool-picker-import-link'), { target: { value: 'cubecobra.com/cube/x' } });
    fireEvent.click(screen.getByTestId('pool-picker-import-go'));
    await waitFor(() => expect(importCube).toHaveBeenCalledWith('cubecobra.com/cube/x'));
    await waitFor(() => expect(listCubes).toHaveBeenCalledTimes(2));
  });
});
