// Loaded before every unit file (root `vitest.config.ts` `setupFiles`). Two
// knobs, both about a CI runner running `check` beside three e2e shards and a jvm job.
import { setImmediate } from 'node:timers';

import { configure } from '@testing-library/dom';
import { afterEach } from 'vitest';

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
