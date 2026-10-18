# e2e — two friends, one pod, a real browser each

PR-2 had been "built end to end, unproven with two people" for four waves. This
directory is the proof. Two independent Chromium contexts, with separate cookie
jars, identities and sockets, drive the **built** UI bundle against the
**built** server through a whole draft — entering it the way a person does
since w23: one friend makes a **draft room** on the front page, the other finds
that room in the **room list** and enters it, both mark themselves ready, and
only then is the first pack dealt. Then pick, pass, wheel, refresh mid-draft,
finish. Every draft envelope each browser receives is captured as raw text and
checked for isolation.

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

The driver picks every 400 ms. The server allows a burst of 15 picks, then one
every 250 ms per participant (`PICK_RATE_LIMIT`), so the driver never comes
near that limit.

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
- **The room list persists between runs.** `harness.ts` leaves
  `CARDTABLE_ROOMS_DIR` unset, so the lobby's store lands under
  `e2e/.run/data/rooms` and yesterday's rooms are still listed today. Nothing is
  wrong with that — but it is why every lookup in the specs is by the
  `data-room-id` of the room that run created, and never by a row's position or
  by name alone.

## What is asserted

**The gate** (test 1). With no session, the page is a 404. Forged identity
headers get a 404 through the edge, and a 404 when sent straight to the server
around it. A socket.io namespace connect gets `44{"message":"not found"}` with
no session and with an unknown one, and `40{"sid":…}` as alice. `/api/whoami`
as alice returns `{userId:"e2e-alice-id", tier:"friend"}` — the id, not the
display name, which is `e2e-alice` (`identities.ts`).

**The draft** (test 2):

- **The door.** There is one, and this is the spec that drives it. Alice makes a
  draft room with the front page's create form (`room-create-type` = `draft`)
  and lands on `#/room/<id>`; the old "Start a pod" button and paste-an-id box
  are asserted **absent**. Bob opens the front page and enters that same room
  from the **room list**, located by its `data-room-id`. Neither of them ever
  types or pastes an id. The pod's `invite-url` is the room's own url, which is
  what keeps "an invite link still works" honest — and alice's mid-draft reload
  of that url is the end-to-end proof that following it lands you back in your
  seat.
- **The readiness gate.** Joining deals nothing. With bob already a member and
  only alice ready, `GET /api/rooms/:id` still reports `draftStartedAt: null`
  and neither page shows a pod. Both ready → the pod appears, `2 people · 6 bots
  of 8 seats`, with distinct participant ids. The gate is asserted on the room
  **record** as well as on screen, because the record is the gate; markup
  belongs to the room screen and can be restyled.
- **Seats are read off the wire.** The room id is server-minted (`r-<hex>`) and
  the id IS the engine's seed, so the pools differ from run to run. Both sockets
  connect the instant the draft is dealt, so which browser gets seat 0 is a
  race: each player's seat comes from `viewer.seatId`, and the tally, the
  refresh check and the isolation report are all keyed on that rather than on a
  hardcoded 0 and 1. What is **not** a race is the pair of seats. The draft is
  dealt with no humans, so all eight seats hold a bot, and `seatParticipant`
  (`@wolffm/rooms-protocol`, `seats.js`) therefore reaches its last resort — the
  lowest bot's seat — for every arrival. The two humans are always in seats 0
  and 1. That is asserted, and it is what keeps them adjacent for the pass check
  below.
- **Pick.** Before every pick, the pack on screen must equal the pack in the
  latest envelope. The driver takes the lowest card id, then waits for the
  server's own envelope confirming the pick before it looks at anything else.
- **Pass.** The two humans are neighbours (above), so after every pick one of
  them hands the other exactly its pack minus the card taken, read off the wire.
  Which one does the handing is **measured** rather than derived from a seat
  number — so it holds whichever of the pair each browser landed in — and it
  must flip each pack (left, right, left).
- **Wheel.** A seat's pack at pick k+8 is a subset of its pack at pick k. It is
  exactly 8 cards smaller and no longer holds the card taken at k.
- **Refresh.** After pick 20, alice's page reloads — the room url, which is also
  the invite url. The first `state` snapshot after the reload must name the same
  seat she already had and exactly the same 20-card pool. The UI's pool count
  must read 20, the tally must still name her seat, and that seat in the
  snapshot must still hold the same participant id.
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

`summary.json` changed with the new door. The old fixed `draftId` key is now
**`roomId`** — the server-minted room id, which is the pod id and the engine's
seed — and there is a new **`seats`** key recording which seat each browser
actually got, so a run can be read back without guessing. `pools` still holds a
digest per player, and it is still **reported and never asserted**: the seed is
now different every run, so a pinned digest would fail by design. If the seat
assertions ever go red, `seats` is the first field to read.

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

On the full live run it examined 276 envelopes, 8,355 card objects, 92
same-cursor pairs and 6,225 raw-token probes, and found 0 violations. Those
figures were measured under the old fixed-seed door and drift from run to run
now that the seed is minted per run; they are a sense of scale, not expected
values. What the spec asserts is **minimums** on those counts (90 views, 45
pairs, at least one probe), so a check that looked at nothing cannot pass.

## Findings

Each finding comes from a live run, with the evidence file named. The first one
is not a failure; the other three are worth an owner's attention.

1. **Two people can draft a whole pod, and neither sees the other's cards.** The
   2 people + 6 bots pod runs to 45 picks each. Isolation holds over every
   envelope received. The seat and pool survive a refresh. Since w23 they reach
   the pod through the room list and a readiness gate, and the pod is no longer
   dealt until both have readied.

   **The pools are no longer identical across runs, and that is the new door's
   doing, not a regression.** The pod id used to be the fixed `e2e-two-friends`,
   so the digests were stable (`2a2131959181e76f` / `2efa3f8728daeed8` in the
   runs that were measured). The room id is now minted per run and the id IS the
   seed, so every run deals a different draft. Nothing asserted those digests
   then and nothing does now — `summary.json` reports them. What replaced that
   determinism as the guard against a run that proves nothing is the minimums on
   the isolation counts (below) and the 45-picks-each pool assertions.
2. **Every round used to be a gap followed by a resync — FIXED, and this run is
   the proof.** A human pick that completes a round lets the bots pick at once
   (`runBots` in `apps/server/src/room/socket.ts`). That advances `seq` once per
   bot pick while the room emits one update, so every browser used to classify
   that update as a `gap`, drop it, and request a snapshot. Measured then:
   `serverPicks: 90`, `serverResyncs: 90`, 45 resync requests from each browser.
   In the server log: `pick … botPicks:6 seq:10`, then
   `resync have:{seq:3} at:{seq:18}`.

   `fe17cfd` ("a full-state update says so, and a seq jump on one no longer
   costs a resync") closed it. Measured again on 2026-09-27, after w23's
   rewrite: **`serverPicks: 90`, `serverResyncs: 0`, and `resyncsRequested`
   `{alice: 0, bob: 0}`** — with the bot batching unchanged (45 of the 90 `pick`
   lines still carry `botPicks: 6`). So the batching was never the defect; the
   gap classification was, and the recovery path is now rarely taken as
   intended. The counts are still reported in `summary.json` rather than
   asserted, so a regression here would show up as a number, not a red.
3. **A real refresh does NOT exercise the `leaveRoom` guard.** In Chromium on
   loopback, the old socket's close lands 36 ms before the new socket joins:
   `disconnected … transport close guarded:false`, then `join seat:0
   changed:true`. The seat is held by the reservation, not by the guard. For
   about 80 ms the other browser sees the refreshing player's seat empty (one
   update, seq 190, with `occupant: null`) — seat 0 in the run quoted here,
   though which seat that is now varies per run. The guard
   (`draftRooms.test.ts` "the refresh hazard") is still covered only by its unit
   test. The ordering it protects against did not occur here.
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

## The wiring, applied

This directory arrived with a list of changes outside `e2e/**` that it needed
before `pnpm e2e` would run at all: an `e2e` entry in `pnpm-workspace.yaml`, the
root `e2e` script, the lockfile's `e2e` importer, an `e2e/**/*.ts` glob in the
relaxed eslint block, and the browser-install plus spec steps in CI. **All of it
is applied** — `pnpm-workspace.yaml`, the root `package.json` `scripts.e2e`,
`eslint.config.js` and `.github/workflows/ci.yml` carry it today, which is why
`pnpm e2e` and `eslint .` both work from a clean checkout. Read those four files
for the current truth; the diffs that used to be quoted here were a to-do list,
and keeping them would have read as pending work that is in fact done.

Three consequences of that wiring are still worth knowing, because nothing else
states them:

- **CI does need a browser-install step** (`playwright install chromium`, no
  `--with-deps`, per D14). It is idempotent and a no-op once
  `~/.cache/ms-playwright` is warm.
- **The ports are fixed by default** (19108 edge, 19008 server). Two runs
  sharing a host must be given distinct `CARDTABLE_E2E_EDGE_PORT` /
  `CARDTABLE_E2E_SERVER_PORT` values — which is a live hazard on this machine,
  where the play e2e and parallel agent waves bind neighbouring ports.
- Root `vitest` does not collect `isolation.test.ts`: it uses `node:test`, and
  the vitest config includes only `apps/*/src` and `packages/*/src`. The root
  `typecheck` does pick up `@hadoku/e2e`'s own `tsc --noEmit`.
