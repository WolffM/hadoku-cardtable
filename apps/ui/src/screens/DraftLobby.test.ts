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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CubeSummary, DraftPlan, DraftPreset, PoolSource, PoolVerdict, SetSummary } from '@hadoku/shared';

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
    listSets: vi.fn().mockResolvedValue([]),
    listPresets: vi.fn().mockResolvedValue([]),
    savePreset: vi.fn(),
    deletePreset: vi.fn(),
  };
  // A default resolved outcome, so a test that picks something without caring
  // what the server answers (most of the Set/Custom/preset tests below) does
  // not crash on an unresolved mock; a test that DOES care overrides it.
  rooms = { setPlan: vi.fn().mockResolvedValue({ ok: true, room: {} as unknown as never }) };
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
  artId: null,
  ...over,
});

const setFixture = (over: Partial<SetSummary> = {}): SetSummary => ({
  code: 'ISD',
  name: 'Innistrad',
  date: '2011-09-30',
  type: 'Expansion',
  cards: 231,
  verdict: null,
  ...over,
});

const setPlan = (code: string, style: 'realistic' | 'set-cube' = 'realistic'): DraftPlan => ({
  rounds: [
    { kind: 'set', code, style },
    { kind: 'set', code, style },
    { kind: 'set', code, style },
  ],
});

const customPlan = (rounds: [PoolSource, PoolSource, PoolSource]): DraftPlan => ({ rounds });

const presetFixture = (over: Partial<DraftPreset> = {}): DraftPreset => ({
  id: 'preset-1',
  name: 'Alara block',
  plan: customPlan([
    { kind: 'set', code: 'ALA', style: 'realistic' },
    { kind: 'set', code: 'ALA', style: 'realistic' },
    { kind: 'set', code: 'ARB', style: 'realistic' },
  ]),
  createdBy: 'u-alice',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('the draft lobby', () => {
  // The operator, 2026-10-21: spectators take no seat, and "i like showing that there are spectators in the draft process".
  it('draws the seat grid in its first frame, and names who holds no seat as a spectator, with no button', () => {
    const pod = podFixture({ seats: Array.from({ length: POD_SEATS }, (_, i) => (i === 0 ? { memberId: 'u-alice', name: 'Alice' } : null)) });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [member('u-alice', 'Alice', true), member('u-bob', 'Bob')] }));

    expect(screen.getByTestId('pod-seat-0').querySelector('.pod-seats__label')?.textContent).toBe('Alice');
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
    const leaderRadio = await waitFor(() => screen.getByTestId(`pool-picker-cubes-${cube.id}`) as HTMLInputElement);
    expect(leaderRadio.disabled, 'the leader may change it').toBe(false);
    expect(leaderRadio.checked, 'the room’s own plan is drawn chosen').toBe(true);
    expect(screen.getByTestId('pool-picker-import-link'), 'the leader gets the import field').not.toBeNull();

    cleanup();
    render(createElement(DraftLobby, { ...baseProps, pod, myId: 'u-bob', members: [alice, bob] }));
    const readerRadio = await waitFor(() => screen.getByTestId(`pool-picker-cubes-${cube.id}`) as HTMLInputElement);
    expect(readerRadio.disabled, 'everyone else only reads it').toBe(true);
    expect(readerRadio.checked, 'and sees the same choice').toBe(true);
    expect(screen.queryByTestId('pool-picker-import-link'), 'no import field for a non-leader').toBeNull();
  });

  it('a null verdict reads as checking, and disables Ready', async () => {
    const cube = cubeFixture();
    vi.mocked(pools.listCubes).mockResolvedValue([cube]);
    const pod = plannedPod(cubePlan(cube.id), cube.name, null);

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-cubes-${cube.id}`)).not.toBeNull());

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
      unplayable: [],
      missingText: [],
      message: 'Forge is not available to check playability — try again once the pool service is up',
    });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId('pool-picker-verdict').getAttribute('data-state')).toBe('refused'));

    expect(screen.getByTestId('pool-picker-verdict').textContent).toBe('Forge is not available to check playability — try again once the pool service is up Show');
    // A refusal opens as a modal (the operator, 2026-10-22: "this error should appear as a popout modal").
    expect(screen.getByTestId('pool-picker-refusal').textContent).toContain('Forge is not available to check playability');
    // `pool-picker-verdict` renders on the first pass from the `pod` prop; the cube
    // radios come from the async `pools.listCubes()` and may not have landed yet —
    // `findByTestId`, not `getByTestId`, so a slow fake (or a busy CI runner)
    // does not flake this (hadoku-cardtable-76, 1 failure in 30 unmodified).
    const radio = (await screen.findByTestId(`pool-picker-cubes-${cube.id}`)) as HTMLInputElement;
    expect(radio.checked, 'still shows the room’s own (refused) plan chosen').toBe(true);
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
    await waitFor(() => expect(screen.getByTestId(`pool-picker-cubes-${bad.id}`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`pool-picker-cubes-${bad.id}`));
    expect(rooms.setPlan).toHaveBeenCalledWith('r-cube', cubePlan(bad.id));

    await waitFor(() => expect(screen.getByTestId('pool-picker-verdict').getAttribute('data-state')).toBe('refused'));
    expect(screen.getByTestId('pool-picker-verdict').textContent).toBe('1 card can’t be drafted Show');
    expect(screen.getByTestId('pool-picker-refusal-unplayable').textContent).toBe('Not A Real Card');
    // Closed, it stays closed while the same refusal stands; the line opens it again.
    fireEvent.click(screen.getByTestId('pool-picker-refusal-close'));
    expect(screen.queryByTestId('pool-picker-refusal')).toBeNull();
    fireEvent.click(screen.getByTestId('pool-picker-refusal-show'));
    expect(screen.getByTestId('pool-picker-refusal')).not.toBeNull();
    expect((screen.getByTestId(`pool-picker-cubes-${bad.id}`) as HTMLInputElement).checked, 'the picker shows the attempted cube').toBe(true);
    expect((screen.getByTestId(`pool-picker-cubes-${good.id}`) as HTMLInputElement).checked, 'not the one it replaced').toBe(false);
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled, 'Start is disabled').toBe(true);
    // `DraftLobby` never mutates its own `pod` prop — it only READS it — so "the
    // previous choice is still the room's plan" holds by construction here: the
    // fixture handed in still names `good`, untouched by the refused attempt.
    expect(pod.plan).toEqual(cubePlan(good.id));
  });

  // The operator, 2026-10-22: the refusal's modal answers "Draft without them" or "Cancel".
  it('a refused pick is answered Cancel, which only closes it, or Draft without them, which sends the same pool less its refused cards', async () => {
    const bad = cubeFixture({ id: 'cc-jenny', name: 'Jenny’s Cube' });
    vi.mocked(pools.listCubes).mockResolvedValue([bad]);
    vi.mocked(rooms.setPlan).mockResolvedValueOnce({ ok: false, message: 'refused', verdict: { ok: false, unplayable: ['Ademi'], missingText: ['GO TO JAIL'] } });
    const pod = plannedPod(cubePlan('vintage-cube-2025-12'), 'MTGO Vintage Cube', { ok: true, cards: 540 });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    fireEvent.click(await screen.findByTestId(`pool-picker-cubes-${bad.id}`));
    await screen.findByTestId('pool-picker-refusal-without');

    fireEvent.click(screen.getByTestId('pool-picker-refusal-cancel'));
    expect(screen.queryByTestId('pool-picker-refusal')).toBeNull();
    expect(rooms.setPlan).toHaveBeenCalledTimes(1);

    vi.mocked(rooms.setPlan).mockResolvedValueOnce({ ok: true, room: {} as never });
    fireEvent.click(screen.getByTestId('pool-picker-refusal-show'));
    fireEvent.click(screen.getByTestId('pool-picker-refusal-without'));
    expect(rooms.setPlan).toHaveBeenLastCalledWith('r-cube', { ...cubePlan(bad.id), without: ['Ademi', 'GO TO JAIL'] });
    await waitFor(() => expect(screen.queryByTestId('pool-picker-refusal')).toBeNull());
  });

  it('offers no Draft without them where leaving cards out cannot help: a refusal with no card list', async () => {
    const cube = cubeFixture();
    vi.mocked(pools.listCubes).mockResolvedValue([cube]);
    const pod = plannedPod(cubePlan(cube.id), cube.name, { ok: false, unplayable: [], missingText: [], message: 'Forge is not available to check playability' });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await screen.findByTestId('pool-picker-refusal');
    expect(screen.queryByTestId('pool-picker-refusal-without')).toBeNull();
    expect(screen.queryByTestId('pool-picker-refusal-cancel')).toBeNull();
  });

  // Refresh/delete/the importer badge moved to `#/inventory` (AF305 §B —
  // the operator: "when i'm in a room i wouldn't want to mess with the
  // refresh state of the cube… i dont need a cube cobra pill"); that
  // behaviour is `InventoryScreen.test.ts`'s now, not this room's.

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

describe('the Set tab (wave 74 §F)', () => {
  const alice = member('u-alice', 'Alice', true);
  const bob = member('u-bob', 'Bob', true);

  it('a non-leader follows the room onto the Set tab with no interaction of their own, and sees the same set/style chosen', async () => {
    const isd = setFixture();
    vi.mocked(pools.listSets).mockResolvedValue([isd]);
    const pod = plannedPod(setPlan(isd.code), 'Innistrad · Realistic', { ok: true, cards: isd.cards });

    render(createElement(DraftLobby, { ...baseProps, pod, myId: 'u-bob', members: [alice, bob] }));

    await waitFor(() => expect(screen.getByTestId('pool-picker-tab-set').getAttribute('aria-selected')).toBe('true'));
    const setRadio = (await waitFor(() => screen.getByTestId(`pool-picker-sets-${isd.code}`))) as HTMLInputElement;
    expect(setRadio.checked, 'the room’s own set is drawn chosen').toBe(true);
    expect((screen.getByTestId('pool-picker-style-realistic') as HTMLInputElement).checked, 'and its style').toBe(true);
    // A non-leader's tabs are read-only — the room's plan drives them, never a click.
    expect((screen.getByTestId('pool-picker-tab-set') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the leader opens the Set tab, picks a set and a style, and the whole plan is one source three times', async () => {
    const isd = setFixture();
    vi.mocked(pools.listSets).mockResolvedValue([isd]);
    const pod = podFixture();

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    fireEvent.click(screen.getByTestId('pool-picker-tab-set'));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-sets-${isd.code}`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`pool-picker-sets-${isd.code}`));
    fireEvent.click(screen.getByTestId('pool-picker-style-realistic'));
    await waitFor(() => expect(rooms.setPlan).toHaveBeenLastCalledWith('r-cube', setPlan(isd.code, 'realistic')));
  });
});

describe('the Custom tab (wave 74 §F)', () => {
  const alice = member('u-alice', 'Alice', true);
  const bob = member('u-bob', 'Bob', true);

  it('a refused round names which round and lists the cards, from that source’s own cached verdict — not a round trip', async () => {
    const good = cubeFixture({ id: 'good-cube', name: 'A fine cube' });
    const bad = setFixture({ code: 'ARB', name: 'Alara Reborn', verdict: { ok: false, unplayable: ['Some Card Forge Does Not Know'], missingText: [] } });
    vi.mocked(pools.listCubes).mockResolvedValue([good]);
    vi.mocked(pools.listSets).mockResolvedValue([bad]);
    const pod = podFixture();

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    fireEvent.click(screen.getByTestId('pool-picker-tab-custom'));
    await waitFor(() => expect(screen.getByTestId('pool-picker-custom-round-0')).not.toBeNull());

    // Round 0 is the active slot by default; its CONTAINER renders at once.
    // Its cube rows come from the async `pools.listCubes()` — `findByTestId`,
    // not a bare `getByTestId`, for the first touch of a list-derived row.
    fireEvent.click(await screen.findByTestId('pool-picker-custom-round-0-cubes-good-cube'));
    // Each round's own edit now writes the whole (merged) plan at once
    // (AF305 §B), which disables the picker for that round trip — wait for
    // the NEXT control to go enabled again before clicking it, the same way
    // a real click would have to.
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-1')); // selecting a slot is never busy-gated
    await waitFor(() => expect((screen.getByTestId('pool-picker-custom-round-1-cubes-good-cube') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-1-cubes-good-cube'));
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-2'));
    await waitFor(() => expect((screen.getByTestId('pool-picker-custom-round-2-type-set') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-2-type-set'));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-custom-round-2-sets-${bad.code}`)).not.toBeNull());
    await waitFor(() => expect((screen.getByTestId(`pool-picker-custom-round-2-sets-${bad.code}`) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId(`pool-picker-custom-round-2-sets-${bad.code}`));
    await waitFor(() => expect((screen.getByTestId('pool-picker-custom-round-2-style-realistic') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-2-style-realistic'));

    const round2Verdict = await waitFor(() => screen.getByTestId('pool-picker-custom-round-2-verdict'));
    expect(round2Verdict.getAttribute('data-state'), 'round 2 names itself refused') .toBe('refused');
    expect(round2Verdict.textContent, 'and lists the cards').toBe('Some Card Forge Does Not Know');
    // Round 2 is the active slot now — the other two rounds' pickers (and their verdict
    // lines) are not mounted at all (AF305 §B: one shared picker, not three at once).
    expect(screen.queryByTestId('pool-picker-custom-round-0-verdict')).toBeNull();
    expect(screen.queryByTestId('pool-picker-custom-round-1-verdict')).toBeNull();
  });

  // Found live (AF305, the tracker's screenshot review): Custom's pack slots
  // used to seed empty and stay that way until every round was re-picked from
  // scratch, so a room whose plan already had a source (every room does, past
  // the new-room default) showed three blank slots — looking broken even
  // though the room had a perfectly good plan. The slots now show that plan
  // immediately, and editing one round merges the other two from it.
  it('opening Custom on a room with an existing plan shows it in all three slots at once — no edit needed', async () => {
    const good = cubeFixture({ id: 'good-cube', name: 'A Fine Cube' });
    vi.mocked(pools.listCubes).mockResolvedValue([good]);
    const pod = plannedPod(cubePlan(good.id), good.name, { ok: true, cards: good.size });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    fireEvent.click(screen.getByTestId('pool-picker-tab-custom'));

    for (const round of [0, 1, 2]) {
      // `pool-picker-custom-round-<n>`'s own testid sits on the slot's native radio
      // input; its surrounding label carries the text this asserts on.
      const input = await waitFor(() => screen.getByTestId(`pool-picker-custom-round-${round}`));
      const slot = input.closest('label');
      expect(slot?.textContent, `slot ${round}`).toContain('A Fine Cube');
    }
  });

  it("a round's own edit writes the whole plan AT ONCE, merging the other two rounds from the room's current plan", async () => {
    const dflt = cubeFixture({ id: 'default', name: 'Default Cube' });
    const good = cubeFixture({ id: 'good-cube', name: 'A Fine Cube' });
    vi.mocked(pools.listCubes).mockResolvedValue([dflt, good]);
    const pod = podFixture(); // plan: default ×3 (the fixture's own baseline)

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    fireEvent.click(screen.getByTestId('pool-picker-tab-custom'));
    await waitFor(() => expect(screen.getByTestId('pool-picker-custom-round-0')).not.toBeNull());

    // Round 0 only — rounds 1 and 2 are never touched in this test.
    fireEvent.click(await screen.findByTestId('pool-picker-custom-round-0-cubes-good-cube'));
    await waitFor(() =>
      expect(rooms.setPlan, 'writes immediately, rounds 1 and 2 carried forward from the room’s own plan').toHaveBeenCalledWith('r-cube', {
        rounds: [{ kind: 'cube', cubeId: 'good-cube' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }],
      }),
    );
  });
});

describe('presets (wave 74 §G routes, §F UI)', () => {
  const alice = member('u-alice', 'Alice', true);
  const bob = member('u-bob', 'Bob', true);

  it('a preset saved by Alice is listed for whoever leads next; only Alice (its creator) may delete it', async () => {
    // Preset management sits beside import/refresh/delete, the Cube tab's
    // own leader-only actions (`PoolPicker.tsx`'s `CubeRow`: a non-leader
    // never sees that block at all, not merely disabled) — so this proves
    // the creator rule with BOTH renders leading, never a non-leader's
    // screen, which would not draw the block in the first place. Listing a
    // preset for every member regardless of leadership is §G's own route
    // test (`GET /api/pools/presets`), not this component's.
    const mine = presetFixture({ id: 'p-mine', createdBy: 'u-alice' });
    vi.mocked(pools.listPresets).mockResolvedValue([mine]);
    const pod = plannedPod(mine.plan, 'Custom', { ok: true, cards: 15 });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-preset-${mine.id}`)).not.toBeNull());
    expect(screen.getByTestId(`pool-picker-preset-${mine.id}-delete`), 'the creator, leading, deletes').not.toBeNull();

    cleanup();
    render(createElement(DraftLobby, { ...baseProps, pod, myId: 'u-bob', leaderId: 'u-bob', members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-preset-${mine.id}`)).not.toBeNull());
    expect(screen.queryByTestId(`pool-picker-preset-${mine.id}-delete`), 'a DIFFERENT leader, not its creator, may not').toBeNull();
  });

  it('loading a preset writes its plan', async () => {
    const preset = presetFixture();
    vi.mocked(pools.listPresets).mockResolvedValue([preset]);
    const pod = plannedPod(preset.plan, 'Custom', { ok: true, cards: 15 });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    await waitFor(() => expect(screen.getByTestId(`pool-picker-preset-${preset.id}-load`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`pool-picker-preset-${preset.id}-load`));
    await waitFor(() => expect(rooms.setPlan).toHaveBeenCalledWith('r-cube', preset.plan));
  });

  it('saving names the three chosen rounds', async () => {
    const good = cubeFixture({ id: 'good-cube' });
    vi.mocked(pools.listCubes).mockResolvedValue([good]);
    vi.mocked(pools.savePreset).mockResolvedValue({ ok: true, preset: presetFixture() });
    const pod = podFixture();

    render(createElement(DraftLobby, { ...baseProps, pod, members: [alice, bob] }));
    fireEvent.click(screen.getByTestId('pool-picker-tab-custom'));
    await waitFor(() => expect(screen.getByTestId('pool-picker-custom-round-0')).not.toBeNull());
    // Round 0 is the first touch of a cube row (listCubes-derived) — findByTestId, not getByTestId; see the test above.
    fireEvent.click(await screen.findByTestId('pool-picker-custom-round-0-cubes-good-cube'));
    // Round 1 and 2: select each slot first — its picker is not mounted otherwise (AF305 §B).
    for (const round of [1, 2]) {
      fireEvent.click(screen.getByTestId(`pool-picker-custom-round-${round}`));
      fireEvent.click(screen.getByTestId(`pool-picker-custom-round-${round}-cubes-good-cube`));
    }
    // The third round's pick fires the real (mocked) `setPlan` round trip —
    // wait for it to settle (Save is disabled, same as Ready, while busy)
    // before touching the save form.
    await waitFor(() => expect(rooms.setPlan).toHaveBeenCalledWith('r-cube', cubePlan(good.id)));

    fireEvent.change(screen.getByTestId('pool-picker-preset-name'), { target: { value: 'My preset' } });
    await waitFor(() => expect((screen.getByTestId('pool-picker-preset-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('pool-picker-preset-save'));
    await waitFor(() => expect(pools.savePreset).toHaveBeenCalledWith('My preset', cubePlan(good.id)));
  });
});

/* Each list is read again after this screen's own write: an older read answering last must not put the older list back (`../rooms/latest.ts`). */
describe('a list read a newer one overtook', () => {
  const alice = member('u-alice', 'Alice', true);
  const bob = member('u-bob', 'Bob', true);

  /** A read that answers with what `server()` held when it was asked, once the test releases it. */
  function heldReads<T>(server: () => T) {
    const held: (() => void)[] = [];
    const read = vi.fn(() => {
      const answer = server();
      return new Promise<T>((resolve) => held.push(() => resolve(answer)));
    });
    const release = async (i: number): Promise<void> => {
      await act(async () => held[i]!());
    };
    return { held, read, release };
  }

  it('the cubes: the read from before an import lands nothing once the read after it has', async () => {
    const cube = cubeFixture();
    let server: CubeSummary[] = [];
    const cubes = heldReads(() => server);
    pools.listCubes = cubes.read;
    pools.importCube = vi.fn(async () => {
      server = [cube];
      return { ok: true as const, cube };
    });
    render(createElement(DraftLobby, { ...baseProps, pod: plannedPod(cubePlan(cube.id), cube.name, { ok: true, cards: cube.size }), members: [alice, bob] }));
    await waitFor(() => expect(cubes.held).toHaveLength(1));

    fireEvent.change(screen.getByTestId('pool-picker-import-link'), { target: { value: 'cubecobra.com/cube/x' } });
    fireEvent.click(screen.getByTestId('pool-picker-import-go'));
    await waitFor(() => expect(cubes.held).toHaveLength(2));
    await cubes.release(1);
    await waitFor(() => expect(screen.getByTestId(`pool-picker-cubes-${cube.id}`)).not.toBeNull());
    await cubes.release(0);
    expect(screen.queryByTestId(`pool-picker-cubes-${cube.id}`), 'the older list lands nothing').not.toBeNull();
  });

  it('the presets: the read after the first delete lands nothing once the read after the second has', async () => {
    const first = presetFixture({ id: 'p-first', createdBy: 'u-alice' });
    const second = presetFixture({ id: 'p-second', createdBy: 'u-alice' });
    let server = [first, second];
    const presets = heldReads(() => server);
    pools.listPresets = presets.read;
    pools.deletePreset = vi.fn(async (id: string) => {
      server = server.filter((p) => p.id !== id);
      return { ok: true as const };
    });
    render(createElement(DraftLobby, { ...baseProps, pod: plannedPod(first.plan, 'Custom', { ok: true, cards: 15 }), members: [alice, bob] }));
    await waitFor(() => expect(presets.held).toHaveLength(1));
    await presets.release(0);
    await waitFor(() => expect(screen.getByTestId(`pool-picker-preset-${second.id}-delete`)).not.toBeNull());

    fireEvent.click(screen.getByTestId(`pool-picker-preset-${first.id}-delete`));
    await waitFor(() => expect(presets.held).toHaveLength(2));
    fireEvent.click(screen.getByTestId(`pool-picker-preset-${second.id}-delete`));
    await waitFor(() => expect(presets.held).toHaveLength(3));
    await presets.release(2);
    await waitFor(() => expect(screen.queryByTestId(`pool-picker-preset-${second.id}`)).toBeNull());
    await presets.release(1);
    expect(screen.queryByTestId(`pool-picker-preset-${second.id}`), 'the older list lands nothing').toBeNull();
  });
});
