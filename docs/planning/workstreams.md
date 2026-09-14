# Workstreams — hadoku-cardtable

**The tracker owns this file.** Managers and sub-agents report; the tracker
records. Every row carries the evidence it was checked against, not the doc that
claimed it.

Last swept: 2026-09-14. **Wave 2 PLANNED** —
`docs/planning/wave2-2026-09-14.md`, five lanes, transport-free. Three things
moved under the board since the last sweep and are recorded in "Verified this
pass": the **remote now exists and CI is green**, **watchparty published
`0.38.109`** so PR-3 is no longer wholly blocked, and **O2 is settled — TS
reimplementation**.

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
| **PR-2** | **Draft** — pure draft engine, cube import, draft UI. Playable with friends. | **Wave 2 — lanes A/B/C** |
| **PR-3** | **Room module** — our P3–P6 contributions to `@wolffm/rooms-protocol` / `-server` (**renamed**: `@wolffm/rooms` never shipped) | designs done Wave 1; **P0–P2-core published `0.38.109` 2026-09-14** — implementation unblocked, delivery is Wave 2 lane E |
| **PR-4** | **Play** — WS/JSON bridge at `IToClient`, headless Forge, the embedded client | unblocked; **React client** (D7 NO-GO). **Wave 2 lane D** spikes headless `case "server":` |

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
| Import Forge's `.draft` recipes (94) | **wave-2 lane A** | — | **new row.** `cubes/` has the card lists; nothing yet carries the *pack recipe* that makes them draftable |
| Card resolution: `Name\|SET` → real card | **wave-2 lane A** | — | **new row.** **47,315** card lines carry a set code, **72** are bare names, across **375 distinct set codes** — Forge's codes, not always Scryfall's |
| Import Forge's cube lists | **done** | C `7db43ca` | **95, not 96.** `res/cube/` = **95** `.dck`, all imported byte-identical (`diff -rq` clean). The 96 came from `res/draft/`, which has 96 *entries* = 94 `.draft` + 1 `.rankings` + 1 `.txt`. A `.dck` parser + 29 tests ship with it |
| Pure draft engine (no transport) | **wave-2 lane B** | — | **O2 settled: TS.** `BoosterDraft.java` is in `forge-gui` (the module Wave 1's headless result excluded), 17 `SGuiChoose`/`SOptionPane` call sites + `FModel` singleton. Engine consumes `SeatTable` from `@wolffm/rooms-protocol` rather than inventing seats |
| Pack generation rules | **wave-2 lane B** | — | **The "no oracle" risk does not apply to cubes.** Across all 94 `.draft` recipes: **92 are `Booster: 15 Any`**, 93/94 `Singleton:True`, 93/94 3 packs × 8 players, **exactly 1** uses rarity slots. 7 keys in the format |
| Draft UI in the canvas slot | **wave-2 lane C** | — | **1,341 lines, not 1,344** (recounted). Wave 2 builds the slot *interior* on fixtures only — no room chrome, no socket |
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
| **Deliver P3–P6 to hadoku-watchparty** | **wave-2 lane E** | us | Confirmed undelivered: their `docs/requests/` holds only `ROOM_MODULE_RESPONSE.md`. **Must be revised before sending** — see the P3 row |
| P3–P6 implementations | **unblocked, not scheduled** | us | The blocker cleared on 2026-09-14. Not in Wave 2 by choice — Wave 2 is transport-free. Wave 3 |
| **`emitPerRecipient` missing (W1)** | **watch** | watchparty | **new row.** `emit.d.ts:34` exports `SKIP` as *"Skip sentinel for `emitPerRecipient`"*, but that function is in neither `emit.d.ts` nor `index.d.ts`. A consumer can import `SKIP` and has nothing to pass it to |
| **`@wolffm/rooms-client` (W2)** | **deferred, agreed** | watchparty | **new row.** They deferred it; we agree, and D6 makes it stronger: their `GameModule.tsx:129-133` says a cross-origin iframe *"can't touch this app's Socket.io connection, so we relay via postMessage"*. Our payload never holds a socket. Ask instead for the **resync/seq-gap contract** in `rooms-protocol`, which P6 rides on |
| CI must use `HADOKU_NPM_READ_TOKEN` | **done but VACUOUS** | A `5b41cc1` | `.github/workflows/ci.yml:58` is correct, and CI has now run **4× green**. But `gh secret list` is **EMPTY** and nothing depends on `@wolffm/*`, so the token path has never executed. Lane B makes it load-bearing → operator item **P2** |

### PR-4 Play

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| `case "server":` headless mode | **wave-2 lane D** (spike) | us | `Main.java:111` prints "Not implemented." — re-read 2026-09-14. **`case "sim":` beside it IS implemented** (`SimulateMatch.java`, 404 lines): a working headless-entry precedent |
| WS/JSON `IToClient` | todo | us | `IRemote` is 3 methods; `IToClient` is empty (D9: required in every branch) |
| ~~gdx-teavm embed payload~~ **or** React client | **decided: React** | us | D7 NO-GO. ~14 prompt components over a board renderer. D6's iframe payload does **not** already exist |
| Disable jUPnP | **wave-2 lane D** | us | `FServerManager` imports `org.jupnp`; lane D reports config-vs-code-change |
| `FSerializableFunction` on the wire | **wave-2 lane D** | us | `getChoices`/`one` pass a *function*; lane D settles whether it is a real wire problem |

## Operator's list — only they can do these

| # | Item | Why it's theirs |
| --- | --- | --- |
| ~~O1~~ | ~~fork `Card-Forge/forge`~~ — **resolved 2026-09-11: deferred.** A plain clone already syncs upstream (`origin` *is* upstream); a fork only buys somewhere to push our Forge commits, a submodule URL, and the ability to PR `case "server"` back. None needed until the first line of Java, and lane B explicitly writes none. **Repo creation DONE 2026-09-14** — `WolffM/hadoku-cardtable` exists, private, created 07:26, `main` pushed, CI green. Only the *fork* half remains deferred. | |
| **P1** | **Refresh the GitHub Packages token in `~/.npmrc`** — verified dead: `npm view @wolffm/rooms-server` → `E401 "User cannot be authenticated with the token provided"`, while `gh auth token` resolves `0.38.109`. **Blocks Wave 2 lane B.** | Credential |
| **P2** | **Set `HADOKU_NPM_READ_TOKEN` on the repo** — `gh secret list` is empty; CI's green runs are vacuous until something depends on `@wolffm/*`. | Repo secret |
| ~~O2~~ | ~~P1 draft: reimplement in TS vs. reuse Forge's `limited/`~~ — **RESOLVED 2026-09-14: reimplement in TS.** | **Live and now decidable — the spike is in, and it changed the terms.** The "free draft engine *and* UI in the iframe" branch is **dead** (D7 NO-GO). But lane B proved the other half: `forge-core`+`forge-game` run headless on the JVM in 1.6 s and resolve real card interactions, so reusing `limited/` **server-side** is viable in a way nobody had evidence for before. So the trade is now: TS reimplementation (JVM-free P1, but pack collation/rarity/foil is accumulated correctness with no oracle but Forge — the D4 objection stands) vs. a JVM draft service (correct by construction, but P1 now carries a JVM and O3 arrives early). **Resolved.** The JVM branch lost on evidence gathered at planning time: `BoosterDraft.java` lives in **`forge-gui`** — precisely the module Wave 1's headless proof excluded — and carries 17 `SGuiChoose`/`SOptionPane` call sites plus the `FModel` singleton. Meanwhile the "accumulated correctness, no oracle" objection turned out to be about **set-booster collation**, which a cube never opens: 92 of 94 recipes are `Booster: 15 Any`, 93/94 singleton, exactly 1 uses rarity slots. Reuse would cost `forge-gui` + a JVM to buy a pick/pass loop. **Revisit only for set/block draft or sealed**, where `BoosterGenerator` genuinely earns its keep. |
| O3 | One JVM per match vs. one hosting many | defer to PR-4, but decide before the service-participant lifecycle. **Arrives sooner if O2 goes the JVM way.** |
| ~~O4~~ | ~~Does the spike block Wave 2?~~ | **Resolved 2026-09-12: moot.** The spike ran and finished inside Wave 1. |

## Watches the tracker holds

- ~~**Watchparty P0→P2.**~~ **Closed 2026-09-14.** `@wolffm/rooms-protocol`,
  `@wolffm/rooms-server` and `@wolffm/watchparty-ui` all resolve at
  **`0.38.109`**. Note the watch was checking the **wrong name** — `@wolffm/rooms`
  is still E404 and always will be; it shipped as `rooms-protocol`. Had the token
  in `~/.npmrc` been live, the E401 would have said "exists" three days sooner.
- **Watchparty P2-full.** They shipped P0–P2-**core**. Closes when the rest of
  P2 lands or they confirm P2 complete.
- **`emitPerRecipient` (W1).** Closes when they export it or confirm P3 is ours
  to land against `rooms-server`.
- **`HADOKU_NPM_READ_TOKEN` (P2).** Closes when `gh secret list` is non-empty
  **and** a CI run resolves an `@wolffm/*` dependency. Not before — green CI
  today proves nothing.
- **`docs/LICENSING.md` §3.** *Was* "Scryfall terms / 403". **The 403 is
  disproved** (Wave 1 lane C, re-verified by the manager: a missing `User-Agent`
  is a **400**, not a 403; Cloudflare was filtering the fetching tool). §3 is
  owned by nobody, so its ⚠️ is still there and now *known* stale. Closes when
  §3 is rewritten. Two things it must say, both from lane C:
  **(1)** Scryfall's image rules govern *presentation*, not redistribution —
  they publish no blanket no-caching prohibition, so our no-images rule is
  **stricter than they require and stays**, because it is driven by WotC's IP.
  Say so, or someone will later relax D13 on the grounds Scryfall didn't forbid
  it. **(2)** Their anti-paywall clause says end-users "should be able to access
  card data anonymously or with free accounts"; we take no money so the paywall
  proper isn't engaged, but we offer neither. Write the tension down.
- ~~**D7 / the spike.**~~ **Closed 2026-09-12: NO-GO.**

## Verified this pass (2026-09-14 — tracker, planning Wave 2)

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
- **The `~/.npmrc` token is dead.** `E401 "User cannot be authenticated with the
  token provided"`; `gh auth token` (scopes include `read:packages`) works. The
  distinction matters: **E401 ≠ E404** — a 401 means the package exists.
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
  5 methods. Cube pack recipes across all 94 files: **92 `Booster: 15 Any`**,
  93/94 singleton, 93/94 3×8, **1** with rarity slots, 7 keys total.
- **Card resolution is the real lane-A risk:** **47,315** set-qualified card
  lines vs **72** bare names, over **375 distinct set codes**.
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
  206 and was owned by nobody this wave — **stale, needs fixing.**
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
