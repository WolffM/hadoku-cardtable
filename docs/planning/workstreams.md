# Workstreams — hadoku-cardtable

**The tracker owns this file.** Managers and sub-agents report; the tracker
records. Every row carries the evidence it was checked against, not the doc that
claimed it.

Last swept: 2026-09-14. **Wave 2 LANDED — four lanes of five.** `df716ef` D ·
`e5102de`+`62b1e64`+`169cb9c` E · `ae5a076` A · `1a7a2f4` C, each pushed
separately with **CI green on every one**. Branch `w2` and its worktree are
gone; `forge/` verified pristine at `2cd497c` throughout.

**Lane B was never dispatched.** Operator item **P1** (`NODE_AUTH_TOKEN`
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
| **PR-2** | **Draft** — pure draft engine, cube import, draft UI. Playable with friends. | **two-thirds done.** Cards resolve (A) and the UI picks from fixtures (C); **the engine between them does not exist** — lane B blocked on P1. Wave 3 |
| **PR-3** | **Room module** — our P3–P6 contributions to `@wolffm/rooms-protocol` / `-server` (**renamed**: `@wolffm/rooms` never shipped) | designs done Wave 1; **delivered** Wave 2 lane E on a branch in their repo — **but unpushed and already stale**: they shipped `0.38.110` mid-wave. Implementation is Wave 3 |
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
| **Pure draft engine (no transport)** | **BLOCKED — not built** | — | **Lane B was never dispatched.** Gate `npm view @wolffm/rooms-protocol version` → **E401**; `NODE_AUTH_TOKEN` **unset**. The wave plan's own instruction was "if that returns E401, do not dispatch B", and the manager followed it rather than working around the credential. O2 settled TS; the design stands untouched. **Wave 3, the moment P1 clears** |
| Wire schema (Zod, `packages/shared`) | **BLOCKED — not built** | — | **new row.** Same gate as the engine — it was lane B's other half. `packages/shared` is still an empty directory. Lane C's fixtures are written against the §B.5 **prose** envelope instead, so the schema has a contract to satisfy the day it exists |
| Pack generation rules | **not built** (lane B) | — | **The "no oracle" risk does not apply to cubes.** Across all 94 `.draft` recipes: **91 are `Booster: 15 Any`** (corrected from 92 — 90 clean + 1 with trailing whitespace, which is what a naive `uniq -c` misses), plus `16 Any`, `9 Any`, and **exactly 1** rarity-slot recipe. 93/94 `Singleton:True`, 93/94 3 packs × 8 players |
| Draft UI in the canvas slot | **done** | C `1a7a2f4` | `@hadoku/ui` renders a pack fanned for picking, the pool grouped by mana value, pack/pick counters, `seq`, and a seat bar — from **5 committed fixtures**, 63 tests. No socket, no room chrome, no `@wolffm/watchparty-ui` (greppped in the **diff**, exit 1). Cards drawn by us: zero `<img>`, zero `url()`, pips are our own circles, `{T}` renders as the word TAP |
| **Hidden-information split holds** | **done** | C `1a7a2f4` | **new row.** The spectator payload is **1,077 bytes**, `viewer:{"kind":"spectator"}`, no pack and no pool. Tracker diffed it against the seat-3 payload's 30 card names: **0 leaked**. Mutation-tested — injecting seat 3's 19-card pool fails the suite (exit 1) |
| **B↔C integration check** | **outstanding** | tracker | **new row.** §C's done-when is half-open: "`apps/ui`'s fixtures parse under lane B's Zod schema" cannot run while B does not exist. When B lands, run its schema over `apps/ui/src/draft/fixtures/*.json`. **Per the wave plan a failure there is a lane C bug, not a B bug** |
| `.dck` export | todo | — | not in Wave 2; the parser exists, the writer does not |

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
| P3–P6 implementations | **unblocked, not scheduled** | us | Wave 3. Note `emitPerRecipient` now exists upstream (W1 below), which changes what P3 still has to land |
| ~~**`emitPerRecipient` missing (W1)**~~ | **CLOSED — they fixed it** | watchparty | **Closed 2026-09-14.** Their `e58e3005` *"give SKIP its function, and ship the reconnect contract (W1, W2)"*. Verified in their source: `emit.ts:121 export function emitPerRecipient`, plus `emitToRole:148`, at **`0.38.110`**. The sentinel now has something to pass it to. Lane E reported the defect; they had already fixed it by the time the wave closed |
| ~~**`@wolffm/rooms-client` (W2)**~~ | **CLOSED — they shipped the contract we asked for** | watchparty | **Closed 2026-09-14.** We agreed with the deferral and asked instead for the reconnect/resync/identity-reassert **contract** in the zero-dep `rooms-protocol`. It exists: `rooms-protocol/src/resync.ts` exports `SeqCursor`, `classifySeq`, `missedCount`, `needsResync`, `RosterIdentity`, `IdentityReassert`, `resolveIdentityReassert`, re-exported from `index.ts:15`. **This is what P6's "survive a restart and a refresh" binds to** |
| **Envelope needs an `epoch` (W4)** | **wave-3 lane A** | us | **new row, ours not theirs.** Found reading `rooms-protocol@0.38.110` as its first consumer. `SeqCursor` is `{epoch, seq}`; all five committed fixtures carry `seq` and **no `epoch`**, so they cannot use `classifySeq`. The epoch separates "missed events" from "server restarted and recounted" — opposite responses, and the second **is** P6's restart case. Their `resync.d.ts` header says `lastEventSeq` is stamped only on watchparty's control events and an app wanting gap detection stamps its own cursor |
| **`SKIP` arm doesn't constrain (W5)** | **watch** | watchparty | **new row.** `emitPerRecipient`'s `build` returns `unknown \| typeof SKIP`, and `unknown` absorbs the union — tsc 5.9.3 resolves it to plain `unknown`, so the SKIP arm type-checks nothing. Cosmetic today. Raised with the seat answer |
| **`ClientMeta.socketId` is one string (W3)** | **watch** | watchparty | **new row, found by lane E reading their source rather than their docs.** P3 §3.2 asked for `sockets: Set<string>`; what shipped is `state.ts:16 socketId: string`. On a refresh, `leaveRoom` can unseat a participant who is already back on a live socket. E reproduced it against their real `seats.ts` — the participant ends `spectator` with their seat empty. Closes when they confirm the ordering or take one of the three fixes |
| CI must use `HADOKU_NPM_READ_TOKEN` | **done but VACUOUS** | A `5b41cc1` | `.github/workflows/ci.yml:58` is correct, and CI has now run **4× green**. But `gh secret list` is **EMPTY** and nothing depends on `@wolffm/*`, so the token path has never executed. Lane B makes it load-bearing → operator item **P2** |

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

## Wave 3 — PLANNED and scaffolded · `docs/planning/wave3-2026-09-14.md`

Five lanes, finishing PR-2. **A** draft engine + Zod schema (gated on P1) ·
**B** deck build + `.dck` export · **C** the stale facts in `CLAUDE.md` and
three docs · **D** deliver P3–P6 + the W3 seat answer, in their repo ·
**E** wire the UI to a live engine (after A).

Two operator decisions settled 2026-09-14 and written into the wave:
**W3 → we want reservation-with-TTL**, not the socket Set (it is the only one
of the two that survives a network blip or a server restart, which is what P6
actually requires); and **`cardtable-w2-requests` → rebase, re-read against
`0.38.110`, push**.

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
| **P1** | **Export `NODE_AUTH_TOKEN`** — `~/.npmrc` reads `_authToken=${NODE_AUTH_TOKEN}` and the variable is unset, so npm sends the literal placeholder and gets `E401`. Not a rotation: `NODE_AUTH_TOKEN=$(gh auth token) npm view @wolffm/rooms-protocol version` → a version. **STILL OPEN — re-checked 2026-09-14 after Wave 2: the variable is unset and the bare `npm view` still returns E401.** ⚠️ **This already cost a lane.** Wave 2 shipped four lanes of five; lane B — the pure draft engine *and* the Zod wire schema, i.e. the middle of PR-2 — was never dispatched because of it. **Blocks Wave 3's first lane.** Put it in the shell profile. | Shell env |
| **P2** | **Set `HADOKU_NPM_READ_TOKEN` on the repo** — `gh secret list` re-checked 2026-09-14: **still empty**. CI's green runs are still vacuous: Wave 2 added no `@wolffm/*` dependency (because B never ran), so the token path has **still** never executed. The first lane that depends on `@wolffm/rooms-protocol` is where a cold runner surfaces the 403. | Repo secret |
| **P3** | **Decide what to do with `cardtable-w2-requests` in `hadoku-watchparty`** — our P3–P6 delivery is committed there on a branch with **no upstream**, and it is already stale: they shipped `0.38.110` mid-wave and answered W1 and W2 in `e58e3005`. Either push/PR it after a rebase + re-read, or drop it and re-derive against `0.38.110`. **Nothing reaches them until someone pushes.** | Their repo; ours to send |
| ~~O2~~ | ~~P1 draft: reimplement in TS vs. reuse Forge's `limited/`~~ — **RESOLVED 2026-09-14: reimplement in TS.** | **Live and now decidable — the spike is in, and it changed the terms.** The "free draft engine *and* UI in the iframe" branch is **dead** (D7 NO-GO). But lane B proved the other half: `forge-core`+`forge-game` run headless on the JVM in 1.6 s and resolve real card interactions, so reusing `limited/` **server-side** is viable in a way nobody had evidence for before. So the trade is now: TS reimplementation (JVM-free P1, but pack collation/rarity/foil is accumulated correctness with no oracle but Forge — the D4 objection stands) vs. a JVM draft service (correct by construction, but P1 now carries a JVM and O3 arrives early). **Resolved.** The JVM branch lost on evidence gathered at planning time: `BoosterDraft.java` lives in **`forge-gui`** — precisely the module Wave 1's headless proof excluded — and carries 17 `SGuiChoose`/`SOptionPane` call sites plus the `FModel` singleton. Meanwhile the "accumulated correctness, no oracle" objection turned out to be about **set-booster collation**, which a cube never opens: **91** of 94 recipes are `Booster: 15 Any` (the planner said 92; lane A's count is the right one), 93/94 singleton, exactly 1 uses rarity slots. Reuse would cost `forge-gui` + a JVM to buy a pick/pass loop. **Revisit only for set/block draft or sealed**, where `BoosterGenerator` genuinely earns its keep. |
| O3 | One JVM per match vs. one hosting many | defer to PR-4, but decide before the service-participant lifecycle. **Arrives sooner if O2 goes the JVM way.** |
| ~~O4~~ | ~~Does the spike block Wave 2?~~ | **Resolved 2026-09-12: moot.** The spike ran and finished inside Wave 1. |

## Verified this pass (2026-09-14 — tracker, closing Wave 2)

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
- **Watchparty P2-full.** They shipped P0–P2-**core**, now at **`0.38.110`**.
  Closes when the rest of P2 lands or they confirm P2 complete.
- ~~**`emitPerRecipient` (W1).**~~ **Closed 2026-09-14** — they exported it
  (`emit.ts:121`) in `e58e3005`. See the PR-3 row.
- ~~**`@wolffm/rooms-client` (W2).**~~ **Closed 2026-09-14** — they shipped the
  resync/identity contract into `rooms-protocol` (`resync.ts`), which is what we
  asked for instead of the client. See the PR-3 row.
- **`ClientMeta.socketId` (W3).** **New.** A single `socketId: string` where P3
  §3.2 asked for `sockets: Set<string>`; a refresh can unseat a participant who
  is already back. Closes when they confirm the ordering or take a fix.
- **`0.38.110` publication.** Their `package.json` says `0.38.110` and the code
  is in their `main`, but we could **not** confirm it is published — `npm view`
  is E401 (P1). Closes with `NODE_AUTH_TOKEN=$(gh auth token) npm view
  @wolffm/rooms-protocol version`.
- **`HADOKU_NPM_READ_TOKEN` (P2).** Closes when `gh secret list` is non-empty
  **and** a CI run resolves an `@wolffm/*` dependency. Not before — green CI
  today still proves nothing, and Wave 2 did not change that.
- **`CLAUDE.md` is stale in three places**, and it is owned by nobody so no wave
  has fixed it. Verified against the tree 2026-09-14: **(1)** "Maven ✗ — hokon
  has no `mvn`" — Maven **3.9.16 is installed** at `~/.local/bin/mvn` and lane D
  built Forge with it; **(2)** "the 62-method enum" — `ProtocolMethod` has
  **60** constants; **(3)** "Ability dispatch (enum of **206** class literals)" —
  **202** constants naming **200** distinct classes. Closes when a wave owns
  `CLAUDE.md` and corrects all three.
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

## Verified this pass (2026-09-14 — tracker, closing Wave 2)

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
  (lines 47, 216, 217, 218); 206 > 200 because six files are never named. The
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
  (206 files / 202 constants / 200 distinct), not two. `CLAUDE.md` still carries
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
