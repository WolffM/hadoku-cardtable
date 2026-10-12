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

**Rules out:** a `git subtree` that would put ~70k upstream commits in our
history.

It also ruled out *an MIT room layer living in this repo* (see D11). **That
clause was amended by D16 on 2026-09-16 and is no longer live as written** —
there is exactly one carve-out, `packages/room-ask`, justified by a documented
clean room and an MIT destination, and D20 records the condition that makes it
leave. Nothing else in this tree is MIT.

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

## D6 — The Forge UI renders inside the player canvas · **mechanism superseded by D17** · 2026-09-11 · operator

> **Superseded 2026-09-16 by D17.** The *layout* intent below stands exactly —
> their room chrome around, our table in the centre. The **mechanism does
> not**: there is no iframe payload, because D7 came back NO-GO and cardtable
> is its own app importing their chrome as a package. Read D17 before planning
> anything off this entry. Closed as O7 in D20.

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

## D7 — gdx-teavm spike decides P4 · settled **NO-GO** · 2026-09-12

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
  (`ApiType { Abandon(AbandonEffect.class), … }` × 202), all statically visible.
  *(202 constants, over **206** effect classes on disk — both figures are real
  and measure different things; the original note conflated them. Recounted in
  lane B, refined in `c8a0aac`.)*

Assets aren't the obstacle either: `res/cardsfolder` is 132 MB of text that
`gzip -9`s to **5.6 MB**.

Honest headwind: TeaVM's own docs say it is *"not suited for taking your large
existing codebase in Java and producing JavaScript"*.

### Outcome — NO-GO · 2026-09-12 · Wave 1 lane B

Evidence: `docs/spikes/teavm-go-no-go.md`, `scripts/spike/`. Reproduced by the
wave manager independently of the lane that wrote it.

`forge-core` + `forge-game` do not link against TeaVM 0.15.0's class library:
**30 distinct missing APIs**, and TeaVM writes *no artifact at all* when there
are link errors (`Output file built with errors`). `scripts/spike/run.sh wasm`
exits 1.

**Both of the two "usual killers" above actually passed.** The spike died on
plumbing, not on anything architecturally interesting:

- **Coroutines — PASS.** `Object.wait()` suspended, `main()` returned to the host
  in 1 ms, the worker notified, main resumed after 52 ms. Forge's blocking game
  thread is *not* the blocker. This is the assumption everyone expected to fail.
- **Enum-of-class-literals reflection — PASS.** DCE follows the class literals.
  What was missing was reflection *metadata*, fixed by a 40-line
  `ReflectionPolicy` overlay; WASM output byte-identical to the JVM.

What kills it: `Game.java:97` constructs a Guava `EventBus`; Guava's
`LocalCache$Segment` **extends `java.util.concurrent.locks.ReentrantLock`**; and
`teavm-classlib-0.15.0.jar` ships **zero** classes in
`java.util.concurrent.locks` (14 types in all of `java.util.concurrent`). It
fires on every game event:

```
[ERROR] Class com.google.common.cache.LocalCache$Segment extends
        java.util.concurrent.locks.ReentrantLock, which is missing in the classpath
```

This is a **classlib** gap, not a WASM-backend gap — the JS backend reports 29 of
the same 30.

**Consequences, binding:**

- **P4 proceeds as React** — ~14 prompt components over a board renderer.
- **D6's iframe payload does not already exist.** It has to be built.
- Revisit only if TeaVM ships `java.util.concurrent.locks`. The fork surface
  looks small (3 of 961 files touch Guava `EventBus`, 9 touch `j.u.c.`) — but
  fixing all 30 only reaches the *next* link error, because the spike program
  exercises one static ability on two cards. Treat 30 as a floor, not a cost.

**Not measured, and not measurable while it fails:** full-engine artifact size
and cold start — the 712,640 B / 42.9 ms figures are the **reflection probe
only** — and whether `java.io.File` works under WASM GC at all, so browser
card-script loading is untested and open.

**Bonus finding, verified, and it matters for PR-4:** `forge-core` +
`forge-game` alone are a complete runnable rules engine on the JVM. 33,752 card
scripts and 95,746 printings load in 1.6 s, and Glorious Anthem buffs Grizzly
Bears to 3/3 through the real layer system — with no `forge-gui` and no
`forge-ai`.

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

Also flagged by them, for us: **our CI must use `HADOKU_NPM_READ_TOKEN`, not
`GITHUB_TOKEN`** — a warm pnpm store hides the 403. Done in Wave 1 lane A
(`.github/workflows/ci.yml`).

### Correction · 2026-09-12 · Wave 1 lane D, re-verified by the manager

They also told us `safeEmit`'s backpressure priority list hardcodes watchparty
event names, "so our state deltas would get dropped as low-priority under load".
**That is wrong.** Reading `apps/server/src/util/safeEmit.ts:32-48` in their
tree: the drop only happens when `LOW_PRIORITY_ORDER.indexOf(event) !== -1`. An
event in neither `HIGH_PRIORITY` (line 15) nor `LOW_PRIORITY_ORDER` (line 16)
takes `idx === -1`, skips the inner block entirely, and reaches `socket.emit` at
line 48. **Unlisted events are never shed — they are always sent.**

The error is in our favour, but it changes what we ask for. Our real hazard is
the inverse: unbounded buffering behind a slow socket, with no shedding and no
ceiling. So the P3 ask is not "let us register our events as high priority" but
*a bound on the queue*. `docs/requests/P3_PER_RECIPIENT_EMIT.md` §2.2 carries the
corrected version. Tell them when these are delivered — this is their bug in
their own document, not ours.

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

> ⚠️ *Pointer added 2026-09-15, Wave 4 lane D. The text below is **unedited** and
> is the record of what was decided on 2026-09-11. Two parts of it are no longer
> current: the **image clause** in "Hard rules" is **superseded by D15**, and the
> **"Open: Scryfall's terms … unverified"** paragraph is closed — see the
> `### Amended` block at the end of this decision. Everything else in D13 stands.
> This pointer sits here rather than at the foot because a reader who greps for
> "never commit, host, mirror, cache or proxy card images" lands in the middle of
> this section, and would otherwise never reach the amendment.*

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

### Amended · 2026-09-15 · Wave 4 lane D — the "403 / unverified" paragraph is closed

The paragraph immediately above is **stale**, and separately from the image
reversal in D15. It is left in place because this log is append-only, but it no
longer describes reality:

- **The 403 was a Cloudflare artefact, not Scryfall's policy.** It was
  bot-filtering the *fetching tool's* egress. With an honest `User-Agent` and an
  `Accept` header the page returns **200**; with neither it returns **400** plus
  Scryfall's own error text saying both headers are required.
- **The terms have since been read three times** — Wave 1 lane C (`7db43ca`),
  re-run by the Wave 2 manager, and re-fetched on 2026-09-14. Rate limits,
  attribution and the image guidelines are written up in `docs/LICENSING.md` §3,
  §3.1 and §3.2, quoted rather than paraphrased.
- **Their image-redistribution stance is now known**: the guidelines govern
  *presentation*, not redistribution, and there is no blanket prohibition on
  caching or serving the bytes. That is a finding about Scryfall and it is
  logically independent of D15 — D15 turns on **WotC's** IP, which was never
  Scryfall's to license either way.

So: nothing in this paragraph is still open. It is kept verbatim as the record of
what was believed on 2026-09-11.

**Why an amendment and not an edit:** this correction is about *Scryfall's terms
being verified*, which is a different question from *whether we host art*.
Folding it into D15's body would have made D15 read as though the Scryfall
finding were part of the grounds for hosting — it is not, and that
misattribution is exactly the kind of thing this log exists to prevent
(cf. §3.1's warning against inferring permission from Scryfall's silence). D14
already establishes the `### Amended` form for correcting a decision without
rewriting it.

## D14 — Maven installs to `~/.local`, no host mutation · settled · 2026-09-11

Forge needs Maven; hokon has none and upstream ships no `mvnw` (only
`.mvn/maven.config`). Verified: `~/.local/bin` exists and is on `PATH`, `sudo`
requires a password, and `dlcdn.apache.org` returns 200. So Maven goes in as a
user-local tarball — **no sudo, no fleet mutation, no operator action needed**.

Forge targets 17.

### Amended · 2026-09-12 · Wave 1 lane B — a JRE is not enough

"Java 21 is already present" was true and **misleading**: hokon ships
`openjdk-21-jre`, which has **no `javac` and no `lib/ct.sym`**. The stock Forge
build fails with `error: release version 17 not supported`, which reads like a
Forge/toolchain version mismatch and is in fact a missing compiler. That cost
lane B its first attempt.

**This decision now covers the JDK as well as Maven.** Temurin 21 installs to
`~/.local/opt/jdk-21…` by the same no-sudo tarball mechanism; `scripts/spike/run.sh
bootstrap` installs both. Posture is unchanged: no sudo, no fleet mutation, no
operator action needed.

With both present, stock `mvn install -pl forge-core,forge-game -am -DskipTests`
passes in **13.2 s warm / 27 s cold `~/.m2`**.

## D15 — Card art is hosted on `cdn.hadoku.me` · settled · 2026-09-15 · operator

**Supersedes D13's image clause.** D13 reads *"never commit, host, mirror, cache
or proxy card images"*; that clause is repealed, and D13's text above is left
untouched as the record of what was decided on 2026-09-11. Everything else in
D13 — GPL-3, conveying vs. running, the Fan Content Policy not covering us, no
money, no public tier, no WotC marks — stands unchanged.

The operator decided this explicitly, three separate times. What it means, in
full:

- **Art is uploaded to `cdn.hadoku.me`** by `packages/carddata/src/cli/upload-art.ts`,
  fetched once from Scryfall at their rate-limit guidance rather than hotlinked
  per tile. The CDN is content-addressed by SHA-256, so the upload is idempotent
  and a modified image would be a different object.
- **The CDN is world-readable, and that was accepted knowingly.** Its own
  documentation is *"uploading is friend+; reading is public"*. Every uploaded
  card image is therefore fetchable by anyone holding its SHA-256 URL. The
  operator was shown this and accepted it. **Do not add a gate to the CDN** —
  it is a shared service, this is its designed posture, and re-litigating it is
  out of scope.
- **The art is a PLACEHOLDER, and that is the load-bearing part.** The operator
  expects to source the art elsewhere later and asked that pointing a card at a
  new image stay easy. So a card's art is an indirection, never a URL in a component:
  `apps/ui/src/draft/art-manifest.json` maps `scryfallId → { source, key }` and
  `packages/carddata/src/art/index.ts` resolves it, with an absent or unusable row
  falling back to Scryfall and then to the text tile. Repointing one card is a
  **one-line data edit reviewable in a diff**. The manifest is kept out of
  `pool.json` on purpose, because `build-pool` regenerates the pool wholesale and
  would silently discard hand-curated art.
- **Image bytes still never enter this repo.** `.gitignore` refuses `*.jpg`,
  `*.png`, `cards/`, `card-images/`, and `scripts/d13-gate.sh` fails CI if an
  image file reaches the built bundle.
- **The app's own origin still never serves an image.** Every art URL is
  absolute and its origin is `https://cdn.hadoku.me` or
  `https://cards.scryfall.io` (`ALLOWED_ART_HOSTS`). A relative, root-relative or
  `hadoku.me/cardtable/` image URL remains **forbidden**, and
  `scripts/d13-gate.sh` arm 2 is that assertion. This is the half of D13 that
  survives, and it is the half the gate exists for.

**Grounds**, so the rule does not flip back for want of a reason: no money in any
form; private and friend-gated (401 to anonymous); every other §2 mitigation
untouched; and the art held as a replaceable placeholder rather than a
dependency. This was weighed as a **judgement**, not argued as compliance — it
moves us up `docs/LICENSING.md` §2's risk table, hosting is a louder act than
linking, and the permission that would settle it was never Scryfall's to give.
§3.1 carries the full register, including the superseded argument quoted in full.

**Rules out:**

- reinstating "never host card images" without a new operator decision, and
  citing D13, `LICENSING.md`'s old rule 2, or any pre-2026-09-15 wave plan as
  authority for doing so;
- serving image bytes from the app's own origin, or any relative/same-origin
  image URL — that was never what changed;
- committing image bytes to git;
- hardcoding an image host in a component, or any design where re-sourcing a
  card's art is more than a manifest edit;
- putting art assignments into `pool.json`;
- adding an access gate to `cdn.hadoku.me`, or treating its public-read posture
  as an unresolved problem;
- scaling past the one cube that has been decided — see **O5**.

**Not decided, and deliberately so:** how much art we host. One cube is 534 cards
at roughly 100 KB each, about **53 MB**. All 95 bundled cubes is a different
conversation and nobody has had it yet. See **O5**.

**Known gap, verified 2026-09-15 and not closed by this wave:** the UI footer
(`apps/ui/src/App.tsx`) still tells the user *"this project never loads, caches
or proxies a card image"*. D15 makes that **false on screen**, and it is the one
place the claim is user-visible rather than internal. `LICENSING.md` §2 rule 6
also wants the unaffiliated/unendorsed disclaimer in that footer and it is not
there. That file belongs to another workstream; this is recorded so the gap is
owned rather than forgotten. **Closed 2026-10-11:** the footer line is gone and
the footer now carries *"Unofficial fan project; not affiliated with or endorsed
by Wizards of the Coast."*


## D16 — `@hadoku/room-ask` is MIT inside a GPL repo · settled · 2026-09-16 · operator

**Amends D2.** D2's "rules out" line reads *"an MIT room layer living in this
repo (see D11)"*. `packages/room-ask` is exactly that, and it stays. D2's
mechanism — Forge vendored, whole repo GPL-3.0-or-later — is unchanged;
what is amended is the blanket exclusion.

### Why the exclusion existed, and why it does not apply here

D2 ruled it out to avoid a licence question nobody wanted: GPL code and MIT code
in one tree, with no clean story about which is which. The story is clean here,
for one specific reason.

**`room-ask` is not a derivative of Forge.** It was written under D12's
clean-room firewall by a fresh agent that read
`docs/requests/P4_ASK_REGISTRY.md` and nothing else — the read-list is in its
own commit message, and `grep -rniE 'forge|replypool' packages/room-ask/`
returns nothing. Copyleft attaches to derivative works. A file that never saw
the GPL work is ours to licence, and the repo being GPL elsewhere does not
change that.

### Why it must be MIT rather than simply GPL

This is the load-bearing half. **P4 is destined for `@wolffm/rooms-server`,
which is MIT** (D10 assigned P3–P6 to us; D12 required the clean room precisely
so the result *could* go upstream). MIT → GPL consumption is fine; GPL → MIT is
not. Licensing `room-ask` GPL would make it unusable by the package it was
written for, which would waste the entire clean-room exercise.

The sibling package is the contrast that proves the rule:
**`packages/room-store` is GPL-3.0-or-later**, because P5/P6 are ours, consume
watchparty's primitives rather than being contributed into them, and are not
going upstream. Two packages, two licences, each matching where it is going.

### Mechanics, so this is checkable

- `packages/room-ask/LICENSE` carries the MIT text.
- `packages/room-ask/src/index.ts` opens with `SPDX-License-Identifier: MIT`.
- Every other package, and the repo root, stays GPL-3.0-or-later.
- **If a future change makes `room-ask` read Forge, or copy from it, this
  decision is void** and the file must be relicensed or discarded. The firewall
  is the whole justification.

**Rules out:** a second MIT carve-out added casually. This one is justified by a
documented clean room and an MIT destination. Anything else comes back here
first.

## D17 — Cardtable is its own app and imports room UI · settled · 2026-09-16 · operator

> **Amended 2026-10-10 by D21:** still its own app, and it also ships a game
> bundle a watchparty room mounts. Read D21 before planning off this entry.

**Supersedes D6's mechanism; keeps its layout intent.**

D6 said the Forge UI renders *inside* a watchparty room's central canvas slot,
as an iframe payload, modelled on `GameModule.tsx`. That was written on
2026-09-11, when the payload was expected to be `forge-gui-mobile` compiled to
WASM (D7), and before hadoku_site existed as a consumer of ours.

Two things happened since, and neither was reconciled until now:

1. **D7 came back NO-GO.** There is no WASM payload to put in an iframe. P4 is a
   React client we write.
2. **hadoku_site onboarded cardtable as a standalone loopback-UI tunnel app** at
   `hadoku.me/cardtable/`, port 9008, friend tier — the shape *their* agent
   chose, which is live and working. That is not "inside a watchparty room".

For three waves D6 and production quietly contradicted each other, and the
tracker never put a row on the board for it. The operator settled it:

> *"cardtable is its own app. my expectation is that we import a package from
> watchparty for the ui."*

**The shape, settled:**

- Cardtable is **its own application**, its own route, its own server. It is not
  embedded in watchparty and does not move there.
- It **imports** watchparty's room chrome — chat, roster, presence — as a
  package, and renders its own draft/play surface in the middle. D6's *layout*
  intent survives exactly: their chrome around, our table in the centre.
- The iframe + `postMessage` mechanism is **dropped**. Both apps are ours and
  same-origin concerns do not apply the way they did for a cross-origin Bevy
  bundle.

**Known blocker, recorded so nobody plans around it:**
`@wolffm/watchparty-ui@0.38.115` cannot be composed with. Read from the
published tarball, it exports exactly `createWatchpartyRouter`, `mount` and
`unmount` — a whole-app mount, with no room shell, roster, chat or slot
component — and ships **zero `.d.ts` files** despite declaring
`types: "./dist/index.d.ts"`. Wave 6 lane E asked them for composable exports
(`docs/requests/WATCHPARTY_UI_COMPOSABLE.md`). Until that lands, cardtable
builds its own shell behind a seam, which is what Wave 6 lane A did.

**Rules out:** planning any wave on the assumption that watchparty's UI package
can be imported piecemeal today; and re-opening "should cardtable live inside
watchparty", which is now answered.

---

## Still open — each needs an operator decision

| # | Question | Recommendation |
| --- | --- | --- |
| O1 | Create `WolffM/hadoku-cardtable` and fork `Card-Forge/forge`? Both are outward-facing. | Yes to both; the fork is needed before `forge/` can become a submodule |
| O2 | P1: reimplement draft in TS, or reuse Forge's 6,781-line `limited/` engine? | Reimplement — staying JVM-free *is* the point of draft-first. Take the 95 cube lists verbatim (95, not 96 — imported in Wave 1 lane C). |
| O3 | One JVM per match, or one hosting many? | Defer to P3; decide before building the service-participant lifecycle |
| ~~O4~~ | ~~Does the WASM spike block Wave 2?~~ | **Resolved 2026-09-12: moot.** The spike ran and finished inside Wave 1 (NO-GO, D7). Wave 2 is unblocked and its card/draft work was needed in either branch anyway. |
| O5 | How much card art do we host? D15 settled *that* we host it; one cube is ~53 MB, all 95 is ~5 GB and a materially different posture. | Stay at the cubes actually being drafted. Bring it back to the operator **before** uploading a second cube's worth, not after — "we are tiny" is the mitigation D15 was priced against. Raised 2026-09-15 by Wave 4 lane D; the tracker holds the matching watch. |

---

## D18 — "our own origin never serves an image" is repealed

**2026-09-19, operator.** Supersedes the origin clause of D15 and of
`docs/LICENSING.md` rule 3. The operator repealed the rule as stricter than
needed for a private, non-commercial, friend-tier app that shows card images
unaltered.

**Recorded accurately, because the reason matters more than the rule:** showing
an image unaltered does not by itself make it permitted — copying an unaltered
image is still reproduction, and WotC's Fan Content Policy is permission that
can be withdrawn, not a licence. The decision is still a reasonable one,
because the exposure was never carried by that rule. It is carried by **no
money** and **scale**, and both mitigations are untouched: no revenue in any
form, `/cardtable/*` behind a friend gate, a handful of players, and the
disclaimer in `NOTICE.md`. The repealed rule was belt-and-braces stacked on top
of those.

**What changed.** `scripts/d13-gate.sh` loses arms 2-4 — the host allowlist and
the relative/same-origin refusal — and the 50 reference fixtures that proved
they bit. The gate is 316 lines, down from 367, and its self-test is 9
fixtures, 9 as expected.

**What did NOT change, and these are not negotiable by the same argument:**

- **No image bytes in the bundle** (arm 1). A 5.85 MB PNG inlined into a JS
  chunk is a performance bug whoever owns the picture. `.gitignore` still
  refuses `*.jpg`/`*.png`.
- **No copied Scryfall `image_uris` / `image_status` / `art_crop` blob**
  (arm 5). This is an architecture rule the operator asked for — *"just make
  sure that it's easy to simply hook up a link to a new image in the cdn"* — so
  a card's art stays a lookup, not a URL.
- **No money, ever.**
- **The friend gate**, which is now doing more of the work than it was.

**Rules out:** re-adding a host allowlist to the image gate without a new
operator decision; and citing D13 or D15's origin clause as live.

**Immediate consequence:** watchparty's sprites, served from
`hadoku.me/watchparty/…`, no longer fail our gate. That was O10, and it was the
thing that would have made the O9 room-chrome request worthless even if
watchparty shipped it.

## D19 — Two game frontends, user-selectable · settled · 2026-09-21 · operator

The product keeps **two frontends for the same matches**: our own React UI
(primary) and **Forge's own desktop UI** (the option). The operator, on
keeping the old UI after w16: *"i want to continue supporting the old forge ui
(either through streamed client or Cheerpj whichever is better) the client can
be chosen through an options menu by the user"* — including mid-game, where
switching reloads the page with the newly selected client and the game and
room load naturally (a seat is a client-agnostic identity, not a renderer).

**Delivery of the old-UI half is streaming, not CheerpJ.** The operator first
leaned CheerpJ on latency (*"CheerpJ looks like it's saves us ~150ms
latency"*), but the w16 live bench and the CheerpJ spike's own constraints
settled it the other way at product level: the CheerpJ runtime licence forbids
self-hosting it, the page needs a CSP carve-out, the tab holds ~1.4 GiB, and
— decisive — the operator then chose our own UI as the primary route
(*"ok let's see if we can build our own UI then. that's the right route"*),
which removes the reason to carry CheerpJ's weight for the secondary one. The
CheerpJ staging was deleted with w17 lane D and stays deleted.

**Interim form, live since 2026-09-21:** `/cardtable/stream/<n>/` — the
streamed containers behind the app's own friend gate (5301813). Static
containers, one Forge session each, matches started by hand through Forge's
own Online lobby, until room-scoped streamed rooms ship.

---

## D19a — Amendment: the mode is the ROOM's, not the user's · settled · 2026-09-22 · operator

**Amends D19's delivery clause.** The two frontends stand, but the choice is
made **once, by the room creator, at room creation** — not per user, not
switchable mid-game.

**Operator, 2026-09-22:** *"let's have it be a room toggle. otherwise we have
to side-load host the 1gb streaming clients which is awful. on room create the
room creator can decide the mode."*

Per-user choice fails on resources, and w17's own §0 priced it: a streamed
player costs **~1.26 GiB + ½ core of hokon**. If any seat in any room could
elect streaming, containers must sit warm for every room in the app. Room-
scoped, only rooms that chose it ever pay — which is the same shape as the
friend gate: a small, explicit set of trusted humans, each paying only for
what they opened.

**What this kills:** the options-menu client picker, mid-game switching, and
the client-agnostic seat work that existed only to make a seat survive a
renderer swap. A seat in a streamed room is a container; a seat in a builtin
room is our React board; a room is one or the other for its whole life.

**What stands:** both frontends exist; streamed rooms provision their
containers on creation and reclaim them when the room dies; the static
two-seat bench at `/cardtable/stream/<n>/` stays up (a friend demo is
pending) until an operator has played a room-scoped streamed room end to
end.

---

## D20 — The four stale board items are closed: O5, O7, O9, O10 · settled · 2026-09-26 · wave 21 lane E

These are the **board's** O-numbers (`docs/planning/workstreams.md:292-295`),
not the `O1`–`O5` table earlier in this file. The two series collided and were
reconciled in `docs/requests/HADOKU_SITE_SUBMODULE_DEPLOY.md` Part 2: the
board's series is the live one, and **this file's own O5 — how much card art we
host — is a different item and stays open.**

All four had sat over a week and none blocked anything. Two were already
answered by a later decision and only ever needed the pointer written onto the
earlier one (O7, O10); two needed a sentence that did not exist yet (O5, O9).
Written from the record that exists, not re-litigated.

### O5 — `packages/room-ask` is the MIT room layer D2 ruled out, and it stays

**Closed.** D16 settled the substance on 2026-09-16 — MIT inside a GPL repo,
justified by D12's clean room and an MIT destination. What was actually stale
was D2's own "rules out" line, which still read as live; it now points here.
No new licensing argument was needed and none was made.

**The death condition, which is what O5 was really missing.** `room-ask` leaves
this repo when any one of these becomes true:

1. **It reads from Forge, or copies from it.** D16 voids itself on this — the
   firewall is the entire justification. `grep -rniE 'forge|replypool'
   packages/room-ask/` must stay empty; if it ever does not, the package is
   relicensed GPL or discarded, not argued about.
2. **Watchparty takes it.** They declined once — *"nothing in either repo uses
   it"* (`docs/planning/wave13-2026-09-19.md:184`) — so the offer in
   `docs/requests/WATCHPARTY_ROOM_CHROME.md` §6 is **spent, not standing**. A
   second offer needs a consumer to point at first.
3. **The operator says delete it.** They have not, and it is not a lane's to
   take.

**What is NOT a death condition: having no consumer.** That has been true since
the day it was written and is the state it was specified in — P4 was specified
for watchparty, and `apps/server/src/play/match.ts` shipped its own asks by
`callId` instead. Re-verified 2026-09-26: nothing under `apps/` or `packages/`
imports `@hadoku/room-ask` except two doc comments in `packages/forge-wire`
(`envelope.ts:52`, `index.ts:30`). Carrying a clean-room package costs this
paragraph; reproducing one costs a firewall.

**Rules out:** deleting `room-ask` on "no consumer" alone; re-offering it
upstream without a consumer; and a second MIT carve-out, which D16 already
refused.

### O7 — D6's mechanism is superseded, its layout intent is not

**Closed by D17** (2026-09-16), which says exactly that in its first line. The
only thing missing was the marker on D6 itself, so that a reader arriving at D6
first does not read a dead mechanism as live. Added above; no new decision.

### O9 — we are **not** sending `WATCHPARTY_ROOM_CHROME.md`

**Closed: deliberately not sent.** The ask it carries was answered without it —
`RoomChrome` shipped in `@wolffm/watchparty-ui@0.39.0`
(watchparty's `docs/requests/ROOM_CHROME_RESPONSE.md`) and we consume it at
**0.39.5** (`apps/ui/src/room/RoomShell.tsx:44`,
`apps/ui/package.json:24`). Sending it now would ask for something already
delivered and would re-open its §6 offer of `room-ask`, which watchparty has
already declined. The outstanding asks that came *out of* consuming the chrome
live in `docs/requests/RETRO_UPSTREAM_2026-09-26.md`, and that is what was sent
instead. The request document stays in the repo as the record of what was asked
and why; it is not to be sent.

**Rules out:** sending a written-but-unsent request without first checking
whether the thing it asks for shipped in the meantime.

### O10 — moot; D18 repealed the clause the question was about

**Closed: moot.** O10 asked whether D15's *"our own origin"* meant the
cardtable app server or all of `hadoku.me`. **D18 (2026-09-19) repealed the
clause outright**, so there is no reading left to choose between — D18's own
closing paragraph already says so.

Checked rather than assumed: `bash scripts/d13-gate.sh --self-test` exits **0**,
**9 fixtures, 9 as expected**, and not one of them asserts anything about a
host — arms 2–4 (the allowlist and the relative/same-origin refusal) and their
50 host fixtures are gone. Watchparty's sprites on `hadoku.me/watchparty/…`
were the case that raised the question and cannot fail a check that no longer
exists. What the gate still enforces is arm 1 (no image bytes in the bundle)
and arm 5 (no copied Scryfall `image_uris` blob), and neither is about origin.

**Rules out:** treating O10 as a live question; and restoring a host allowlist
without a new operator decision, which D18 already said.

---

## D21 — Cardtable also ships a game bundle watchparty mounts · settled · 2026-10-10 · operator

**Amends D17; does not reverse it.** Cardtable stays its own app — its own
route, its own server, its standalone page unchanged, still importing
watchparty's room chrome there. It *also* ships
`/cardtable/embed/cardtable-embed.js`, an ES module a watchparty room imports
and mounts in the slot its media player occupies. Two deployments of one UI.

The operator, setting the goal (`docs/planning/games-platform-vision.md`): the
games should each be a *"standalone page"*, a *"loadable submodule inside
watchparty"*, and *"clickable inside games-host"*. On how, answering whether an
iframe or a package: *"iframe sounds slow. are we not able to deliver a static
package? i guess the issue is the server component. so maybe (b) is better. we
need to make sure the watchparty component loading our package is as thin as
possible so they dont need to make any changes."*

**A module, not an iframe.** The bundle is static; the server stays our PM2
process, reached same-origin, so the edge cookie authenticates every request
and socket exactly as on the standalone page. An iframe would load a second
document and a second copy of React and the fleet's CSS, and need a
`postMessage` bridge D17 already dropped once.

**The contract** is watchparty's, generic to every game (they publish it from
`@wolffm/rooms-protocol`, module `game-bundle`; `apps/ui/src/embed/contract.ts`
holds it until then): `mount(el, { roomKey, identity, theme, isLeader, close })`
→ `{ update, unmount }`. `roomKey` is watchparty's room id, opaque to us.

**The shape, settled:**

- **The table is bound to the watchparty room.** `POST /api/rooms/watchparty`
  makes or joins `wp-<20 hex of sha256(roomKey)>`, so everyone in that room
  lands at one table without an id being passed around.
- **Chromeless.** No `AppHeader`, no `RoomShell`/`RoomChrome` — watchparty is
  the chrome. The match settings get a gear of their own in place of the
  header's.
- **A shadow root, not the page.** Styles adopted by the shadow root (one
  build-time sheet, `:root`/`html`/`body` → `:host`), fonts and `@property`
  lent to the document while mounted, routes in memory, document-wide lookups,
  hit tests and window-level event targets read through the shadow boundary
  (`apps/ui/src/dom.ts`). `unmount()` leaves nothing; `e2e/embed.spec.ts`
  counts it.
- **Not used from the context:** `identity` (the server's identity is the
  edge's, and a second identity path is how this app shipped `anon` once),
  `isLeader` (the cardtable room has its own leader, enforced by the server; a
  client gate on watchparty's would be a second authority), and `close()`
  (leaving a match returns to the table; closing the slot is watchparty's).

**Rules out:** an iframe payload; a cardtable-specific mount in watchparty; the
embed growing its own header, roster or chat; and a second concurrent mount on
one page (refused — the route, the scope and a few play modules are page
singletons, as on the standalone page).
