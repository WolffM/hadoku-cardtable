# e2e — two friends, one pod, a real browser each

PR-2 had been "built end to end, unproven with two people" for four waves. This
directory is the proof. Two independent Chromium contexts, with separate cookie
jars, identities and sockets, drive the **built** UI bundle against the
**built** server through a whole draft: join by invite link, pick, pass, wheel,
refresh mid-draft, finish. Every draft envelope each browser receives is
captured as raw text and checked for isolation.

It is a measurement. It changes no product code.

## Run it

```sh
# from the repo root, once the workspace diffs below are applied
pnpm e2e
```

That builds `@hadoku/ui` and `@hadoku/server`, then runs `@hadoku/e2e`'s
`test`, which runs two things in order:

| step | what | needs |
| --- | --- | --- |
| `node --test isolation.test.ts` | the checker against committed fixtures, including the mutations that must fail | Node 24 only |
| `playwright test -c playwright.config.ts` | the browser run | built `apps/*/dist`, Chromium |

The browser is Playwright 1.62.1's Chromium (revision 1234, headless shell).
If it is not in `~/.cache/ms-playwright`, install it once:
`pnpm --filter @hadoku/e2e exec playwright install chromium`. Don't use
`--with-deps`: it calls `apt` through sudo, and D14 rules out host mutation.

A run takes about 75 seconds. Most of that is pacing. The server allows a burst
of 8 picks, then one every 1.5 s per participant (`PICK_RATE_LIMIT`), and the
driver picks every 1.6 s so it never trips that limit.

Ports are 19108 (edge) and 19008 (server). Override them with
`CARDTABLE_E2E_EDGE_PORT` and `CARDTABLE_E2E_SERVER_PORT` if two runs share a
host.

## What runs

```
browser ctx "alice" ─┐
                     ├─► edge.ts :19108  /cardtable/* → strip prefix, stamp identity
browser ctx "bob"   ─┘        │
                              ▼
                     apps/server/dist/index.js :19008  (EDGE_AUTH_SECRET = random per run)
                     serving a COPY of apps/ui/dist
```

- **`harness.ts`** is Playwright's `webServer`. It starts the built server in
  the production posture: a real `EDGE_AUTH_SECRET`, minted per run, with **no**
  `CARDTABLE_INSECURE_NO_EDGE_AUTH`. That dev escape hatch would not even have
  worked here. It gives every header-less caller the same `local-dev` id, so
  the two contexts would have been one participant.
- **`edge.ts`** stands in for edge-router. It routes only `/cardtable/*` and
  strips the prefix. It deletes any identity header the browser sent, resolves
  the caller from a session cookie (`identities.ts`), and stamps `X-Edge-Auth`,
  tier, `X-User-Id` and `X-User-Key`. It does this for the websocket upgrade as
  well as for HTTP.
- The bundle is served from a temp copy. That stops a concurrent `vite build`
  from emptying `dist/` mid-run. It also works around `send`, which 404s any
  path with a dot-directory in it, such as `.claude/worktrees/…` (see Findings).

## What is asserted

**The gate** (test 1). With no session, the page is a 404. Forged identity
headers get a 404 through the edge, and a 404 when sent straight to the server
around it. A socket.io namespace connect gets `44{"message":"not found"}` with
no session and with an unknown one, and `40{"sid":…}` as alice. `/api/whoami`
as alice returns `{userId:"e2e-alice", tier:"friend"}`.

**The draft** (test 2):

- **Join.** Alice joins through the lobby's join box. Bob opens the invite link
  she was shown. Both see `2 people · 6 bots of 8 seats`, alice as seat 0 and
  bob as seat 1, with distinct participant ids.
- **Pick.** Before every pick, the pack on screen must equal the pack in the
  latest envelope. The driver takes the lowest card id, then waits for the
  server's own envelope confirming the pick before it looks at anything else.
- **Pass.** Seats 0 and 1 are neighbours. After every pick, one of them hands
  the other exactly its pack minus the card taken, read off the wire. Which one
  does the handing must flip each pack (left, right, left).
- **Wheel.** A seat's pack at pick k+8 is a subset of its pack at pick k. It is
  exactly 8 cards smaller and no longer holds the card taken at k.
- **Refresh.** After pick 20, alice's page reloads. The first `state` snapshot
  after the reload must name the same seat and exactly the same 20-card pool.
  The UI's pool count must read 20, and bob's view must seat the same
  participant.
- **Finish.** Each server pool is 45 cards, equal to the cards that browser
  clicked, in click order. The "Draft complete" list shows exactly those names.
  The server refused no pick: no `error` envelope at all.
- **Isolation.** `isolation.ts` checks every envelope both browsers received
  (below).
- **Art.** External requests are blocked. Every blocked request must be for
  `cdn.hadoku.me` or `cards.scryfall.io`.

Evidence goes to `e2e/.run/`, which is gitignored and text only:
`{alice,bob}.captures.json` (every raw frame), `server.jsonl` (the server's
structured log) and `summary.json`.

## The isolation check

`isolation.ts` is pure. It runs over each context's full log of server→client
envelopes, whether they arrived as websocket frames or long-polling bodies:

1. **Positional.** A card may appear only at `view.viewer.pack[i]` or
   `view.viewer.pool[i]`. This uses `findCardPaths`, the walker from the UI's
   own hidden-info audit, over the whole envelope.
2. **Whose seat.** Every view names the recipient's seat.
3. **Disjoint at the same cursor.** For every `(epoch, seq)` both received, the
   cards in alice's envelope and the cards in bob's share nothing.
4. **Gone once taken.** Once a card is in the other seat's pool, no later
   envelope's raw text contains `"<cardId>"`. This catches a bare id in a field
   nobody named, not just a card-shaped object.

`isolation.test.ts` shows the check biting, against fixtures only. The fixture
`fixtures/two-seat-captures.json` holds the first 8 draft envelopes each context
received in a real run, unedited, cut by `make-fixture.ts`. Each mutation
re-serialises one captured frame the way socket.io would and must make the check
FAIL:

| fixture | verdict | detail |
| --- | --- | --- |
| real log | pass | 16 envelopes, 16 views, 240 cards, 5 pairs, 18 probes |
| bob's pack spliced into alice's frame at the same cursor | FAIL | `alice and bob both hold c67,…,c23 at cursor …:3` |
| one of bob's pack cards added to alice's pool | FAIL | `both hold c67` |
| bob's card in `view.seats[1].lastPick` | FAIL | `card at $.view.seats[1].lastPick` |
| bare id `"c12"` in `view.debug`, after bob took it | FAIL | `alice received c12 at seq 18, after bob had already taken it` |
| alice's frame addressed to seat 1 | FAIL | `view is for seat 1, expected 0` |
| alice's log empty | FAIL | `alice: received no draft envelopes at all` |

On the full live run it examines 276 envelopes, 8,355 card objects, 92
same-cursor pairs and 6,225 raw-token probes, and finds 0 violations. The spec
also asserts minimums on those counts, so a check that looked at nothing cannot
pass.

## Findings

Each finding comes from a live run, with the evidence file named. The first one
is not a failure; the other three are worth an owner's attention.

1. **Two people can draft a whole pod, and neither sees the other's cards.** The
   2 people + 6 bots pod runs to 45 picks each. Isolation holds over every
   envelope received. The seat and pool survive a refresh. The final pools are
   identical across runs (digests `2a2131959181e76f` / `2efa3f8728daeed8`).
2. **Every round is a gap followed by a resync.** A human pick that completes a
   round lets the bots pick at once (`runBots` in
   `apps/server/src/room/socket.ts`). That advances `seq` once per bot pick, but
   the room emits one update. So every browser classifies that update as a
   `gap`, drops it, and requests a snapshot. Measured: `serverPicks: 90`,
   `serverResyncs: 90`, 45 resync requests from each browser (one per round) in
   `summary.json`. In the server log: `pick … botPicks:6 seq:10`, then
   `resync have:{seq:3} at:{seq:18}`. The draft still completes. But the
   rarely-taken recovery path is the path every round takes, and each round
   costs an extra round trip before the next pack renders. This is not fixed
   here: this lane changes no product code.
3. **A real refresh does NOT exercise the `leaveRoom` guard.** In Chromium on
   loopback, the old socket's close lands 36 ms before the new socket joins:
   `disconnected … transport close guarded:false`, then `join seat:0
   changed:true`. The seat is held by the reservation, not by the guard. For
   about 80 ms bob sees seat 0 empty (one update, seq 190, with `occupant:
   null`). The guard (`draftRooms.test.ts` "the refresh hazard") is still
   covered only by its unit test. The ordering it protects against did not
   occur here.
4. **Minor, dev-only: `/health` is green while every page 404s.** This happens
   when the server runs from any path with a dot-directory in it, which includes
   every agent worktree (`.claude/worktrees/…`). express's `sendFile`/`static`
   (`send`, `dotfiles: 'ignore'`) answer 404 `Not Found`, while `/health` says
   `healthy` because `checkBasePath` reads `index.html` with `readFileSync`.
   Production serves from the main checkout, which has no dot segment, so it is
   not affected. The harness serves a temp copy.

Two other things are worth knowing:

- **Pick in the grid layout.** The fan overlaps cards on purpose, so a click at a
  card's centre lands on its neighbour unless you hover it first. The driver
  switches to the grid.
- **Polling vs websocket.** Nearly every envelope arrived over the websocket
  after the upgrade. One run delivered one envelope in a polling body. The
  polling parser is exercised by `isolation.test.ts` either way.

## Out-of-lane changes the manager must apply

Everything above lives in `e2e/**`. Wiring it into the repo needs these:

**`pnpm-workspace.yaml`**

```diff
 packages:
   - 'apps/*'
   - 'packages/*'
+  - 'e2e'
```

**`package.json`** (root), under `scripts`:

```diff
-    "build": "pnpm -r --if-present run build"
+    "build": "pnpm -r --if-present run build",
+    "e2e": "pnpm --filter @hadoku/ui build && pnpm --filter @hadoku/server build && pnpm --filter @hadoku/e2e test"
```

**`pnpm-lock.yaml`**: run `pnpm install` with the two changes above. The
expected delta against `HEAD`'s lockfile was measured with `pnpm install
--lockfile-only` on a copy. It is +54 lines: an `e2e` importer
(`@playwright/test 1.62.1`, `@types/node ^24.10.1 → 24.13.3`, `typescript ^5.9.3
→ 5.9.3`), plus `@playwright/test`, `playwright` and `playwright-core` 1.62.1
and optional `fsevents 2.3.2`. 1.62.1 was published 2026-07-30, so it clears
`minimumReleaseAge`.

**`eslint.config.js`**: `eslint .` currently lints only `e2e/isolation.test.ts`
(through `**/*.test.ts`). Add the rest to the relaxed tests/harness block:

```diff
       'scripts/**/*.{ts,js,mjs,cjs}',
+      'e2e/**/*.ts',
     ],
```

With that config, every file in `e2e/` lints with 0 errors and 0 warnings.

The root `typecheck` then picks up `@hadoku/e2e`'s `typecheck`
(`tsc --noEmit -p tsconfig.json`) through `pnpm -r --if-present`. It passes. That
was checked with this `tsconfig.json`, but with `@playwright/test` resolved
from an install outside the tree, because it is not installed here yet.
Root `vitest` does not collect `isolation.test.ts`: it uses `node:test`, and
the vitest config includes only `apps/*/src` and `packages/*/src`.

**`.github/workflows/ci.yml`**, after "Build the bundle":

```yaml
      - name: Build the server
        run: pnpm --filter @hadoku/server build

      # Idempotent. On the self-hosted runner the browser is cached in
      # ~/.cache/ms-playwright and this is a no-op. No --with-deps (D14).
      - name: E2E — browser
        run: pnpm --filter @hadoku/e2e exec playwright install chromium

      - name: E2E — two friends draft one pod
        run: pnpm --filter @hadoku/e2e test
```

So CI **does** need a browser-install step, though it costs nothing once the
cache is warm. The run adds about 1.5 minutes, well inside the job's 20-minute
timeout. The ports are fixed by default, so if two CI jobs can share a runner
host, give them distinct `CARDTABLE_E2E_*_PORT` values.
