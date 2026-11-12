/*
 * The relay channel's own e2e fixture, and only it. `relay-test` is never a real room type a player can
 * pick — the server's own `relay-test` (`apps/server/src/plugins/relay.ts`) is registered only
 * behind `CARDTABLE_PLAY_PROBE=1`, never in production — so this client-side registration needs
 * the same kind of fence, but a browser bundle has no env var to read. `e2e/relay-fixture.spec.ts`
 * sets `window.__CARDTABLE_E2E_RELAY_TEST__` with Playwright's `addInitScript`, BEFORE this
 * module (statically imported by `./BundleSlot.tsx`, reachable from `rooms/games/bomberman.tsx` →
 * `composition.tsx`, eagerly imported at boot) ever evaluates, so the flag is in place the moment
 * this line runs. Never set outside that one spec: this module's own body is dead code for every
 * real player and every other test — the import always ships (same chunk as `BundleSlot.tsx`), but
 * the registrations it makes never run unless the flag is already true.
 */
import { BundleSlot } from './BundleSlot.tsx';
import { registerGameRoomUi } from './game-setup.ts';
// A relative cross-package import, not a bare `@hadoku/shared` specifier — see `BundleSlot.tsx`'s
// own comment on `gameTypeSpec`/`registerGameType` for why.
import { registerGameType } from '../../../../packages/shared/src/game-type-spec.ts';

declare global {
  interface Window {
    __CARDTABLE_E2E_RELAY_TEST__?: boolean;
  }
}

if (typeof window !== 'undefined' && window.__CARDTABLE_E2E_RELAY_TEST__ === true) {
  registerGameType({
    id: 'relay-test',
    runtime: 'relay',
    seats: { min: 2, max: 2 },
    ready: false,
    series: { length: 1 },
    canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
  });
  registerGameRoomUi('relay-test', {
    game: (p) => <BundleSlot src="/relay-fixture/relay-test-embed.js" view={p.view} me={p.me} />,
  });
}
