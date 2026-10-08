// Loaded before every unit file (root `vitest.config.ts` `setupFiles`). One
// knob: testing-library's `waitFor` default of 1 s is a hang detector locally and
// a load detector on a claw running `check` beside three e2e shards and a jvm
// job — the same frame-timing case that reddened the deploy gate twice on
// d460e2d (2026-10-08) was green in 421 ms locally. Under CI the wait is five
// seconds; a test that passes its own `{ timeout }` keeps it.
import { configure } from '@testing-library/dom';

configure({ asyncUtilTimeout: process.env.CI ? 5_000 : 1_000 });
