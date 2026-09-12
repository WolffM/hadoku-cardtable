# Decision log

Append-only. Newest last. Every decision that shaped this project, who made it,
and what it rules out. If you're about to re-litigate something here, read the
"rules out" column first.

Status key: **settled** = do not re-open without new evidence · **provisional**
= made on current evidence, expected to change · **open** = not decided.

---

## D1 — Repo name `hadoku-cardtable` · settled · 2026-09-11 · operator

Route `hadoku.me/cardtable/`, registry id `cardtable`.

Chosen over `hadoku-cube` (too format-specific) and `hadoku-forge` (couples the
name to a dependency we may de-emphasise). **Rules out:** naming the product
after Forge or after cube drafting specifically.

## D2 — Forge is vendored in-repo · settled · 2026-09-11 · operator

Forge lives at `forge/`. Consequence, accepted knowingly: **this whole repo is
GPL-3.0-or-later.**

Mechanism: **git submodule** onto `WolffM/forge` once that fork exists. Today
`forge/` is a plain shallow clone of upstream and is **gitignored** — there is
nothing to fork from yet because we've made no changes.

**Rules out:** an MIT room layer living in this repo (see D11), and a
`git subtree` that would put ~70k upstream commits in our history.

## D3 — Draft-first sequencing · settled · 2026-09-11 · operator

P1 browser cube draft → P2 play in Forge desktop → P3 WS/JSON bridge → P4
browser play client.

Rationale: drafting is the social bottleneck, needs no rules engine, and is
playable long before the bridge exists. **Rules out:** bridge-first, and
lobby-only.

## D4 — Java stays; no port to Rust/Bevy · settled · 2026-09-11 · operator

After measuring: "engine + all the UI" is **392,151 lines** (`forge-core` +
`forge-game` + `forge-ai` + `forge-gui` + `forge-gui-mobile`) plus 33,755 card
scripts.

Three reasons, in order of weight:

1. **The value is the corner cases, not the code.** `forge-game` is 127k lines
   because Magic is 30 years of exceptions. A port loses exactly what you're
   porting for — **and has no oracle**, since the only way to verify a Rust
   engine plays Magic correctly is to diff it against Forge.
2. **Rust's ownership model is the worst fit for this shape** — Forge's state is
   a large cyclic mutable graph (`Game` ↔ `Player` ↔ `Zone` ↔ `Card` ↔
   `SpellAbility`). You'd put `Rc<RefCell<…>>` on every edge: Java's object model
   with worse ergonomics and runtime borrow panics.
3. **The cross-platform argument is already satisfied.** libGDX gives desktop +
   Android + iOS today — `forge-gui-android` (3,789 lines) and `forge-gui-ios`
   (3,155 lines) are *thin launchers* over the shared 103k-line
   `forge-gui-mobile`. Web is the only missing platform.

Also: brave-quartet's `crates/net` is lightyear rollback netcode for a realtime
action game. Magic is turn-based with blocking prompts — nothing to roll back.

**Rules out:** transpilation, a Rust rules engine, and Bevy as the UI layer.
Full argument in `WASM_AND_PORTING.md`.

## D5 — WASM is about deployment, not language · settled · 2026-09-11

TeaVM/CheerpJ **compile Java**; they don't free you from writing it. What frees
you from Java is the architecture: a 3-method transport seam and a closed
62-method protocol mean the only Java we ever touch is one `IToClient`
implementation and `Main.java`'s stubbed `case "server":`.

**Rules out:** "go WASM so we don't write Java" as a reason. The reasons that
survive are: no JVM to operate, client-side solo play, and a browser client we
didn't have to write.

## D6 — The Forge UI renders inside the player canvas · settled · 2026-09-11 · operator

> *"render the entire forge ui INSIDE what is currently reserved as the media
> player canvas from the watchparty ui"*

The watchparty room chrome — chat, roster, presence, lobby — surrounds a central
canvas slot. Forge's UI occupies that slot. This is **exactly the bomberman
pattern already shipping**: `apps/ui/src/components/GameModule.tsx` (1,344 lines)
mounts an isolated iframe in the player slot and bridges `postMessage` ↔ socket
events.

Consequences:

- The Forge UI is an **iframe payload**, not React components. We do not rebuild
  the deck editor.
- This is the strongest argument yet for the gdx-teavm path (D7): the payload we
  want in that iframe is `forge-gui-mobile` compiled to WASM.
- The iframe ↔ parent bridge is a first-class deliverable, modelled on
  `GameModule.tsx`.

**Rules out:** a React re-implementation of Forge's deck editor / draft / match
screens as the primary plan.

## D7 — gdx-teavm spike decides P4 · provisional · 2026-09-11

`forge-gui-mobile` is libGDX, and [gdx-teavm](https://github.com/xpenatan/gdx-teavm)
(maintained, last release Aug 2026) emits WASM. If it compiles, **P4 is deleted**
and the iframe payload of D6 already exists.

The two usual killers are absent:

- **Blocking game threads** — Forge parks a thread awaiting player input;
  browsers can't block the main thread. But [TeaVM 0.13](https://teavm.org/docs/release-notes/0.13.0.html)
  brought coroutines to the WASM GC backend, which its notes call the *final* gap
  between the JS and WASM GC backends.
- **Reflective class loading** — TeaVM can't see `Class.forName("…" + name)`.
  Forge doesn't do that: dispatch is an enum of **class literals**
  (`ApiType { Abandon(AbandonEffect.class), … }` × 206), all statically visible.

Assets aren't the obstacle either: `res/cardsfolder` is 132 MB of text that
`gzip -9`s to **5.6 MB**.

Honest headwind: TeaVM's own docs say it is *"not suited for taking your large
existing codebase in Java and producing JavaScript"*.

**Provisional until** the go/no-go spike lands (Wave 1 lane B). If it fails, P4
proceeds as React — ~14 prompt components over a board renderer.

## D8 — CheerpJ ruled out · settled · 2026-09-11

Full WASM JVM, runs unmodified JARs including Swing. But it ships a JVM to the
browser and renders **Swing** — desktop-mouse UI, touch-hostile, heavy. It's a
"run my legacy app" tool, not a foundation. Java 17 support is borderline
(CheerpJ 4.3 claims 8/11/17). Free for personal use, so a 30-minute sanity test
costs nothing, but it is not the plan.

## D9 — P3 survives regardless of WASM · settled · 2026-09-11

Browsers have no TCP sockets, so Forge's Netty netplay cannot reach a browser
client no matter what compiles it. The WS/JSON bridge at `IToClient` is required
in every branch. **WASM changes who writes the client, not how it talks.**

## D10 — Room module division of labour · settled · 2026-09-11 · watchparty

Watchparty [accepted the extraction](../../hadoku-watchparty/docs/requests/ROOM_MODULE_RESPONSE.md)
and set the order. Verified live: their worktree `rooms/p0-participant-identity`
exists but sits at main's commit (scaffolded, no commits yet), and
`@wolffm/rooms*` returns 404 from the registry — we are firmly pre-package.

| Phase | Item | Owner |
| --- | --- | --- |
| P0 | stable `ParticipantId`, distinct from socket id | **watchparty** |
| P1 | seats + roles + stable ordering | **watchparty** |
| P2 | `RoomState<TApp>`, carve packages, migrate watchparty, **publish 0.x** | **watchparty** |
| P3 | per-recipient emit | **us** |
| P4 | ask + correlation registry | **us** |
| P5 | service participant | **us** |
| P6 | pluggable persistence | **us** |

They reordered ours behind P0 because `clientId IS socket.id` in their repo
today — there is no stable participant identity, so pending-ask replay, seats,
and persistence are all unbuildable until P0 lands. That critique was correct and
we accept it.

We propose the P3–P6 interfaces; they ratify the public surface. **Everything we
can do before their P2 publishes is what Wave 1 is for.**

## D11 — Their design calls, accepted · settled · 2026-09-11 · watchparty

Accepted without argument — each corrects something we couldn't see from outside:

- **`RoomState<TApp>` has no default for `TApp`.** Our `= unknown` let code touch
  a room without declaring which app it belongs to.
- **`readyCheck` is NOT a core field** — it's a feature over seats. Putting it in
  core is how their `RoomState` reached 30 fields.
- **A participant has a `Set` of sockets, not one socket id.** Plural because a
  refreshing leader's old transport is still live when the new one joins; ~40
  lines of takeover heuristics exist to paper over that. Matters to us directly:
  *a mid-draft refresh must not vacate a seat for even one tick.*
- **`ParticipantId` is tiered and the tier is in the id** — `fk:` / `dev:` /
  `eph:`. A 45-minute draft seat can require `fk:` or `dev:`. The raw id never
  goes on the wire; clients see an opaque handle.
- **`ask` is keyed on participant, not client; timeout carries a value**
  (`{mode:'value', value:T} | {mode:'throw'}`); asks to a participant with no live
  socket **queue rather than fail**; cancelled when they leave the **seat**, not
  when a socket drops.
- **Per-recipient emit is room-scoped** (`room.emit.perParticipant(...)`), and
  skipping uses a `SKIP` **symbol** — `null` is a legal payload.
- **Service participant is a `role`, not a second mechanism.**
- **Auth is an injected hook**; hadoku's tier ladder stays out of the package.

Also flagged by them, for us: `safeEmit`'s backpressure priority list hardcodes
watchparty event names, so our state deltas would be dropped as low-priority
under load until P2 makes it injected config. And **our CI must use
`HADOKU_NPM_READ_TOKEN`, not `GITHUB_TOKEN`** — a warm pnpm store hides the 403.

## D12 — Clean-room firewall on P4 · settled · non-negotiable · watchparty

> *"Specify P4 from requirements, never from Forge's implementation … Preferably
> the person who read `ReplyPool.java` is not the person who writes `ask()`."*

These packages stay **MIT**; Forge is **GPL-3.0**. MIT → GPL consumption is fine;
the reverse is not.

**This session has read `ReplyPool.java` and is therefore contaminated for P4.**
Operational consequence, binding on every future session:

- The P4 implementer must be a **fresh agent**, never a fork of a contaminated
  session.
- It may read: watchparty's `ROOM_MODULE_RESPONSE.md` §3.4, and a
  requirements-only brief.
- It may **not** read: anything under `forge/`, `docs/FORGE_ANALYSIS.md`, or
  `docs/requests/WATCHPARTY_ROOM_MODULE.md` — all three discuss `ReplyPool`.
- No contaminated session reviews P4 code against Forge's implementation.

## D13 — Licensing posture · settled · 2026-09-11

GPL-3.0-or-later confirmed from source (491 files carry the "or (at your option)
any later version" header). Obligations trigger on **conveying binaries**, not on
running a server — so hosting for friends owes nothing, but **P2 must ship the
stock upstream Forge build**, not a patched one, or we owe every recipient source.

The Fan Content Policy **does not cover us** — it prohibits WotC IP "in other
games…regardless of whether it is distributed for free". Forge/XMage/Cockatrice
are a *tolerated grey zone*, not a licensed one. Say this plainly rather than
citing the FCP as cover.

Hard rules: **no money in any form, ever** · no public or anonymous tier · never
commit, host, mirror, cache or proxy card images · no WotC marks in the UI.

Open: Scryfall's terms — `scryfall.com/docs/api` returned 403 twice. Rate limits,
attribution and their image-redistribution stance are **unverified** and must be
checked before any ingest ships.

## D14 — Maven installs to `~/.local`, no host mutation · settled · 2026-09-11

Forge needs Maven; hokon has none and upstream ships no `mvnw` (only
`.mvn/maven.config`). Verified: `~/.local/bin` exists and is on `PATH`, `sudo`
requires a password, and `dlcdn.apache.org` returns 200. So Maven goes in as a
user-local tarball — **no sudo, no fleet mutation, no operator action needed**.

Java 21 is already present; Forge targets 17.

---

## Still open — each needs an operator decision

| # | Question | Recommendation |
| --- | --- | --- |
| O1 | Create `WolffM/hadoku-cardtable` and fork `Card-Forge/forge`? Both are outward-facing. | Yes to both; the fork is needed before `forge/` can become a submodule |
| O2 | P1: reimplement draft in TS, or reuse Forge's 6,781-line `limited/` engine? | Reimplement — staying JVM-free *is* the point of draft-first. Take the 96 cube lists verbatim. |
| O3 | One JVM per match, or one hosting many? | Defer to P3; decide before building the service-participant lifecycle |
| O4 | Does the WASM spike block Wave 2, or run beside it? | Run beside — Wave 2's card/draft work is needed in both branches |
