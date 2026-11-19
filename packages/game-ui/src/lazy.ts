/*
 * Code the first screen does not need, loaded when it is first drawn, or earlier on purpose.
 *
 * The page's entry is the lobby and the chrome around every screen; each other screen, and the
 * lobby's featured board, is a chunk of its own (`screens/Screen.tsx`, `front/LiveSlot.tsx`), with
 * the big data tables in long-lived chunks beside them (`vite.config.ts`). A chunk loads the first
 * time its component draws, or before, from `preload()`: the screens a player opens next are warmed
 * once the page is idle (`main.tsx`), so a press rarely waits on the network.
 *
 * The mechanism is `@wolffm/rooms-client/react`'s `lazyComponent`, the platform's one copy (a
 * loaded module draws without suspending; a failed load reloads the page once for a new build,
 * guarded by a window so it never loops). This binds the app's storage key.
 */

import type { ComponentType } from 'react';
import { lazyComponent as platformLazy, LAZY_RELOAD_GUARD_MS, type LazyComponent } from '@wolffm/rooms-client/react';
import { appId } from '@hadoku/ui-shell/app-id';

export type { LazyComponent };

/** How soon after a reload another failed chunk is a real failure rather than a deploy. */
export const RELOAD_GUARD_MS = LAZY_RELOAD_GUARD_MS;

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): LazyComponent<P> {
  return platformLazy(load, { storageKey: () => `${appId()}:reloaded-for-chunk` });
}
