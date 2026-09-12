# TeaVM go/no-go: can `forge-core` + `forge-game` run in a browser?

**Verdict: NO-GO** on TeaVM 0.15.0 as it stands. `forge-core` + `forge-game`
link-fail against TeaVM's class library with **30 distinct missing APIs**, and
TeaVM emits **no artifact at all** when there are link errors — so there is no
`.wasm` to point at and no cold-start number for the engine to quote.

This settles **D7**. **P4 survives as a React client.** D6's iframe payload does
*not* already exist.

But the failure is narrow and legible, and two of the three things everyone
expected to kill this idea did not:

| Item from the brief | Result |
| --- | --- |
| (1) classlib coverage | **FAIL** — 30 missing APIs, dominated by `java.util.concurrent` |
| (2) enum-of-class-literals reflection (`ApiType` × 202) | **PASS** — needs a 40-line policy file, then works |
| (3) coroutines — does a blocking wait resume? | **PASS** — `Object.wait()` suspended and resumed under WASM GC |
| (4) artifact size | measured for a partial link only: **712,640 B** raw / **244,096 B** gzip -9 |
| (5) cold-start time | measured for the same partial link: **42.9 ms** total in Node v24 |

(4) and (5) are honest but partial: they are for a program that links the whole
ability-dispatch layer but never constructs a `Game`. There is no full-engine
number, because there is no full-engine artifact.

Everything below is reproducible from `scripts/spike/`. Nothing under `forge/`
was modified; the proof is at the bottom.

---

## Reproducing it

```sh
scripts/spike/run.sh bootstrap        # Maven + a JDK under ~/.local, no sudo
scripts/spike/run.sh copy-forge       # copy the vendored clone to ~/.cache
scripts/spike/run.sh build-forge      # stock mvn install of forge-core, forge-game
scripts/spike/run.sh gen-controller   # regenerate the 109-method PlayerController stub
scripts/spike/run.sh jvm              # JVM baseline: PASS
scripts/spike/run.sh wasm             # WASM GC: link errors, no artifact
scripts/spike/run.sh wasm spike.Probe           # reflection probe: PASS
scripts/spike/run.sh wasm spike.CoroutineProbe  # coroutine probe: PASS
scripts/spike/run.sh verify-pristine
```

The overlay lives entirely in `scripts/spike/teavm/`: a standalone Maven project
that consumes `forge-core` and `forge-game` as ordinary artifacts, excludes
`io.sentry:sentry` and `org.tinylog:tinylog-impl`, and shadows the two Sentry
classes with stubs. No patch is ever applied to `forge/`.

---

## Step 1 — Maven, user-local

`mvn` was absent and upstream Forge ships no `mvnw`, only `.mvn/maven.config`.
Installed Apache Maven **3.9.16** from the Apache mirror to
`~/.local/opt/apache-maven-3.9.16`, symlinked at `~/.local/bin/mvn`, SHA-512
verified. No sudo, no system packages (D14).

Note for anyone repeating this: `dlcdn.apache.org` only carries the two current
releases. 3.9.11 (named in earlier planning) is **404**; 3.9.16 and 3.10.0-rc-1
are what is actually there.

## Step 2 — the stock build, and the JDK that wasn't there

First attempt, exit **1** in 18 s:

```
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.8.1:compile
(default-compile) on project forge-core: Fatal error compiling: error: release version 17 not supported
```

**This is not a Forge problem and not a Maven problem.** hokon has
`openjdk-21-jre` / `openjdk-21-jre-headless` and **no JDK**:

```
$ ls /usr/lib/jvm/java-21-openjdk-amd64/bin/
java  jpackage  keytool  rmiregistry          # no javac
$ ls /usr/lib/jvm/java-21-openjdk-amd64/lib/ct.sym
ls: cannot access ...: No such file or directory
```

The `jdk.compiler` module *is* in the JRE image, which is why the compiler
plugin started at all — but `--release N` reads historical API data from
`lib/ct.sym`, which only the JDK ships. Hence the misleading message.

**Judgement call:** D14 sanctions a user-local Maven under `~/.local` with no
sudo. A JDK is the same class of action and nothing in this lane is possible
without one, so Temurin 21.0.12.1 went to `~/.local/opt/jdk-21.0.12.1+1` the
same way. No system package was touched. Flagging it because the brief named
only Maven.

With that:

```
$ mvn install -pl forge-core,forge-game -am -DskipTests
[INFO] Forge Parent ... SUCCESS [  0.589 s]
[INFO] Forge Core ..... SUCCESS [  3.411 s]
[INFO] Forge Game ..... SUCCESS [  9.031 s]
[INFO] BUILD SUCCESS
[INFO] Total time:  13.185 s
```

exit **0**. Wall clock: **13.2 s** with a warm `~/.m2`; **27 s** measured
against an empty local repository (`-Dmaven.repo.local=…/m2cold`), downloads
included. Copying the 811 MB clone took 2.7 s.

### One thing downstream consumers hit

Forge uses `${revision}` CI-friendly versioning **without**
`flatten-maven-plugin`, so the POMs it installs name their parent literally:

```xml
<parent><artifactId>forge</artifactId><groupId>forge</groupId><version>${revision}</version></parent>
```

Any project depending on `forge:forge-core` therefore fails with
`Could not find artifact forge:forge:pom:${revision}`. `run.sh build-forge`
shims the local repository instead of patching `forge/`. Worth an upstream PR
eventually; it costs nothing to fix there.

## Step 3 — the overlay, not a patch

`forge-game` calls Sentry from 10 engine files (`GameAction`, `AbilityFactory`,
`AbilityUtils`, `Card`, `CardState`, `CardFactoryUtil`, `CardCopyService`,
`KeywordInstance`, `TriggerHandler`, `ManaEffect`). The surface is five members:
`new Breadcrumb(String)`, `Breadcrumb.setData`, `Sentry.addBreadcrumb`,
`Sentry.setExtra`, `Sentry.removeExtra`.

`io.sentry:sentry` is excluded in the overlay's POM and shadowed by
`scripts/spike/teavm/src/main/java/io/sentry/{Sentry,Breadcrumb}.java`. Only the
five used members are declared, so an unexpected call fails to compile rather
than silently no-opping. `forge/` stays stock (D2).

## Step 4a — JVM baseline first

The interaction had to be one that needs **no player input**, because the only
concrete `PlayerController`s live in `forge-ai` and `forge-gui`, which this
spike deliberately does not link. `SpikePlayerController` is generated from
reflection over the 109 abstract methods and throws on every one; reaching it at
all is a failure that names the decision.

Chosen interaction: **Glorious Anthem + Grizzly Bears**. Bears is a printed 2/2;
the Anthem is a static "creatures you control get +1/+1". Neither is hardcoded
in Java — both are text files under `res/cardsfolder`, parsed by `forge-core`,
and the buff is applied by `forge-game`'s continuous-effect layer system when
`GameAction.checkStateEffects` runs.

```
$ scripts/spike/run.sh jvm
[spike] card data loaded in 1595 ms
[spike] cards in db: 95746
[spike] game constructed, players: 2, life: 20
[spike] Grizzly Bears alone:            2/2
[spike] Grizzly Bears + Glorious Anthem: 3/3
[spike] RESULT: PASS (expected 3/3 after the anthem's static ability applied)
```

exit **0**. (It also prints `LOGGER WARN: No logging framework implementation
found in classpath` — the overlay excludes `tinylog-impl`, see below. Harmless.)

So **`forge-core` + `forge-game` alone are a complete, runnable
rules engine** — 33,752 card scripts, 95,746 printings, in 1.6 s, with no
`forge-gui` and no `forge-ai`. That is a useful finding in its own right for
PR-4's headless server, independent of the browser question.

Three globals must be initialised first or the engine NPEs:
`Localizer.getInstance().initialize`, `Lang.createInstance`, and
`ImageKeys.initializeDirs` (empty paths — we never touch card images).

## Step 4b — WASM GC

### (2) The enum-of-class-literals pattern: PASS

The first WASM run of `spike.Probe` linked and then died at runtime:

```
JavaError: No default constructor found in class forge.game.ability.effects.AbandonEffect
```

TeaVM's DCE **does** follow the class literals — the classes were linked. What
was missing is reflection *metadata*: `ApiType`'s constructor calls
`ReflectionUtil.makeDefaultInstanceOf`, i.e. `getConstructor().newInstance()`,
and TeaVM only keeps members a `ReflectionPolicy` declares.

TeaVM 0.15 has a declarative SPI for exactly this. Forty lines
(`spike/ForgeReflectionPolicy.java` plus a `META-INF/services` entry) covering
the four reflective dispatch tables:

| Package | Table | Reflective call |
| --- | --- | --- |
| `forge.game.ability.effects` | `ApiType` (202) | `getConstructor().newInstance()` |
| `forge.game.keyword` | `Keyword` | `getConstructor().newInstance()` |
| `forge.game.replacement` | `ReplacementType` (40) | `getDeclaredConstructors()` |
| `forge.game.trigger` | `TriggerType` (148) | `getDeclaredConstructors()` |

Then, under Node v24:

```
$ scripts/spike/run.sh wasm spike.Probe
ApiType constants:         202
TriggerType constants:     148
ReplacementType constants: 40
DealDamage effect class:   forge.game.ability.effects.DamageDealEffect
smartValueOf("dealdamage"): DealDamage
[runner] cold start total: 42.9 ms
```

Byte-identical to the JVM run. **The pattern `WASM_AND_PORTING.md` §2 called the
usual port-killer is a solved problem here** — 1055 classes / 9790 methods,
712,640 B raw, 244,096 B gzip -9, 42.9 ms cold start (0.8 ms runtime import,
39.1 ms compile+instantiate, 3.0 ms `main`).

One correction to `WASM_AND_PORTING.md`: `ApiType` has **202** constants, not
206.

### (3) Coroutines: PASS

The property the whole iframe idea rests on. `spike.CoroutineProbe` reproduces
Forge's `sendAndWait` shape with nothing but `java.lang`: a worker thread, a
monitor, `Object.wait()` on one side and `notifyAll()` on the other, with a
`Thread.sleep(50)` to force the wait to be entered first.

```
$ scripts/spike/run.sh wasm spike.CoroutineProbe
[coroutine] main thread: main
[coroutine] main blocks in Object.wait()
[runner] main() returned in : 1.0 ms          <-- the fiber suspended
[coroutine] worker set the answer and notifies
[coroutine] main resumed after 52 ms, answer=reply-from-worker
[coroutine] worker joined
[coroutine] RESULT: PASS (a blocking wait was entered and resumed)
```

exit **0**; the JVM run of the same class prints the same thing (51 ms). Note
the ordering: `main()` *returned to the host in 1 ms* while the Java `main`
thread was still parked in `wait()`. That is the continuation-passing transform
doing its job on the WASM GC backend, and it is why `run-wasm.mjs` sets
`process.exitCode` instead of calling `process.exit` — exiting when `main()`
returns kills the program mid-suspend.

So TeaVM 0.13+'s coroutine claim holds, and Forge's blocking game thread is
**not** the blocker.

### (1) Classlib coverage: FAIL — this is what kills it

`spike.SpikeMain`, the class that passes on the JVM:

```
$ scripts/spike/run.sh wasm
[ERROR] Method com.google.common.cache.LocalCache$Segment.isHeldByCurrentThread()Z was not found
    at com.google.common.cache.LocalCache$Segment.runUnlockedCleanup(LocalCache.java:3415)
    ...
    at com.google.common.eventbus.EventBus.post(EventBus.java:265)
    at forge.game.Game.fireEvent(Game.java:1020)
    at forge.game.phase.PhaseHandler.devModeSet(PhaseHandler.java:1214)
    at spike.SpikeMain.newGame(SpikeMain.java:106)
[ERROR] Failed to execute goal org.teavm:teavm-maven-plugin:0.15.0:compile: Build error
```

exit **1**. `-Dspike.stopOnErrors=false` does not help: the log says
`Output file built with errors` and **no file is written**. There is no
degraded-mode artifact to run.

36 distinct missing APIs initially; excluding `tinylog-impl` (whose writers are
registered by `ServiceLoader`, so TeaVM links every one of them including
`JdbcWriter` → `java.sql`) drops it to **30**:

**Group 1 — Guava `EventBus` / `LocalCache` (7).** `java.util.concurrent.locks.ReentrantLock`
(`LocalCache$Segment` *extends* it), its `lock`/`unlock`/`tryLock`/`isHeldByCurrentThread`,
`ConcurrentLinkedQueue`, `CopyOnWriteArraySet`, `AtomicReferenceArray`,
`ListenableFuture`/`java.util.concurrent.Future`.
Entry point: `forge.game.Game.fireEvent` — every game event.

**Group 2 — tinylog-api, still reachable after dropping the impl (8).**
`ReentrantReadWriteLock`, `ReadWriteLock`, `ClassLoader.getResources`,
`ManagementFactory`, `ProcessHandle`, `sun.reflect.Reflection`,
`android.os.Process`, `dalvik.system.VMStack`.
Entry point: `forge.game.Game.<clinit>` → `org.tinylog.Logger.<clinit>`. Note
`android.os.Process` and `dalvik.system.VMStack` are tinylog's Android dialect,
not Guava's android flavour.

**Group 3 — Forge's own `java.util.concurrent` (3).** `Executors` and
`ThreadFactory` (`forge.util.ThreadUtil.<clinit>`, reached from
`CardStorageReader`), `ConcurrentSkipListMap` (`StaticData`).

**Group 4 — plain JDK holes in TeaVM (6).** `java.util.StringJoiner`
(commons-lang3 `EnumUtils` → `CardType$CoreType.<clinit>`),
`Collections.emptyNavigableMap`, `Collections.unmodifiableSortedSet`
(`Card`, `CardFactory`, `KeywordCollection`), `Normalizer$Form.NFKD`
(commons-lang3 `stripAccents` → `CardStorageReader`),
`Package.getImplementationVersion` (`forge.util.BuildInfo`),
`Constructor.canAccess` (jgrapht `SupplierUtil` →
`GameAction.findStaticAbilityToApply` — the static-ability layer system itself).

**Group 5 — I/O and class loading (2).** `File.toPath` (`CardStorageReader`),
`java.net.URLClassLoader` (`forge.util.Localizer`, which resolves `.properties`
bundles through a `URLClassLoader` over a directory).

The centre of gravity is `java.util.concurrent`. TeaVM 0.15's classlib ships
**14** public types in that package — `ArrayBlockingQueue`, `BlockingQueue`,
`Callable`, `CancellationException`, `ConcurrentHashMap`, `ConcurrentMap`,
`CopyOnWriteArrayList`, `ExecutionException`, `Executor`, `Flow`,
`LinkedBlockingDeque`, `Map.Entry`, `ThreadLocalRandom`, `TimeUnit` — and
**zero classes in `java.util.concurrent.locks`**. No `ExecutorService`, no
`FutureTask`, no `Future`. (`FutureTask` matters beyond this spike: it is what
Forge's `ReplyPool` parks on.)

### Not a WASM problem — a classlib problem

Same overlay, `-Dspike.targetType=JAVASCRIPT`: **29 of the same 30**, and again
`Output file built with errors` with no artifact. The one that differs is a
diagnostic wording, not a capability
(`ListenableFuture implements java.util.concurrent.Future, which is missing`).
Both backends share `teavm-classlib`. Choosing JS over WASM GC changes nothing
about this verdict.

---

## What a GO would require

The failure is narrow, which is the one piece of good news. Direct Guava
`EventBus` use in `forge-core` + `forge-game` is **3 files out of 961**
(`Game`, `Match`, `GameLogFormatter`); direct `java.util.concurrent` use is
**9 files**; there is no `CacheBuilder` use in Forge at all — the `LocalCache`
that fails is Guava's own, inside `EventBus`.

So a GO needs, roughly:

1. **TeaVM to grow `java.util.concurrent.locks`**, or Guava's `EventBus`
   replaced in the fork with a plain listener list. Groups 1 and part of 2.
2. **Forge's logging facade swapped** off tinylog, or a TeaVM class substitution
   for `org.tinylog.Logger`. Group 2.
3. **`ThreadUtil` and `StaticData` de-threaded** for the browser build. Group 3.
4. **Six small classlib additions upstream in TeaVM.** Group 4 — `StringJoiner`
   and two `Collections` methods are trivial; `Constructor.canAccess` sits under
   jgrapht, which the layer system uses.
5. **`Localizer` rewritten** off `URLClassLoader`, and a story for card-script
   I/O. Group 5.

And a caveat that matters more than the list: **fixing all 30 only gets you to
the next link error.** TeaVM reports what its reachability analysis touches, and
this program touches one static ability on two cards. A real client exercises
far more of the engine, plus 103k lines of `forge-gui-mobile` and `gdx-teavm`
on top. The 30 is a floor, not an estimate.

Given that, and that P4-as-React is a known quantity, **the recommendation is to
proceed with P4 and revisit if TeaVM ships `java.util.concurrent.locks`.**

## What was NOT verified

- **Whether `java.io.File` works at all under WASM GC.** TeaVM has a `File`
  class (only `toPath` is missing), but no artifact could be produced, so
  nothing exercised a filesystem. Card-script loading in a browser is untested
  and remains an open risk — see also `res/cardsfolder` being 132 MB raw /
  5.6 MB gzip per `WASM_AND_PORTING.md`.
- **A full-engine artifact size or cold-start time.** Not measurable; TeaVM
  writes no file on link errors. The commands that would produce them are
  `scripts/spike/run.sh wasm` and `node scripts/spike/run-wasm.mjs …`, and they
  are exactly what fails.
- **`gdx-teavm` on `forge-gui-mobile`** (step 4 of the plan's spike). Not
  reached — step 3 gates it.
- **CheerpJ.** Out of scope for this lane.
- **`forge-ai`.** Not linked; the spike is `forge-core` + `forge-game` only, as
  the brief specifies.

## `forge/` is unmodified

```
$ git -C /home/hadoku/repos/hadoku-cardtable/forge status --porcelain
$ echo $?
0
$ git -C /home/hadoku/repos/hadoku-cardtable/forge log -1 --format='%H %s'
2cd497cfbeb6df4e2a013c916aaab9de5ecf9795 Merge pull request #11849 from tjtillman/master
```

Empty porcelain output. Every build ran against `~/.cache/w1-spike/forge`, a
`cp -a` of the clone; the overlay's Maven build directory is
`~/.cache/w1-spike/teavm-spike-target`, also outside the repo, so no `target/`
tree appears in anyone's `git status`.

## Toolchain, for the record

| | |
| --- | --- |
| Maven | 3.9.16, `~/.local/opt/apache-maven-3.9.16` |
| JDK | Temurin 21.0.12.1+1, `~/.local/opt/jdk-21.0.12.1+1` |
| TeaVM | 0.15.0 (latest on Central; 0.13.0 is the coroutine release) |
| Node | v24.18.0 (WasmGC on by default) |
| Forge | `2cd497cf`, `2.0.15-SNAPSHOT` |
