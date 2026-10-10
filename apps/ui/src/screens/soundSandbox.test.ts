// @vitest-environment jsdom
/*
 * The sandbox, driven through its props: a stub client and a stub mixer whose
 * `play` records the events it was handed. What this pins is the wiring — a
 * scenario's beats reach the mixer as role + colour layer + seat, on time —
 * since what the mixer then does with an event is `sound/mix.test.ts`'s job.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SoundSandbox } from './SoundSandbox.tsx';
import type { SoundsClient } from '../sound/builderClient.ts';
import { createMixPlanner, DEFAULT_MIX, type SoundEvent } from '../sound/mix.ts';
import type { Mixer } from '../sound/mixer.ts';
import { SCENARIOS } from '../sound/scenarios.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TAKE = {
  file: 'lib-water/take-1.ogg',
  sound: 'lib-water',
  name: 'Water',
  group: 'Water',
  section: 'Library' as const,
  label: 'Water · 1',
  seconds: 1.2,
  prompt: 'a brook',
};

function stubClient(canEdit: boolean, cells: Record<string, string[]> = {}) {
  const saves: { cell: string; files: string[]; gain?: number }[] = [];
  const client: SoundsClient = {
    catalogue: async () => [TAKE],
    assignments: async () => ({ cells, gains: {}, canEdit }),
    save: async (cell, files, gain) => {
      saves.push({ cell, files: [...files], gain });
      return { files: [...files], gain: gain ?? 1 };
    },
    retire: async () => [],
    restore: async () => true,
    takeUrl: (f) => f,
  };
  return { client, saves };
}

function stubMixer() {
  const events: SoundEvent[] = [];
  const planner = createMixPlanner(() => 0);
  const mixer: Mixer = {
    planner,
    settings: DEFAULT_MIX,
    play: (event) => {
      events.push(event);
      return planner.plan(event, events.length * 1000, DEFAULT_MIX);
    },
    playFile: vi.fn(),
    preload: vi.fn(),
    setLevels: vi.fn(),
    loop: vi.fn(),
  };
  return { mixer, events };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SoundSandbox', () => {
  it('renders nothing for a non-admin', async () => {
    const { client } = stubClient(false);
    const { container } = render(createElement(SoundSandbox, { client, mixer: stubMixer().mixer }));
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('plays every beat of the chosen scenario through the mixer, layered with the seat identities', async () => {
    vi.useFakeTimers();
    const { client } = stubClient(true);
    const { mixer, events } = stubMixer();
    render(createElement(SoundSandbox, { client, mixer }));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'A quiet turn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    const quiet = SCENARIOS.find((s) => s.id === 'quiet-turn')!;
    await act(async () => {
      vi.advanceTimersByTime(quiet.beats.at(-1)!.at + 10);
    });

    expect(events).toHaveLength(quiet.beats.length);
    expect(events).toContainEqual({ role: 'g.land', colourCell: 'RG|land', seat: 'me' });
    expect(events).toContainEqual({ role: 'g.creature', colourCell: 'RG|creature', seat: 'me' });
  });

  it("a row's ▶ fires that beat alone, and shows the take it played", async () => {
    const { client } = stubClient(true, { 'g.game-start|play': [TAKE.file] });
    const { mixer, events } = stubMixer();
    render(createElement(SoundSandbox, { client, mixer }));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Fire Coin toss' }));
    expect(events).toEqual([{ role: 'g.game-start', colourCell: null, seat: 'me' }]);
    expect(screen.getByText('Water · 1')).toBeTruthy();
  });

  it('a gain moved in a row saves that cell with its files', async () => {
    const { client, saves } = stubClient(true, { 'g.game-start|play': [TAKE.file] });
    render(createElement(SoundSandbox, { client, mixer: stubMixer().mixer }));
    await flush();

    const slider = screen.getByRole('slider', { name: 'g.game-start|play gain' });
    fireEvent.change(slider, { target: { value: '1.4' } });
    fireEvent.pointerUp(slider);
    await flush();
    expect(saves).toEqual([{ cell: 'g.game-start|play', files: [TAKE.file], gain: 1.4 }]);
  });
});
