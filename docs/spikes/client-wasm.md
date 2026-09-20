# TeaVM go/no-go, part 2: can Forge's own **client** run in a browser?

**Verdict: NO-GO on `forge-gui-mobile` as it stands — but what stops the
client is not what stopped the engine, and it is a much smaller thing.**

D7 (`docs/spikes/teavm-go-no-go.md`) asked whether `forge-core` + `forge-game`
link under TeaVM. They do not: **30** missing APIs, and it blamed
`java.util.concurrent.locks`. That was the **engine**. The engine does not need
to be in a browser — it runs on hokon in a real JVM today
(`docs/FORGE_JAR.md`), one child JVM per match. Nobody had measured the
reachable set from the **client**.

Measured now, against TeaVM 0.15.0, the same version D7 used:

| what links | entry point | missing APIs | artifact |
| --- | --- | --- | --- |
| Forge's **view layer** (`GameView` / `CardView` / `PlayerView` / `Tracker` / the 214-property `TrackableProperty`) | `clientspike.ViewLayerMain` | **0** | **493,189 B** raw / **195,460 B** gzip -9, 632 classes / 5,936 methods |
| one method, `updatePhase`, alone | `clientspike.UpdatePhaseMain` | **15** | none |
| 98 of `IGuiGame`'s 106 methods on `MatchController` (all but eight) | `clientspike.GuiSurfaceMinusMain` | **11** | none |
| all 106 — the client's whole inbound protocol surface | `clientspike.GuiSurfaceMain` | **53** | none |
| all 106 inbound + all 15 outbound (`NetGameController`) | `clientspike.NetClientMain` | **56** | none |
| the engine, for comparison (D7) | `spike.SpikeMain` | 30 | none |

Three things in that table matter more than the verdict:

1. **Forge's view layer — the thing on the wire — links clean and produces a
   real artifact.** Zero missing APIs, both on WASM GC and on JavaScript. D7
   could not produce a full-engine artifact at all; this is a 493 KB one for
   the half a client actually needs.
2. **Forge's outbound half costs 3 APIs, none of them `java.util.concurrent`.**
   `ReplyPool`/`FutureTask` — the thing D7 flagged as "matters beyond this
   spike" — is **not** on `NetGameController`'s path. It belongs to
   `FGameClient`, the netty transport, which our bridge replaces anyway.
3. **`java.util.concurrent.locks` is on the client's list, but it arrives
   through two code paths a net-play client has no business on** — a dev-mode
   state snapshot that is dead when `GameView.getGame()` is null, and the
   quest-draft bracket simulator behind the win/lose screen. Both are named
   below, by file and line.

So the answer to *"is D7 live again?"* is: **the engine is not the obstacle;
`forge-gui-mobile` is.** What kills this is that the mobile GUI is a whole
product — quest mode, adventure mode, gauntlet, the deck editor, a
server-hosting singleton — reachable in a handful of hops from the match
screen, and TeaVM's whole-program analysis links all of it.

Everything below is reproducible from `scripts/spike/client-wasm/`. Nothing
under `forge/` was modified; the proof is at the bottom.

---

## Reproducing it

```sh
scripts/spike/client-wasm/run.sh copy-forge       # copy the vendored clone to ~/.cache
scripts/spike/client-wasm/run.sh build-forge      # mvn install -pl forge-gui-mobile -am
scripts/spike/client-wasm/run.sh link clientspike.ViewLayerMain        # exit 0,  0 missing
scripts/spike/client-wasm/run.sh link clientspike.UpdatePhaseMain      # exit 1, 15 missing
scripts/spike/client-wasm/run.sh link clientspike.GuiSurfaceMinusMain  # exit 1, 11 missing
scripts/spike/client-wasm/run.sh link clientspike.GuiSurfaceMain       # exit 1, 53 missing
scripts/spike/client-wasm/run.sh link clientspike.NetClientMain        # exit 1, 56 missing
scripts/spike/client-wasm/run.sh verify-pristine
```

`run.sh all` does all of it in order. Each `link` writes
`~/.cache/w14a-spike/link-<entry>.<target>.log` and the de-duplicated
missing-API list next to it as `missing-<entry>.<target>.txt`; the counts above
are `wc -l` of those files. To see **why** each one is missing:

```sh
scripts/spike/client-wasm/attribute.py ~/.cache/w14a-spike/link-GuiSurfaceMain.WEBASSEMBLY_GC.log
scripts/spike/client-wasm/attribute.py ~/.cache/w14a-spike/link-GuiSurfaceMain.WEBASSEMBLY_GC.log --by-entry
```

Timings on hokon, warm `~/.m2`: `mvn install -pl forge-gui-mobile -am
-DskipTests` **21.2 s** (exit 0); the links **6.1 s / 4.8 s / 16.8 s / 19.5 s**
for `ViewLayerMain`, `GuiSurfaceMinusMain`, `GuiSurfaceMain`, `NetClientMain`.
Copying the 1.7 GB clone is the slowest step.

The overlay is `scripts/spike/client-wasm/`: a standalone Maven project that
consumes `forge:forge-gui-mobile` as an ordinary artifact, excludes
`io.sentry:sentry`, `org.tinylog:tinylog-impl` and `org.testng:testng`, and
shadows the Sentry classes with stubs. Its build directory is
`~/.cache/w14a-spike/client-wasm-target`, outside the repo. No patch is ever
applied to `forge/` (D2).

### What the entry points are

`forge-gui-mobile` has no "client main" to point TeaVM at — `forge.Forge` is
the whole application, main menu and all. So the entry points are built from
the protocol instead, which is what a browser client would actually be driven
by:

- **`ViewLayerMain`** — the trackable view layer alone. No libGDX, no
  `MatchController`, no netty.
- **`GuiSurfaceMain`** — calls **all 106** methods `IGuiGame` declares
  (overloads and `default`s included) on
  `forge.screens.match.MatchController.instance`. 43 of `ProtocolMethod`'s 45
  `Mode.SERVER` entries are `IGuiGame` methods; the other two,
  `setRememberedActions` and `nextRememberedAction`, are `IMacroSystem` and are
  covered by `NetClientMain`. Both counts are checkable:

  ```sh
  P=forge/forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java
  grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.SERVER' $P                       # 45
  javap -cp ~/.m2/repository/forge/forge-gui/2.0.15-SNAPSHOT/forge-gui-2.0.15-SNAPSHOT.jar \
        forge.gui.interfaces.IGuiGame | grep -cE '\('                          # 106
  ```

  `driveGui` holds 98 of those call sites and `driveQuarantined` the other 8.
- **`GuiSurfaceMinusMain`** — the same minus the eight calls listed in
  `GuiSurfaceMain.driveQuarantined`.
- **`UpdatePhaseMain`** — one call, `updatePhase`. It exists because TeaVM
  reports only the *shortest* path to a missing API, so inside a larger entry
  point this method's route to `forge.game.Game` is hidden behind a shorter one
  and vanishes from the log.
- **`NetClientMain`** — `GuiSurfaceMain` plus every `IGameController` method on
  a `NetGameController`, with a stub `IToServer` in place of netty, because in
  this design our bridge **is** the transport.

None of them is ever run. **Linking is the question; a running client is a
later wave.** This is a spike and it changes no product code.

---

## The 53, and where each one enters

`attribute.py --by-entry` attributes every missing API to the protocol call
that reaches it. Across all 106 inbound calls, **every one of the 53 enters
through four of them**:

```
$ scripts/spike/client-wasm/attribute.py \
    ~/.cache/w14a-spike/link-GuiSurfaceMain.WEBASSEMBLY_GC.log --by-entry
 19  g.applyDelta((DeltaPacket) null);
 18  g.finishGame();
 13  g.openView((TrackableCollection<PlayerView>) null);
  8  (no entry frame)
  2  g.setPlayerAvatar((LobbyPlayer) null, (IHasIcon) null);
--- 60 distinct missing APIs, 5 distinct entry-point call sites
```

| protocol method | missing APIs it drags in | what it reaches |
| --- | --- | --- |
| `applyDelta` | 19 | `TrackableSerializer` → `CObjectInputStream`, netty's logger discovery |
| `finishGame` | 18 | `ViewWinLose` → quest-draft / gauntlet → **`forge.game.Game`** |
| `openView` | 13 | `MatchScreen` → `VChat` → `OnlineMenu` → `FServerManager` |
| `setPlayerAvatar` | 2 | `ImageCache` → `ImageKeys`' thread pool |

Two notes on the arithmetic. The tool's headline says **60**, not 53: 53 is the
`… was not found` form that the counts in this document use — D7's basis — and
the other 7 are TeaVM's `Class X extends Y, which is missing in the classpath`
form, which names 3 further missing types
(`java.util.concurrent.ScheduledExecutorService`, `java.util.concurrent.Future`,
`org.apache.logging.log4j.spi.ExtendedLoggerWrapper`) and carries no stack. The
`(no entry frame)` bucket is those 7 plus one that genuinely has no client
frame — `Runtime.removeShutdownHook`, reached from `FServerManager`'s own
shutdown hook lambda. Both forms come out of the same run:

```sh
L=~/.cache/w14a-spike/link-GuiSurfaceMain.WEBASSEMBLY_GC.log
grep -oE '^\[ERROR\] (Method|Class|Field) [^ ]+ was not found' $L | sort -u | wc -l   # 53
grep -oE '^\[ERROR\] Class [^ ]+ (extends|implements) [^ ]+, which is missing in the classpath' \
     $L | sort -u | wc -l                                                            # 7
```

And this attribution is **not a decomposition**. TeaVM reports the *shortest*
path it found, so cutting those four does not leave zero — it exposes the next
shortest path through other methods. That is exactly what
`GuiSurfaceMinusMain` measures, below.

### The exact chain to `Game`, twice

The brief asked which class literal and which call chain reaches `Game`. There
are two, and neither is a net-play code path.

**(1) `updatePhase` — a dev-mode state snapshot that is dead on a net client.**
Reproduce with `run.sh link clientspike.UpdatePhaseMain` (exit **1**, **15**
missing) and `attribute.py link-UpdatePhaseMain.WEBASSEMBLY_GC.log`:

```
forge.screens.match.MatchController.updatePhase(MatchController.java:312)
  -> forge.game.GameState.initFromGame(GameState.java:163)
     -> forge.game.Game.<clinit>(Game.java:65)
        -> org.tinylog Logger.tag("NETWORK")
           -> java.util.concurrent.locks.ReentrantReadWriteLock   [MISSING]
              java.lang.management.ManagementFactory, java.lang.ProcessHandle,
              sun.reflect.Reflection, android.os.Process,
              dalvik.system.VMStack, ClassLoader.getResources
```

`MatchController.java:310-315` is:

```java
if (ph != null && saveState && ph.isMain()) {
    phaseGameState = new GameState();
    try {
        phaseGameState.initFromGame(getGameView().getGame());
    } catch (Exception e) {
    }
}
```

`GameView.game` is declared `private final transient Game game; //TODO: Remove
this when possible before network support added` (`GameView.java:36`). On a
client the view arrives deserialized, so `getGame()` is **null** and the whole
block throws into an empty catch. It is dead code on a net client, and it is
what links `forge.game.Game` — and with it tinylog's whole platform-probing
`<clinit>`.

**(2) `finishGame` — the win/lose screen simulating a quest-draft bracket.**

```
forge.screens.match.MatchController.finishGame(MatchController.java:368)
  -> forge.screens.match.winlose.ViewWinLose.<init>(ViewWinLose.java:123)
     -> forge.screens.match.winlose.QuestDraftWinLose.showRewards(QuestDraftWinLose.java:67)
        -> forge.gamemodes.quest.QuestDraftUtils.update(QuestDraftUtils.java:259)
           -> forge.gamemodes.quest.QuestDraftUtils.updateFromTournament(QuestDraftUtils.java:363,366)
              -> forge.game.Match.<init>(Match.java:38) / Match.createGame(Match.java:73)
                 -> forge.game.Game.<init>(Game.java:317 -> 383)
                    -> forge.game.Game.subscribeToEvents(Game.java:1023)
                       -> com.google.common.eventbus.EventBus.register
                          -> com.google.common.cache.LocalCache$Segment
                             extends java.util.concurrent.locks.ReentrantLock   [MISSING]
```

This is **D7's exact failure**, reached from the client — but through the quest
draft's tournament simulator, which hosts local `Game`s for the rest of the
bracket. The same `finishGame` also reaches `GauntletIO` (xstream →
`java.io.ObjectOutputStream`) and adventure mode's `Config`.

### Four more chains worth naming

- **Forge's delta wire format is Java serialization.**
  `NetworkGuiGame.applyDelta(NetworkGuiGame.java:171)` →
  `TrackableSerializer.unwrapEvents(TrackableSerializer.java:206-209)` →
  `forge.gamemodes.net.CObjectInputStream`, which **extends
  `java.io.ObjectInputStream`** — a class TeaVM does not have at all, in any
  backend. `TrackableSerializer.<clinit>` additionally pulls netty's logger
  discovery in: `sun.misc.Unsafe`, `LinkedBlockingQueue`, log4j,
  `ClassLoader.getSystemResources`.
- **The match chat widget reaches the server-hosting singleton.**
  `MatchScreen.<init>` → `VChat.<init>(VChat.java:34)` →
  `VChat.lobbyChat(VChat.java:48)` → `OnlineMenu$OnlineScreen.getScreen` →
  `FServerManager.<clinit>(FServerManager.java:397-398)` → `Executors`,
  `ThreadFactory`, `SelectorProvider`, netty's `EventExecutorGroup`.
- **The font path needs a native library.** `FSkinFont.generateFont`
  (`FSkinFont.java:450`) → `System.loadLibrary` / `System.load`: that is
  gdx-freetype's JNI loader.
- **Filesystem profile discovery runs in a class initializer.**
  `ForgeConstants.<clinit>(ForgeConstants.java:233)` →
  `ForgeProfileProperties.load` → `File.toPath`, `System.getenv`. Reached from
  `FSkinFont.<clinit>`, i.e. from drawing any text.

## What is left after the eight are cut: **11**

`GuiSurfaceMinusMain` links the other 98 call sites. Exit **1**, **11**
distinct missing APIs, and — the point — **`forge.game.Game` is no longer in
any chain, and `java.util.concurrent.locks` is gone entirely.** What remains is
`forge-gui-mobile`'s own scaffolding, reached now through `showPromptMessage`
(6), `handleGameEvent` (3), `updateStack` (1) and `setCurrentPlayer` (1):

| missing | reached from |
| --- | --- |
| `System.loadLibrary`, `System.load` | `FSkinFont.generateFont` — gdx-freetype natives |
| `File.toPath`, `System.getenv` | `ForgeConstants.<clinit>` → `ForgeProfileProperties` |
| `Executors`, `ExecutorService`, gdx's `AsyncExecutor$1` | libGDX `AssetManager` via `forge.assets.Assets` |
| `ConcurrentSkipListMap` | `StaticData.<init>` via `FModel.getPreferences` |
| `DocumentBuilderFactory`, `org.w3c.dom.NodeList` | `AchievementCollection.load` via `FModel.<clinit>` |
| `java.text.BreakIterator` | `forge.assets.TextRenderer.<init>` |
| `java.util.StringJoiner` | `ForgePreferences.<clinit>` via `YieldController` |

Note this is **not** a clean subtraction. Cutting an edge does not delete the
APIs behind it; it makes TeaVM report the *next* shortest path, which is why
`showPromptMessage` — clean in the full run — accounts for six of these. The
count is a floor for each entry point, never an estimate of the next. That
said, 53 → 11 with `Game` and every lock gone is a real reduction, not a
relabelling: the missing types themselves are different.

## The outbound half costs 3, and none of them is a lock

`NetClientMain` adds all 15 `IGameController` methods on a `NetGameController`.
56 − 53 = **3**:

| missing | chain |
| --- | --- |
| `Class.getGenericSuperclass`, `Class.getGenericInterfaces` | `NetGameController.concede(:106)` → `GameProtocolSender.send(:13)` → `ProtocolMethod.checkArgs(:166)` → `ReflectionUtil.isInstance(ReflectionUtil.java:72)` |
| `Properties.store(Writer,String)` | `NetGameController.setShouldAutoYield(:143)` → `YieldController.setShouldAutoYield(:218)` → `PersistentAutoDecisionStore.save(:127)` |

**`ReplyPool` never appears.** It is a field of `FGameClient`
(`FGameClient.java:39`) and `RemoteClient`, not of `NetGameController`;
`GameProtocolSender.sendAndWait` only calls `IRemote.sendAndWait` on whatever
transport it was handed. So Forge's blocking-reply plumbing — and with it
`FutureTask`, which TeaVM 0.15.0 does not have — goes away for free the moment
our bridge is the transport instead of netty.

## D7's classlib finding, re-checked and confirmed

TeaVM 0.15.0 ships **14** types in `java.util.concurrent`, **14** more in
`java.util.concurrent.atomic`, and **zero** in `java.util.concurrent.locks`:

```sh
cd ~/.m2/repository/org/teavm/teavm-classlib/0.15.0
J=teavm-classlib-0.15.0.jar
unzip -l $J | awk '{print $4}' \
  | grep -cE 'org/teavm/classlib/java/util/concurrent/[A-Za-z]+\.class$'          # 14
unzip -l $J | awk '{print $4}' \
  | grep -cE 'org/teavm/classlib/java/util/concurrent/atomic/[A-Za-z]+\.class$'   # 14
unzip -l $J | awk '{print $4}' | grep -cE 'java/util/concurrent/locks/'           # 0
```

D7's numbers hold exactly, including its list of what is absent: no
`ExecutorService`, no `Future`, no `FutureTask`. What has changed is only which
of them the client actually needs, and the answer is none of the locks and none
of `FutureTask`.

## WASM GC vs JavaScript, and gdx-teavm

`-Dspike.targetType=JAVASCRIPT` gives a **byte-identical** 53-entry list for
`GuiSurfaceMain` (`diff` of the two `missing-*.txt` is empty), and
`ViewLayerMain` links clean there too, emitting **500,694 B** of JavaScript.
Both backends share `teavm-classlib`; the choice of backend changes nothing
about this verdict, exactly as D7 found.

`gdx-teavm` — `com.github.xpenatan.gdx-teavm:backend-teavm:1.4.0`, on Maven
Central, libGDX 1.14.0, TeaVM **0.13.0** — is on the `-Pgdxteavm` profile. Put
on the TeaVM plugin's classpath it **partially engages**: it resolves
`Class.getResource` and `ClassLoader.loadClass`, adds `Date.from(Instant)`, and
takes the JavaScript count from 53 to **52**. It does **not** substitute
gdx-freetype's `System.loadLibrary`, and it cannot touch `forge.game.Game` or
`java.io.ObjectInputStream`.

```sh
SPIKE_EXTRA_PROFILES=gdxteavm SPIKE_TARGET_TYPE=JAVASCRIPT \
  scripts/spike/client-wasm/run.sh link clientspike.GuiSurfaceMain   # exit 1, 52
```

Two honest caveats. First, gdx-teavm declares `org.reflections:reflections` at
**runtime** scope, so the TeaVM plugin dies with `Unexpected error occurred:
org/reflections/Reflections` before reporting anything until you declare it
yourself — the profile does. Second, **this is not gdx-teavm's supported
route**: it normally drives the build itself through `TeaBuildConfiguration` /
`TeaBuilder` on TeaVM 0.13.0, and mixing its 0.13-era plugin with the 0.15.0
compiler was a deliberate choice to keep the number comparable with D7's 30.
A gdx-teavm-native build was **not** attempted — see *What was NOT verified*.

---

## What a GO would require

The good news first: the half of Forge a browser client genuinely needs — the
view layer, the 45 inbound protocol methods' semantics, the 15 outbound ones —
is **not** the problem. The problem is that `forge-gui-mobile`'s match screen
cannot be separated from the rest of the mobile application by dead-code
elimination alone.

A GO on this route needs, in rough order of cost:

1. **A fork that severs eight edges from the match screen.** Every one is a
   small, local cut: delete `updatePhase`'s dev-mode `GameState` snapshot
   (dead on a net client), make `finishGame` not construct a
   `QuestDraftWinLose`, make `MatchScreen` not build a `VChat` that reaches
   `FServerManager`, and so on. That is the 53 → 11 step, measured.
2. **libGDX under gdx-teavm for real**, on its own TeaVM version, with the
   freetype font path replaced — a web font, not a JNI native.
3. **A delta format that is not Java serialization.** `CObjectInputStream`
   cannot exist under TeaVM. Our bridge already re-encodes the wire, so this
   may be free on our side; it is not free if the browser is to speak Forge's
   own protocol directly.
4. **`ForgeConstants` / `FModel` / `StaticData` de-globalised** for a browser
   build: no profile directories, no achievements XML, no
   `ConcurrentSkipListMap`.
5. **Two small classlib gaps upstream** (`StringJoiner`, `BreakIterator`), plus
   `Collections.unmodifiableSortedSet` if the engine is ever wanted too.

And the caveat D7 got right, which applies here unchanged: **fixing all 53 only
gets you to the next link error.** These entry points call each protocol method
once with null arguments; a real client exercises much more.

**Recommendation: NO-GO for this wave.** Not because a browser Forge client is
impossible — the view layer linking clean at 493 KB is the strongest evidence
yet that it is not — but because the route runs through forking
`forge-gui-mobile`, and that is a far bigger commitment than a spike can
authorise. Lane B (CheerpJ) and lane C (streaming) answer the same question
without a fork, and should be read against this.

If this is re-opened, the cheapest first step is item 1 above: it is eight
named edges, all measured, and it is worth doing **before** any libGDX work,
because it is what decides whether the rest is worth paying for.

## What was NOT verified

- **Anything at runtime.** By design — the brief says linking is the question.
  `ViewLayerMain` produces an artifact and nothing has executed it. The command
  that would is `node scripts/spike/run-wasm.mjs
  ~/.cache/w14a-spike/client-wasm-target/wasm` (D7's runner, against this
  lane's output directory).
- **A gdx-teavm-native build.** gdx-teavm's supported entry is its own
  `TeaBuilder` on TeaVM 0.13.0, driven from Gradle. Using it means giving up
  comparability with D7's 0.15.0 numbers and building a second toolchain; it
  was not attempted. It would be settled by porting
  `scripts/spike/client-wasm/` to gdx-teavm's `TeaBuildConfiguration` and
  re-running the same five entry points.
- **Whether the 11 residual APIs are the floor.** They are the floor *for those
  98 call sites*; cutting them would expose longer paths, as the 53 → 11 step
  already showed.
- **`forge-gui-desktop` (Swing).** Out of scope for this lane; that is lane B.
- **TeaVM's `classesToPreserve`** as an alternative to explicit call sites. The
  plugin has the parameter; the explicit-call-site approach was chosen because
  it attributes each missing API to a named protocol method, which is what made
  the table above possible.

## `forge/` is unmodified

```sh
$ scripts/spike/client-wasm/run.sh verify-pristine
git -C /home/hadoku/repos/hadoku-cardtable/forge status --porcelain:
(empty above == unmodified)
HEAD 2ad70eb447a22efe5b80904c07188311da034a42 Implement `forge server`: host a lobby with no window
$ git submodule status forge
-2ad70eb447a22efe5b80904c07188311da034a42 forge
```

Empty porcelain output, and the leading `-` in this worktree is correct — the
submodule is deliberately uninitialised here. Every build ran against
`~/.cache/w14a-spike/forge`, a `cp -a` of the main checkout's clone; the
overlay's Maven build directory is `~/.cache/w14a-spike/client-wasm-target`,
also outside the repo, so no `target/` tree appears in anyone's `git status`.

## Toolchain, for the record

| | |
| --- | --- |
| Maven | 3.9.16, `~/.local/opt/apache-maven-3.9.16` (off `PATH` on purpose, D14) |
| JDK | Temurin 21.0.12.1+1, `~/.local/opt/jdk-21.0.12.1+1` |
| TeaVM | 0.15.0 — the same version D7 measured 30 against |
| gdx-teavm | `com.github.xpenatan.gdx-teavm:backend-teavm:1.4.0` (libGDX 1.14.0, TeaVM 0.13.0) |
| libGDX | 1.14.2, as `forge-gui-mobile/pom.xml` declares |
| Forge | `2ad70eb4`, `2.0.15-SNAPSHOT` |

---

# ITEM 1, MEASURED 2026-09-20: one cut removes D7's killer

The section above recommends, as the cheapest first step on a GO,
*"a fork that severs eight edges from the match screen"*, and says it is worth
doing **before** any libGDX work because it decides whether the rest is worth
paying for.

**One of those edges has now been cut and measured. It removes the exact chain
D7 died on.**

Patch: `scripts/spike/client-wasm/cuts/01-winlose-net-modes-only.patch`, applied
to the spike's **copy** of forge. `forge/` itself is untouched —
`run.sh verify-pristine` and `git submodule status forge` both confirm it.

## The cut

`ViewWinLose.<init>` switches on `game0.getGameType()` and hands control to a
mode-specific win/lose controller: Quest, QuestDraft, PlanarConquest, Adventure,
Gauntlet. **A net-play client is in none of those modes** — they are
single-player, driven by the local game model. The cut deletes those branches
and leaves Draft/Sealed plus the default `ControlWinLose`. About twenty lines.

## What it moved

| | before | after |
| --- | --- | --- |
| distinct missing APIs, all 106 inbound calls | **53** | **43** |
| entering via `finishGame()` | 18 | **7** |

The ten that came off are not ten arbitrary APIs. They are D7's verdict:

```
java.util.concurrent.locks.ReentrantLock              <- D7's stated killer
com.google.common.cache.LocalCache$Segment.lock()V
com.google.common.cache.LocalCache$Segment.unlock()V
com.google.common.cache.LocalCache$Segment.tryLock()Z
com.google.common.cache.LocalCache$Segment.isHeldByCurrentThread()Z
com.google.common.util.concurrent.ListenableFuture.isDone()Z
java.util.concurrent.ConcurrentLinkedQueue
java.util.concurrent.CopyOnWriteArraySet
java.util.concurrent.atomic.AtomicReferenceArray
java.io.ObjectStreamField
```

D7 concluded: *"`Game.java:97` constructs a Guava `EventBus`; Guava's
`LocalCache$Segment` extends `ReentrantLock`; and `teavm-classlib-0.15.0.jar`
ships **zero** classes in `java.util.concurrent.locks`."*

That chain reached the client **only through the non-net game modes**, and a
twenty-line cut to one `switch` severs it. The engine was never the client's
problem; the quest/gauntlet/adventure wiring hanging off the match screen was.

## What is left: 43

| entering via | count | what it is |
| --- | --- | --- |
| `applyDelta` | 19 | Java serialization — `CObjectInputStream` → `ObjectInputStream`. **Likely inapplicable to us:** our bridge already re-encodes the wire as JSON (`@hadoku/forge-wire`), so a browser client of ours never calls `TrackableSerializer.unwrapEvents`. Unverified as a cut. |
| `openView` | 14 | Forge's own match UI — `TextRenderer`→`BreakIterator`, `FSkinFont.generateFont`→native fonts. **These must NOT be "cut":** removing them deletes the UI this whole route exists to run. They are real work (a web font for freetype), not edges to sever. |
| `finishGame` | 7 | what remains after the cut above |
| `setPlayerAvatar` | 2 | `ImageKeys.getImageFile` → `ImageCache` |
| (no entry frame) | 6 | |

## What this does and does not change

**It does not turn D7's NO-GO into a GO.** The caveat both spikes carry still
holds: these entry points call each protocol method once with null arguments,
so fixing the last of them only gets you to the next link error, and libGDX
under gdx-teavm remains unattempted.

**It does change the shape of the bet.** Before this, "fork `forge-gui-mobile`"
was an unbounded commitment against a blocker D7 described in terms of the
rules engine. It is now a bounded one against a blocker that is the mobile
app's *other game modes*, with the largest single edge measured at twenty
lines and the most feared API already gone.

The honest next measurement is `applyDelta`: if those 19 are genuinely ours to
skip, the remaining surface is the match UI itself, which is work rather than
an obstacle.

## A defect in this harness, found the hard way

`run.sh build-forge` ran `( cd … && mvn install … )` in a subshell and returned
**0 when maven printed `BUILD FAILURE`**. The first measurement of this cut was
taken against the PREVIOUS jar and reported "53, unchanged" — a number that
looked like a result and meant nothing. It was caught only because the
installed jar's mtime predated the edit.

Fixed: the exit code is now checked explicitly and the function refuses to
continue, with a message saying anything linked afterwards would measure a
stale artifact. Mutation-tested — appending `this is not java` to the cut file
makes it exit 1 and print the refusal.

**Every number this harness produced before that fix should be re-taken if it
matters.** The ones in the original section were produced by the same code
path; they are probably fine, because the builds preceding them succeeded, but
"probably" is doing real work in that sentence.
