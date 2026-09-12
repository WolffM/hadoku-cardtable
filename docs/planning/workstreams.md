# Workstreams — hadoku-cardtable

**The tracker owns this file.** Managers and sub-agents report; the tracker
records. Every row carries the evidence it was checked against, not the doc that
claimed it.

Last swept: 2026-09-12. **Wave 1 LANDED** — all five lanes verified and merged
to `main` (`e359649` E, `5b41cc1` A, `81583ae` D, `7db43ca` C, `9f6f953` B, plus
the tracker commit). Branch `w1` and its worktree are gone. The wave's headline:
**D7 is settled NO-GO** — Forge does not compile to WASM GC, so P4 is a React
client and D6's iframe payload has to be built.

**SHA note:** the tracker rewrote history after the wave (to strip AI-attribution
trailers and swap a real email for the noreply address, both required by
`~/.claude/AGENTS.md`; nothing had been pushed). Every SHA below is the
**post-rewrite** one and resolves in `main`. The manager's own closing note cites
pre-rewrite SHAs that no longer exist.

Rows below carry Wave 1 evidence. **Wave 2 has not been planned** — that is the
next planner's job.

## What this project is for

Friends draft a cube in a browser and play the decks, behind the friend gate at
`hadoku.me/cardtable/`. Forge supplies the rules engine; the watchparty room
layer supplies everything above a match; **Forge's UI renders inside the room's
central canvas slot** (D6).

## Programmes, in dependency order

| # | Programme | State |
| --- | --- | --- |
| **PR-1** | **Ground truth** — toolchain, card data, and the WASM go/no-go that decides the UI strategy | **done** (Wave 1) |
| **PR-2** | **Draft** — pure draft engine, cube import, draft UI. Playable with friends. | Wave 2 |
| **PR-3** | **Room module** — our P3–P6 contributions to `@wolffm/rooms` | P3/P5/P6 designs in Wave 1; code blocked on watchparty P2 |
| **PR-4** | **Play** — WS/JSON bridge at `IToClient`, headless Forge, the embedded client | unblocked; **React client** (D7 NO-GO). Headless Forge already proven to run |

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
| Import Forge's cube lists | **done** | C `7db43ca` | **95, not 96.** `res/cube/` = **95** `.dck`, all imported byte-identical (`diff -rq` clean). The 96 came from `res/draft/`, which has 96 *entries* = 94 `.draft` + 1 `.rankings` + 1 `.txt`. A `.dck` parser + 29 tests ship with it |
| Pure draft engine (no transport) | wave-2 | — | — |
| Pack generation rules | wave-2 | — | `gamemodes/limited/` = 6,781 lines. **O2 now decidable** — the spike verdict is in |
| Draft UI in the canvas slot | wave-2 | — | pattern: `GameModule.tsx`, 1,344 lines |
| `.dck` export | wave-2 | — | — |

### PR-3 Room module

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| P0 stable `ParticipantId` | blocked (theirs) | watchparty | worktree `rooms/p0-participant-identity` exists at **main's commit** — scaffolded, 0 commits |
| P1 seats/roles | blocked (theirs) | watchparty | — |
| P2 carve + publish `0.x` | blocked (theirs) | watchparty | `npm view @wolffm/rooms` → **E404**; `@wolffm/rooms-server` → **E404** |
| P3 per-recipient emit — **design** | **done** | D `81583ae` | `docs/requests/P3_PER_RECIPIENT_EMIT.md`. Carries a **correction to their own §4** — see D11 |
| P5 service participant — **design** | **done** | D `81583ae` | `docs/requests/P5_SERVICE_PARTICIPANT.md`, five-state lifecycle |
| P6 persistence — **design** | **done** | D `81583ae` | `docs/requests/P6_PERSISTENCE.md`, `RoomStore` in-memory by default |
| P4 ask/correlation — **clean-room spec** | **done** | E `e359649` | `docs/requests/P4_ASK_REGISTRY.md`. Firewall held: fresh agent, contamination grep over the doc returns nothing. Read-list is self-reported |
| **Deliver P3–P6 to hadoku-watchparty** | **todo** | us | **new row.** Four docs written *here*; nothing sent. No lane was allowed to write to their repo |
| P3–P6 implementations | blocked | us | blocked on their P2 publishing |
| CI must use `HADOKU_NPM_READ_TOKEN` | **done** | A `5b41cc1` | `.github/workflows/ci.yml:58`. `GITHUB_TOKEN` appears only in a comment saying never to use it. **Workflow has never run** — no remote |

### PR-4 Play

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| `case "server":` headless mode | todo | us | `Main.java:111` prints "Not implemented." |
| WS/JSON `IToClient` | todo | us | `IRemote` is 3 methods; `IToClient` is empty (D9: required in every branch) |
| ~~gdx-teavm embed payload~~ **or** React client | **decided: React** | us | D7 NO-GO. ~14 prompt components over a board renderer. D6's iframe payload does **not** already exist |
| Disable jUPnP | todo | us | `FServerManager` imports `org.jupnp` |
| `FSerializableFunction` on the wire | todo | us | `getChoices`/`one` pass a *function*; not yet investigated |

## Operator's list — only they can do these

| # | Item | Why it's theirs |
| --- | --- | --- |
| ~~O1~~ | ~~fork `Card-Forge/forge`~~ — **resolved 2026-09-11: deferred.** A plain clone already syncs upstream (`origin` *is* upstream); a fork only buys somewhere to push our Forge commits, a submodule URL, and the ability to PR `case "server"` back. None needed until the first line of Java, and lane B explicitly writes none. Repo creation still pending operator. | |
| **O2** | P1 draft: reimplement in TS vs. reuse Forge's `limited/` | **Live and now decidable — the spike is in, and it changed the terms.** The "free draft engine *and* UI in the iframe" branch is **dead** (D7 NO-GO). But lane B proved the other half: `forge-core`+`forge-game` run headless on the JVM in 1.6 s and resolve real card interactions, so reusing `limited/` **server-side** is viable in a way nobody had evidence for before. So the trade is now: TS reimplementation (JVM-free P1, but pack collation/rarity/foil is accumulated correctness with no oracle but Forge — the D4 objection stands) vs. a JVM draft service (correct by construction, but P1 now carries a JVM and O3 arrives early). **Operator's call; Wave 2 needs it.** |
| O3 | One JVM per match vs. one hosting many | defer to PR-4, but decide before the service-participant lifecycle. **Arrives sooner if O2 goes the JVM way.** |
| ~~O4~~ | ~~Does the spike block Wave 2?~~ | **Resolved 2026-09-12: moot.** The spike ran and finished inside Wave 1. |

## Watches the tracker holds

- **Watchparty P0→P2.** Nothing of ours in PR-3 can be *implemented* until
  `@wolffm/rooms*` publishes. Closes when `npm view @wolffm/rooms-server version`
  returns a version instead of E404.
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

## Verified this pass (2026-09-12 — Wave 1 manager, re-run from artifacts)

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
