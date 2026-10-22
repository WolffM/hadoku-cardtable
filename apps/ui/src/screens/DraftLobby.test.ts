// @vitest-environment jsdom
/*
 * A null pod draws every member in one list, no seats; a real pod draws the
 * 8-seat grid, in the same frame as the members, with unseated members moved
 * to their own "Spectators" list. The
 * ready-toggle's own meaning is untouched either way — see the file's own
 * header on why seats are additive, not a new gate.
 *
 * `.test.ts`, not `.test.tsx` — the root vitest config globs
 * `apps/*\/src/**\/*.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CubeSummary, DraftPlan, PoolVerdict } from '@hadoku/shared';

const { aiPod, sitPod, standPod } = vi.hoisted(() => ({
  aiPod: vi.fn(),
  sitPod: vi.fn(),
  standPod: vi.fn(),
}));

vi.mock('./pod/client.ts', () => ({ aiPod, sitPod, standPod }));

const { preloadCubeArt } = vi.hoisted(() => ({ preloadCubeArt: vi.fn() }));
vi.mock('../play/live/art-preload.ts', () => ({ preloadCubeArt }));

import { DraftLobby } from './DraftLobby.tsx';
import type { PoolsClient, RoomsClient } from '../rooms/api.ts';
import { POD_SEATS, type PodView } from './pod/wire.ts';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const member = (id: string, name: string, ready = false): { id: string; name: string; joinedAt: string; ready: boolean } => ({
  id,
  name,
  joinedAt: new Date().toISOString(),
  ready,
});

const noop = (): void => undefined;

/** A pool picker that never touches the network: every test supplies its own answers. */
let pools: PoolsClient;
let rooms: Pick<RoomsClient, 'setPlan'>;
beforeEach(() => {
  pools = {
    listCubes: vi.fn().mockResolvedValue([]),
    importCube: vi.fn(),
    refreshCube: vi.fn(),
    deleteCube: vi.fn(),
    cubeCards: vi.fn().mockResolvedValue(null),
  };
  rooms = { setPlan: vi.fn() };
});

const baseProps = {
  roomId: 'r-cube',
  leaderId: 'u-alice',
  myId: 'u-alice',
  iAmReady: false,
  allReady: false,
  dealing: false,
  error: null,
  onReady: noop,
  onRetry: noop,
  get pools() {
    return pools;
  },
  get rooms() {
    return rooms;
  },
};

const podFixture = (over: Partial<PodView> = {}): PodView => ({
  phase: 'lobby',
  seats: Array.from({ length: POD_SEATS }, () => null),
  round: 0,
  rounds: 0,
  results: [],
  standings: [],
  pairings: [],
  bye: null,
  drafters: [],
  built: [],
  // wave 73 §A step 6: PodView gains these three. Minimal valid default only
  // — B's own lane fills in the real picker/verdict fixtures on rebase.
  plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
  planName: 'Test Cube',
  verdict: null,
  ...over,
});

/** `podFixture` plus the three pool-picker fields set to specific values, for a test that cares which ones. */
const plannedPod = (plan: DraftPlan, planName: string, verdict: PoolVerdict | null, over: Partial<PodView> = {}): PodView => ({
  ...podFixture(over),
  plan,
  planName,
  verdict,
});

const cubePlan = (cubeId: string): DraftPlan => ({
  rounds: [
    { kind: 'cube', cubeId },
    { kind: 'cube', cubeId },
    { kind: 'cube', cubeId },
  ],
});

const cubeFixture = (over: Partial<CubeSummary> = {}): CubeSummary => ({
  id: 'vintage-cube-2025-12',
  name: 'MTGO Vintage Cube 2025-12',
  size: 540,
  origin: 'shortlist',
  cubeCobraId: null,
  importedBy: null,
  importedAt: null,
  refreshedAt: null,
  verdict: null,
  ...over,
});

describe('the draft lobby', () => {
  // The operator, 2026-10-21: spectators take no seat, and "i like showing that there are spectators in the draft process".
  it('draws the seat grid in its first frame, and names who holds no seat as a spectator, with no button', () => {
    const pod = podFixture({ seats: Array.from({ length: POD_SEATS }, (_, i) => (i === 0 ? { memberId: 'u-alice', name: 'Alice' } : null)) });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [member('u-alice', 'Alice', true), member('u-bob', 'Bob')] }));

    expect(screen.getByTestId('pod-seat-0').textContent).toContain('Alice (you)');
    expect(screen.getByTestId('pod-seat-0-ready').getAttribute('data-state')).toBe('yes');
    expect(screen.getAllByTestId('pod-spectator').map((r) => r.dataset['member'])).toEqual(['u-bob']);
    expect(screen.getByTestId('pod-spectators').querySelector('button')).toBeNull();
  });

  it('draws no spectator list while everyone is seated', () => {
    const pod = podFixture({ seats: Array.from({ length: POD_SEATS }, (_, i) => (i === 0 ? { memberId: 'u-alice', name: 'Alice' } : i === 1 ? { memberId: 'u-bob', name: 'Bob' } : null)) });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));

    expect(screen.queryByTestId('pod-spectators')).toBeNull();
  });

  it('the ready-toggle keeps its own meaning regardless of seating', () => {
    const onReady = vi.fn();
    // A ready pool (wave 73 §B): the ready-toggle's OWN gate is what this test
    // is about, and that gate must not be entangled with the pool's — see
    // "the pool picker" describe block below for the verdict's own gating.
    const pod = plannedPod(cubePlan('c'), 'C', { ok: true, cards: 1 });

    render(createElement(DraftLobby, { ...baseProps, pod, onReady, members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));

    screen.getByTestId('ready-toggle').click();
    expect(onReady).toHaveBeenCalledWith(true);
  });

  it('changes nothing on the screen while a seat press is in flight, and sends a second press once the first has answered', async () => {
    let answer: (v: { ok: boolean; message: string | null }) => void = () => undefined;
    sitPod.mockImplementation(() => new Promise((r) => (answer = r)));
    render(createElement(DraftLobby, { ...baseProps, pod: podFixture(), members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));
    const buttons = () => [...screen.getByTestId('draft-lobby').querySelectorAll('button')];
    const before = buttons().map((b) => b.disabled);

    screen.getByTestId('pod-seat-2').querySelector('button')?.click();
    expect(buttons().map((b) => b.disabled), 'no button greys out for the round trip').toEqual(before);
    screen.getByTestId('pod-seat-3').querySelector('button')?.click();
    expect(sitPod, 'one at a time').toHaveBeenCalledTimes(1);

    answer({ ok: true, message: null });
    await waitFor(() => expect(sitPod).toHaveBeenCalledTimes(2));
    expect(sitPod).toHaveBeenLastCalledWith('r-cube', 3);
  });

  it('sits a member in the chosen seat and clears on a refusal', async () => {
    sitPod.mockResolvedValue({ ok: false, message: 'the lobby phase has ended' });

    render(createElement(DraftLobby, { ...baseProps, pod: podFixture(), members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));

    screen.getByTestId('pod-seat-2').querySelector('button')?.click();
    await waitFor(() => expect(sitPod).toHaveBeenCalledWith('r-cube', 2));
    await waitFor(() => expect(screen.getByTestId('pod-seat-error').textContent).toBe('the lobby phase has ended'));
  });
});

describe('the pool picker (wave 73 §B)', () => {
  const alice = member('u-alice', 'Alice', true);
  const bob = member('u-bob', 'Bob', true);

  it('the leader edits the picker; a non-leader sees the same list, read-only, with no import field', async () => {
    const cube = cubeFixture();
    vi.mocked(pools.listCubes).mockResolvedValue([cube]);
    const pod = plannedPod(cubePlan(cube.id), cube.name, { ok: true, cards: cube.size });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    const leaderRadio = await waitFor(() => screen.getByTestId(`pool-picker-cube-${cube.id}`) as HTMLInputElement);
    expect(leaderRadio.disabled, 'the leader may change it').toBe(false);
    expect(leaderRadio.checked, 'the room’s own plan is drawn chosen').toBe(true);
    expect(screen.getByTestId('pool-picker-import-link'), 'the leader gets the import field').not.toBeNull();

    cleanup();
    render(createElement(DraftLobby, { ...baseProps, pod, myId: 'u-bob', members: [alice, bob] }));
    const readerRadio = await waitFor(() => screen.getByTestId(`pool-picker-cube-${cube.id}`) as HTMLInputElement);
    expect(readerRadio.disabled, 'everyone else only reads it').toBe(true);
    expect(readerRadio.checked, 'and sees the same choice').toBe(true);
    expect(screen.queryByTestId('pool-picker-import-link'), 'no import field for a non-leader').toBeNull();
  });

  it('a null verdict reads as checking, and disables Ready', async () => {
    const cube = cubeFixture();
    vi.mocked(pools.listCubes).mockResolvedValue([cube]);
    const pod = plannedPod(cubePlan(cube.id), cube.name, null);

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-cube-${cube.id}`)).not.toBeNull());

    expect(screen.getByTestId('pool-picker-verdict').getAttribute('data-state')).toBe('checking');
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled, 'Start waits on the first check').toBe(true);
  });

  it("a refused BACKGROUND verdict (no local attempt — e.g. no jar yet) shows refused, never an empty 'ready'", async () => {
    // Found live (2026-10-22): the CURRENT plan's own verdict can be refused
    // with nobody having attempted a pick (room/plan.ts's checkCards, no
    // jar: "never passes by default"). The verdict line used to default to
    // `ready` whenever no LOCAL attempt had failed, drawing an empty line
    // while Ready stayed correctly disabled — a driver waiting on the
    // `ready` state by itself got stuck forever.
    const cube = cubeFixture();
    vi.mocked(pools.listCubes).mockResolvedValue([cube]);
    const pod = plannedPod(cubePlan(cube.id), cube.name, {
      ok: false,
      unplayable: ['Forge is not available to check playability — try again once the pool service is up'],
      missingText: [],
    });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-verdict').getAttribute('data-state')).toBe('refused'));

    expect(screen.getByTestId('pool-picker-verdict').textContent).toBe('Forge is not available to check playability — try again once the pool service is up');
    expect((screen.getByTestId(`pool-picker-cube-${cube.id}`) as HTMLInputElement).checked, 'still shows the room’s own (refused) plan chosen').toBe(true);
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an ok verdict shows the card count, and Ready is enabled', async () => {
    const cube = cubeFixture({ size: 540 });
    vi.mocked(pools.listCubes).mockResolvedValue([cube]);
    const pod = plannedPod(cubePlan(cube.id), cube.name, { ok: true, cards: 540 });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-verdict').getAttribute('data-state')).toBe('ready'));

    expect(screen.getByTestId('pool-picker-verdict').textContent).toBe('540 cards');
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a refused pick shows the attempted cube chosen and its unplayable names, disables Ready, and leaves the room’s own plan untouched', async () => {
    const good = cubeFixture({ id: 'vintage-cube-2025-12', name: 'MTGO Vintage Cube 2025-12' });
    const bad = cubeFixture({ id: 'test-unplayable', name: 'A cube Forge does not know' });
    vi.mocked(pools.listCubes).mockResolvedValue([good, bad]);
    vi.mocked(rooms.setPlan).mockResolvedValue({
      ok: false,
      message: 'refused',
      verdict: { ok: false, unplayable: ['Not A Real Card'], missingText: [] },
    });
    const pod = plannedPod(cubePlan(good.id), good.name, { ok: true, cards: good.size });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-cube-${bad.id}`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`pool-picker-cube-${bad.id}`));
    expect(rooms.setPlan).toHaveBeenCalledWith('r-cube', cubePlan(bad.id));

    await waitFor(() => expect(screen.getByTestId('pool-picker-verdict').getAttribute('data-state')).toBe('refused'));
    expect(screen.getByTestId('pool-picker-verdict').textContent).toBe('Not A Real Card');
    expect((screen.getByTestId(`pool-picker-cube-${bad.id}`) as HTMLInputElement).checked, 'the picker shows the attempted cube').toBe(true);
    expect((screen.getByTestId(`pool-picker-cube-${good.id}`) as HTMLInputElement).checked, 'not the one it replaced').toBe(false);
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled, 'Start is disabled').toBe(true);
    // `DraftLobby` never mutates its own `pod` prop — it only READS it — so "the
    // previous choice is still the room's plan" holds by construction here: the
    // fixture handed in still names `good`, untouched by the refused attempt.
    expect(pod.plan).toEqual(cubePlan(good.id));
  });

  it('refresh is open to any leader; delete only shows for the importer', async () => {
    const mine = cubeFixture({ id: 'cc-mine', name: 'My import', origin: 'cubecobra', cubeCobraId: 'mine', importedBy: 'u-alice' });
    const theirs = cubeFixture({ id: 'cc-theirs', name: 'Their import', origin: 'cubecobra', cubeCobraId: 'theirs', importedBy: 'u-bob' });
    vi.mocked(pools.listCubes).mockResolvedValue([mine, theirs]);
    const pod = plannedPod(cubePlan(mine.id), mine.name, { ok: true, cards: mine.size });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-refresh-${mine.id}`)).not.toBeNull());

    expect(screen.getByTestId(`pool-picker-refresh-${theirs.id}`), 'refresh: any friend').not.toBeNull();
    expect(screen.getByTestId(`pool-picker-delete-${mine.id}`), 'delete: the importer').not.toBeNull();
    expect(screen.queryByTestId(`pool-picker-delete-${theirs.id}`), 'delete: not another friend').toBeNull();
  });

  it("warms the plan's own cube art before the deal, from GET /api/pools/cubes/:id/cards — never the bundled pool", async () => {
    const cube = cubeFixture();
    vi.mocked(pools.listCubes).mockResolvedValue([cube]);
    const card = {
      cardId: 'c0',
      scryfallId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      name: 'Lightning Bolt',
      manaCost: ['R'],
      manaValue: 1,
      colors: ['R' as const],
      typeLine: 'Instant',
      oracleText: '',
      setCode: 'LEA',
      collectorNumber: '1',
      rarity: 'common' as const,
    };
    vi.mocked(pools.cubeCards).mockResolvedValue([card]);
    const pod = plannedPod(cubePlan(cube.id), cube.name, { ok: true, cards: cube.size });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));

    await waitFor(() => expect(pools.cubeCards).toHaveBeenCalledWith(cube.id));
    await waitFor(() => expect(preloadCubeArt).toHaveBeenCalledWith([card]));
  });
});
