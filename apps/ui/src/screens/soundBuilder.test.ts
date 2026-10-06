// @vitest-environment jsdom
/*
 * The sound builder, driven through its own props — a stub `SoundsClient` and
 * a stub `AudioPool`, never a real fetch or a real `<audio>`. What this pins:
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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SoundBuilder } from './SoundBuilder.tsx';
import type { Assignments, AudioPool, SoundsClient } from '../sound/builderClient.ts';

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

function stubClient(assignments: Assignments, takes = [TAKE_A, TAKE_B]): SoundsClient & { saves: { cell: string; files: string[] }[] } {
  const saves: { cell: string; files: string[] }[] = [];
  return {
    saves,
    async catalogue() {
      return takes;
    },
    async assignments() {
      return assignments;
    },
    async save(cell, files) {
      saves.push({ cell, files: [...files] });
      return [...files];
    },
    takeUrl(file) {
      return `/api/sounds/takes/${file}`;
    },
  };
}

function stubPool(): AudioPool {
  return { play: vi.fn(async () => undefined) };
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
      save: vi.fn(async (_cell, files) => [...files]),
      takeUrl: (file) => file,
    };

    const { container } = render(createElement(SoundBuilder, { client, audioPool: stubPool() }));
    expect(client.catalogue).toHaveBeenCalledTimes(1);
    expect(client.assignments).toHaveBeenCalledTimes(1);
    expect(assignmentsResolved).toBe(false); // nothing has resolved yet — the render above proves nothing

    await act(async () => {
      gate.resolve({ cells: {}, canEdit: false });
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
    render(createElement(SoundBuilder, { client, audioPool: stubPool() }));
    expect(await screen.findByText('Sound Builder')).toBeTruthy();
    expect(screen.getByText('2', { selector: 'b' })).toBeTruthy(); // "2 keepers"
  });

  it('click a pill then click a cell sends one PUT with the new list', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    const pool = stubPool();
    const { container } = render(createElement(SoundBuilder, { client, audioPool: pool }));
    await screen.findByText('Sound Builder');

    const pill = screen.getByRole('button', { name: /Water · 1: play and pick up/ });
    fireEvent.click(pill);
    expect(pool.play).toHaveBeenCalledWith(TAKE_A.file);
    expect(pill.getAttribute('aria-pressed')).toBe('true');

    const cell = container.querySelector('[data-cell="W|spell"]');
    expect(cell).toBeTruthy();
    fireEvent.click(cell!);

    expect(client.saves).toEqual([{ cell: 'W|spell', files: [TAKE_A.file] }]);
  });

  it('dragging a placed take to another cell sends two PUTs: source, then target', async () => {
    const client = stubClient({ cells: { 'W|spell': [TAKE_A.file] }, canEdit: true });
    const { container } = render(createElement(SoundBuilder, { client, audioPool: stubPool() }));
    await screen.findByText('Sound Builder');

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
    const { container } = render(createElement(SoundBuilder, { client, audioPool: stubPool() }));
    await screen.findByText('Sound Builder');

    const cell = container.querySelector('[data-cell="W|spell"]')!;
    const remove = screen.getByRole('button', { name: `Remove ${TAKE_A.label}` });
    fireEvent.click(remove);

    expect(client.saves).toEqual([{ cell: 'W|spell', files: [TAKE_B.file] }]);
    expect(cell.querySelector(`[title="${TAKE_A.prompt}"]`)).toBeNull();
  });

  it('marks a cell unsaved, with no text, when the save fails', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    client.save = async () => null;
    const { container } = render(createElement(SoundBuilder, { client, audioPool: stubPool() }));
    await screen.findByText('Sound Builder');

    const pill = screen.getByRole('button', { name: /Water · 1: play and pick up/ });
    fireEvent.click(pill);
    const cell = container.querySelector('[data-cell="W|spell"]')!;
    fireEvent.click(cell);

    await vi.waitFor(() => expect(cell.getAttribute('data-unsaved')).toBe(''));
    // The ONLY content is the pill the click placed and the random-play button —
    // no extra banner node explaining the failure in words.
    expect(cell.children.length).toBe(2);
    expect(cell.querySelector('.sound-builder__hint')).toBeNull();
  });

  it('a mono identity\'s Land cell is hinted with its basic land name when empty', async () => {
    const client = stubClient({ cells: {}, canEdit: true });
    const { container } = render(createElement(SoundBuilder, { client, audioPool: stubPool() }));
    await screen.findByText('Sound Builder');

    const landCell = container.querySelector('[data-cell="W|land"]')!;
    expect(landCell.textContent).toBe('Plains');
  });
});
