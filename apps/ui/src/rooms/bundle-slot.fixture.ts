/**
 * A real `GameBundleModule` for `BundleSlot.test.ts`, loaded by the same relative specifier
 * `BundleSlot` loads any bundle by (`import(src)`, where the test's `src` prop names this file).
 * `mount` records every call it gets into `calls`, so the test can assert on the context it was
 * handed; `ctx.roomKey === 'throw'` makes `mount` itself throw, to prove `BundleSlot` reports a
 * failed mount through its own error UI rather than crashing.
 */

import type { GameBundleContext, MountedGameBundle } from '@wolffm/rooms-protocol';

export type FixtureCall = ['mount', GameBundleContext] | ['update', GameBundleContext] | ['unmount', string];

export const calls: FixtureCall[] = [];

export async function mount(_el: HTMLElement, ctx: GameBundleContext): Promise<MountedGameBundle> {
  calls.push(['mount', ctx]);
  if (ctx.roomKey === 'throw') throw new Error('mount exploded');
  return {
    update(next: GameBundleContext) {
      calls.push(['update', next]);
    },
    unmount() {
      calls.push(['unmount', ctx.roomKey]);
    },
  };
}
