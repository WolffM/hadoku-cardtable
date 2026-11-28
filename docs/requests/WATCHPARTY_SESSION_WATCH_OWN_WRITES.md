# Request to hadoku-watchparty: the session watch holds still while the page changes its own session

**From:** hadoku-cardtable
**Status:** request / not yet agreed
**Asking for:** `@wolffm/rooms-client`'s session watch (`packages/rooms-client/src/sessionWatch.ts`, 0.45.143)
to take the change cardtable made to its own copy (`packages/ui-shell/src/session/index.ts`,
hadoku-cardtable#110), so cardtable's switch to rooms-client on 2026-11-30 keeps the fix.

**What breaks today:** Delete account → Delete for good in the fleet header posts
`/session/account/delete` with the page's own `fetch`. The session ends before that answers (1.3 s and
more on 2026-11-27, hadoku_site's `deletion.spec.ts` on cardtable-ppe), so the page's requests and socket
handshakes meet the edge's 401, the watch's probe confirms it, and `lose()` reloads the page. The reload
cuts the delete off before the header's `location.assign('/')`, and the sign-in wall makes the browser a
brand-new guest. A sign-in with a key or a passkey from the header (`/auth/sign-in`, `/session/create`)
races the same way. rooms-client's `lose()` and `suspect()` are the same as cardtable's were, so a
watchparty page does it too.

**The change** (cardtable's, ~45 lines with its tests):

- `SESSION_SERVICE_PATHS = ['/session/', '/auth/']` and `SESSION_WRITE_HOLD_MS` (= `PROBE_GAP_MS`).
- In the `fetch` wrapper, before the scope check: a same-origin request whose method is not GET/HEAD
  under one of those paths is the page's own session write. While one is in flight, and for
  `SESSION_WRITE_HOLD_MS` after one answers 2xx, `suspect()` probes nothing and `lose()` does nothing.
  A write that fails or throws holds nothing past its answer.
- rooms-client has one watch per scope on a page (`watches()`): the hold is the page's, not one watch's,
  so keep the in-flight count and the hold's end beside `watches()` and have every watch read them (the
  wrapper that sees the write may be any of the stacked ones).

**Tests cardtable added** (`packages/ui-shell/src/session/index.test.ts`, "a session the page changes
itself"): a delete in flight with the edge refusing (no probe, no reload, sockets kept); a probe already
asking when the delete starts (its 401 stops nothing); a failed delete (the next loss still reloads); a
key sign-in (held, then armed again after the hold); a GET under `/session/` holds nothing. The e2e is
`e2e/session-delete.spec.ts`, against a stand-in edge whose delete answers 2.5 s late.

**Not asking for** any change to how a lost session is handled, or to the header: the header's writes
already go through the page's `fetch`, which is what lets the watch see them without the header knowing
it exists.
