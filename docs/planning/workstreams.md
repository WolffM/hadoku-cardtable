# Workstreams — hadoku-cardtable

**The tracker owns this file.** Managers and sub-agents report; the tracker
records. Every row carries the evidence it was checked against, not the doc that
claimed it.

Last swept: 2026-09-11.

## What this project is for

Friends draft a cube in a browser and play the decks, behind the friend gate at
`hadoku.me/cardtable/`. Forge supplies the rules engine; the watchparty room
layer supplies everything above a match; **Forge's UI renders inside the room's
central canvas slot** (D6).

## Programmes, in dependency order

| # | Programme | State |
| --- | --- | --- |
| **PR-1** | **Ground truth** — toolchain, card data, and the WASM go/no-go that decides the UI strategy | Wave 1 |
| **PR-2** | **Draft** — pure draft engine, cube import, draft UI. Playable with friends. | Wave 2 |
| **PR-3** | **Room module** — our P3–P6 contributions to `@wolffm/rooms` | P3/P5/P6 designs in Wave 1; code blocked on watchparty P2 |
| **PR-4** | **Play** — WS/JSON bridge at `IToClient`, headless Forge, the embedded client | after PR-1's spike answers D7 |

## Board

Status: `todo` · `wave-N` · `blocked` · `done` · `watch`

### PR-1 Ground truth

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| pnpm workspace, tsconfig, lint, vitest, CI | wave-1 A | — | repo has zero code files; `git ls-files` = 15 entries, all docs |
| Maven user-local install | wave-1 B | — | `mvn` absent; `~/.local/bin` on PATH; `sudo` needs password; dlcdn 200 |
| Stock `mvn install` of Forge passes | wave-1 B | — | not attempted |
| Sentry stubbed out of engine | wave-1 B | — | 13 engine files call `io.sentry`, incl. `GameAction`, `AbilityFactory` |
| **`forge-core`+`forge-game` → WASM GC (go/no-go)** | wave-1 B | — | not attempted. Decides D7. |
| Scryfall terms verified | wave-1 C | — | `scryfall.com/docs/api` returned **403 twice** to WebFetch; unverified |
| Card data ingest design | wave-1 C | — | Forge ships `ScryfallBulkDataSync.java`, `ScryfallSetSync.java`; gson already a dep |

### PR-2 Draft

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| Import Forge's cube lists | wave-2 | — | `forge-gui/res/cube/` = 96 `.dck`; `res/draft/` = 96 `.draft` |
| Pure draft engine (no transport) | wave-2 | — | — |
| Pack generation rules | wave-2 | — | `gamemodes/limited/` = 6,781 lines to learn from (O2: reimplement) |
| Draft UI in the canvas slot | wave-2 | — | pattern: `GameModule.tsx`, 1,344 lines |
| `.dck` export | wave-2 | — | — |

### PR-3 Room module

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| P0 stable `ParticipantId` | blocked (theirs) | watchparty | worktree `rooms/p0-participant-identity` exists at **main's commit** — scaffolded, 0 commits |
| P1 seats/roles | blocked (theirs) | watchparty | — |
| P2 carve + publish `0.x` | blocked (theirs) | watchparty | `npm view @wolffm/rooms` → **E404**; `@wolffm/rooms-server` → **E404** |
| P3 per-recipient emit — **design** | wave-1 D | us | `broadcastToRoom` already iterates sockets (`util/safeEmit.ts:63`) |
| P5 service participant — **design** | wave-1 D | us | their §3.6 fixes `role: 'service'` |
| P6 persistence — **design** | wave-1 D | us | their rooms are `const rooms = new Map()`; a deploy destroys state |
| P4 ask/correlation — **clean-room spec** | wave-1 E | us | **D12 firewall applies** |
| P3–P6 implementations | blocked | us | blocked on their P2 publishing |
| CI must use `HADOKU_NPM_READ_TOKEN` | todo | us | their §4; a warm pnpm store hides the 403 |

### PR-4 Play

| Item | Status | Owner | Evidence checked |
| --- | --- | --- | --- |
| `case "server":` headless mode | todo | us | `Main.java:111` prints "Not implemented." |
| WS/JSON `IToClient` | todo | us | `IRemote` is 3 methods; `IToClient` is empty (D9: required in every branch) |
| gdx-teavm embed payload **or** React client | blocked | us | depends on wave-1 B |
| Disable jUPnP | todo | us | `FServerManager` imports `org.jupnp` |
| `FSerializableFunction` on the wire | todo | us | `getChoices`/`one` pass a *function*; not yet investigated |

## Operator's list — only they can do these

| # | Item | Why it's theirs |
| --- | --- | --- |
| O1 | Create `WolffM/hadoku-cardtable`; fork `Card-Forge/forge` | outward-facing; `forge/` can't become a submodule until the fork exists |
| O2 | P1 draft: reimplement in TS vs. reuse Forge's `limited/` | scope call. Rec: reimplement |
| O3 | One JVM per match vs. one hosting many | defer to PR-4, but decide before the service-participant lifecycle |
| O4 | Does the spike block Wave 2? | Rec: no — Wave 2 is needed in both branches |

## Watches the tracker holds

- **Watchparty P0→P2.** Nothing of ours in PR-3 can be *implemented* until
  `@wolffm/rooms*` publishes. Closes when `npm view @wolffm/rooms-server version`
  returns a version instead of E404.
- **Scryfall terms.** 403 to automated fetch. Closes when a human reads the page
  and `docs/LICENSING.md` §3 loses its ⚠️.
- **D7 / the spike.** Closes when lane B reports a WASM artifact that runs a
  scripted card interaction, or reports the failure mode.

## Verified this pass (2026-09-11)

- `@wolffm/rooms` and `@wolffm/rooms-server` → **E404**. Pre-package confirmed.
- Watchparty `rooms/p0-participant-identity` worktree is at `39e47007`, same as
  main — their "P0 is underway" means scaffolded, **not** started.
- `mvn` absent; Maven installable user-local without sudo (D14).
- `forge/` is stock upstream, untracked, unmodified — nothing to fork from yet.
- Forge module LOC re-measured correctly after a bad `xargs`/`tail` count:
  `forge-game` 127,083 · `forge-gui-mobile` 103,038 · all-but-mobile-platforms
  516,450.
