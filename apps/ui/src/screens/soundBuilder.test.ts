// @vitest-environment jsdom
/*
 * The sound builder, driven through its own props — a stub `SoundsClient` and
 * a stub player, never a real fetch or a real `AudioContext`. What this pins:
 *
 *   - a non-admin (`canEdit: false`) gets nothing rendered — the gate is the
 *     server's `canEdit`, and there is no local override;
 *   - click a bin pill (picks it up) then click a cell → exactly one PUT, with
 *     the cell's new list;
 *   - dragging a placed take to another cell → two PUTs, source then target;
 *   - the `×` on a placed pill removes it with one PUT;
 *   - `pickRandom`'s no-repeat rule is covered in `sound/builderClient.test.ts`
 *     directly — nothing here re-derives it through a click sequence.
 *
 * `.test.ts` + `createElement`, not `.test.tsx` — see `screens/lobby.test.ts`'s
 * header for why a `.tsx` test here would silently not run at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { SoundBuilder } from './SoundBuilder.tsx';
import { promptGist } from './SoundQueue.tsx';
import type { Assignments, SoundsClient } from '../sound/builderClient.ts';

afterEach(() => cleanup());

const TAKE_A = {
  file: 'lib-water/take-1.ogg',
  sound: 'lib-water',
  name: 'Water',
  group: 'Water',
  section: 'Library' as const,
  label: 'Water · 1',
  seconds: 1.2,
  prompt: 'a brook',
};
const TAKE_B = {
  file: 'lib-water/take-2.ogg',
  sound: 'lib-water',
  name: 'Water',
  group: 'Water',
  section: 'Library' as const,
  label: 'Water · 2',
  seconds: 1.4,
  prompt: 'a river',
};

type Saved = { cell: string; files: string[]; gain?: number };

function stubClient(
  assignments: Omit<Assignments, 'gains'> & { gains?: Record<string, number> },
  takes = [TAKE_A, TAKE_B],
): SoundsClient & { saves: Saved[]; retires: { file: string; reason: string }[]; marked: { file: string; mark: string | null }[] } {
  const saves: Saved[] = [];
  const retires: { file: string; reason: string }[] = [];
  const marked: { file: string; mark: string | null }[] = [];
  // The server's own state, so a retire and its restore read back as the server would answer.
  let live = [...takes];
  const out = new Set<string>();
  return {
    saves,
    retires,
    marked,
    async marks() {
      return {};
    },
    async mark(file, mark) {
      marked.push({ file, mark });
      return true;
    },
    async catalogue() {
      return live;
    },
    async assignments() {
      const cells = Object.fromEntries(Object.entries(assignments.cells).map(([c, fs]) => [c, fs.filter((f) => !out.has(f))]));
      return { gains: {}, ...assignments, cells };
    },
    async retire(file, reason) {
      retires.push({ file, reason });
      out.add(file);
      live = live.filter((t) => t.file !== file);
      return [];
    },
    async restore(file) {
      out.delete(file);
      live = takes.filter((t) => !out.has(t.file));
      return true;
    },
    async save(cell, files, gain) {
      saves.push(gain === undefined ? { cell, files: [...files] } : { cell, files: [...files], gain });
      return { files: [...files], gain: gain ?? 1 };
    },
    takeUrl(file) {
      return `/api/sounds/audio/${file}`;
    },
  };
}

function stubPlayer() {
  return { playFile: vi.fn() };
}

/** The matrix lives on the Colours tab; Roles is the default. */
function showColours(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Colours' }));
}

function dataTransferStub() {
  let payload = '';
  return {
    setData: (_type: string, value: string) => {
      payload = value;
    },
    getData: () => payload,
  };
}

/** A promise this test resolves on its own schedule, plus the function to do it. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SoundBuilder', () => {
  it('renders nothing for a non-admin, proven AFTER the load has actually resolved', async () => {
    // Nothing renders before the load resolves either — `!loaded` and
    // `loaded && !canEdit` draw the identical empty page — so asserting an
    // empty container right after `render()` would pass even with the
    // `canEdit` gate deleted outright. The fix is an out-of-band signal that
    // the load genuinely completed, checked BEFORE trusting the empty render:
    // a gate this test controls, plus a flag flipped only once the stub's
    // `assignments()` has actually resolved.
    const gate = deferred<Assignments>();
    let assignmentsResolved = false;
    const client: SoundsClient = {
      catalogue: vi.fn(async () => []),
      assignments: vi.fn(async () => {
        const v = await gate.promise;
        assignmentsResolved = true;
        return v;
      }),
      save: vi.fn(async (_cell, files) => ({ files: [...files], gain: 1 })),
      retire: vi.fn(async () => []),
      restore: vi.fn(async () => true),
      marks: vi.fn(async () => ({})),
      mark: vi.fn(async () => true),
      takeUrl: (file) => file,
    };

    const { container } = render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    expect(client.catalogue).toHaveBeenCalledTimes(1);
    expect(client.assignments).toHaveBeenCalledTimes(1);
    expect(assignmentsResolved).toBe(false); // nothing has resolved yet — the render above proves nothing

    await act(async () => {
      gate.resolve({ cells: {}, gains: {}, canEdit: false });
      // Flush the whole chain inside `act`: the gate settling, `Promise.all`'s
      // own combinator, the component's `.then` (`setTakes`/`setCells`/
      // `setCanEdit`/`setLoaded`), and the resulting re-render. Two extra
      // microtask turns give every hop in that chain a tick to run before this
      // callback's promise settles, which is what makes `act` flush them.
      await gate.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(assignmentsResolved).toBe(true); // the load DID complete by now
    expect(container.textContent).toBe('');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the builder once canEdit is true', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    expect(await screen.findByText('Sound Builder')).toBeTruthy();
    expect(screen.getByText('2', { selector: 'b' })).toBeTruthy(); // "2 keepers"
  });

  it('click a pill then click a cell sends one PUT with the new list', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    const player = stubPlayer();
    const { container } = render(createElement(SoundBuilder, { client, player }));
    await screen.findByText('Sound Builder');
    showColours();

    const pill = screen.getByRole('button', { name: /Water · 1: play and pick up/ });
    fireEvent.click(pill);
    expect(player.playFile).toHaveBeenCalledWith(TAKE_A.file);
    expect(pill.getAttribute('aria-pressed')).toBe('true');

    const cell = container.querySelector('[data-cell="W|spell"]');
    expect(cell).toBeTruthy();
    fireEvent.click(cell!);

    expect(client.saves).toEqual([{ cell: 'W|spell', files: [TAKE_A.file] }]);
  });

  it('dragging a placed take to another cell sends two PUTs: source, then target', async () => {
    const client = stubClient({ cells: { 'W|spell': [TAKE_A.file] }, canEdit: true });
    const { container } = render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    showColours();

    const source = container.querySelector('[data-cell="W|spell"]')!;
    const target = container.querySelector('[data-cell="U|spell"]')!;
    const placedPill = source.querySelector('.sound-builder__pill--placed')!;

    const dt = dataTransferStub();
    fireEvent.dragStart(placedPill, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    expect(client.saves).toEqual([
      { cell: 'W|spell', files: [] },
      { cell: 'U|spell', files: [TAKE_A.file] },
    ]);
  });

  it('the × on a placed take removes it with one PUT', async () => {
    const client = stubClient({ cells: { 'W|spell': [TAKE_A.file, TAKE_B.file] }, canEdit: true });
    const { container } = render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    showColours();

    const cell = container.querySelector('[data-cell="W|spell"]')!;
    const remove = screen.getByRole('button', { name: `Remove ${TAKE_A.label}` });
    fireEvent.click(remove);

    expect(client.saves).toEqual([{ cell: 'W|spell', files: [TAKE_B.file] }]);
    expect(cell.querySelector(`[title="${TAKE_A.prompt}"]`)).toBeNull();
  });

  it('marks a cell unsaved, with no text, when the save fails', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    client.save = async () => null;
    const { container } = render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    showColours();

    const pill = screen.getByRole('button', { name: /Water · 1: play and pick up/ });
    fireEvent.click(pill);
    const cell = container.querySelector('[data-cell="W|spell"]')!;
    fireEvent.click(cell);

    await vi.waitFor(() => expect(cell.getAttribute('data-unsaved')).toBe(''));
    // The ONLY content is the pill the click placed (its ▶ sits with its level, beside the cell) —
    // no extra banner node explaining the failure in words.
    expect(cell.children.length).toBe(1);
    expect(cell.querySelector('.sound-builder__hint')).toBeNull();
  });

  it('a mono row has a Basic land cell, hinted with its basic, beside its Land; other rows have no basic', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    const { container } = render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    showColours();

    expect(container.querySelector('[data-cell="W|basic"]')!.textContent).toBe('Plains');
    expect(container.querySelector('[data-cell="W|land"]')!.textContent).toBe('');
    expect(container.querySelector('[data-cell="WU|land"]')).not.toBeNull();
    expect(container.querySelector('[data-cell="WU|basic"]')).toBeNull();
    expect(container.querySelectorAll('[data-cell$="|basic"]')).toHaveLength(5);
  });

  it('Delete retires the take in hand as bad, Shift+Delete as broken: out of the bin and every cell, with an Undo', async () => {
    const client = stubClient({ cells: { 'W|spell': [TAKE_A.file, TAKE_B.file] }, canEdit: true });
    const { container } = render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    showColours();

    fireEvent.click(screen.getByRole('button', { name: /Water · 1: play and pick up/ }));
    fireEvent.keyDown(document, { key: 'Delete' });
    await act(async () => undefined);
    expect(client.retires).toEqual([{ file: TAKE_A.file, reason: 'bad' }]);
    expect(screen.queryByRole('button', { name: /Water · 1: play and pick up/ })).toBeNull();
    expect(container.querySelector('[data-cell="W|spell"]')!.textContent).not.toContain('Water · 1');
    expect(screen.getByTestId('sound-retired').getAttribute('data-reason')).toBe('bad');

    await act(async () => {
      fireEvent.click(screen.getByTestId('sound-retired-undo'));
    });
    expect(screen.getByRole('button', { name: /Water · 1: play and pick up/ })).toBeTruthy();
    expect(container.querySelector('[data-cell="W|spell"]')!.textContent).toContain('Water · 1');

    fireEvent.click(screen.getByRole('button', { name: /Water · 2: play and pick up/ }));
    fireEvent.keyDown(document, { key: 'Delete', shiftKey: true });
    await act(async () => undefined);
    expect(client.retires.at(-1)).toEqual({ file: TAKE_B.file, reason: 'broken' });
  });

  it('middle-click marks a take keep, right-click delete, the same click again clears it; the queue never offers a delete', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    const pill = (): HTMLElement => screen.getByRole('button', { name: /Water · 1: play and pick up/ });
    fireEvent(pill(), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(pill().getAttribute('data-mark')).toBe('keep');
    fireEvent.contextMenu(pill());
    expect(pill().getAttribute('data-mark')).toBe('trash');
    fireEvent.contextMenu(pill());
    expect(pill().getAttribute('data-mark')).toBeNull();
    fireEvent.contextMenu(pill());
    await act(async () => undefined);
    expect(client.marked).toEqual([
      { file: TAKE_A.file, mark: 'keep' },
      { file: TAKE_A.file, mark: 'trash' },
      { file: TAKE_A.file, mark: null },
      { file: TAKE_A.file, mark: 'trash' },
    ]);
    // Marking is not picking up, and not deleting.
    expect(pill().getAttribute('aria-pressed')).toBe('false');
    expect(client.retires).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    expect(screen.getAllByTestId('sound-queue-choice').map((c) => c.getAttribute('data-file'))).not.toContain(TAKE_A.file);
  });

  it('Delete does nothing with no take in hand, or while typing in the search', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    fireEvent.keyDown(document, { key: 'Delete' });
    fireEvent.click(screen.getByRole('button', { name: /Water · 1: play and pick up/ }));
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Backspace' });
    await act(async () => undefined);
    expect(client.retires).toEqual([]);
  });

  it('the queue shows a prompt without the generator’s stock tail', () => {
    expect(promptGist('Fingertip brushing a card, close-mic, dry. High-quality, stereo, 44.1kHz, sound effect.')).toBe(
      'Fingertip brushing a card, close-mic, dry',
    );
    expect(promptGist('A triumphant chord.')).toBe('A triumphant chord.');
  });

  describe('the queue', () => {
    async function openQueue(client: ReturnType<typeof stubClient>, player = stubPlayer()) {
      render(createElement(SoundBuilder, { client, player }));
      await screen.findByText('Sound Builder');
      fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
      return player;
    }
    // The order is random (2026-10-10): read the cell and its choices off the screen.
    const current = (): string => screen.getByTestId('sound-queue').getAttribute('data-cell') ?? '';
    const files = (): string[] => screen.getAllByTestId('sound-queue-choice').map((c) => c.getAttribute('data-file') ?? '');

    it('serves an empty cell; a number only plays, Space picks the take last heard, Enter places and moves on', async () => {
      const client = stubClient({ cells: {}, canEdit: true });
      const player = await openQueue(client);
      const cell = current();
      const offered = files();
      expect([...offered].sort()).toEqual([TAKE_A.file, TAKE_B.file]);
      const picks = screen.getAllByTestId('sound-queue-pick');

      fireEvent.keyDown(document, { key: '2' });
      expect(player.playFile).toHaveBeenCalledWith(offered[1]);
      expect(picks[1]!.getAttribute('aria-pressed'), 'hearing is not picking').toBe('false');
      fireEvent.keyDown(document, { key: ' ' });
      expect(picks[1]!.getAttribute('aria-pressed')).toBe('true');
      fireEvent.keyDown(document, { key: '1' });
      fireEvent.keyDown(document, { key: ' ' });
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Enter' });
      });
      // In the order offered, not the order picked.
      expect(client.saves).toEqual([{ cell, files: offered }]);
      expect(current()).not.toBe(cell);
    });

    it('a card click only plays, its check picks and unpicks; none picked moves on, a skip moves on too', async () => {
      const client = stubClient({ cells: {}, canEdit: true });
      const player = await openQueue(client);
      const first = current();
      fireEvent.click(screen.getAllByTestId('sound-queue-choice')[0]!);
      expect(player.playFile).toHaveBeenCalledWith(files()[0]);
      expect((screen.getByTestId('sound-queue-place') as HTMLButtonElement).disabled, 'a click to listen picks nothing').toBe(true);
      fireEvent.click(screen.getAllByTestId('sound-queue-pick')[0]!);
      expect((screen.getByTestId('sound-queue-place') as HTMLButtonElement).textContent).toContain('1');
      fireEvent.click(screen.getAllByTestId('sound-queue-pick')[0]!);
      expect((screen.getByTestId('sound-queue-place') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.keyDown(document, { key: 'Enter' });
      const second = current();
      expect(second).not.toBe(first);
      fireEvent.keyDown(document, { key: 's' });
      const third = current();
      expect(third).not.toBe(second);
      fireEvent.click(screen.getByTestId('sound-queue-skip'));
      expect(current()).not.toBe(third);
      expect(client.saves).toEqual([]);
    });

    it('Delete throws out the take last heard, logged as bad (Shift: broken), and it leaves the choice', async () => {
      const client = stubClient({ cells: {}, canEdit: true });
      await openQueue(client);
      fireEvent.keyDown(document, { key: 'Delete' });
      expect(client.retires).toEqual([]);
      const heard = files()[0]!;
      fireEvent.keyDown(document, { key: '1' });
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Delete', shiftKey: true });
      });
      expect(client.retires).toEqual([{ file: heard, reason: 'broken' }]);
      expect(files()).not.toContain(heard);
    });
  });

  it('the ▶ on a filled cell plays it even with a take in hand, and places nothing', async () => {
    const client = stubClient({ cells: { 'W|spell': [TAKE_A.file] }, canEdit: true });
    const player = stubPlayer();
    const { container } = render(createElement(SoundBuilder, { client, player }));
    await screen.findByText('Sound Builder');
    showColours();

    fireEvent.click(screen.getByRole('button', { name: /Water · 1: play and pick up/ }));
    player.playFile.mockClear();
    const cell = container.querySelector('[data-cell="W|spell"]')!;
    // The ▶ shares a line with the level, under the cell's takes (2026-10-10).
    const play = within(cell.closest('td')!).getByRole('button', { name: /Play one of 1 at random/ });
    expect(play.closest('.sound-builder__ctl')!.querySelector('input[type="range"]')).not.toBeNull();
    fireEvent.click(play);
    expect(player.playFile).toHaveBeenCalledWith(TAKE_A.file, 1);
    expect(client.saves).toEqual([]);
  });

  it('opens on the roles, and a take placed on a role saves that role cell', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    const { container } = render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');
    expect(container.querySelector('[data-cell="W|spell"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Water · 1: play and pick up/ }));
    fireEvent.click(container.querySelector('[data-cell="g.draw|play"]')!);
    expect(client.saves).toEqual([{ cell: 'g.draw|play', files: [TAKE_A.file] }]);
  });

  it("a filled cell's gain commits once on release, with its files", async () => {
    const client = stubClient({ cells: { 'g.draw|play': [TAKE_A.file] }, gains: { 'g.draw|play': 0.5 }, canEdit: true });
    render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');

    const slider = screen.getByRole('slider', { name: 'Draw gain' }) as HTMLInputElement;
    expect(slider.value).toBe('0.5');
    fireEvent.change(slider, { target: { value: '0.8' } });
    fireEvent.change(slider, { target: { value: '0.9' } });
    expect(client.saves).toEqual([]);
    fireEvent.pointerUp(slider);
    expect(client.saves).toEqual([{ cell: 'g.draw|play', files: [TAKE_A.file], gain: 0.9 }]);
  });

  it("a role's name filters the bin to the takes written for it", async () => {
    const roleTake = { ...TAKE_B, file: 'ui.select/take-v1-5000.ogg', name: 'Select', label: 'Select · 1a', prompt: 'a click' };
    const client = stubClient({ cells: {}, canEdit: true }, [TAKE_A, roleTake]);
    render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');

    fireEvent.click(screen.getByRole('button', { name: 'Show takes for Select' }));
    expect(screen.getByRole('button', { name: /Select · 1a: play and pick up/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Water · 1: play and pick up/ })).toBeNull();
  });

  it('the search and the unplaced filter narrow the bin', async () => {
    const client = stubClient({ cells: { 'g.draw|play': [TAKE_A.file] }, canEdit: true });
    render(createElement(SoundBuilder, { client, player: stubPlayer() }));
    await screen.findByText('Sound Builder');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Unplaced' }));
    expect(screen.queryByRole('button', { name: /Water · 1: play and pick up/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Water · 2: play and pick up/ })).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search takes' }), { target: { value: 'brook' } });
    expect(screen.queryByRole('button', { name: /Water · 2: play and pick up/ })).toBeNull();
  });
});
