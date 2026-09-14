# Headless server spike: does Forge start headless as a server?

**Verdict: YES for the process, NO for `case "server":` — and the gap is
smaller than the board assumes, because a headless network harness already
exists in the tree.**

`Main.java:111-112` still prints `Dedicated server mode.\nNot implemented.` —
this spike ran it and captured exactly that. But everything around that empty arm
already works without a display:

| Question from §D of the wave plan | Result |
| --- | --- |
| (1) Write no Java into `forge/` | **held** — overlay in `scripts/spike/headless/`; the vendored tree is byte-for-byte pristine, proof at the bottom |
| (2) Get `SimulateMatch` running, capture real output | **PASS** — a full AI-vs-AI game to a win in 9,549 ms, headless, exit 0 |
| (3) Map `ProtocolMethod` against a browser client | **done** — and the enum is **60 methods, not 62**. **38 of 60 required**, 20 not, **2 dead** |
| (4) jUPnP: config or code change? | **config.** `UPnP=NEVER` in `server.preferences`. No fork change needed |
| (5) `FSerializableFunction` on the wire | **a real problem, with a one-line fix Forge's own source already names** |

Three things turned up that nobody had budgeted for, and all three move PR-4:

- **`forge-gui-desktop/src/test/java/forge/net/` is a 3,919-line headless
  network harness that already exists**, including `HeadlessNetworkGuiGame`,
  `HeadlessNetworkClient`, `HeadlessGuiDesktop` and a
  `NetworkPlayIntegrationTest` that calls `server.startServer(port)`. The
  "headless Forge server" PR-4 wants is not greenfield.
- **Two of the 60 protocol constants dispatch to nothing.**
  `setRememberedActions` and `nextRememberedAction` are not methods on
  `IGuiGame`; `ProtocolMethod.getMethod()` returns `null` for both, and
  `RemoteClientGuiGame` never emits either. Don't budget work for them.
- **`Main.main()` calls `Sentry.init` with a hardcoded upstream DSN before it
  reads the mode argument** (`Main.java:65-74`). Any server started through
  `Main` phones `sentry.asgardsrealm.net`. The fork must strip that.

Everything below is reproducible from `scripts/spike/headless/`.

---

## Reproducing it

The overlay is parameterised on a Forge checkout. **Point `FORGE_DIR` at a
scratch copy, not at the repo's vendored `forge/`** — Maven writes `target/`
dirs into whatever it builds, and D2/O1 says the vendored tree stays stock
until the fork exists.

```sh
cp -a /path/to/vendored/forge ~/.cache/forge-spike     # or: git clone

export FORGE_DIR=~/.cache/forge-spike
export JAVA_HOME=~/.local/opt/jdk-21.0.12.1+1          # a JDK, see below
export MVN=~/.local/bin/mvn

scripts/spike/headless/run.sh build             # ~69 s cold, ~16 s warm
scripts/spike/headless/run.sh protocol          # the 60-method dump
scripts/spike/headless/run.sh sim               # SimulateMatch, a real game
scripts/spike/headless/run.sh server            # case "server": as it stands
scripts/spike/headless/run.sh verify-pristine   # vendored forge/ untouched
```

`run.sh sim` stages a throwaway Forge profile and deck store under `WORK_DIR`
(default `${TMPDIR:-/tmp}/forge-headless-spike`) so nothing lands in the user's
real `~/.forge`, and symlinks Forge's `res/` into the run directory.

### `JAVA_HOME` is not optional, and the error if you skip it lies to you

`CLAUDE.md` says **"Maven ✗"**. That is now stale: Maven **3.9.16** is at
`~/.local/bin/mvn`. But the *other* half of the toolchain is the trap.

`java` on `PATH` is `/usr/lib/jvm/java-21-openjdk-amd64`, a Debian **JRE** — no
`javac` (`which javac` → exit 1). `mvn -v` happily reports "Java version:
21.0.12.1", so it looks fine. The build then fails with:

```
[ERROR] Failed to execute goal ...maven-compiler-plugin:3.8.1:compile
        (default-compile) on project forge-core:
        Fatal error compiling: error: release version 17 not supported
```

**exit 1, in 3.598 s.** That message names 17 and has nothing to do with 17 —
it is what the compiler plugin says when it cannot find a `javac`. The fix is
`JAVA_HOME=~/.local/opt/jdk-21.0.12.1+1` (Temurin 21, the JDK Wave 1 lane B
installed because `openjdk-21-jre` has no `javac`). `run.sh` refuses to start
without it rather than let anyone else spend time on that error.

### What was built, and how long it took

`mvn -B install -pl forge-gui-desktop -am -DskipTests` — the narrowest set that
yields `SimulateMatch`, which lives in `forge-gui-desktop`, not `forge-gui`.

| Module | Cold | Warm |
| --- | --- | --- |
| Forge Parent | 0.738 s | 0.703 s |
| Forge Core | 2.290 s | 2.225 s |
| Forge Game | 10.950 s | 3.124 s |
| Forge AI | 4.821 s | 0.046 s |
| Forge Gui | 7.175 s | 2.094 s |
| Forge (`forge-gui-desktop`) | 42.958 s | 7.513 s |
| **total** | **1 min 09 s** | **15.9 s** |

Both **exit 0**. Cold includes downloading every plugin and dependency. Output:
`forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar`, 39,680,865 B —
a self-contained fat jar, which is what a server deployment would ship.

Note that this pulls in `forge-ai` and `forge-gui`, both of which Wave 1's
headless engine proof deliberately excluded. That is expected: a *server* needs
`forge-gui` (the protocol and lobby live there) in a way a bare rules-engine
probe did not.

---

## Item 2 — `SimulateMatch` runs headless. Actual output.

`case "sim":` sits one arm above `case "server":` in the same switch and is the
working precedent the brief asked about. It works:

```
$ scripts/spike/headless/run.sh sim
==> sim: forge.view.Main sim -d 'Abzan Siege.dck' 'Air Forces.dck' -n 1 -s 1234 -q
Error handling registered!
12:22:44 [INFO ] GuiBase: ##########################################
12:22:44 [INFO ] GuiBase: APP: Forge v.2.0.15-SNAPSHOT-09.14
12:22:44 [INFO ] GuiBase: Java: 21.0.12.1 (Eclipse Adoptium)
12:22:44 [INFO ] GuiBase: OS: Linux 6.12.101+deb13-amd64 amd64
12:22:44 [INFO ] GuiBase: RAM: 15856 MB max, 12 CPUs
12:22:44 [INFO ] GuiBase: ##########################################
Language 'en-US' loaded successfully.
(ThreadUtil first call): Running with priority 5
Read cards: 33752 files in 0 ms (25 parts) using thread pool
Upcoming set Star Trek (TRK) dated in the future. All `upcoming` cards will be
  added to this set with unknown rarity.
The card A-Alrund's Epiphany was not assigned to any set. Adding it to UNKNOWN
  set... to fix see res/editions/ folder.
   [... 18 more "not assigned to any set" lines ...]
Read cards: 848 files in 0 ms (8 parts) using thread pool
Simulation mode
Ai(1)-Abzan Siege vs Ai(2)-Air Forces - one game of Constructed seed 1234
Game Outcome: Turn 12
Game Outcome: Ai(1)-Abzan Siege has won because all opponents have lost
Game Outcome: Ai(2)-Air Forces has lost because life total reached 0
Match Result: Ai(1)-Abzan Siege: 1 Ai(2)-Air Forces: 0

Game Result: Game 1 ended in 9549 ms. Ai(1)-Abzan Siege has won!
```

**exit 0.** 42 lines total. No `DISPLAY`, no X server, no outbound network
required. A complete game of Magic, decided on damage, on turn 12.

The 19 "not assigned to any set" warnings and the Star Trek notice are stock
upstream data noise, not a symptom of the headless path — they are the same
lines a desktop Forge prints at startup.

Two decks are staged from `res/quest/precons/` (`Abzan Siege`, `Air Forces`).
They are shipped `.dck` files; any two would do. Seed `1234` is fixed so the
run reproduces: a second run produced the identical turn-12 result, with the
trailing millisecond figure at 12,591 ms rather than 9,549 ms. That number is
wall clock, not part of the outcome — the *game* is seed-deterministic, the
timing is not.

### …and `case "server":`, for the record

```
$ scripts/spike/headless/run.sh server
Error handling registered!
12:23:09 [INFO ] GuiBase: APP: Forge v.2.0.15-SNAPSHOT-09.14
12:23:09 [INFO ] GuiBase: Java: 21.0.12.1 (Eclipse Adoptium)
12:23:09 [INFO ] GuiBase: OS: Linux 6.12.101+deb13-amd64 amd64
12:23:09 [INFO ] GuiBase: RAM: 15856 MB max, 12 CPUs
Dedicated server mode.
Not implemented.
```

**exit 0.** The interesting part is what *does* happen: the JVM boots, AWT goes
headless (`Main.isCommandLineMode` lists `"server"` alongside `"sim"` and
`"parse"`, so upstream already intends this arm to be console-only), the GUI
interface is installed, and the process reaches the arm and exits cleanly. The
scaffolding is not the missing piece. The body is.

---

## Item 3 — the protocol enum is **60 methods, not 62**

`CLAUDE.md` and the planning board both call `ProtocolMethod` "the 62-method
enum". Read out of the *compiled* enum by reflection
(`scripts/spike/headless/src/ProtocolDump.java`, so this is a count, not a
grep):

```
TOTAL	60	SERVER	45	CLIENT	15	UNRESOLVED	2
```

Same class of error as the `ApiType` 206-vs-202 correction in
`docs/FORGE_ANALYSIS.md`. Someone should fix `CLAUDE.md`; it is owned by nobody
this wave, so this doc records it rather than silently editing it.

### How "required" was decided

Two of the three columns below are **measured**; one is **reasoned**, and the
difference matters:

- **Measured.** Whether the server *blocks* on a method was extracted from
  `RemoteClientGuiGame.java` by classifying each `ProtocolMethod` call site as
  `send` / `syncAndSend` (fire-and-forget) versus `sendAndWait` /
  `syncAndSendAndWait` (server thread blocks for the reply). **15 of the 45
  SERVER methods block.** A blocking ask that a browser client stubs out
  deadlocks the match or answers wrongly, so *all 15 are required, without
  judgement entering into it*.
- **Measured.** Whether Forge's own non-desktop client already no-ops it. The
  libGDX port (`forge-gui-mobile/.../MatchController.java`) is the existing
  proof that a client can skip a method and still play. Six are outright empty
  there: `showCombat() { }`, `flashIncorrectAction() { //TODO }`,
  `alertUser() { //TODO }`, `enableOverlay() { }`, `disableOverlay() { }`,
  `setPanelSelection() { //TODO }`, plus `setCard()` with the comment
  *"doesn't need to do anything"*.
- **Reasoned.** For the remaining fire-and-forget pushes, "required" means the
  browser client cannot run a correct, playable match without real behaviour.
  That is a judgement call and is flagged as such in the Why column.

### The 45 server → client methods

`[B]` = server blocks on the reply (measured).

| # | Method | Required? | Why |
| --- | --- | --- | --- |
| 0 | `setGameView` | **yes** | initial state + the delta-sync sequence baseline |
| 1 | `openView` | **yes** | tells the client which `PlayerView`s are its own |
| 2 | `afterGameEnd` | **yes** | teardown between games of a match |
| 3 | `showCombat` | no | mobile port: `{ }` |
| 4 | `showPromptMessage` | **yes** | the text that says what is being asked |
| 5 | `updateDrawOffer` | no | `IGuiGame` declares it `default { }`; optional feature |
| 6 | `updateButtons` | **yes** | OK/Cancel enablement drives the whole input loop |
| 7 | `flashIncorrectAction` | no | mobile port: `//TODO`, empty |
| 8 | `alertUser` | no | mobile port: `//TODO`, empty |
| 9 | `enableOverlay` | no | mobile port: `{ }` |
| 10 | `disableOverlay` | no | mobile port: `{ }` |
| 11 | `finishGame` | **yes** | end-of-game transition |
| 12 | `showManaPool` | no | presentation hint; pool contents arrive in the view |
| 13 | `hideManaPool` | no | same |
| 14 | `tempShowZones` `[B]` | **yes** | blocking, and returns the zones it opened |
| 15 | `hideZones` | **yes** | pairs with 14; skipping it leaves zones open |
| 16 | `setPanelSelection` | no | mobile port: `//TODO`, empty — desktop detail panel |
| 17 | `getAbilityToPlay` `[B]` | **yes** | blocking; which ability of a card to cast |
| 18 | `assignCombatDamage` `[B]` | **yes** | blocking; damage assignment order |
| 19 | `assignGenericAmount` `[B]` | **yes** | blocking; divide-N-among-targets effects |
| 20 | `message` | **yes** | trivial, but a no-op silently swallows game text |
| 21 | `showErrorDialog` | **yes** | same, for errors |
| 22 | `showConfirmDialog` `[B]` | **yes** | blocking yes/no |
| 23 | `showOptionDialog` `[B]` | **yes** | blocking pick-one-of-N |
| 24 | `showInputDialog` `[B]` | **yes** | blocking free text / number entry |
| 25 | `confirm` `[B]` | **yes** | blocking card-scoped confirm |
| 26 | `getChoices` `[B]` | **yes** | blocking; **carries the lambda — see item 5** |
| 27 | `order` `[B]` | **yes** | blocking; stack/trigger ordering |
| 28 | `sideboard` `[B]` | **yes** | blocking; between games of a match |
| 29 | `chooseSingleEntityForEffect` `[B]` | **yes** | blocking; the main targeting ask |
| 30 | `chooseEntitiesForEffect` `[B]` | **yes** | blocking; multi-target |
| 31 | `manipulateCardList` `[B]` | **yes** | blocking; scry/surveil-style reordering |
| 32 | `setCard` | no | mobile port: *"doesn't need to do anything"* |
| 33 | `setSelectables` | **yes** | what is legal to click; targeting is impossible without it |
| 34 | `clearSelectables` | **yes** | pairs with 33 |
| 35 | `setHighlighted` | no | pure render state (`AbstractGuiGame:325` just repaints) |
| 36 | `setWeaklySelectable` | no | render hint |
| 37 | `clearWeaklySelectable` | no | render hint |
| 38 | `openZones` `[B]` | **yes** | blocking; returns which zones actually opened |
| 39 | `restoreOldZones` | **yes** | pairs with 38 |
| 40 | `setRememberedActions` | **DEAD** | not on `IGuiGame`; `getMethod()` → `null`; never emitted |
| 41 | `nextRememberedAction` | **DEAD** | same |
| 42 | `showWaitingTimer` | no | elapsed-time display only |
| 43 | `applyDelta` | **yes** | the entire incremental state channel |
| 44 | `applyYieldUpdate` | **yes** | routes to the local `IGameController` (`AbstractGuiGame:714`) — authoritative state, not UI |

**29 required, 14 not required, 2 dead.**

### The 15 client → server methods

| # | Method | Required? | Why |
| --- | --- | --- | --- |
| 45 | `useMana` | **yes** | manual mana payment |
| 46 | `undoLastAction` | no | convenience; strongly expected, not load-bearing |
| 47 | `selectPlayer` | **yes** | targeting a player |
| 48 | `selectCard` | **yes** | the primary interaction |
| 49 | `selectButtonOk` | **yes** | resolves every prompt |
| 50 | `selectButtonCancel` | **yes** | same |
| 51 | `selectAbility` | **yes** | activating an ability |
| 52 | `nextGameDecision` | **yes** | continue/quit between games |
| 53 | `getActivateDescription` | no | tooltip text |
| 54 | `concede` | **yes** | must be able to leave |
| 55 | `drawOfferAction` | no | optional feature |
| 56 | `alphaStrike` | no | attack-with-everything hotkey |
| 57 | `reorderHand` | no | cosmetic hand sort |
| 58 | `requestResync` | **yes** | reconnect / sequence-gap recovery. Over a browser WebSocket this is not optional, and it is the same contract W2 on the board asks watchparty for |
| 59 | `sendYieldUpdate` | no | auto-pass is a pacing convenience. Near-essential for *playable* Magic; not required for correctness |

**9 required, 6 not required.**

### The count

> **38 of 60 required** — 29 server→client + 9 client→server.
> 20 not required, 2 dead.

For a browser **draft** client the number is **0 of 60**. `ProtocolMethod` is
the *match* protocol; it has no draft methods at all. Forge's draft goes
through `SGuiChoose`/`IGuiBase`, not `IGuiGame`, which is consistent with O2's
decision to reimplement drafting in TypeScript — lane B's engine never touches
any of this.

### `ITriggerEvent` is already a solved case, and it is the template

Three methods (`getAbilityToPlay`, `selectPlayer`, `selectCard`) take an
`ITriggerEvent` — a mouse event (`getButton/getX/getY`). Forge **already**
hardcodes `null` for it in both directions:

- `RemoteClientGuiGame.java:410` — `null/*triggerEvent*/` with the comment
  *"someplatform don't have mousetriggerevent class or it will not allow them
  to click/tap"*
- `NetGameController.java:61` and `:66` — the same, same comment

So the desktop-only argument on those three is a non-problem: the wire never
carries it. That matters because it is the existing precedent for item 5.

---

## Item 5 — `FSerializableFunction`: yes, it is a real wire problem

**Verdict: real, but narrow, and Forge's own source already names the fix —
`getChoices` should send rendered display strings instead of the function.**

The board flagged `getChoices`/`one`. Splitting them:

- **`one` never crosses the wire.** It is not a `ProtocolMethod` constant at
  all. `AbstractGuiGame.one` (`:771`) resolves locally to
  `getChoices(message, 1, 1, choices, null, display)`. Half the concern
  evaporates on inspection.
- **`getChoices` does.** `RemoteClientGuiGame.java:458` passes `display`
  straight into `syncAndSendAndWait(ProtocolMethod.getChoices, …, display)`,
  and the transport is **Java native serialization**. An
  `FSerializableFunction` is `Function<T,V> extends Serializable`, so a lambda
  serializes as a `java.lang.invoke.SerializedLambda`: a capture record naming
  the implementing class and a synthetic `lambda$…` method. Reconstituting it
  requires a JVM with that exact class on its classpath. **There is no way for
  a JavaScript client to deserialize or invoke one.** This is not a JSON
  encoding difficulty; it is bytecode identity on the wire.

Forge knows. `WireClassFilter.java:44-50` allowlists exactly one class by exact
name, and the comment is explicit:

> The filter's one deliberate soft spot. `ProtocolMethod.getChoices` ships an
> `FSerializableFunction`, so real traffic carries lambdas; removing this means
> changing that method to send rendered strings.

**The fix is cheap and exact, for one reason: the server already holds
everything the function needs.** `display` is only ever `T -> String`, a label
renderer, and both `T` and the lambda are constructed server-side — the only
real call site is `PlayerControllerHuman.java:3203`, a token-naming label. So
the server can apply `display` to each choice before sending and ship a
parallel `List<String>` of labels. Semantically identical; nothing is lost.

It is also already legal to send nothing: `IGuiGame`'s convenience overload
`getChoices(message, min, max, choices)` passes `display = null`, so `null` is
a value the protocol handles today — it just degrades labels to `toString()`.

Two consequences for our fork:

1. **The `SerializedLambda` allowlist entry can be deleted** once `getChoices`
   is changed, which closes the gadget-deserialization soft spot
   `WireClassFilter` documents. That is a security improvement we get for free.
2. **This is one method.** Every other blocking ask carries only view objects
   and primitives. `FSerializableFunction` does not recur across the protocol;
   it is a single seam.

---

## Item 4 — jUPnP: **config, not a code change**

`FServerManager` imports six `org.jupnp` types and holds an
`UpnpService upnpService` field, so jUPnP must stay on the *classpath* — but it
is never *touched* unless a preference says so. `startServer` (`:228-241`):

```java
public void startServer(final int port) {
    this.port = port;
    String UPnPOption = FModel.getNetPreferences().getPref(ForgeNetPreferences.FNetPref.UPnP);
    boolean startUPnP;
    if (UPnPOption.equalsIgnoreCase("ASK")) {
        startUPnP = callUPnPDialog();
    } else {
        startUPnP = UPnPOption.equalsIgnoreCase("ALWAYS");
    }
    ...
    if (startUPnP) {
        mapNatPort();
    }
```

`mapNatPort()` is the only thing that instantiates `UpnpServiceImpl`. So:

> **Write `UPnP=NEVER` into `<userDir>/preferences/server.preferences` before
> starting the server and jUPnP is never constructed. No fork change.**

`NEVER` is not invented for this spike — `callUPnPDialog` persists exactly that
string when the user picks "Never" (`FServerManager.java:298`), and
`ForgeNetPreferences.FNetPref` declares the key with default `"ASK"`. Any value
other than `ASK` or `ALWAYS` also yields `startUPnP = false`, so the setting
fails safe.

**The default is the trap, not jUPnP.** `UPnP("ASK")` is the shipped default,
and the `ASK` branch calls `callUPnPDialog()` → `SOptionPane.showOptionDialog`,
a blocking modal a headless server cannot answer. Whoever writes
`case "server":` must set the pref (or pass a non-`ASK` value) before calling
`startServer`, or the server will hang or throw on a dialog nobody can see.
That is still config: one line in a properties file the server writes at boot.

Two further notes:

- The UPnP call site is already defensive. `mapNatPort` catches
  `LinkageError | Exception` and logs *"UPnP mapping unavailable"*
  (`FServerManager.java:795-802`), specifically so a missing jUPnP degrades
  instead of killing hosting. `forge-gui-ios` relies on this: its pom scopes
  jUPnP `provided` and `Main.java:417` returns `null` from
  `getUpnpPlatformService()` with the comment *"not used on iOS (jupnp is
  compile-only: provided scope in pom)"*.
- **So if the fork ever wants jUPnP gone entirely, the iOS precedent shows how**
  — scope it `provided` in `forge-gui/pom.xml` and let the `LinkageError` catch
  handle it. That is a pom change, not a source change, and it is not needed to
  ship. Port mapping is for reaching a host over the open internet; we are
  behind the friend gate at `hadoku.me/cardtable/` and will be reverse-proxied,
  so UPnP has no job here at all.

---

## What this changes for PR-4

- **`case "server":` is a smaller job than "implement a headless server".** The
  process already runs headless, `FServerManager.startServer` already works
  (the in-tree integration tests call it), and jUPnP is a preference away.
  What the arm needs is: set the UPnP pref, construct the lobby, call
  `startServer(port)`, and block instead of falling through to `System.exit(0)`.
- **Read `forge-gui-desktop/src/test/java/forge/net/` before writing any of
  it.** `HeadlessGuiDesktop` (130 lines) and `HeadlessNetworkGuiGame` (209
  lines) are an existing `IGuiGame` implementation with no display behind it —
  which is most of what a WS/JSON `IToClient` bridge needs to be tested
  against. `MultiProcessGameExecutor` (625 lines) already runs client and
  server as separate processes.
- **`IToClient` is still empty and `IRemote` is still 3 methods**
  (`send`, `sendAndWait`, and a `write` default that delegates to `send`), so
  D9's "the bridge is required in every branch" is unchanged. The seam is as
  thin as advertised.
- **Budget 38 methods, not 62.** And of the 38, 15 are blocking asks that are
  genuinely mandatory; the rest are pushes.
- **Strip `Sentry.init` in the fork.** `Main.java:65-74` initialises Sentry with
  `options.setEnableExternalConfiguration(true)` and, if no DSN is configured,
  *sets upstream's own DSN* — `https://…@sentry.asgardsrealm.net/3`. There is no
  external configuration that disables it, because the code refills an empty
  DSN. A dedicated server would report our crashes to the Forge project. Wave 1
  lane B already stubbed Sentry out for the TeaVM overlay; PR-4 needs the same
  decision made deliberately, in the fork, for the server entry point.

## Not verified

- **No server was actually started.** This spike ran `SimulateMatch` and the
  empty `case "server":` arm; it did not write a `startServer` call, because
  that means writing Java, and D2/O1 says not yet. The claim "`startServer`
  works headless" rests on the in-tree integration tests *existing and calling
  it*, not on this spike running them. Running `mvn test` on
  `forge-gui-desktop` would settle it and was out of scope here.
- **The required/not-required split for fire-and-forget pushes is reasoned, not
  measured.** The blocking set (15) and the mobile port's no-ops (7) are
  measured; the rest is judgement, marked as such above.
- **Nothing was measured about a draft over this protocol**, because there is
  nothing to measure — the enum has no draft methods.

## The vendored tree is pristine

Every build and run in this document used `~/.cache/forge-w2-spike`, a copy at
commit `2cd497cfbeb6df4e2a013c916aaab9de5ecf9795`. Afterwards:

```
$ git -C forge status --porcelain
(empty)                                    exit 0
$ git -C forge rev-parse HEAD
2cd497cfbeb6df4e2a013c916aaab9de5ecf9795   exit 0
$ find forge -maxdepth 2 -name target -type d
(nothing)
```

`scripts/spike/headless/run.sh verify-pristine` re-checks this and exits 1 if
the tree is dirty.
