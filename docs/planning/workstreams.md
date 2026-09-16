# Workstreams — hadoku-cardtable

**The tracker owns this file.** Managers and sub-agents report; the tracker
records. Every row carries the evidence it was checked against, not the doc that
claimed it.

Last swept: 2026-09-16. **Wave 5 LANDED — all four lanes, one push, deployed.**
`20346e1`+`2e88af1`+`9a99fa3` H · `a530349` F · `0465c08` G · `fcf8c13` E, plus
the manager's lockfile commit `5cc9773`. CI green on `5cc9773`; the redeploy
dispatched and `hadoku_site`'s receiving run succeeded 7 s later. Branch `w5`
and its worktree are gone.

**The room layer exists.** PR-3's P3–P6 are implemented, not just specified: a
socket server with per-seat emit behind the friend gate, an MIT clean-room ask
registry, room persistence with a service participant, and a client socket
driver that is a **third** source beside the in-process engine and the fixtures.
`pnpm check` on `main`: **28 files, 473 tests, exit 0** (Wave 3 closed at 15/242).

**What is NOT proven: two browsers drafting one pod.** Every lane says so and
none of them claimed it. It is the one thing PR-2 exists for, it needs two
friend-authenticated browser sessions, and it is now the top of the queue.

**Wave 4 also landed** — `b4a024b` A · `e0ccd0e` C · `541d2a9` B · `b2917ac` D,
CI green — and **its closing notes were never recorded here.** The rows below
are Wave 5's. What is verifiable about W4 from artifacts is in this pass's
ledger; the rest needs its own closeout.

**This header had not moved since Wave 2** even though Wave 3's closing ledger
was already in the file, and a 39-line block appeared twice. Both corrected in
this pass.

Previously: 2026-09-14. **Wave 2 LANDED — four lanes of five.** `df716ef` D ·
`e5102de`+`62b1e64`+`169cb9c` E · `ae5a076` A · `1a7a2f4` C, each pushed
separately with **CI green on every one**. Branch `w2` and its worktree are
gone; `forge/` verified pristine at `2cd497c` throughout.

**Lane B was never dispatched.** *(Historical — superseded. P1 is closed, the
engine shipped in Wave 3 and `packages/shared` now carries both the draft
envelope and the wire envelope. Kept for the record of what Wave 2 cost.)*
Operator item **P1** (`NODE_AUTH_TOKEN`
unset → `E401`) is its gate and is still open, so the pure draft engine and the
Zod wire schema — the heart of PR-2 — did not get built. `packages/shared` is
still empty. **This is the single thing standing between here and a playable
draft**, and it is a one-line shell fix.

The wave's other headline: **the board's own numbers were wrong in five places**
and the lanes caught them. `ProtocolMethod` is **60**, not 62. `15 Any` is
**91** recipes, not 92. The cube corpus is **49,345** lines over **388** set
codes, not 47,315 over 375 — and the tracker reproduced *why* the old number
was wrong (below). All corrected in place, with the evidence in "Verified this
pass".

Previously: 2026-09-12. **Wave 1 LANDED** — all five lanes verified and merged
to `main` (`e359649` E, `5b41cc1` A, `81583ae` D, `7db43ca` C, `9f6f953` B, plus
the tracker commit). Branch `w1` and its worktree are gone. The wave's headline:
**D7 is settled NO-GO** — Forge does not compile to WASM GC, so P4 is a React
client and D6's iframe payload has to be built.

**SHA note:** the tracker rewrote history after the wave (to strip AI-attribution
trailers and swap a real email for the noreply address, both required by
`~/.claude/AGENTS.md`; nothing had been pushed). Every SHA below is the
**post-rewrite** one and resolves in `main`. The manager's own closing note cites
pre-rewrite SHAs that no longer exist.

Rows below carry Wave 1 evidence, plus the 2026-09-14 re-verification.

## What this project is for

Friends draft a cube in a browser and play the decks, behind the friend gate at
`hadoku.me/cardtable/`. Forge supplies the rules engine; the watchparty room
layer supplies everything above a match; **Forge's UI renders inside the room's
central canvas slot** (D6).

## Programmes, in dependency order

| # | Programme | State |
| --- | --- | --- |
| **PR-1** | **Ground truth** — toolchain, card data, and the WASM go/no-go that decides the UI strategy | **done** (Wave 1) |
| **PR-2** | **Draft** — pure draft engine, cube import, draft UI. Playable with friends. | **built end to end, unproven with two people.** Engine (W3), card art (W4) and a live socket (W5) all land; `DraftScreen` renders from fixtures, the in-process engine, or a server. **"Playable with friends" is not ticked** until two browsers draft one pod — see the queue |
| **PR-3** | **Room module** — our P3–P6 contributions to `@wolffm/rooms-protocol` / `-server` (**renamed**: `@wolffm/rooms` never shipped) | **implemented Wave 5, locally.** Designs W1, delivered to watchparty W2/W3, built here W5. Upstream still ships **none** of P4–P6, so ours are our own packages consuming their primitives — `@wolffm/rooms-server@0.38.111` is `RoomRegistry` + seating + emit + rate limiting + `collectGC` and nothing else. The socket wiring is ours |
| **PR-4** | **Play** — WS/JSON bridge at `IToClient`, headless Forge, the embedded client | **spiked and de-risked** (D). Forge runs headless; 38 of 60 protocol methods required; jUPnP is a config flag. Not greenfield — a 3,919-line headless net harness already exists in-tree |

## Board

Status: `todo` · `wave-N` · `blocked` · `done` · `watch`

### PR-1 Ground truth

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| pnpm workspace, tsconfig, lint, vitest, CI | **done** | A `5b41cc1` | clean-clone `pnpm install --frozen-lockfile` **exit 0**, `pnpm check` **exit 0**. Gate mutation-tested: typecheck→2, lint→1, test→1, all restored to 0 |
| Maven user-local install | **done** | B `9f6f953` | Maven 3.9.16 → `~/.local/opt`, SHA-512 verified, no sudo |
| JDK user-local install | **done** | B `9f6f953` | **new row.** `openjdk-21-jre` has no `javac`; Temurin 21 → `~/.local/opt`. D14 amended |
| Stock `mvn install` of Forge passes | **done** | B `9f6f953` | `-pl forge-core,forge-game -am -DskipTests` exit 0, **13.2 s warm / 27 s cold** |
| Sentry stubbed out of engine | **done** | B `9f6f953` | overlay under `scripts/spike/`, NOT a patch to `forge/`; 2 stub classes, 5 members |
| **`forge-core`+`forge-game` → WASM GC (go/no-go)** | **done — NO-GO** | B `9f6f953` | 30 missing classlib APIs, no artifact. Manager reproduced: `run.sh wasm` exit 1. **D7 settled.** Root cause: TeaVM ships 0 classes in `java.util.concurrent.locks`; Guava `LocalCache$Segment` extends `ReentrantLock`; `Game.java:97` builds an `EventBus` |
| JVM headless engine runs a real interaction | **done** | B `9f6f953` | **new row.** 33,752 card scripts, 95,746 printings in 1.6 s; Glorious Anthem → Grizzly Bears 3/3, no `forge-gui`/`forge-ai`. Manager re-ran: exit 0 |
| Scryfall terms verified | **done** | C `7db43ca` | **The 403 was a phantom.** Manager re-ran: no UA/Accept → **400** quoting Scryfall's own rule; honest UA+Accept → **200**; `server: cloudflare`. It was bot-filtering of the fetching tool's egress, not policy |
| Card data ingest | **done** | C `7db43ca` | `pnpm --filter @hadoku/carddata sync` ran against live bulk data: 38,740 cards, 0 skipped, exit 0. Zero runtime deps |

### PR-2 Draft

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| Import Forge's `.draft` recipes (94) | **done** | A `ae5a076` | All 94 in `drafts/`. Tracker re-ran `cmp` on the 94 **committed git blobs** vs source: **0 differing**, and **2 blobs still CRLF** — `drafts/.gitattributes` (`*.draft -text`) is what preserves that; the root `* text=auto eol=lf` would have silently rewritten them. 8th key `CustomRankings` parsed too (`CustomLimited.java:123`) |
| Card resolution: `Name\|SET` → real card | **done** | A `ae5a076` | **49,337 of 49,345 resolved (99.984%); 93 of 95 cubes at 100%.** Tiers: 989 name+set+collector, 48,274 name+set, 74 name-only. The **8** failures are Scryfall data gaps (2 Arena `A-` rebalanced, 6 unspoiled), returned as values, never guessed. `packages/carddata/reports/cube-resolution.json` is the committed artifact and `resolve.test.ts` gates it |
| Two-faced cards written by front face alone | **done** | A `ae5a076` | **new row.** **942 references** write `Delver of Secrets` where Scryfall's `name` is `Delver of Secrets // Insectile Aberration`. Without front-face matching only **12 of 95** cubes resolve. This was the lane's real technical risk, and it was invisible in the planning numbers |
| Forge→Scryfall set-code translation | **done** | A `ae5a076` | **new row.** **26 of 388** set codes genuinely need translating, over 679 card lines; Forge's own `ScryfallCode` table (679 edition files → 760 keys) supplies them. `set-codes.generated.ts` |
| Import Forge's cube lists | **done** | C `7db43ca` | **95, not 96.** `res/cube/` = **95** `.dck`, all imported byte-identical (`diff -rq` clean). The 96 came from `res/draft/`, which has 96 *entries* = 94 `.draft` + a `rankings/` **directory** + `rankings_cubecobra.txt`. **Corrected 2026-09-14:** the board said "1 `.rankings` file"; `ls -F` shows `rankings/` is a directory. A `.dck` parser + 29 tests ship with it |
| **Pure draft engine (no transport)** | **DONE** | `2658ddf` | `@hadoku/draft`. Seeded + deterministic (`Math.random` banned; bot rngs keyed by seed+seat+pack+pick, so a human picking in a different order cannot change bot behaviour). Rejections are values, never throws. Seats consumed from `@wolffm/rooms-protocol@0.38.111` **including the W3 seat reservations**, wired at a 120 s TTL. 26 engine tests + 4 against Forge's **real** cube lists; a real 540-card Vintage Cube drafts to completion, 360 unique cards, 0 duplicates. Replay mutation-tested: non-determinism in the rng fails 2 tests |
| ~~superseded engine row~~ | — | — | **Lane B was never dispatched.** Gate `npm view @wolffm/rooms-protocol version` → **E401**; `NODE_AUTH_TOKEN` **unset**. The wave plan's own instruction was "if that returns E401, do not dispatch B", and the manager followed it rather than working around the credential. O2 settled TS; the design stands untouched. **Wave 3, the moment P1 clears** |
| ~~Wire schema (Zod, `packages/shared`)~~ | ~~BLOCKED — not built~~ **superseded: built in W3, extended in W5** | — | **new row.** Same gate as the engine — it was lane B's other half. `packages/shared` is still an empty directory. Lane C's fixtures are written against the §B.5 **prose** envelope instead, so the schema has a contract to satisfy the day it exists |
| Pack generation rules | **not built** (lane B) | — | **The "no oracle" risk does not apply to cubes.** Across all 94 `.draft` recipes: **91 are `Booster: 15 Any`** (corrected from 92 — 90 clean + 1 with trailing whitespace, which is what a naive `uniq -c` misses), plus `16 Any`, `9 Any`, and **exactly 1** rarity-slot recipe. 93/94 `Singleton:True`, 93/94 3 packs × 8 players |
| Draft UI in the canvas slot | **done** | C `1a7a2f4` | `@hadoku/ui` renders a pack fanned for picking, the pool grouped by mana value, pack/pick counters, `seq`, and a seat bar — from **5 committed fixtures**, 63 tests. No socket, no room chrome, no `@wolffm/watchparty-ui` (greppped in the **diff**, exit 1). Cards drawn by us: zero `<img>`, zero `url()`, pips are our own circles, `{T}` renders as the word TAP |
| **Hidden-information split holds** | **done** | C `1a7a2f4` | **new row.** The spectator payload is **1,077 bytes**, `viewer:{"kind":"spectator"}`, no pack and no pool. Tracker diffed it against the seat-3 payload's 30 card names: **0 leaked**. Mutation-tested — injecting seat 3's 19-card pool fails the suite (exit 1) |
| **B↔C integration check** | **outstanding** | tracker | **new row.** §C's done-when is half-open: "`apps/ui`'s fixtures parse under lane B's Zod schema" cannot run while B does not exist. When B lands, run its schema over `apps/ui/src/draft/fixtures/*.json`. **Per the wave plan a failure there is a lane C bug, not a B bug** |
| `.dck` export | **done** | B `a766665` | `@hadoku/deck` — pool→deck model + a Forge `.dck` **writer**, 1,408 lines, round-tripped over **all 95 cubes**: 79 byte-identical once header casing is restored, 92 identical modulo the losses `parseDck` itself imposes, and the 3 that differ each mix `Name\|SET` and `Name\|SET\|1` in one file — which **Forge's own `CardRequest` cannot represent either**. Zero external deps |
| ~~**Pure draft engine (no transport)**~~ | ~~BLOCKED — 2nd wave~~ **superseded: shipped `2658ddf`, see the DONE row above** | — | **Lane A never dispatched, again.** Same gate, same E401, same unset `NODE_AUTH_TOKEN`. The manager obeyed the wave's own "do not dispatch on E401" instruction both times, which is correct and is why the hole is clean rather than papered over |
| ~~**Wire schema (Zod, `packages/shared`)**~~ | ~~BLOCKED — 2nd wave~~ **superseded** | — | **2026-09-16: `packages/shared/src` holds `draft.ts`, `wire.ts`, `semantics.ts`, `index.ts` and `wire.test.ts`.** Originally: `packages/shared/src` is still `.gitkeep`. It was lane A's other half |
| **Envelope needs an `epoch` (W4)** | **DONE** | `2658ddf` | Envelope carries `{epoch, seq}` — a `rooms-protocol` `SeqCursor`, so `classifySeq` runs over it directly. All five fixtures updated |
| ~~superseded W4 row~~ | — | — | Tracker-found. Lane A's step 7 carries it; A did not run, so the five fixtures still have `seq` and no `epoch` |
| Wire the UI to a live engine | **DONE** | `2658ddf` | The app boots into a **live draft**; the 5 fixtures became the regression net behind a source switch. `types.ts`'s mirror and `validate.ts`'s hand-rolled checker both had explicit deletion conditions — both met, both deleted, module paths kept as re-exports so 12 importers did not move. **Played in a browser:** picked Mana Drain from the opening pack, packs passed, pick 2 of 15 arrived with 14 cards, seq 17 |
| **B↔C integration check** | **DONE** | `2658ddf` | Wave 2's outstanding item. All five committed fixtures validate under the schema, asserted in `engine.test.ts` and `fixtures.test.ts` |
| ~~47 of 540 cube cards do not resolve~~ | **FIXED — and it was never the set codes** | us | **The tracker's diagnosis was wrong.** Every failing card had a *known* Forge code that translated fine — `isKnownForgeSetCode` true, `toScryfallSetCode` non-null for all of them. The real cause: we synced `oracle_cards`, which carries **one** printing per card, and for 41 of these Scryfall's chosen representative is a **digital-only** printing, which the resolver correctly refuses. Lion's Eye Diamond, Mox Diamond, Bazaar of Baghdad, Cabal Ritual — ordinary paper cards with a digital representative. Switching the default to `default_cards` (every printing, 78 MB vs 24 MB) takes it to **534/540**. The remaining **6 are genuinely absent from Scryfall**: all `OM1` / "Through the Omenpaths", a Forge `Type=Online` set. 534 is the ceiling from this data source, not a bug |
| **A third source: a real socket** | **done** | H `2e88af1`, E `fcf8c13` | `App.tsx` offers `live` · `fixtures` · `socket`, and `DraftScreen`'s props did **not** change to add it — the interchangeability the fixture lane was built for, spent as intended. `live` and `fixtures` still work untouched (21 + 15 tests, neither file edited) |
| **Two browsers drafting one pod** | **NOT VERIFIED** | — | The done-when of both §E.6 and §H.5, and the point of PR-2. No lane claimed it; a test runner cannot. Settle by opening `https://hadoku.me/cardtable/` in two friend-authenticated contexts, Source → "Server", same draft id, pick in one and watch the other, then refresh one mid-draft |
| **Demo pool is committed (232 K)** | **done** | `2658ddf` | **new row.** `apps/ui/src/draft/pool.json` so the UI builds from a clean clone without a Scryfall sync. Gameplay text only: 13 named fields, **no image field, no URL anywhere**. `build-pool` refuses to write a pool that fails that check. The first version of that control fired on **"Phantasmal Image"** and **"Nissa's Pilgr*image*"** — it scanned free text; it now scans field names and URL shapes |

### PR-3 Room module

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| P0 stable `ParticipantId` | **done (theirs)** | watchparty | **`@wolffm/rooms-protocol@0.38.109`**, `participantId.d.ts`. Three tiers `fk:`/`dev:`/`eph:`, digests not credentials. Read out of the published tarball |
| P1 seats/roles | **done (theirs)** | watchparty | `seats.d.ts`. `SeatId` **is** the order; sticky across reconnect; `kind:'bot'` + `padWithBots` with positional `bot:<n>` ids; humans evict bots; `capacity`. Its own header cites *"in a draft the pack passes left, then right, then left again"* |
| P2 carve + publish `0.x` | **done (core)** | watchparty | **`0.38.109`**, three packages, verified with `gh auth token`. **`@wolffm/rooms` never shipped — renamed `@wolffm/rooms-protocol`** (still E404 under the old name, which is what made this look blocked). `rooms-protocol` is zero-dep; `rooms-server` peers `socket.io` |
| P3 per-recipient emit — **design** | **done** | D `81583ae` | `docs/requests/P3_PER_RECIPIENT_EMIT.md`. Carries a **correction to their own §4** — see D11 |
| P5 service participant — **design** | **done** | D `81583ae` | `docs/requests/P5_SERVICE_PARTICIPANT.md`, five-state lifecycle |
| P6 persistence — **design** | **done** | D `81583ae` | `docs/requests/P6_PERSISTENCE.md`, `RoomStore` in-memory by default |
| P4 ask/correlation — **clean-room spec** | **done** | E `e359649` | `docs/requests/P4_ASK_REGISTRY.md`. Firewall held: fresh agent, contamination grep over the doc returns nothing. Read-list is self-reported |
| **Deliver P3–P6 to hadoku-watchparty** | **done, but STALE and unpushed** | E `fd584664` | Delivered on branch **`cardtable-w2-requests`** in their repo — 5 files under `docs/requests/`, their `main` untouched, no PR (per the brief). **Two caveats, both live:** the branch has **no upstream** (never pushed), and it was written against `0.38.109` while they shipped `0.38.110` **mid-wave**. Needs a re-read and a rebase off `98610f42` before it is sent |
| P3 trimmed against shipped code | **done** | E `169cb9c` | Four asks deleted as already-shipped. The line that forced it, verbatim at `rooms-server/src/emit.ts:19`: `/** Droppable, EARLIEST FIRST. An event in neither list is never dropped. */` — plus `thresholdBytes:16`, `highPriority:18`, `lowPriorityOrder:20`. What survives: per-participant `seq`, the shed-envelope rule, fail-closed projections |
| **P3 — socket server + per-seat emit** | **done** | E `fcf8c13` | `apps/server/src/room/**`. `socket.io` on the existing express app; `io.engine.use(edgeProvenance)` then an `io.use` tier check, so the socket inherits the friend gate with **no second auth scheme**. Per-recipient payloads via `emitPerRecipient`; `broadcastToRoom` is not reachable from that file. 44 tests. **Tracker drove the BUILT bundle with a real socket.io-client:** no headers, forged `X-Hadoku-Tier: admin`, and forged `friend` all → REFUSED (`not found`); forged `friend` is refused because `EDGE_AUTH_SECRET` unset ⇒ `sanitizeHeaders` fails closed |
| **P4 — ask registry (MIT, clean room)** | **done** | F `a530349` | `packages/room-ask/**`, 23 tests, all seventeen of `P4_ASK_REGISTRY.md` §4's A-1…A-17 plus three for its own decisions. `"license": "MIT"` with its own `LICENSE` and a clean-room header on all six sources — the one carve-out in a GPL repo. Firewall: fresh agent, contamination grep for Forge vocabulary returns only the licence headers. Read-list self-reported, as with the spec |
| **P5 service participant + P6 persistence** | **done** | G `0465c08` | `packages/room-store/**`, 69 tests over 6 files, in-memory by default. Five-state service lifecycle (`lost` entered by the room's clock, not the peer); `RoomStore` with snapshot/restore, quarantine, and a **real** `SIGTERM` test that forks a child process rather than mocking the signal |
| **Client socket driver** | **done** | H `2e88af1` | `apps/ui/src/draft/socket.ts`, 28 tests. `classifySeq` on every inbound envelope; `duplicate` drops and **never** resyncs. `live` and `fixtures` untouched and still selectable — socket is a **third** source, not a replacement |
| **Wire envelope** | **done** | H `20346e1` | `packages/shared/src/wire.ts`, 20 tests. One socket.io event name per **direction** carrying a tagged union, so there is one handler per direction and no unvalidated entry point. Client→server schemas are `z.strictObject`: a browser supplying `participantId` is a parse **error**, not a stripped field |
| **`@hadoku/room-ask` has no consumer** | **watch** | us | Built because the operator asked for the full P3–P6 set, and because PR-4 play will need it. **A draft pick is an event, not an ask** — the wave file says so. Nothing imports it today |
| ~~**`emitPerRecipient` missing (W1)**~~ | **CLOSED — they fixed it** | watchparty | **Closed 2026-09-14.** Their `e58e3005` *"give SKIP its function, and ship the reconnect contract (W1, W2)"*. Verified in their source: `emit.ts:121 export function emitPerRecipient`, plus `emitToRole:148`, at **`0.38.110`**. The sentinel now has something to pass it to. Lane E reported the defect; they had already fixed it by the time the wave closed |
| ~~**`@wolffm/rooms-client` (W2)**~~ | **CLOSED — they shipped the contract we asked for** | watchparty | **Closed 2026-09-14.** We agreed with the deferral and asked instead for the reconnect/resync/identity-reassert **contract** in the zero-dep `rooms-protocol`. It exists: `rooms-protocol/src/resync.ts` exports `SeqCursor`, `classifySeq`, `missedCount`, `needsResync`, `RosterIdentity`, `IdentityReassert`, `resolveIdentityReassert`, re-exported from `index.ts:15`. **This is what P6's "survive a restart and a refresh" binds to** |
| ~~**Envelope needs an `epoch` (W4)**~~ | **CLOSED — see the PR-2 row** | us | **new row, ours not theirs.** Found reading `rooms-protocol@0.38.110` as its first consumer. `SeqCursor` is `{epoch, seq}`; all five committed fixtures carry `seq` and **no `epoch`**, so they cannot use `classifySeq`. The epoch separates "missed events" from "server restarted and recounted" — opposite responses, and the second **is** P6's restart case. Their `resync.d.ts` header says `lastEventSeq` is stamped only on watchparty's control events and an app wanting gap detection stamps its own cursor |
| **`SKIP` arm doesn't constrain (W5)** | **watch — possibly moving** | watchparty | **2026-09-14:** an untracked `apps/server/test/emit-payload-types.test-d.ts` sits beside a modified `emit.ts` in their `rooms-resv` worktree. Uncommitted; not shipped. |
| ~~superseded W5 row~~ | — | — | **new row.** `emitPerRecipient`'s `build` returns `unknown \| typeof SKIP`, and `unknown` absorbs the union — tsc 5.9.3 resolves it to plain `unknown`, so the SKIP arm type-checks nothing. Cosmetic today. Raised with the seat answer |
| **`ClientMeta.socketId` is one string (W3)** | **open upstream; we guard it locally** | watchparty | **Re-reproduced 2026-09-16 against the shipped `0.38.111`** — unchanged. Wave 5 lane E takes option (c), the host-side guard: after `leaveRoom`, if `clientByParticipant` still finds a live client for that id, `seatParticipant` returns them to the remembered seat. Mutation-tested — delete the guard and 3 tests fail, the socket-level one as `expected null to be +0`. See the Watches entry. **Every other `rooms-server` consumer still has this bug.** Originally: **found by lane E reading their source rather than their docs.** P3 §3.2 asked for `sockets: Set<string>`; what shipped is `state.ts:16 socketId: string`. On a refresh, `leaveRoom` can unseat a participant who is already back on a live socket. E reproduced it against their real `seats.ts` — the participant ends `spectator` with their seat empty. Closes when they confirm the ordering or take one of the three fixes |
| CI must use `HADOKU_NPM_READ_TOKEN` | **no longer vacuous — one caveat** | A `5b41cc1`, W5 | **Re-checked 2026-09-16.** `gh secret list` is **non-empty** (`HADOKU_NPM_READ_TOKEN`, `HADOKU_SITE_TOKEN`), and the repo now genuinely depends on `@wolffm/rooms-protocol` **and** `@wolffm/rooms-server`, so the path is no longer structurally dead. CI green on `5cc9773` installed 307 packages with `scope: @wolffm`. **Caveat, and it is this repo's own trap:** the runner is self-hosted and warm (`reused 299`), so a cached store can satisfy the install without ever hitting the registry. Settle with a cold runner or `pnpm store prune` before install |

### PR-4 Play

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| `case "server":` headless mode | **spiked — viable** | D `df716ef` | **Forge runs headless.** `SimulateMatch` played a full AI-vs-AI game to a damage win on turn 12, exit 0, no display, no X server, no network; actual output in `docs/spikes/headless-server.md`. `case "server":` itself reaches its arm headless and exits 0 — **the scaffolding works, only the body is missing.** Build: `mvn -B install -pl forge-gui-desktop -am -DskipTests`, 69 s cold / 15.9 s warm |
| **A headless net harness already exists in-tree** | **found** | D `df716ef` | **new row, nobody had budgeted for this.** `forge-gui-desktop/src/test/java/forge/net/` is **3,919 lines**: `HeadlessNetworkGuiGame`, `HeadlessNetworkClient`, `HeadlessGuiDesktop`, a `MultiProcessGameExecutor`, and an integration test that calls `FServerManager.startServer(port)`. **PR-4 is not greenfield** |
| `ProtocolMethod` surface | **measured** | D `df716ef` | **60 methods, not 62** — tracker re-derived independently from the enum: **45 SERVER / 15 CLIENT**. **38 required** (29 s→c + 9 c→s), 20 not, **2 dead** (`setRememberedActions`, `nextRememberedAction` are not on `IGuiGame` at all). **For a browser *draft* client: 0 of 60** — `ProtocolMethod` is the *match* protocol and has no draft methods, which independently corroborates O2 |
| WS/JSON `IToClient` | todo | us | `IRemote` is 3 methods; `IToClient` is empty (D9: required in every branch) |
| ~~gdx-teavm embed payload~~ **or** React client | **decided: React** | us | D7 NO-GO. ~14 prompt components over a board renderer. D6's iframe payload does **not** already exist |
| Disable jUPnP | **answered: config, not code** | D `df716ef` | `FServerManager.java:230-274` — `mapNatPort()` runs only when the `UPnP` pref is `ALWAYS`, so `UPnP=NEVER` in `server.preferences` means jUPnP is never constructed. **No fork change needed.** The trap is the shipped `ASK` default: it calls `SOptionPane.showOptionDialog`, a blocking modal a headless server cannot answer |
| `FSerializableFunction` on the wire | **answered: real but narrow** | D `df716ef` | `one` never crosses the wire (it resolves locally to `getChoices`). `getChoices` serializes the lambda as a `SerializedLambda` no JS client can reconstitute — **but the server holds both the choices and the lambda**, so rendering labels server-side and sending strings loses nothing. That is the fix `WireClassFilter.java:45` already names |
| **Strip upstream's Sentry DSN in the fork** | **todo — do not skip** | us | **new row.** `Main.java:65` calls `Sentry.init` with upstream's **hardcoded DSN** before it reads the mode argument, and *refills* an empty DSN, so no external config disables it. A dedicated server would report **our** crashes to the Forge project. Must be stripped when the fork exists |

## Waves 3, 4, 5 — all LANDED

`docs/planning/wave3-2026-09-14.md` · `wave4-2026-09-16.md` · `wave5-2026-09-16.md`

### Wave 3 (as planned) · `docs/planning/wave3-2026-09-14.md`

Five lanes, finishing PR-2. **A** draft engine + Zod schema (gated on P1) ·
**B** deck build + `.dck` export · **C** the stale facts in `CLAUDE.md` and
three docs · **D** deliver P3–P6 + the W3 seat answer, in their repo ·
**E** wire the UI to a live engine (after A).

Two operator decisions settled 2026-09-14 and written into the wave:
**W3 → we want reservation-with-TTL**, not the socket Set (it is the only one
of the two that survives a network blip or a server restart, which is what P6
actually requires); and **`cardtable-w2-requests` → rebase, re-read against
`0.38.110`, push**.

### Wave 4 · `docs/planning/wave4-2026-09-16.md` — card art moves to our CDN

Four lanes, all landed, CI green on `b2917ac`. **A** art-source indirection
(`packages/carddata/src/art/**` + `art-manifest.json`) · **B** the CDN upload
CLI · **C** the UI consuming the art source · **D** the rules rewritten
(`docs/LICENSING.md`, `CLAUDE.md`, `DECISIONS.md`, `NOTICE.md`, `ci.yml`).

The headline is **D15, which supersedes D13's image clause**: card art lives on
`cdn.hadoku.me`, image bytes still never enter the repo, and **our own origin
never serves an image**. `scripts/d13-gate.sh` replaced the inline CI gate.
Ran **concurrently with Wave 5** in a separate worktree; the two overlapped on
exactly `apps/ui/package.json` and `pnpm-lock.yaml`, both resolved at W5's
rebase.

**Its closing notes were never recorded on this board.** What the tracker can
verify from artifacts is in the 2026-09-16 ledger; a proper W4 closeout is owed.

### Wave 5 · `docs/planning/wave5-2026-09-16.md` — the room layer, P3–P6

Four lanes, all landed, one push, deployed. **E** socket server + room ·
**F** ask registry (clean room, MIT) · **G** service participant + persistence ·
**H** wire schema + client socket driver. Full ledger in the 2026-09-16
"Verified this pass" section below.

### What's next — the queue after Wave 5

| # | Item | Why it is next |
| --- | --- | --- |
| 1 | **Two browsers drafting one pod** | The only thing PR-2 exists for and the one claim no lane could make. Needs two friend-authenticated sessions, not a test runner |
| 2 | **Wave 4 closeout** | Its notes never reached this board |
| 3 | **Wire P6 into `apps/server`** | `@hadoku/room-store` exists and nothing imports it. Today a restart loses every draft — lane E runs **no GC** and keeps rooms for the process lifetime, which is a slow leak with no persistence under it |
| 4 | **`CLAUDE.md:101`** | Still says "Maven ✗" against an installed Maven 3.9.16 |
| 5 | **`KEY_SERVICE_CARDTABLE`** | Every redeploy reports nothing, silently, and passes |

### Superseded — the shape before it was planned

Not planned in detail and **not scaffolded** (that needs approval). What Wave 2
left determines it:

| Lane | Owns | Why |
| --- | --- | --- |
| **B (re-run)** | `packages/draft/**`, `packages/shared/**` | The engine + Zod schema Wave 2 could not build. **Gated on P1** — this lane is the whole reason P1 matters. Its brief in `wave2-2026-09-14.md` §B is still accurate and can be reused verbatim |
| **B↔C integration** | tracker, no files | Run B's schema over `apps/ui/src/draft/fixtures/*.json`. A failure is a **lane C** bug |
| **Deliver P3–P6, take 2** | `docs/requests/**` + a branch in watchparty | Re-read against `0.38.110`, drop what `e58e3005` answered (W1, W2), keep W3, rebase off `98610f42`, and **actually push it** |
| **Doc debt** | `CLAUDE.md` | The three stale facts. Wave 2 couldn't touch it — owned by nobody — and three separate lanes tripped over it |

The ordering that matters: **B before the integration check**, and B before
anything in PR-4, because the wire schema is what `IToClient` will carry.

## Operator's list — only they can do these

| # | Item | Why it's theirs |
| --- | --- | --- |
| ~~O1~~ | ~~fork `Card-Forge/forge`~~ — **resolved 2026-09-11: deferred.** A plain clone already syncs upstream (`origin` *is* upstream); a fork only buys somewhere to push our Forge commits, a submodule URL, and the ability to PR `case "server"` back. None needed until the first line of Java, and lane B explicitly writes none. **Repo creation DONE 2026-09-14** — `WolffM/hadoku-cardtable` exists, private, created 07:26, `main` pushed, CI green. Only the *fork* half remains deferred. | |
| ~~**P1**~~ | **CLOSED 2026-09-16 — it is in the profile.** `~/.bashrc:166` exports `NODE_AUTH_TOKEN` (and again at `:167` — a duplicate export, harmless, worth tidying). `npm view @wolffm/rooms-protocol version` → **`0.38.115`**, exit 0. The bare-env control still 401s (`env -u NODE_AUTH_TOKEN npm view` → exit 1), which is what makes the export load-bearing rather than cosmetic. Note it is a **static `gho_` token in a dotfile**, not `$(gh auth token)`, so it will expire on its own schedule. ~~Export `NODE_AUTH_TOKEN`~~ — `~/.npmrc` reads `_authToken=${NODE_AUTH_TOKEN}` and the variable is unset, so npm sends the literal placeholder and gets `E401`. Not a rotation: `NODE_AUTH_TOKEN=$(gh auth token) npm view @wolffm/rooms-protocol version` → a version. **STILL OPEN — re-checked 2026-09-14 after Wave 2: the variable is unset and the bare `npm view` still returns E401.** ⚠️ **This already cost a lane.** Wave 2 shipped four lanes of five; lane B — the pure draft engine *and* the Zod wire schema, i.e. the middle of PR-2 — was never dispatched because of it. **Blocks Wave 3's first lane.** Put it in the shell profile. | Shell env |
| ~~**P2**~~ | **CLOSED — and it was already closed before Wave 5 started.** `gh secret list -R WolffM/hadoku-cardtable` on 2026-09-16 returns `HADOKU_NPM_READ_TOKEN` and `HADOKU_SITE_TOKEN`; the former was already dated 2026-09-15 when the Wave 5 manager first looked, and was re-seeded 2026-09-16T08:01Z. **The board carried "still empty" for two passes after it stopped being true.** ~~Set `HADOKU_NPM_READ_TOKEN` on the repo~~ — ~~`gh secret list` re-checked 2026-09-14: **still empty**.~~ CI's green runs are still vacuous: Wave 2 added no `@wolffm/*` dependency (because B never ran), so the token path has **still** never executed. The first lane that depends on `@wolffm/rooms-protocol` is where a cold runner surfaces the 403. | Repo secret |
| ~~**P3**~~ | **CLOSED 2026-09-14 — delivered.** `origin/cardtable-w2-requests` at `ccfeab46`, upstream set, rebased to 0 behind their `main`, re-read against `0.38.110`, carrying the seat answer. ~~Decide what to do with `cardtable-w2-requests` in `hadoku-watchparty`~~ — our P3–P6 delivery is committed there on a branch with **no upstream**, and it is already stale: they shipped `0.38.110` mid-wave and answered W1 and W2 in `e58e3005`. Either push/PR it after a rebase + re-read, or drop it and re-derive against `0.38.110`. **Nothing reaches them until someone pushes.** | Their repo; ours to send |
| ~~O2~~ | ~~P1 draft: reimplement in TS vs. reuse Forge's `limited/`~~ — **RESOLVED 2026-09-14: reimplement in TS.** | **Live and now decidable — the spike is in, and it changed the terms.** The "free draft engine *and* UI in the iframe" branch is **dead** (D7 NO-GO). But lane B proved the other half: `forge-core`+`forge-game` run headless on the JVM in 1.6 s and resolve real card interactions, so reusing `limited/` **server-side** is viable in a way nobody had evidence for before. So the trade is now: TS reimplementation (JVM-free P1, but pack collation/rarity/foil is accumulated correctness with no oracle but Forge — the D4 objection stands) vs. a JVM draft service (correct by construction, but P1 now carries a JVM and O3 arrives early). **Resolved.** The JVM branch lost on evidence gathered at planning time: `BoosterDraft.java` lives in **`forge-gui`** — precisely the module Wave 1's headless proof excluded — and carries 17 `SGuiChoose`/`SOptionPane` call sites plus the `FModel` singleton. Meanwhile the "accumulated correctness, no oracle" objection turned out to be about **set-booster collation**, which a cube never opens: **91** of 94 recipes are `Booster: 15 Any` (the planner said 92; lane A's count is the right one), 93/94 singleton, exactly 1 uses rarity slots. Reuse would cost `forge-gui` + a JVM to buy a pick/pass loop. **Revisit only for set/block draft or sealed**, where `BoosterGenerator` genuinely earns its keep. |
| O3 | One JVM per match vs. one hosting many | defer to PR-4, but decide before the service-participant lifecycle. **Arrives sooner if O2 goes the JVM way.** |
| ~~O4~~ | ~~Does the spike block Wave 2?~~ | **Resolved 2026-09-12: moot.** The spike ran and finished inside Wave 1. |

## Verified this pass (2026-09-16 — tracker, closing Wave 5)

Nothing below is taken from a closing note. Each line names the command that
produced it, and every mutation test reports **reverted fails N / restored
passes N** or it does not appear.

**The wave landed and is running.**

- **Seven commits, one push.** `b2917ac..5cc9773`, 46 files, +9582/−34. One push
  and not four, because `redeploy.yml` sets `concurrency: redeploy-cardtable,
  cancel-in-progress: true` — lane-by-lane pushes would have been four deploy
  chains cancelling each other.
- **Gates on `main`, exit codes read directly:** `pnpm install --frozen-lockfile`
  **0** (what CI runs) · `pnpm run typecheck` **0** · `pnpm check` **0** →
  **28 files, 473 tests** · `pnpm -r build` **0** · `bash scripts/d13-gate.sh
  apps/ui/dist` **0** · `--self-test` **65 fixtures, 65 as expected** · CI green
  on `5cc9773`.
- **DEPLOY confirmed, not assumed.** Deployed tree HEAD `5cc9773` ==
  `origin/main`. `apps/server/dist/index.js` rebuilt **06:42:19Z** (push was
  06:42:01Z) and contains `draft:c2s` and `emitPerRecipient`. The serving
  process started 06:42:19Z, **after** the install. `restart_time` reads 0
  because the PM2 wrapper does delete+start, which resets that counter — the
  **uptime** is the evidence, not the counter.
- **Re-checked 11 h later:** the PID had changed (host-side restart, no new
  redeploy run), but the bundle mtime is unchanged and still carries the wave.
  Still landed.
- **Production, anonymous:** `/cardtable/`, `/cardtable/health`,
  `/cardtable/api/whoami` and
  `/cardtable/socket.io/?EIO=4&transport=polling` all → **HTTP 401**. A socket
  path is a path, and the edge treats it as one.
- **The deploy tree IS `/home/hadoku/repos/hadoku-cardtable`** — the repo's own
  main checkout, not a separate clone. That makes "never work in the main
  checkout" a **production** rule here, not hygiene. Worth knowing before the
  next wave scaffolds anything.

**Mutation tests, all four lanes, counts both ways.**

| Guard | Broken | Restored |
| --- | --- | --- |
| E — per-seat leak (`emit.ts`, leak the neighbour's pack into a new view field) | **1 failed / 15 passed**, by name: `expected [ '$.view.neighbourPack[0]', …(14) ] to deeply equal []` | byte-identical, **44 pass** |
| E — refresh guard (`draftRooms.ts`) | **3 failed / 41 passed**; socket-level one fails `expected null to be +0` — the seat really went null | byte-identical, **44 pass** |
| F — requirement 8 drop counter (`registry.ts:413`) | **7 failed / 16 passed** — A-3, A-4, A-11, A-12, A-16, A-17, A-20, i.e. every requirement-8 test | byte-identical, **23 pass** |
| G — §4.5 unknown `storeVersion` (`snapshot.ts:325`) | **2 failed / 67 passed** | byte-identical, **69 pass** |
| G — §4.1 save-before-load (`persistence.ts:340`) | **2 failed / 67 passed** | byte-identical, **69 pass** |
| H — duplicate-never-resyncs (`socket.ts:399`) | **2 failed / 26 passed** | byte-identical, **28 pass** |

**Three mutation attempts were INVALID and looked exactly like success.** Worth
recording as a method, because all three produced a red suite:

1. A `perl` substitution on G's §4.1 guard silently did not match the source
   line. Empty diff, 69 passing, exit 0 — indistinguishable from a decorative
   guard, in the *other* direction.
2. Three attempts at E's leak used `room.app.packs`, but `DraftApp` is
   `{ state: DraftState | null }`. The build callback threw, `emitPerRecipient`
   fail-closed, no envelope reached anyone, and every test **timed out**. Red
   suite, zero evidence.

The rule that falls out: **assert the mutation diff is non-empty before trusting
the run, and read HOW the test failed, not just that it did.** A timeout is not
an assertion.

**Claims the tracker re-ran independently, not the lanes' own tests.**

- **The wire schema** (before lane E was unblocked): a client message carrying
  `participantId` is rejected **and named by key**; an honest pick parses; a
  forged envelope cursor disagreeing with its payload is rejected; a Scryfall
  `image_uris` blob **inside** the embedded view is rejected at
  `$.view.viewer.pack[0].image_uris`; all five engine `PickRejection` codes are
  carryable and exactly those five.
- **A precise limit on that control, found by probing it:**
  `safeParseServerMessage` **accepts** a card-shaped object in a *new* field, and
  accepts bare card names as strings. `semanticIssues` walks `viewer.pack` and
  `viewer.pool` and applies D13 **there**; it does not hunt card-shaped objects
  in arbitrary fields. The positional hidden-information control lives in the
  **tests** (`leakedCardPaths`) and in `apps/ui/src/draft/hiddenInfo.ts` — not in
  the shipped validator. That is defensible (the envelope's type design means a
  leak requires *adding a field*, which a reviewer sees) but it is not what
  "the parser rejects leaks" would imply, and the board should not imply it.
- **P6's headline, on the tracker's own driver** rather than lane G's fixtures:
  20 real picks, `flushAll`, then a fresh `FileRoomStore` over the same
  directory in a second `RoomPersistence` → same roomId · same seat · **pool
  identical card-for-card (20 cards)** · **epoch CHANGED** · next pick accepted
  and the pool grew by exactly 1 · no other seat's cards anywhere in the view
  (**20 ids checked**). The first run of that last check read `checked 0 ids`
  and *passed* — vacuous, the same shape as the D13 test that kept passing
  because its fixtures had no ids. It only became real once the restore
  actually restored.
- **`tsc` genuinely cannot emit `apps/server` any more.** Rebuilt the old
  emit-to-`dist` tsconfig against the new sources: exit 2, **16×TS5097**; with
  tests excluded the errors move into `packages/draft/src` itself
  (**13×TS5097**), because the workspace packages export TypeScript source whose
  imports carry `.ts`. Adding `allowImportingTsExtensions` then demands `noEmit`
  (TS5096). So `build` is now `tsc --noEmit && esbuild --bundle`. **The external
  contract is unchanged**: `main`, `start` and `dist/index.js` are byte-identical
  in intent, and the PM2 wrapper
  (`hadoku_site/services/pm2/cardtable-wrapper.mjs`) runs
  `node <repo>/apps/server/dist/index.js` — read directly, confirming the
  choice. Bundle externalises exactly `express`, `socket.io` and the two
  `@wolffm` packages; `zod` is inlined because pnpm's strict layout will not
  expose a transitive next to `dist/`.
- **`esbuild@0.28.2` clears the supply-chain gate** — published 2026-08-08, 38
  days old against `minimumReleaseAge: 10080` (7 days).
- **The pool resolves on the deploy host** — lane E listed this as
  unverifiable; the deployed process logs `draft socket ready — MTGO Vintage
  Cube 2025-12: 534 cards`. Production also shows **no** `EDGE_AUTH_SECRET
  unset` warning, so provenance verification is live there.

**Still NOT verified — these stay on the board.**

- **Two browsers drafting one pod** (§H.5 / §E.6). No lane claimed it; all of
  them said so. Needs two friend-authenticated browser contexts. Settle with:
  open `https://hadoku.me/cardtable/` in two contexts → Source → "Server" → same
  draft id → pick in one, assert the other's pack updates without a reload →
  refresh one mid-draft, assert it returns to the same seat with its pool intact.
- **P5's acceptance criterion** is a four-player *match* with a board and a
  hand. There is no match engine in this repo (O2 put the draft in-process), so
  every P5 clause is tested against a room with four seated participants and an
  opaque `TApp`. Not a gap in the lane; a gap in what exists to test against.
- **"No filesystem call during a full lifecycle"** is asserted as an empty temp
  directory, not by stubbing `node:fs`. Lane G's own test comment says so.
- **W4's art gate proved nothing on this artifact.** `d13-gate.sh` says so
  itself: arms 2–4 examined **zero** references because the art manifest is
  empty until the upload CLI runs. Arms 1 and 5 ran; the 65-fixture `--self-test`
  is what shows the arms bite. **If the count stays 0 after an upload, the gate
  has stopped seeing the artifact** — the script says that too.

**Found, and now owed to someone.**

- **`markDirty` is a silent-loss edge.** A host that mutates `room.app` and
  forgets `persistence.markDirty(roomId)` flushes nothing and loses everything;
  `flushAll()` returns `[]` and nothing complains. The tracker hit it writing
  the restore test. It is the standard explicit-dirty contract and it is
  documented — and `apps/server` is not a consumer yet, so nothing depends on it
  today. It will the day P6 is wired in.
- **Two pieces of P5/P6 are built but not wired**, both correctly declined as
  out-of-lane rather than quietly skipped: cancelling pending asks on service
  `lost` (needs `@hadoku/room-ask`, lane F's package) and `collectGC` →
  `RoomPersistence.destroy`. Lane E deliberately runs **no GC at all** — rooms
  live for the process lifetime, a slow leak — because `collectGC` reaps on
  `clients.size === 0`, which for a 45-minute draft is every room the moment the
  last connection blips.
- **A false claim shipped in production and was corrected mid-wave.**
  `App.tsx`'s footer and `apps/ui/package.json`'s description both said this
  project "never loads, caches or proxies a card image" / "Never renders a card
  image", false since `aea07a6` shipped card art — `CardTile.tsx:105` renders
  `<img src={imageUrl}>`. Lane H fixed the footer and missed the manifest line
  it had rewritten in the same commit; the manager sent it back (`9a99fa3`). On
  the rebase the tracker resolved it a third time, because W4's **D15** landed
  underneath and made H's own correction wrong too — art comes from
  `cdn.hadoku.me`, not Scryfall. Repo-wide grep now finds no surviving copy.
- **Both waves bumped `@hadoku/ui` to 0.2.0 independently** and git auto-merged
  the collision silently. Resolved by taking main's and re-bumping to **0.3.0**,
  rather than letting one version number cover two waves' content.
- **This board contradicted itself.** The header said "Wave 2 LANDED" while a
  Wave 3 closing ledger sat 170 lines below it; a 39-line ledger block appeared
  **twice**, byte-identical; two different Wave 2 ledgers shared one heading;
  and the epoch (W4) row said "wave-3 lane A" in PR-3 while the same row in PR-2
  already said DONE. All corrected this pass. **Wave 4's closing notes were
  never recorded at all** and are not invented here.

## Verified this pass (2026-09-14 evening — tracker, closing Wave 3)

- **`ApiType` is 199 distinct, 7 unnamed — and my 200 was wrong.** Re-derived:
  `ApiType.java:137` is `//NoteCounters (CountersNoteEffect.class),`, commented
  out; my unanchored grep matched inside it. Anchored → **199**. The 7 unnamed,
  listed: `AnimateEffectBase`, `CountersNoteEffect`, `DamageBaseEffect`,
  `DetachedCardEffect`, `ManifestBaseEffect`, `PermanentEffect`,
  `TokenEffectBase`. And 202 − 3 `CharmEffect` duplicates = 199 on its own.
- **Lane C's docs document the trap rather than just the number.** `CLAUDE.md`
  now carries the derivation commands inline and names both of my grep failures
  — the `Mode.` off-by-one at `ProtocolMethod.java:136` and the unanchored
  `.class` at `ApiType.java:137`. `WASM_AND_PORTING.md:91` explicitly says the
  unanchored form "yields exactly the old pair — 200 distinct, six unnamed".
- **P2 is untested, not passed** — the manager is right. Lane B's lockfile delta
  is **6 lines and one workspace link** (`@hadoku/carddata: link:../carddata`);
  `grep -rn '@wolffm' pnpm-lock.yaml packages/*/package.json` returns **nothing**
  repo-wide. `gh secret list` still empty. CI green proves nothing about it: no
  cold runner has tried to resolve an `@wolffm/*` tarball yet. Lane A was that
  first dependency, and lane A did not run.
- **P1 still open, third wave.** `NODE_AUTH_TOKEN` unset; bare `npm view` → E401.
- **Lane D delivered.** `origin/cardtable-w2-requests` at `ccfeab46`, upstream
  set, **0 behind** their `main`, 5 files, commit *"re-read P3-P6 against
  0.38.110, and answer the seat question"*. Committed is now pushed.
- **W3 is genuinely moving, and shaped to our asks.** Their worktree
  `.claude/worktrees/rooms-resv` on `rooms/seat-reservations` is **0 commits
  ahead of main with 7 dirty files** — in progress, uncommitted, so nothing is
  verifiable as shipped. Read-only, their `seats.ts` already carries
  `SeatReservation`, an opt-in **`reservationTtlMs`** (our ask: configurable,
  not a constant), the note that a reservation *"survives the case nothing else
  can"* when a server restarts (our restart argument), that it is **data** so it
  persists with the table (P6), and that it **blocks other humans, not bots** so
  `padWithBots` fills the held seat — which is the botted-and-reclaimable
  behaviour our ask #2 wanted. **Do not record any of this as shipped.**
- **W5 may be moving too** — a new untracked `apps/server/test/emit-payload-types.test-d.ts`
  sits beside a modified `emit.ts` in that same worktree. A *type* test is what
  fixing the `unknown | typeof SKIP` collapse would need.
- **Gate on `main`:** install **0**, check **0**, **187 passed / 11 files**, up
  from Wave 2's 138 / 9.

## Verified in the previous pass (2026-09-14 morning — tracker, closing Wave 2)

Re-derived rather than read. **Every one of the manager's five corrections to
the board is right, including the two I initially failed to reproduce.**

- **Four lane commits are ancestors of `origin/main`** (`df716ef` D, `169cb9c`
  E, `ae5a076` A, `1a7a2f4` C; lane E is three commits, not one). Worktree
  removed, tree clean, `pnpm install --frozen-lockfile` **0**, `pnpm check` **0**.
- **`forge/` pristine** — HEAD still `2cd497c`, **0** dirty lines, after a wave
  that built `forge-gui-desktop`.
- **`Booster: 15 Any` is 91.** My 92 was an addition error over my own
  `uniq -c` buckets, which trailing whitespace had split three ways.
- **The corpus is 49,345 / 388, and my 47,315 / 375 was wrong twice over.**
  Reproduced the whole chain: `^[0-9]+\s+` silently drops **1,958** card lines
  that carry no leading count, across exactly three cubes — `Old School 93-94
  Magic Full Set 878 Card Cube` (878, the entire cube), and both Grixis cubes
  (540 each). 47,315 + 1,958 + 72 bare names = **49,345**. Set codes by field
  `[1]` = **388**; by last field = **720**, which is the wrong answer the
  manager reports getting first, reproduced exactly.
- **`ProtocolMethod` is 60.** 61 lines mention `Mode.SERVER`/`Mode.CLIENT`, but
  line **136** is inside a method body (`if (mode == Mode.SERVER && ...)`), not
  a constant. So **45 SERVER / 15 CLIENT**. `CLAUDE.md`'s "62-method enum" is
  wrong and is still uncorrected.
- **`ApiType` is 206 / 202 / 200 — all three confirmed.** I first read 204 and
  doubted the 206: it is **204 `*Effect.java` plus `AnimateEffectBase.java` and
  `TokenEffectBase.java`**, i.e. 206 `.java` files in `effects/`. 202 constants,
  200 distinct, `CharmEffect.class` named **4×**, and **every** class ApiType
  names has a file on disk.
  > **SUPERSEDED 2026-09-14 by Wave 3 lane C — the tracker was wrong here.**
  > The distinct count is **199**, not 200, and **7** files are unnamed, not 6.
  > `ApiType.java:137` is `//NoteCounters (CountersNoteEffect.class),` — a
  > **commented-out** constant, and the tracker's unanchored
  > `grep -oE '[A-Za-z0-9_]+\.class'` matched inside the comment. Anchoring on
  > the line start gives 199. **The old pair was self-refuting on its face:**
  > 202 constants with `CharmEffect` named 4× removes 3 duplicates, so
  > 202 − 3 = **199**, never 200 — and the tracker asserted both facts in the
  > same sentence. Same failure class as the `^[0-9]+\s+` regex that dropped
  > 1,958 card lines: a pattern that silently matched the wrong thing.
- **`rankings` is a directory**, beside `rankings_cubecobra.txt`.
- **Mutation-tested the hidden-info control myself, with counts.** Injected one
  card-shaped object at `seats[0].lastPick` in `spectator-pack2-pick5.json`:
  **4 failed / 134 passed, exit 1**, the failure naming the exact path
  `$.seats[0].lastPick`. Restored: **138 passed, exit 0**, tree clean. The
  control is positional, not nominal — it walks the whole payload — and it bites.
- **W1 and W2 are genuinely shipped at `0.38.110`**, read from the published
  tarballs, not their source: `emit.d.ts:63 emitPerRecipient`, `:71 emitToRole`,
  `:43 SKIP`; `rooms-protocol/dist/resync.d.ts` exporting `SeqCursor`,
  `classifySeq`, `missedCount`, `needsResync`, `resolveIdentityReassert`.
- **W3 is real and still open.** `rooms-server@0.38.110` `state.d.ts:11` is
  `socketId: string`. Singular, as lane E found.
- **Lane B genuinely did not run.** `packages/draft` does not exist;
  `packages/shared/src` holds only `.gitkeep`. The manager obeyed the wave
  plan's own "do not dispatch B on E401" instruction rather than routing around
  a credential — the right call.
- **P1, P2, P3 all still open**, each re-checked: `NODE_AUTH_TOKEN` unset and
  bare `npm view` → **E401**; `gh secret list` **empty**;
  `cardtable-w2-requests` at `fd584664` with `upstream=[]` and **2 behind**
  their `main`.

## Watches the tracker holds

- ~~**Watchparty P0→P2.**~~ **Closed 2026-09-14.** `@wolffm/rooms-protocol`,
  `@wolffm/rooms-server` and `@wolffm/watchparty-ui` all resolve at
  **`0.38.109`**. Note the watch was checking the **wrong name** — `@wolffm/rooms`
  is still E404 and always will be; it shipped as `rooms-protocol`. Had the token
  in `~/.npmrc` been live, the E401 would have said "exists" three days sooner.
- **Watchparty P2-full.** They shipped P0–P2-**core**, now at **`0.38.115`**.
  Closes when the rest of P2 lands or they confirm P2 complete.
- **`KEY_SERVICE_CARDTABLE` (new).** **Settled 2026-09-16, and the answer is
  "unset".** `gh secret list` has no such secret, so `redeploy.yml`'s
  `report-job` step receives an empty `service-key`. It does **not** fail the
  job: `report-job@v1` guards it and emits `##[warning]service key unset —
  cardtable:redeploy outcome not reported`, observed verbatim on this wave's own
  redeploy run for `5cc9773`. So every cardtable redeploy goes green while
  monitoring-api never hears about it — the exact "a red run is seen by nobody"
  failure the workflow's own header was written about, half-open. Closes when
  the operator seeds it from hadoku_site (`administration.py github-secrets
  child-repos`) or decides cardtable does not report.
- **Our `ParticipantId` bytes vs. watchparty's (new).** `deriveParticipantId`
  is **not published** — `rooms-protocol` ships only the format half — and the
  digest input is undocumented (`P5_SERVICE_PARTICIPANT.md` §7.2's open ask).
  Lane E minted its own: `sha256("hadoku.cardtable.participant.v1" ␟ tier ␟
  material)` truncated to 16 hex, pinned by a test. Ids minted here agree with
  ids minted here, and this process is the only minter for our rooms, so it is
  not a live bug. It becomes one the day anything else mints an id for a
  cardtable room. Closes when they publish the derivation or we agree one.
- ~~**`emitPerRecipient` (W1).**~~ **Closed 2026-09-14** — they exported it
  (`emit.ts:121`) in `e58e3005`. See the PR-3 row.
- ~~**`@wolffm/rooms-client` (W2).**~~ **Closed 2026-09-14** — they shipped the
  resync/identity contract into `rooms-protocol` (`resync.ts`), which is what we
  asked for instead of the client. See the PR-3 row.
- **`ClientMeta.socketId` (W3).** **Still open upstream; we now route around
  it.** Re-reproduced 2026-09-16 against the shipped `0.38.111`, replaying
  `state.js`'s own call order: after a refresh the drafter is `roleOf ==
  'spectator'` with their seat empty, a live reservation held for them, and
  `remembered` intact. `leaveRoom` still calls `unseatParticipant`
  unconditionally. Wave 5 lane E took **option (c)** — the hosting app guards
  the call: after `leaveRoom`, if `clientByParticipant` still finds a live
  client for that id, `seatParticipant` puts them back in the remembered seat.
  Mutation-tested: delete the guard → 3 tests fail, the socket-level one as
  `expected null to be +0`. **Closes when they fix it upstream**; until then
  every consumer of `rooms-server` has this bug unless it writes the same guard.
- ~~**`0.38.110` publication.**~~ **Closed 2026-09-16.** `npm view
  @wolffm/rooms-protocol version` → **`0.38.115`**, exit 0. They are five
  releases past the version this watch was opened on. `rooms-server` lists
  `0.38.108`…`0.38.115`. We pin **`0.38.111`** everywhere, deliberately and
  consistently — that is the version every Wave 5 claim was verified against.
- **`HADOKU_NPM_READ_TOKEN` (P2).** **Half closed 2026-09-16.** `gh secret
  list` is non-empty and the repo now really depends on two `@wolffm/*`
  packages, so the first half is met and the path is no longer structurally
  dead. The second half is **not** proven: the self-hosted runner is warm
  (`reused 299` of 307), so the install can be served from a cached store
  without authenticating. Closes on a cold runner, or `pnpm store prune`
  before `pnpm install --frozen-lockfile`.
- **`CLAUDE.md` — two of three fixed, one still wrong.** Re-verified against
  the tree 2026-09-16, after Wave 4 lane D rewrote the file: **(2) FIXED** —
  line 57 now reads "60-method enum: 45 server→client, 15 client→server", with
  the derivation and the `Mode.SERVER`-in-a-method-body off-by-one spelled out;
  **(3) FIXED** — line 67 now reads "202 constants naming 199 effect classes".
  **(1) STILL WRONG** — `CLAUDE.md:101` still says *"**Maven ✗** — hokon has no
  `mvn`"*, but `command -v mvn` → `/home/hadoku/.local/bin/mvn`, **Apache Maven
  3.9.16**. W4 rewrote the licensing half of the file and did not touch the
  build-prerequisites half. Closes when a wave owns `CLAUDE.md` and fixes line
  101.
- ~~**`docs/LICENSING.md` §3.**~~ **Closed 2026-09-14 by Wave 2 lane E**
  (`62b1e64`). §3 is rewritten from a live `200` fetch, not a relayed claim, and
  carries both required halves — verified in the committed file: the no-images
  rule is *"stricter than Scryfall [requires] … driven by **WotC's IP**"*
  (lines 185-187), and §3.2 *"The anti-paywall clause, and the tension we are
  not resolving"* quotes the clause verbatim and records that we offer
  **neither** anonymous access **nor** free accounts, unresolved, ending "do not
  fix this by opening a public tier". E also caught that their list gates on
  *"join chat servers, or follow channels"* — social gates, not only payment.
  The original ask, kept for the record:
  **(1)** Scryfall's image rules govern *presentation*, not redistribution —
  they publish no blanket no-caching prohibition, so our no-images rule is
  **stricter than they require and stays**, because it is driven by WotC's IP.
  Say so, or someone will later relax D13 on the grounds Scryfall didn't forbid
  it. **(2)** Their anti-paywall clause says end-users "should be able to access
  card data anonymously or with free accounts"; we take no money so the paywall
  proper isn't engaged, but we offer neither. Write the tension down.
- ~~**D7 / the spike.**~~ **Closed 2026-09-12: NO-GO.**

## Verified in the previous pass (2026-09-14 morning — tracker, closing Wave 2, second ledger)

Every line was re-run by the tracker against live state, not taken from the
manager's note. **Five of them correct the board's own prior numbers.**

- **All four landed lanes are green on `main`.** `gh run list --branch main`:
  `df716ef` · `169cb9c` · `ae5a076` · `1a7a2f4`, each **completed success**.
  Worktree `w2-manager` and branch `w2` are gone; `git worktree list` shows only
  the main checkout.
- **`forge/` is byte-for-byte pristine**, checked again at closing: `git -C
  forge status --porcelain` **0 lines**, HEAD still `2cd497c`, **0** `target/`
  dirs. Two lanes built and ran Forge; both did it in a `cp -a` copy the manager
  made under `~/.cache` and never told them the real path.
- **`ProtocolMethod` is 60, not 62.** Re-derived independently of lane D's tool:
  `grep -cE '^\s+\w+\s*\(Mode\.(SERVER|CLIENT)'` → **60** (45 SERVER, 15
  CLIENT). `CLAUDE.md` and the Wave 2 plan both said 62. The 2 "dead" constants
  really are absent from `IGuiGame.java` (grep exit 1).
- **`15 Any` is 91 recipes, not 92.** `grep -h '^Booster:' | sed 's/ *$//' |
  sort | uniq -c` → 91 `15 Any`, 1 `16 Any`, 1 `9 Any`, 1 rarity. **The board's
  92 came from not trimming trailing whitespace** — one recipe writes `15 Any  `
  and splits off as its own bucket. The O2 argument is unaffected.
- **The corpus is 49,345 lines over 388 set codes — and the board's 47,315/375
  were wrong for a findable reason.** The tracker first *reproduced* 47,315,
  then found why: three cubes (`MTGO Grixis Cube`, `MTGO Grixis Cube 2019-09`,
  `Old School 93-94 … 878 Card Cube`) write card lines **with no leading
  count** — `Abbot of Keral Keep|ORI`, not `1 Abbot …`. Any regex requiring
  `^\d+\s+` silently drops all three, i.e. **1,958 lines and an entire 878-card
  cube**. 47,387 − 72 bare = 47,315 exactly. Lane A's parser handles the
  countless form, which is why its number is the right one. Likewise **388**
  set codes, not 375, and not 720: **3,991 lines carry a third
  collector-number field**, so splitting on the *last* `|` counts collector
  numbers as sets. Take field `[1]`.
- **`res/draft/`'s extra entries are a `rankings/` DIRECTORY plus
  `rankings_cubecobra.txt`**, not "1 `.rankings` + 1 `.txt`" as the board said.
  `ls -F` shows the trailing slash.
- **`ApiType` is three counts, not two** (lane E's refinement, re-counted here):
  **206** `.java` files in `effects/`, **202** `ApiType` constants, **200**
  *distinct* classes. 202 > 200 because `CharmEffect.class` is named **4×**
  (lines 47, 216, 217, 218); 206 > 199 because **seven** files are never named
  — the seventh being `CountersNoteEffect`, whose constant is commented out at
  `ApiType.java:137`. *(Corrected 2026-09-14: this line said 200/six.)* The
  board previously said "202, not 206", which reads as a 202-of-206 subset and
  is not one.
- **W1 and W2 are both closed by watchparty's own `e58e3005`, landed mid-wave.**
  `emit.ts:121 export function emitPerRecipient` (plus `emitToRole:148`) and
  `rooms-protocol/src/resync.ts` exporting `classifySeq`/`needsResync`/
  `resolveIdentityReassert`, re-exported at `index.ts:15`. Their `main` moved
  `624091b8` → `98610f42` **while lane E was writing the delivery**, which is
  the same staleness lane E was correcting P3 for.
- **Lane E's delivery is committed but has never been sent.** `git
  for-each-ref` on `cardtable-w2-requests` shows **`upstream=[]`**; their `main`
  is untouched by us. Committed ≠ delivered.
- **P1 and P2 are both still open**, re-checked at closing: `NODE_AUTH_TOKEN`
  **unset**, bare `npm view @wolffm/rooms-protocol version` → **E401**, `gh
  secret list` → **empty**.
- **No TODO/FIXME/XXX in source** (`grep -rn` over `packages/ apps/ scripts/`,
  exit **1** read directly, not through `head`). **No open issues.** Tree clean.
- **Both safety controls bite** — the tracker re-ran the mutations, it did not
  take the counts on trust. D13 no-images: injecting `image_uris`/`.jpg` into
  `resolve.ts` flips the grep to exit 0 **and** fails the test; restored, grep 1
  / test 0. Spectator leak: injecting seat 3's 19-card pool into the spectator
  fixture fails the suite (exit 1); restored, exit 0. Lane D's
  `run.sh verify-pristine`: clean 0, dirtied **1**, restored 0.

## Verified in the previous pass (2026-09-14 — tracker, planning Wave 2)

Every line below was run by the tracker at planning time, not taken from a
report. Four of them contradict the board as it stood.

- **The remote exists and CI is green.** `WolffM/hadoku-cardtable`, **private**,
  created 07:26 on 2026-09-12; `origin/main == local main` (`df26cbd`);
  `gh run list` shows **4 runs, all success**. The board said "no remote" and
  "workflow has never run". O1's repo half is done.
- **…but `gh secret list` is EMPTY.** `HADOKU_NPM_READ_TOKEN` is not set. CI is
  green only because no `@wolffm/*` dependency exists. **The row was true and
  vacuous at the same time**, which is the exact failure class watchparty's own
  closing note warns about — a gate reporting success while doing nothing.
- **Watchparty published.** `rooms-protocol`, `rooms-server`, `watchparty-ui`
  all at **`0.38.109`**, read from the tarballs. **`@wolffm/rooms` was renamed
  `@wolffm/rooms-protocol`** — the old name is still E404, which is why the
  watch read as blocked.
- **The E401 is an unsubstituted env var, not a dead token.** `~/.npmrc` line 1
  is `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` and the variable is
  **unset**, so npm sends the placeholder string as the credential. pnpm warns
  `Failed to replace env in config: ${NODE_AUTH_TOKEN}` on every install.
  `NODE_AUTH_TOKEN=$(gh auth token) npm view @wolffm/rooms-protocol version`
  → **`0.38.109`**. Also worth keeping: **E401 ≠ E404** — a 401 means the
  package exists, which is what disproved the "still blocked" reading.
- **`SKIP` is exported without `emitPerRecipient`.** `rooms-server@0.38.109`
  `emit.d.ts:34` declares the sentinel and points at a function that is in
  neither `emit.d.ts` nor `index.d.ts`. → W1.
- **They shipped our P3 correction.** `EmitPolicy`'s own doc comment says the
  hardcoded list *"would have silently dropped a card game's state deltas as
  'low priority'"*, and `lowPriorityOrder` is documented *"An event in neither
  list is never dropped"* — the D11 correction, now in their code. `thresholdBytes`
  **is** the queue bound our corrected P3 §2.2 asked for. **So P3 must be trimmed
  before delivery**, or we ask them for what they already shipped.
- **O2, settled on evidence.** `BoosterDraft.java` = 925 lines in **`forge-gui`**,
  17 `SGuiChoose`/`SOptionPane` call sites, `FModel` singleton. Reusable core is
  5 methods. Cube pack recipes across all 94 files: ~~92~~ **91
  `Booster: 15 Any`** (corrected above — trailing whitespace on one recipe),
  93/94 singleton, 93/94 3×8, **1** with rarity slots, 7 keys total — and an
  8th, `CustomRankings`, which lane A found in `CustomLimited.java:123`. The O2
  conclusion is unchanged.
- ~~**Card resolution is the real lane-A risk:** **47,315** set-qualified card
  lines vs **72** bare names, over **375 distinct set codes**.~~ **The risk call
  was right; two of the three numbers were wrong.** Corrected in the Wave 2
  ledger above to **49,345** lines / **49,273** set-qualified / **388** set
  codes. Only the **72** bare names survived re-counting.
- **`SimulateMatch.java` is the headless precedent** — 404 lines, `case "sim":`
  implemented right beside the unimplemented `case "server":` at `Main.java:111`.
- **`GameModule.tsx` is 1,341 lines, not 1,344**, and lines 129-133 state the
  iframe *"can't touch this app's Socket.io connection"*. That is what settles W2.
- **No TODO/FIXME in source, no open issues, no stale worktrees, tree clean.**

## Verified in the previous pass (2026-09-12 — Wave 1 manager, re-run from artifacts)

Every one of these was re-run by the manager, not taken from a lane's report.

- **`pnpm check` bites.** Not vacuous: typecheck→exit 2, lint→exit 1, test→exit 1
  under injected faults, all restored to 0.
- **The D13 no-images control is real, both halves.** Sneaking `'image_uris'`
  onto the allowlist fails 1/7; making `projectCard` a `{...raw}` pass-through
  *also* fails 1/7. The second is the one that matters — a static allowlist
  assertion alone would pass while the projection leaked everything.
- **TeaVM NO-GO reproduces.** `run.sh wasm` exit 1, exactly 30 distinct missing
  APIs, 0 tinylog-attributable, 11 in `java.util.concurrent`, 7 Guava.
- **`teavm-classlib-0.15.0.jar` has 0 entries under `java/util/concurrent/locks/`**
  and 14 types in `java.util.concurrent` — read out of the jar.
- **`ApiType` is 202 constants**, not 206. `docs/WASM_AND_PORTING.md` still says
  206 and was owned by nobody this wave — ~~**stale, needs fixing.**~~ **Fixed
  2026-09-14 by Wave 2 lane E (`e5102de`)**, and refined: it is **three** counts
  (206 files / 202 constants / **199** distinct), not two. `CLAUDE.md` still carries
  the old 206 — see the watch.
- **`res/cube/` = 95 `.dck`**, not 96; `res/draft/` = 96 entries (94 `.draft`).
- **Scryfall:** no UA/Accept → 400 with Scryfall's own error text; honest UA +
  Accept → 200; `server: cloudflare`.
- **watchparty `safeEmit.ts:32-48`:** unlisted events take `idx === -1` and reach
  `socket.emit` at line 48. **Never shed.** Their §4 and our D11 were wrong.
- **`forge/` is byte-for-byte pristine** after the whole spike — 0 dirty lines,
  HEAD still `2cd497c`. Every build ran against a `cp -a` copy in `~/.cache`.
- **No AI attribution** in any of the six commits; all authored `WolffM`.

## Verified in the previous pass (2026-09-11)

- `@wolffm/rooms` and `@wolffm/rooms-server` → **E404**. Pre-package confirmed.
- Watchparty `rooms/p0-participant-identity` worktree is at `39e47007`, same as
  main — their "P0 is underway" means scaffolded, **not** started.
- `mvn` absent; Maven installable user-local without sudo (D14).
- `forge/` is stock upstream, untracked, unmodified — nothing to fork from yet.
- Forge module LOC re-measured correctly after a bad `xargs`/`tail` count:
  `forge-game` 127,083 · `forge-gui-mobile` 103,038 · all-but-mobile-platforms
  516,450.
