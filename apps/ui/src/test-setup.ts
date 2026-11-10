// Loaded before every unit file (root `vitest.config.ts` `setupFiles`). Two
// knobs, both about a CI runner running `check` beside three e2e shards and a jvm job,
// and the shell's app id, which `main.tsx` and `embed/index.tsx` set before anything renders.
import { setImmediate } from 'node:timers';

import { configureShell } from '@hadoku/ui-shell/app-id';
import { configure } from '@testing-library/dom';
import { afterEach, beforeAll, beforeEach, expect } from 'vitest';

import { APP_ID } from '../app-name.ts';

configureShell({ appId: APP_ID });

// Every UI test sees the game wired as the app wires it (`./composition.tsx`). Imported once the test file
// has been, so the parts registered are the ones its own `vi.mock`s replaced. A file that replaced a
// registering module outright (a factory with no `register…`) has opted out of that part, and of the ones after it:
// `play/live/matchStart.test.ts` (route.ts, sound/index.ts), `screens/roomSounds.test.ts` and
// `screens/gauntlet/sounds.test.ts` (sound/index.ts).
beforeAll(async () => {
  if (expect.getState().testPath?.includes('/apps/ui/src/') !== true) return;
  try {
    (await import('./composition.tsx')).composeGame();
  } catch (error) {
    if (!/^\[vitest\] No "register\w+" export is defined on the .* mock/.test(String((error as Error).message))) throw error;
  }
});

// testing-library's `waitFor` default of 1 s is a hang detector locally and a
// load detector there — the same frame-timing case that reddened the deploy gate
// twice on d460e2d (2026-10-08) was green in 421 ms locally. Under CI the wait is
// five seconds; a test that passes its own `{ timeout }` keeps it.
configure({ asyncUtilTimeout: process.env.CI ? 5_000 : 1_000 });

// Every test ends on an event-loop turn. Vitest runs a file's tests as one chain
// of promises, and a file of synchronous renders never yields a macrotask between
// them, so a reply from the main thread to anything the worker asked mid-file —
// a module a component imports lazily, the runner's own task updates — sits
// unread until the file ends. Its 60 s RPC timer is read first: Board.test.ts
// ran 64 s on a CI runner and threw 13 unhandled `Timeout calling "fetch"` (the lazy
// artist table) and `"onTaskUpdate"` errors after every test passed (0b7196e,
// 2026-10-12). `node:timers` is the real setImmediate, not a test's fake one.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

// Every test starts on the app's own page. A room's page is a PATH (`screens/route.ts`), which a
// test's `location.hash = ''` would not reset, so one test's room would be the next one's start.
beforeEach(() => {
  if (typeof history !== 'undefined') history.replaceState(null, '', '/');
});
