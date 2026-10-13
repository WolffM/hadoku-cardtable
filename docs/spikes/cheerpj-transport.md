# Forge's client transport, over a browser WebSocket, under CheerpJ

**Verdict: it works, end to end, and the seam it needed is the one this repo
already planned to cut.**

A real `FGameClient` running inside CheerpJ 4.3 completed a protocol round trip
over a browser `WebSocket`, speaking `@hadoku/forge-wire`'s JSON envelope
instead of Forge's Java-serialised one — 25 frames out, 25 frames in, every one
of them validated at the other end by the package's own Zod schemas. Netty
never loads on that branch, so the `UnsatisfiedLinkError:
Java_sun_nio_ch_EPoll_create` that killed Wave 14's client never happens.

Wave 15 lane A. Measured 2026-09-20 on the host, `/proc/loadavg` 7.4–8.6 with three
other lanes running.

The one thing that did **not** survive the crossing is
`java.lang.reflect.Proxy`, and that is the finding in here most likely to cost
somebody a day later — see "Proxy does not work" below.

---

## Reproduce

From the repo root. `export`, not `VAR=x cmd1 && cmd2`: that form sets the
variable for `cmd1` only and has already made a Playwright run in this repo
*skip* its test and exit 0.

```sh
export SPIKE_CACHE=$HOME/.cache/w15a-transport   # NOT the shared w14b cache
export PORT=8741                                 # NOT the shared 8731

./scripts/spike/cheerpj/transport/run.sh patch-check   # exit 0 = applies clean
./scripts/spike/cheerpj/transport/run.sh build
./scripts/spike/cheerpj/transport/run.sh measure       # exit 0 = every check green
```

`measure` prints one JSON object. `"pass": true` and an exit status of 0 mean
all 14 checks held; `failed` names any that did not. The cache and the port are
this lane's own because three lanes drove the same harness concurrently this
wave.

`run.sh all` is the three in order.

## What came out and what came back

The `PROBE`/`TRANSPORT` lines below are Java's own `System.out`, relayed to the
page console and stamped with `performance.now()`. Trimmed to the frames; the
full transcript is what `measure.mjs` prints.

```
6133ms PROBE START build=20260920T070332Z-df08fcd15928
6979ms PROBE OPEN PASS modelledMethods=14
7002ms PROBE THREAD PASS (background pump started)

8784ms TRANSPORT OUT {"kind":"act","method":"selectButtonOk"}
8811ms TRANSPORT IN kind=notify method=message
8926ms PROBE GUI message(w15a-nonce:7afb1637d261771f, w15a)

8970ms TRANSPORT OUT {"kind":"act","method":"useMana","color":3}
8979ms TRANSPORT IN kind=ask method=showConfirmDialog
8980ms PROBE GUI showConfirmDialog(first ask, w15a, Yes, No, true)
8983ms TRANSPORT OUT {"kind":"reply","callId":"w15a-c1","method":"showConfirmDialog","result":true}
8988ms TRANSPORT IN kind=ask method=showConfirmDialog
8991ms PROBE GUI showConfirmDialog(second ask, w15a, Yes, No, false)
8995ms TRANSPORT OUT {"kind":"reply","callId":"w15a-c2","method":"showConfirmDialog","result":false}

9012ms TRANSPORT IN kind=notify method=showPromptMessage
9021ms TRANSPORT REFUSE-IN method=showPromptMessage reason=tier-B-or-C-not-modelled-in-this-spike
9023ms TRANSPORT IN kind=notify method=finishGame
9025ms PROBE GUI finishGame()

9472ms PROBE SAW returned=null in 6ms
9476ms TRANSPORT OUT {"kind":"act","method":"concede"}
11037ms PROBE COUNTS framesOut=25 framesIn=25 refusedOut=0 refusedIn=1
11037ms PROBE DONE
```

Every arrow there is a real `ProtocolMethod` travelling Forge's own call path:

- **out** — `IGameController.selectButtonOk()` →
  `GameProtocolSender.send(ProtocolMethod.selectButtonOk)` →
  `GuiGameEvent` → `IToServer.send(NetEvent)` → the bridge → the socket.
- **in** — the socket → the bridge → `ProtocolMethod.message.getMethod()` →
  `IGuiGame.message(String, String)`.
- **ask/reply** — an inbound `ask` becomes a `GuiGameEvent`, the answer becomes
  a `ReplyEvent`, and `send` turns that into the envelope's `reply` frame. The
  ask/reply half reuses Forge's shape rather than inventing one.

## Why "it passed" is not the same as "it measured something"

This repo has shipped a harness that passed while measuring nothing six times,
so the checks are built around the specific ways this one could have.

| check | the wrong-pass it exists to catch |
| --- | --- |
| `build` | the class that answered was compiled by *this* build. A build id is generated at build time, compiled **into** the jar, and compared against the id `run.sh` wrote next to it. A jar mtime does not prove which class answered; this does. |
| `nonce` | the bytes Java printed are the bytes *this server process* minted. The server mints a fresh 8-byte nonce per run and `measure.mjs` compares what Java printed against what `/__verdict` reports. A bridge echoing its own request fails this. |
| `distinctReplies` | the reply carries the ask's payload. Two `showConfirmDialog` asks are sent with `defaultYes` true and false; the stub returns the ask's own `defaultYes`, so a hard-coded reply cannot pass. |
| `refusedTierB` | an unmodelled frame is declined **by name**, not silently eaten. A legal Tier B `showPromptMessage` goes down the wire and must produce `REFUSE-IN`. |
| `serverVerdict` | every inbound frame passed `@hadoku/forge-wire`'s own `parseClientFrame`, and every outbound one `parseServerFrame`. The spike server imports the real package (Node 24 strips the TypeScript) rather than checking shapes by hand, so "it speaks forge-wire" is a check and not a claim. |

### The harness was shown to fail

Three negative controls, each expected to turn exactly one check red:

```sh
W15A_MUTATE=nonce         ./scripts/spike/cheerpj/transport/run.sh measure  # exit 1
W15A_MUTATE=same-defaults ./scripts/spike/cheerpj/transport/run.sh measure  # exit 1
W15A_FAKE_BUILD_ID=stale  ./scripts/spike/cheerpj/transport/run.sh measure  # exit 1
```

| control | exit | `failed` |
| --- | --- | --- |
| *(none)* | 0 | `[]` |
| `W15A_MUTATE=nonce` | 1 | `['nonce']` |
| `W15A_MUTATE=same-defaults` | 1 | `['distinctReplies', 'serverVerdict']` |
| `W15A_FAKE_BUILD_ID=stale-on-purpose` | 1 | `['build']` |

`same-defaults` reds two because the server records the mismatch as a failure of
its own as well; that is correct, not a leak.

## The fork change

`scripts/spike/cheerpj/transport/forge-patch/0001-browser-transport.patch`
(574 lines, `sha256:4437a21f0636518a…`), applied with `patch -p1` to a **fresh
copy** of `forge-gui/src/main/java/forge/gamemodes/net/client/` in
`$SPIKE_CACHE`. Nothing is written inside `forge/` (D2).

Two files:

- **`BrowserTransport.java`** (new, ~490 lines) — one class implementing
  `IToServer`'s three methods (`send`, `sendAndWait`, `write`), the three
  natives, the JSON codec for Tier A's 14 methods, and the inbound pump.
- **`FGameClient.java`** (5 hunks, ~30 lines) — `connect()` takes a browser
  branch when `-Dforge.net.browserTransport=<ws url>` is set; `send`,
  `sendAndWait` and `close` delegate to the bridge when it exists; a
  `getBrowserTransport()` accessor for the spike's own driving.

**The protocol is not forked.** `ProtocolMethod`, `GuiGameEvent`, `ReplyEvent`,
`GameProtocolSender` and `NetGameController` are untouched and are what the
round trip actually runs on. Only the wire under them changed.

`patch-check` applies the patch to a copy that has never been patched, so
"reapplies cleanly" is a property of the patch and not of a directory that
happened to be in the right state:

```
$ export SPIKE_CACHE=$HOME/.cache/w15a-transport
$ ./scripts/spike/cheerpj/transport/run.sh patch-check; echo $?
checking file forge-gui/src/main/java/forge/gamemodes/net/client/BrowserTransport.java
checking file forge-gui/src/main/java/forge/gamemodes/net/client/FGameClient.java
0
```

### The build shadows the fat jar, it does not rebuild Forge

`run.sh build` compiles only the two patched files (plus the spike's own
classes) against `~/.local/share/cardtable/forge.jar` and jars them into
`transport.jar`, which is put **first** on CheerpJ's classpath:

```js
cheerpjRunMain('spike.TransportProbe', '/app/transport.jar:/app/forge.jar')
```

That takes about two seconds instead of a full Maven build, and it is
self-proving: if CheerpJ ignored classpath order the stock `FGameClient` would
load and the probe would die on `NoSuchMethodError` for `getBrowserTransport()`.
It does not. Nothing was built in `forge/` and Maven was never invoked.

## The native shape, and why it is not negotiable

Three statics, bound through `cheerpjInit({natives: {...}})`:

```java
private static native int  wsOpen(String url);      // blocks until open; 0 = ok
private static native void wsSend(byte[] frameUtf8);
private static native int  wsRecvLength();          // 0 = nothing yet, -1 = closed
private static native void wsRecvInto(byte[] buf);
```

Inbound is length-then-fill because Wave 14 measured that a native returning a
*freshly built* array throws `ArrayIndexOutOfBoundsException` on the Java side
after the JS side has already run correctly (`docs/spikes/cheerpj.md`, the
SETTLED section). A native may only fill an array the caller handed it. Nothing
in this lane contradicts that, and nothing here should be "tidied" into a
`byte[] recv()`.

`wsRecvLength` **awaits** rather than spinning — up to 100 ms, polling the
inbox every 1 ms — which is the same Java-blocks-on-a-JS-Promise behaviour the
ASYNC probe settled. It does not dequeue; `wsRecvInto` does.

## Findings

### 1. `java.lang.reflect.Proxy` does not work under CheerpJ

```
PROBE PROXY FAIL java.lang.InternalError: java.lang.ExceptionInInitializerError
                 <- java.lang.ExceptionInInitializerError: null
                 <- java.lang.NullPointerException: null
```

`Proxy.newProxyInstance` generates a class at runtime. CheerpJ is an AOT
compiler with no bytecode generator behind it, so the proxy class's static
initialiser dies before any of our code runs. Reproducible on every run; the
step is kept in the probe as a measurement rather than deleted.

This lane's `IGuiGame` stub was a `Proxy` and had to become a concrete
generated class (`StubGuiGame.java`, 87 methods). The consequence is general:
**anything in the eventual browser client that reaches for a dynamic proxy has
to be replaced by a concrete class**, including any mocking or interception
library that does the same thing. The probe reports it, not gates on it, so a
future CheerpJ that supports it will show up as `proxySupported: true` rather
than as a mysteriously green run.

### 2. Background Java threads DO work

`PROBE THREAD PASS` — `new Thread(...).start()` ran the inbound pump for the
whole session while `main` drove the protocol, and the two never deadlocked.
That matters more than it looks: Forge's `sendAndWait` parks on an untimed
`ReplyPool.get()`, so without a working pump thread every blocking call would
have nobody left alive to deliver its answer. The bridge also supports inline
pumping (`pumpFor(ms)`) for a caller with no thread, and the probe uses whichever
`startPump()` reports.

### 3. There is no client→server ask on this wire, and one Forge method wants one

`getActivateDescription(CardView) -> String` is the **only** `Mode.CLIENT`
`ProtocolMethod` with a return value (`ProtocolMethod.java:95`), and it breaks
Forge's own stated rule four lines above it. `@hadoku/forge-wire` does not model
it — it is not one of the 38.

`BrowserTransport.sendAndWait` therefore sends nothing and returns `null`
immediately, logging why. Measured: `PROBE SAW returned=null in 6ms`. The
alternative — parking on `ReplyPool.get()` for an answer the wire cannot carry —
would hang a Forge thread forever.

**Forge already treats this call as a mistake on a netplay client.** There are
exactly two call sites:

- `PlayArea.java:839-846` (desktop) — a right-click on a stacked card badge.
  A `null` there is already handled: it calls `flashIncorrectAction()` and
  returns. So the browser client degrades to "that right-click does nothing",
  not to a crash.
- `VCardDisplayArea.java:217-224` (mobile) — guarded by
  `if (!GuiBase.isNetPlay(...))` with the comment *"causes lag on netplay client
  side"*, and falls back to a static label. The libGDX port already refuses to
  make this round trip.

So returning `null` is the behaviour Forge's own mobile client chose, arrived at
independently. If the real browser client wants the description, the options are
to teach the wire a client→server ask or to answer it locally — and lane C
should know the wire currently has no frame for it.

### 4. The browser branch never sends `LoginEvent`

Forge's netty client logs in from `GameClientHandler.channelActive`
(`GameClientHandler.java`, bottom) — a pipeline callback that does not exist on
this branch. Measured: `refusedOut=0`, i.e. the bridge was never even *asked* to
send one. So identity for a browser client comes from the room layer and the
friend gate, not from Forge's lobby handshake. Same for `HeartbeatEvent` and the
`IdleStateHandler` that drives it: no heartbeats on this branch at all.

Both are refused **by name** if anything ever does hand them to `send`, rather
than being dropped.

### 5. Transport round-trip latency: ~6 ms median, from Java

Four runs of 20 iterations each, `act requestResync` → `notify clearSelectables`
(the cheapest legal frame in each direction, so what is timed is the bridge and
not a codec), measured with `System.nanoTime()` on the Java side:

| run | median | min | max | `/proc/loadavg` |
| --- | --- | --- | --- | --- |
| 1 | 11.2 ms | 8.6 ms | 99.6 ms | 7.8 |
| 2 | 7.7 ms | 5.8 ms | 90.4 ms | 7.4 |
| 3 | 6.3 ms | 5.0 ms | 85.7 ms | 7.4 |
| 4 | 6.1 ms | 5.2 ms | 87.0 ms | 8.6 |

The path is Java → JS native → browser socket → node → back. The max in every
run is the **first** iteration and is warm-up, not steady state.

**Read this as a floor and nothing else.** It is not comparable to streaming's
65 ms click-to-pixel: there is no input event, no rendering and no paint in it,
and lane D owns the number that answers the wave's question. Both ends poll, so
about 2 ms of it is granularity. The host was carrying three other lanes
throughout.

---

## What was NOT verified

- **Tier B and Tier C are not marshalled at all.** 14 of the 38 methods have a
  codec; the other 24 — every entity reference, and the whole `applyDelta`
  state channel — are refused by name. **That is where the real work is**, and
  nothing here says how hard it will be. Tier C in particular carries
  `DeltaPacket`, and this lane has no evidence about what turning one back into
  Forge's `TrackableObject` graph costs.
- **No `GameView` ever existed.** `GameClientHandler.beforeCall` builds the
  client's `Tracker` on the first `setGameView` and rewrites `CardView`
  identities against it. The bridge bypasses `GameClientHandler` entirely and
  invokes `IGuiGame` directly, so **none of that tracker machinery ran**. A real
  client cannot bypass it, and whether it survives CheerpJ is unmeasured.
- **The `IGuiGame` on the other end was a stub that only records.** Forge's real
  GUI never ran; nothing painted. Lanes B and D own that.
- **`FThreads.invokeInEdtNowOrLater` was never used.** `GameProtocolHandler`
  dispatches protocol calls onto the EDT (or a background thread) and this lane
  invokes inline on the pump thread instead. Whether Forge's EDT dispatch works
  under CheerpJ is untested, and it sits directly between this transport and any
  real UI.
- **The `abort` frame is written but never exercised.** `BrowserTransport.abort`
  can emit the envelope's `{kind:'abort'}`, and no test sends one. The hazard it
  answers is real — `ReplyPool.get()` is untimed — and the bridge does **not**
  yet arm a timeout on the 15 blocking methods. That is a gap, not an oversight
  in the doc.
- **No reconnection, no backpressure, no close handling beyond `recvLength()`
  returning -1.** A socket that drops mid-game was never tested.
- **Frames are capped at 65,535 bytes** by the spike's hand-rolled RFC6455
  encoder, and fragmented frames close the socket on purpose. The largest frame
  in this run was 161 B. A Tier C `applyDelta` packet will be far larger and
  **will** exceed both limits; the browser's own `WebSocket` has no such
  constraint, but the spike server does.
- **One browser only** — the Playwright Chromium in this repo's pnpm store,
  `playwright-core@1.62.1`, headless. No Firefox, no Safari, no mobile.
- **Nothing was measured on a quiet host.** `/proc/loadavg` was 7.4–8.6
  throughout with three other lanes running.
- **The patch has never been applied to a real Forge *build*.** It compiles
  against the shipped fat jar and is loaded by classpath shadowing. Whether
  `mvn` builds it inside the fork is unverified, and that is the thing that
  matters the day `WolffM/forge` exists. Settle it with
  `scripts/spike/run.sh build-forge` after applying the patch to a copy — and
  read Maven's own `BUILD SUCCESS` line, not the wrapper's exit code (trap 7).
- **`sendAndWait` returning `null` was never seen by real Forge code.** The
  probe called `getActivateDescription` directly; no Forge UI consumed the
  `null`. `PlayArea.java:842` already handles a null there, but that was read,
  not run.
- **Whether JS can allocate a Java array under CheerpJ** — still open from Wave
  14. If it can, `recvLength`/`recvInto` collapses into one call. Not needed.

## `forge/` is unmodified

```
$ git submodule status forge
-2ad70eb447a22efe5b80904c07188311da034a42 forge
$ git -C ~/repos/hadoku-cardtable submodule status forge
 2ad70eb447a22efe5b80904c07188311da034a42 forge (heads/master-2-g2ad70eb447a)
$ git -C ~/repos/hadoku-cardtable status --porcelain forge
$ echo $?
0
```

The leading `-` in the worktree is correct: the submodule is deliberately
uninitialised there. Every Forge source this lane patched was **read** from the
main checkout's initialised copy, copied into `$SPIKE_CACHE`, and patched there.
No `git submodule` command of any kind was run.

## Toolchain, for the record

| | |
| --- | --- |
| CheerpJ | 4.3, `https://cjrtnc.leaningtech.com/4.3/loader.js` |
| JDK (compilation) | Temurin 21.0.12.1+1, `~/.local/opt/jdk-21.0.12.1+1`, `--release 17` → class-file major **61** |
| Node | v24.18.0 — imports `packages/forge-wire/src/index.ts` directly, no build step, no new dependency |
| Browser | Playwright `chromium`, `playwright-core@1.62.1` from the repo's pnpm store, headless |
| Forge jar | `~/.local/share/cardtable/forge.jar`, 39,686,151 B |
| JSON | Gson, already inside that fat jar (`com/google/gson/Gson.class`) |
| Forge submodule | `2ad70eb447a22efe5b80904c07188311da034a42` |
| Cache / port | `~/.cache/w15a-transport`, `8741` — this lane's own |
