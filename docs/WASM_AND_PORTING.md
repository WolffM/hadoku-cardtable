# WASM, Rust, and "can we get away from Java?"

Three separate questions that feel like one:

1. **Can we stop writing Java?** — Yes, and WASM has nothing to do with it.
2. **Can Forge run in a browser?** — Probably, via TeaVM. Worth a spike.
3. **Should we port Forge to Rust/Bevy?** — No. Section 3 is the argument.

---

## 0. The numbers everything else depends on

Measured on the clone, 2026-09-11:

| Module | Lines | Files | What it is |
| --- | ---: | ---: | --- |
| `forge-core` | 26,842 | 152 | card data model |
| `forge-game` | **127,083** | 811 | **the rules engine** |
| `forge-ai` | 56,817 | 191 | AI opponents, bot drafters |
| `forge-gui` | 78,371 | 445 | shared GUI logic, net, draft/limited |
| `forge-gui-mobile` | **103,038** | 373 | **libGDX UI — the whole product UI** |
| `forge-gui-desktop` | 116,026 | 528 | Swing (we'd drop this) |
| `forge-gui-android` | 3,789 | 8 | thin launcher |
| `forge-gui-ios` | 3,155 | 53 | thin launcher |
| **Total (no android/ios)** | **516,450** | | |

Plus **33,755 files** under `res/cardsfolder` (the spike's loader counts
**33,752** actual card scripts) driving the ability effect classes in
`forge-game/src/main/java/forge/game/ability/`.

There are **three** counts there, all real, all measuring different things.
`c8a0aac` corrected the first conflation and introduced a milder one — "206
classes, of which 202 are wired" reads as a 202-of-206 subset, and it isn't
one. Re-counted 2026-09-14, with the commands, from the repo root
(`forge/` is gitignored until the fork exists):

| Count | What it is | Command |
| ---: | --- | --- |
| **206** | `.java` files in `game/ability/effects/` | `find $E -maxdepth 1 -type f -name '*.java' -printf '.' \| wc -c` |
| **202** | constants in `ApiType` | `grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\([A-Za-z][A-Za-z0-9_]*\.class' $A` |
| **199** | *distinct* effect classes those 202 constants name | the `sort -u` below |

```sh
A=forge/forge-game/src/main/java/forge/game/ability/ApiType.java
E=forge/forge-game/src/main/java/forge/game/ability/effects

grep -oE '^ *[A-Za-z][A-Za-z0-9_]* *\(([A-Za-z][A-Za-z0-9_]*)\.class' $A \
  | sed -E 's/.*\(([A-Za-z0-9_]*)\.class/\1/' | sort -u | wc -l   # 199
```

**202 > 199** because `CharmEffect.class` is named by four constants — `Charm`,
`CompanionChoose`, `InternalLegendaryRule`, `InternalIgnoreEffect`
(`ApiType.java:47,216,217,218`) — and it is the only class named more than once,
so 202 − 3 = 199:

```sh
grep -oE '^ *[A-Za-z][A-Za-z0-9_]* *\(([A-Za-z][A-Za-z0-9_]*)\.class' $A \
  | sed -E 's/.*\(([A-Za-z0-9_]*)\.class/\1/' | sort | uniq -c | awk '$1>1'
#       4 CharmEffect
```

**206 > 199** because **seven** files are never named by `ApiType`. Taking the
set difference rather than trusting the subtraction:

```sh
comm -13 <(grep -oE '^ *[A-Za-z][A-Za-z0-9_]* *\(([A-Za-z][A-Za-z0-9_]*)\.class' $A \
            | sed -E 's/.*\(([A-Za-z0-9_]*)\.class/\1/' | sort -u) \
         <(find $E -maxdepth 1 -type f -name '*.java' -printf '%f\n' | sed 's/\.java$//' | sort)
#   AnimateEffectBase
#   CountersNoteEffect
#   DamageBaseEffect
#   DetachedCardEffect
#   ManifestBaseEffect
#   PermanentEffect
#   TokenEffectBase
```

Four are abstract bases (`AnimateEffectBase`, `DamageBaseEffect`,
`ManifestBaseEffect`, `TokenEffectBase`); `PermanentEffect` and
`DetachedCardEffect` are unwired, the latter extending `Card` rather than
`SpellAbilityEffect` so it was never a candidate.

**The seventh, `CountersNoteEffect`, is why this document previously said 200
and six.** Its constant exists but is **commented out**:

```java
//NoteCounters (CountersNoteEffect.class),   // ApiType.java:137
```

A `.class` grep that is not anchored to the start of the line counts that
comment, which yields exactly the old pair — 200 distinct, six unnamed. It is
the only commented-out constant in the file (`grep -nE '^ *//.*\.class' $A`
returns line 137 alone). A commented-out constant is not in the dispatch table,
so it does not count, and the file on disk is dead code until someone
uncomments it.

The number that matters to the argument below is **202**: it is the size of the
statically-visible dispatch table, and none of the three counts changes the
conclusion.

**"Engine + all the UI"** — the thing we'd have to port — is
`core + game + ai + gui + gui-mobile` = **392,151 lines**, plus the card scripts.

### What `forge-gui-mobile` actually contains

This matters, because it's the answer to "we need all the UI including
deckbuilding":

```
screens/
├── limited/     NewDraftScreen, DraftingProcessScreen,
│                NetworkDraftingProcessScreen, LoadDraftScreen,
│                NewSealedScreen, LoadSealedScreen
├── online/      OnlineLobbyScreen, OnlineChatScreen, OnlineMenu,
│                ChatMessageBubble, ServerAddressesDialog
├── match/       the board, stack, zones, prompts
├── constructed/ deck selection
├── settings/, home/, gauntlet/, quest/, planarconquest/, achievements/
deck editor:     FDeckEditor.java (+ Quest/Conquest/Adventure/Draft variants)
```

Deck editor, draft UI, network draft UI, lobby, chat, match. **It is already the
product**, and it's touch-first — so it works on a phone and in a browser
without redesign.

---

## 1. WASM does not get you out of Java

TeaVM, CheerpJ and every other Java→WASM route **compile Java**. You still write
Java, debug Java, and hit a compiler that restricts the language. If the goal is
"I don't want to touch Java", WASM is the wrong lever.

**The architecture already solves that.** Per `FORGE_ANALYSIS.md`, the seam is a
3-method interface and a closed 60-method protocol. Java stays on the host; you
write TypeScript and React; the only Java you ever touch is:

- one class implementing `IToClient` over WebSocket/JSON
- filling in `Main.java`'s stubbed `case "server":`

That's it. Two files against 516k lines you never read.

So the real reason to want WASM isn't language — it's **deployment**: no JVM to
operate, client-side solo play, and a browser client you didn't have to write.

---

## 2. Can Forge run in a browser? (TeaVM — worth a spike)

### Why this suddenly matters more

Once you accept that you need *all* the UI — deck editor included — writing it
yourself is the biggest line item in the project. But `forge-gui-mobile` is
**103,038 lines of exactly that UI**, and it's **libGDX**, and libGDX has a
maintained TeaVM backend ([`gdx-teavm`](https://github.com/xpenatan/gdx-teavm),
last release Aug 2026) that emits **JavaScript or WASM**.

**If this works, P4 is deleted from the plan.** That is the highest-leverage
unknown in the project.

### The blocker that isn't

Forge's design blocks a game thread on player input (`sendAndWait` → a
`FutureTask` in `ReplyPool`). Browsers can't block the main thread — this is the
first thing that should kill the idea.

It doesn't. TeaVM emulates Java threads as **green threads via
continuation-passing transformation**, and **[TeaVM 0.13 brought coroutine
support to the WASM GC backend](https://teavm.org/docs/release-notes/0.13.0.html)** —
which their release notes describe as the *final* gap between the JS and WASM GC
backends. `Thread.start`, `Thread.sleep`, `Object.wait`, `synchronized` all work.

### The blocker that usually kills ports — also not present

TeaVM restricts **reflection**; it does whole-program dead-code elimination and
can't see reflectively-loaded classes. For a card game this normally ends the
conversation, because the classic pattern is
`Class.forName("...effects." + name + "Effect")` — invisible to the optimizer.

Forge doesn't do that. Reflection appears in **10 files**, and the dispatch is an
**enum holding class literals**:

```java
public enum ApiType {
    Abandon           (AbandonEffect.class),
    ActivateAbility   (ActivateAbilityEffect.class),
    AddOrRemoveCounter(CountersPutOrRemoveEffect.class),
    ...  // 202 constants naming 199 distinct classes; 206 files on disk
}
```

Same shape in `TriggerType`, `ReplacementType`, `Keyword`. Every class is a
**static reference** the optimizer can follow. Reflective *construction* still
needs TeaVM's reflection support declared, but the class set is closed and
enumerable — which is the difference between "configure it" and "impossible".

### Asset payload — smaller than it looks

`res/` is 462 MB raw, but most is droppable (`adventure` 153M, `languages` 59M,
`quest` 38M, `music` 17M). What we'd need is ~148 MB raw — and `cardsfolder` is
**plain text**, so:

```
cardsfolder: 132 MB raw  →  5.6 MB gzip -9
```

Card data is not the problem. Card *images* are never shipped anyway
(`LICENSING.md`).

### Honest risks

| Risk | Assessment |
| --- | --- |
| TeaVM's own docs say it's "**not suited for taking your large existing codebase in Java and producing JavaScript**" | The headwind. 392k lines is exactly the case they're warning about. |
| `gdx-freetype` is a native library | gdx-teavm ships replacements; needs verifying |
| **Sentry** is called from 13 engine files incl. `GameAction`, `AbilityFactory` | Must be stubbed out — network error reporter, useless in browser |
| Guava, commons-lang3/text, jgrapht, commons-math3 | Pure Java, but classlib coverage is the usual TeaVM failure mode |
| Java 17 + 97 record types | Records are ordinary classes in bytecode; should be fine |
| First-load size and cold-start | Unknown until measured |

### CheerpJ: ruled out, for now

[CheerpJ 4.3](https://cheerpj.com/docs/overview) is a full WASM JVM that runs
**unmodified** JARs including Swing — it would run `forge-gui-desktop` as-is,
which sounds perfect. Two problems:

1. It supports **Java 8, 11 and 17**; Forge targets 17, so this is borderline
   rather than clearly blocked — worth a 30-minute test before dismissing.
2. It ships a whole JVM to the browser and renders **Swing**. Desktop-mouse UI,
   touch-hostile, heavy. It's a "run my legacy app" tool, not a foundation.

Free for personal/FOSS use, so testing it costs nothing.

---

## 3. Rust + Bevy: no. Here's why, specifically

### 3.1 There is no transpiler, and there couldn't be a good one

Java→Rust at 392k lines isn't a tooling gap, it's a semantics gap. Forge's game
state is a **large, cyclic, mutable object graph** — `Game` ↔ `Player` ↔ `Zone` ↔
`Card` ↔ `SpellAbility`, all holding references to each other and mutating each
other constantly. That is the single hardest shape to express in Rust's
ownership model. You'd end up with `Rc<RefCell<…>>` on essentially every edge,
which is Java's object model reimplemented with worse ergonomics, runtime borrow
panics, and none of Rust's actual benefits.

### 3.2 The value isn't the code — it's the corner cases

This is the real argument. `forge-game` is 127,083 lines not because the rules
are long, but because **Magic is 30 years of exceptions**: layers, timestamps,
replacement effects, state-based actions, the interaction between a copy effect
and a face-down creature with a counter on it. That knowledge lives in accreted
special cases, and a port loses precisely the thing you're porting for.

Worse: **a rewrite has no oracle.** The only way to check your Rust engine plays
Magic correctly is to compare it against… Forge. At which point you're running
Forge anyway.

### 3.3 Bevy is the wrong shape for this UI

A Magic client is roughly **90% dense data UI** — a deck editor searching and
filtering 30,000+ cards, pick grids, zone lists, card detail panes — and **10%
board**. Bevy is an ECS game engine; `bevy_ui`/egui are immediate-mode and
perfectly good for HUDs, menus and a Bomberman. Building a polished deck editor
in them is a large project that libGDX's `FDeckEditor` already finished.

### 3.4 brave-quartet's networking doesn't transfer

`crates/net` is **lightyear 0.27** with `webtransport`, `netcode`, `input_native`
— rollback/prediction netcode for a realtime action game. Magic is turn-based
with **blocking prompts**: the engine stops and waits for one player to choose a
target. There's no tick rate to reconcile and nothing to roll back. Different
problem; the transport (WebTransport) is the only transferable part, and
WebSocket already covers us.

### 3.5 The cross-platform argument — you already have it

> *"if we have bevy then we can deploy to desktop, mobile and web"*

True of Bevy. Also **already true of Forge**, from the same codebase:

| Target | Forge today | via |
| --- | --- | --- |
| Desktop | ✅ | libGDX desktop backend (and Swing) |
| Android | ✅ | `forge-gui-android` — a **3,789-line launcher** over `forge-gui-mobile` |
| iOS | ✅ | `forge-gui-ios` — a **3,155-line launcher** |
| Web | ⬜ | `gdx-teavm` → JS/WASM — **the missing quarter** |

libGDX's whole pitch is that matrix, and Forge already shipped three of the four
platforms off one 103k-line UI. Bevy would buy the same matrix for the price of
rewriting 392k lines; gdx-teavm buys the missing quarter for the price of a
spike.

---

## 4. What this changes in the plan

| Phase | Before | After |
| --- | --- | --- |
| P1 draft | unchanged | unchanged — drafting needs no rules engine |
| P2 desktop play | unchanged | unchanged |
| P3 WS/JSON bridge | required | **still required** — browsers have no TCP sockets, so Forge's Netty netplay can't reach a browser client no matter what compiles it |
| P4 React play client | the biggest phase | **possibly deleted** — if gdx-teavm works, the browser UI is `forge-gui-mobile`, already written |

Note P3 survives either way. WASM changes *who writes the client*, not *how it
talks to the server*.

## 5. Proposed spike (before committing to P4)

Time-boxed. Fail fast, in this order — each step is cheap and kills the idea if
it fails:

1. **Install Maven** (the host has none; upstream ships no `mvnw`) and get a stock
   `mvn install` to pass. Nothing else is possible until this does.
2. **Stub Sentry** out of the 13 engine call sites behind a no-op.
3. **Compile `forge-core` + `forge-game` alone** with TeaVM to WASM GC — no UI.
   Target: construct a `Game`, run a scripted one-card interaction, print the
   result. *This is the go/no-go.* It tests classlib coverage, the enum
   reflection pattern, and coroutines in one shot.
4. Only if 3 passes: **`gdx-teavm` on `forge-gui-mobile`**, target the deck
   editor screen rendering in a browser.
5. Measure cold-start size and time.

**If step 3 fails**, we've lost a few days and P4 proceeds as planned — React,
~14 prompt components over a board renderer, per `FORGE_ANALYSIS.md`.

**If steps 3–4 pass**, the largest phase of the project evaporates and the
answer to "desktop, mobile and web" is yes on all four platforms.
