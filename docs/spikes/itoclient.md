# PR-4 spike 2 — the bridge at `IToClient`

Wave 6, lane F. Follows `docs/spikes/headless-server.md` (Wave 3, which proved
Forge runs headless and measured the protocol surface) and
`docs/spikes/teavm-go-no-go.md` (Wave 1, which settled D7 NO-GO).

Everything here is an **overlay** under `scripts/spike/itoclient/`. No Java was
written into `forge/`, and the vendored tree is byte-for-byte pristine
afterwards — see the last section.

## What this settles

| # | Question | Answer |
| --- | --- | --- |
| 1 | Can a real `IToClient` call cross a real socket, headless? | **Yes.** Done, both directions, exit 0. Output below |
| 2 | Is `IToClient` a substitutable seam today? | **No — it is a seam in name only.** `IToClient` is consumed by **0** files. Measured below |
| 3 | What does a browser client need of the 38 required methods? | Three tiers. **121 of the 214 view properties need no encoder; 13 need a bespoke one** |
| 4 | Is the bridge a week or a month? | **The transport is a week. The browser client is a month, and the month is the React UI, not the wire** |

**The headline correction:** `CLAUDE.md`'s "Maven ✗" line is stale, *and so was
this wave's own premise that the host has no Java compiler.* It has one. See
the next section — that is the only reason item 1 exists.

## The host has a JDK. Two greps disagree, and the wrong one is the obvious one.

The wave brief for this lane stated as a verified fact that `javac` is missing
and that item 1 was therefore blocked on an operator install. It is not.

```console
$ which javac ; echo $?
1
$ ls /usr/lib/jvm/java-21-openjdk-amd64/bin/
java  jpackage  keytool  rmiregistry
$ find /usr/lib/jvm -name javac ; echo $?
0                                   # no output — genuinely not there
$ find "$HOME/.local/opt" -maxdepth 3 -name javac
~/.local/opt/jdk-21.0.12.1+1/bin/javac
$ ~/.local/opt/jdk-21.0.12.1+1/bin/javac -version ; echo $?
javac 21.0.12.1
0
```

The JDK is **Temurin 21.0.12.1, user-local, installed by Wave 1 lane B**
(`9f6f953`) precisely because Debian's `openjdk-21-jre` has no compiler. It is
deliberately *not* on `PATH`, which is why `which javac` says nothing and why
`/usr/lib/jvm` is empty of one. The board already records this — PR-1's row
reads *"JDK user-local install · **done** · B `9f6f953` · `openjdk-21-jre` has
no `javac`; Temurin 21 → `~/.local/opt`. D14 amended"* — and
`scripts/spike/run.sh:40` already resolves it:

```sh
JDK_HOME="${JDK_HOME:-$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1)}"
```

Maven is real too: `~/.local/bin/mvn`, Apache Maven 3.9.16, also
Wave 1 lane B. **`CLAUDE.md`'s "Maven ✗ — the host has no `mvn`" is stale and
should be corrected**; the tracker's own queue already carries that as item 4.

`scripts/spike/itoclient/run.sh` defaults `JAVA_HOME` to the user-local JDK for
exactly this reason, and says so in its header.

## Reproducing it

`FORGE_DIR` must be a **scratch copy** of the Forge checkout, never the
vendored `forge/` — Maven writes `target/` dirs into whatever it builds, and
D2/O1 keep the vendored tree stock. `run.sh` refuses the vendored path outright.

```sh
# one-time: a copy Maven may write into. Wave 1's copy is reused here.
cp -a forge ~/.cache/w1-spike/forge          # 823 MB

export FORGE_DIR=~/.cache/w1-spike/forge
export PATH="$HOME/.local/bin:$PATH"         # for mvn
bash scripts/spike/itoclient/run.sh all      # build + spike + verify-pristine
```

Exit codes read directly with `; echo $?`, never through a pipe:

| Command | Exit | Note |
| --- | --- | --- |
| `mvn -B install -pl forge-gui-desktop -am -DskipTests` | **0** | 23.1–31.3 s warm over two runs. Reactor: Core 2.2 s, Game 3.1 s, AI 5.4 s, Gui 6.0 s, Desktop 13.7 s |
| `run.sh spike` | **0** | 7 of 7 assertions pass |
| `run.sh spike` (mutated, send suppressed) | **1** | 3 of 7 fail — see the mutation test |
| `run.sh all` | **0** | build + spike + verify-pristine in one |
| `FORGE_DIR=./forge run.sh build` | **2** | *"FORGE_DIR is the vendored forge/ tree. Refusing"* |
| `run.sh build` with `FORGE_DIR` unset | **2** | refuses rather than defaulting to the vendored tree |
| `git -C forge status --porcelain` | **0**, no output | pristine |

The two refusals are the load-bearing part: this spike's one way to do real
damage is to let Maven write `target/` into the vendored clone, so the script
will not start without being told where to build, and will not accept that
answer.

### `-DskipTests` still compiles the harness, and that is the whole trick

Wave 3 found the 3,919-line net harness at
`forge-gui-desktop/src/test/java/forge/net/` and nobody had budgeted for it.
(That figure is the **14 top-level files**; counting the `analysis/`
subdirectory too gives **6,456 lines over 18 files**. Both are right, and the
board's 3,919 is the one that matters here — `analysis/` is a log post-processor,
not harness.)
The reason this spike could use it without a test runner is that **`-DskipTests`
skips *running* tests but still *compiles* them** (`-Dmaven.test.skip=true` is
the one that skips compilation). So an ordinary build leaves
`forge-gui-desktop/target/test-classes/forge/net/*.class` on disk.

The four harness classes this spike uses — `TestUtils`, `HeadlessGuiDesktop`,
`HeadlessNetworkGuiGame`, `PortAllocator` — **import neither TestNG nor JUnit**
(`grep -nE '^import (org\.testng|org\.junit)'` over all four: exit 1, no
matches). So the classpath is exactly the fat jar plus `test-classes`, and the
spike is a plain `main()`.

That harness is also where `UPnP=NEVER` gets set
(`TestUtils.java:50`), independently confirming Wave 3's "jUPnP is config, not
code".

## Item 1 — a real `IToClient` call crosses a real socket

`scripts/spike/itoclient/src/IToClientSpike.java`. **Every object on the send
path is production Forge.** The only class the spike supplies is the receiving
`IGuiGame`, which records what arrived:

- `FServerManager.startServer(port)` binds a real Netty `NioServerSocketChannel`
  (`FServerManager.java:228`).
- `FGameClient.connect()` opens a real TCP connection
  (`FGameClient.java:61`) and `GameClientHandler.channelActive` auto-sends the
  `LoginEvent` (`GameClientHandler.java:228`), which is what makes the server
  mint a `RemoteClient` (`FServerManager.java:1069`).
- **`RemoteClient` *is* `IToClient`** — `RemoteClient.java:16`,
  `public final class RemoteClient implements IToClient`.
- `RemoteClientGuiGame` is the stock server-side proxy. Its `message` is
  literally `send(ProtocolMethod.message, message, title)`
  (`RemoteClientGuiGame.java:424-426`), over the `GameProtocolSender` built on
  that `IToClient` (`RemoteClientGuiGame.java:76`).

Actual output, unedited except for card-data noise:

```
=== PR-4 spike 2: one IToClient call across a real socket ===
Read cards: 33752 files in 1 ms (25 parts) using thread pool
13:37:51 [INFO ] TestUtils: [TestConfig] checksum=stable, deltasync=on
harness up in 9987 ms (GuiBase=forge.net.HeadlessGuiDesktop)
13:37:51 [INFO ] FServerManager: Starting Multiplayer Server
server: isHosting=true port=50000 upnpMapped=false
13:37:51 [INFO ] FServerManager$RegisterClientHandler: Client connected to server at /127.0.0.1:58162
13:37:51 [INFO ] GameProtocolHandler: Received: forge.gamemodes.net.event.LoginEvent@711ecd53
connected: username=spike-client slot=1 peer=/127.0.0.1:58162

-- assertion 1: S2C fire-and-forget carries an exact run-time nonce --
13:37:51 [INFO ] GameProtocolHandler: Received: GuiGameEvent 0: message (2 args)
  [PASS] ProtocolMethod.message reached the client GUI
      latch=true
  [PASS] payload is byte-exact
      sent=[itoclient-spike-de8e8f91-8f2e-4882-a555-0e057c09306f] got=[itoclient-spike-de8e8f91-8f2e-4882-a555-0e057c09306f] title=[cardtable-w6]

-- assertion 2: it crossed a socket, not an object reference --
  [PASS] delivered on a different thread than the caller
      caller=[main] receiver=[AWT-EventQueue-0]
  [PASS] server-side peer is a real TCP endpoint on the allocated port
      peer=/127.0.0.1:58162 serverPort=50000
  [PASS] the send side is the IToClient seam
      forge.gamemodes.net.server.IToClient <- forge.gamemodes.net.server.RemoteClient

-- assertion 3: sendAndWait round trip, both answers --
13:37:51 [INFO ] GameProtocolHandler: Received: GuiGameEvent 1: showConfirmDialog (5 args)
13:37:51 [INFO ] FGameClient: Client sent Reply (1): true
13:37:51 [INFO ] GameProtocolHandler: Received: Reply (1): true
  [PASS] showConfirmDialog returned the client's answer (true)
      returned=true expected=true defaultYes-sent=false promptEchoed=true rtt=14ms answeredOn=[AWT-EventQueue-0]
13:37:51 [INFO ] GameProtocolHandler: Received: GuiGameEvent 2: showConfirmDialog (5 args)
13:37:51 [INFO ] FGameClient: Client sent Reply (2): false
13:37:51 [INFO ] GameProtocolHandler: Received: Reply (2): false
  [PASS] showConfirmDialog returned the client's answer (false)
      returned=false expected=false defaultYes-sent=true promptEchoed=true rtt=8ms answeredOn=[AWT-EventQueue-0]

server send errors: 0
=== ALL PASS: 0 failed assertion(s) ===
```

Three things in that output are worth more than the PASS lines:

- **`defaultYes-sent=false` while `returned=true`.** `showConfirmDialog`'s last
  argument is the *default* answer. The spike deliberately sends the **opposite**
  of what the client is rigged to reply, twice, in both directions. A bridge that
  silently returned the default — the failure mode `RemoteClientGuiGame.java:436`
  falls back to when the reply is `null` — would fail both. The value came from
  the client.
- **`rtt=14ms` then `rtt=8ms`.** `sendAndWait` really blocks the calling thread
  (`ReplyPool.get` → `FutureTask.get()`, `ReplyPool.java:33`) until a
  `ReplyEvent` correlated by `GuiGameEvent.id` comes back.
- **`caller=[main] receiver=[AWT-EventQueue-0]`.** See the EDT finding below.

### The mutation test

The repo's rule is that a guard is decorative until you have watched it fail,
and that you assert the mutation diff is non-empty before trusting the run.

Mutation: suppress the send, change nothing else.

```diff
164c164
<         proxy.message(nonce, "cardtable-w6");
---
>         // MUTATION: send suppressed
```

| | Broken | Restored |
| --- | --- | --- |
| `run.sh spike` | **exit 1**, 3 failed / 4 passed | **exit 0**, 0 failed / 7 passed |

The three that fail are exactly the three that depend on the send — *reached the
client GUI*, *payload is byte-exact*, *delivered on a different thread*. The
other four still pass, correctly: the peer address and the seam type do not
depend on that call, and assertion 3 makes its own. **The failure is by name,
not a timeout** — a timeout would have been no evidence at all.

### The client dispatches on the Swing EDT

`GameClientHandler` calls `super(true)` (`GameClientHandler.java:38`), and that
flag is `runInEdt` in `GameProtocolHandler` (`GameProtocolHandler.java:19`). The
run above shows it: the protocol method was invoked on `AWT-EventQueue-0`, even
under `-Djava.awt.headless=true`.

**A browser has no EDT.** This is not a blocker — the flag is a constructor
argument and `GameProtocolHandler.shouldDispatchToGuiThread` is already
`protected` and overridable (`GameProtocolHandler.java:30`) — but it is a real
fact about the receiving side that any bridge has to answer, and it is the kind
of thing that is invisible until something runs.

## Item 2 — `IToClient` is a seam in name only

D9 records `IToClient` as *the* bridge point, and the board's PR-4 row reads
"WS/JSON `IToClient`". The interface is genuinely tiny — it is empty, and its
parent `IRemote` declares three methods (`IRemote.java:6-10`):

```java
void send(NetEvent event);
Object sendAndWait(IdentifiableNetEvent event);
default void write(NetEvent event) { send(event); }
```

**But nothing is typed against it.** Across
`forge-gui/src/main/java/forge/gamemodes/net/`:

```console
$ grep -rn 'IToClient' .
./server/RemoteClient.java:16:public final class RemoteClient implements IToClient, IHasForgeLog {
./server/IToClient.java:5:public interface IToClient extends IRemote {
```

Two hits: the declaration, and the one class implementing it. **Zero consumers.**
Meanwhile the concrete `RemoteClient` is referenced in **13 files**:

| File | `RemoteClient` mentions |
| --- | --- |
| `server/FServerManager.java` | **45** |
| `server/RemoteClient.java` | 5 |
| `server/RemoteClientGuiGame.java` | 5 |
| `server/GameServerHandler.java` | 5 |
| `event/LobbyUpdateEvent.java` | 4 |
| `event/NetEvent.java`, `event/ReceiveEventPoolEvent.java`, the four `event/Draft*Event.java`, `client/GameClientHandler.java` | 2 each |
| `EventParticipant.java` | 1 |

And the coupling is not nominal. `RemoteClientGuiGame` calls four methods on
its client that are **not** on `IRemote`:

| Call | Line | Why it is not on the interface |
| --- | --- | --- |
| `client.setGui(this)` | 78 | back-reference the server registry needs |
| `client.isLibgdx()` | 87 | client-capability flag from the `LoginEvent` |
| `client.getIndex()` | 205 | lobby slot |
| `client.setCodecTracker(…)` | 301 | **pure Netty** — reaches into `ch.pipeline()` to rebind the encoder/decoder (`RemoteClient.java:210-215`) |

`FServerManager` keys its whole client registry on the Netty type —
`private final Map<Channel, RemoteClient> clients` (`FServerManager.java:80`),
with 25 `Channel` references in that file. `RemoteClient` itself has 19
lines mentioning `Channel`/`ByteBuf`/`io.netty`.

**Consequence for Wave 7.** "Implement `IToClient` over a WebSocket and slot it
in" is a three-method job that does not work, because the three methods are not
what the server asks of a client. Doing it that way means widening
`RemoteClientGuiGame`'s constructor and `FServerManager`'s registry off the
Netty types — a fork change, concentrated almost entirely in one file
(`FServerManager.java`, 45 + 25 references), and **blocked on O1**.

**That is not the only option, and it is not the one this spike recommends.**
See the architecture section.

## Item 3 — what a browser client actually needs

Wave 3 measured the surface: **60 methods, 45 SERVER / 15 CLIENT, 38 required,
20 not, 2 dead.** Re-derived here from the **compiled enum** by reflection
(`scripts/spike/headless/src/ProtocolDump.java`, Wave 3's tool, re-run):

```
TOTAL	60	SERVER	45	CLIENT	15	UNRESOLVED	2
40	setRememberedActions	SERVER	UNRESOLVED	void
41	nextRememberedAction	SERVER	UNRESOLVED	void
```

The source greps agree, using the anchored forms `CLAUDE.md` mandates: 45
`Mode.SERVER` + 15 `Mode.CLIENT`; the naive `grep -c 'Mode\.'` still returns
**61** because of the `Mode.SERVER` inside `getMethod()` at
`ProtocolMethod.java:136`.

The **15 blocking** SERVER methods were re-derived independently, by extracting
`sendAndWait(ProtocolMethod.…)` / `syncAndSendAndWait(ProtocolMethod.…)` call
sites from `RemoteClientGuiGame.java`: 15 blocking, 28 fire-and-forget, 2 dead
= 45. Matches Wave 3 exactly.

### The three tiers

This is the part Wave 3 did not do: classifying the 38 by **payload shape**,
which is what decides how much work each one is. Argument and return types come
from the compiled enum, not from reading.

**Tier A — strings, numbers, booleans and enums only. Browser-ready as-is. 14 methods.**

`afterGameEnd` · `finishGame` · `clearSelectables` · `message` ·
`showErrorDialog` · `showConfirmDialog` `[B]` · `showOptionDialog` `[B]` ·
`showInputDialog` `[B]` · `useMana` · `selectButtonOk` · `selectButtonCancel` ·
`concede` · `requestResync` · `nextGameDecision`

`FSkinProp` (`FSkinProp.java:45`) and `NextGameDecision`
(`NextGameDecision.java:3`) are both plain enums; the `List` arguments on
`showOptionDialog` and `showInputDialog` are `List/*String*/` in the enum's own
comments (`ProtocolMethod.java:58-59`).

**Two of these 14 are proven end to end by item 1** — `message` (fire) and
`showConfirmDialog` (blocking ask). Those are the only two shapes in the tier,
so the tier is a transcription job.

**Tier B — carry entity references. Needs an id scheme, which Forge already has. 21 methods.**

`showPromptMessage` · `updateButtons` · `tempShowZones` `[B]` · `hideZones` ·
`getAbilityToPlay` `[B]` · `assignCombatDamage` `[B]` ·
`assignGenericAmount` `[B]` · `confirm` `[B]` · `getChoices` `[B]` ·
`order` `[B]` · `sideboard` `[B]` · `chooseSingleEntityForEffect` `[B]` ·
`chooseEntitiesForEffect` `[B]` · `manipulateCardList` `[B]` ·
`setSelectables` · `openZones` `[B]` · `restoreOldZones` ·
`applyYieldUpdate` · `selectPlayer` · `selectCard` · `selectAbility`

These pass `CardView` / `PlayerView` / `GameEntityView` / `SpellAbilityView`
and collections of them. A browser cannot receive a serialized `CardView`, but
it does not need to: every one of these is a *reference* to an object the
client already holds from the state channel. `TrackableObject` carries a stable
id, and `DeltaPacket.makeDeltaKey` already packs `(typeTag, id)` into one int
(`DeltaPacket.java:61-70`). So Tier B is "replace the object with its id" —
mechanical, once Tier C exists.

`applyYieldUpdate` lands here and not in Tier A because `YieldUpdate` is a
sealed interface whose records embed `PlayerView`
(`YieldUpdate.java:17-35`).

**One method in this tier is not mechanical:** `sideboard` passes two
`CardPool`s, which are quantity maps over `PaperCard`, not references to
anything the client already holds. It needs its own projection — and it is the
one place this repo already has the answer, because `@hadoku/deck` models a
pool→deck exactly and round-trips Forge's own `.dck` format over all 95 cubes.

**Tier C — the state channel. 3 methods, and all the actual work.**

`setGameView` · `openView` · `applyDelta`

14 + 21 + 3 = **38**, which is the required set exactly.

`applyDelta` is "the entire incremental state channel" and it is **already an
id-keyed property diff**, not an object graph (`DeltaPacket.java:28-29`):

```java
private final Map<Integer, Map<TrackableProperty, Object>> objectDeltas;
private final Map<Integer, Map<TrackableProperty, Object>> newObjects;
```

That is the single most useful fact in this document. **The shape of the state
channel is already JSON-shaped.** What is not solved is the value encoding for
the 214 `TrackableProperty` values.

### Sizing Tier C: 214 properties, but only 13 need real work

`TrackableProperty` is **214** constants. (`CLAUDE.md` is right. A whole-file
`grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\('` returns **218** — it also matches the
two constructors at `:270` and `:274`, the `this(…)` delegation at `:271`, and
a `return (…)` at `:294`. Counting only the constant region, lines 14–259,
gives 214. This is the same family of trap as the `Mode.` off-by-one and the
`ApiType` commented-out constant, and it is the third one found in this file.)

Each constant names a `TrackableTypes.*`. There are only **27 distinct types**
across all 214, and they bucket like this:

| Bucket | Properties | What a JSON encoder has to do |
| --- | --- | --- |
| `BooleanType`, `IntegerType`, `StringType` | **121** | nothing — they are already JSON scalars |
| entity refs: `CardViewCollectionType` (27), `PlayerViewType` (9), `CardViewType` (7), `PlayerViewCollectionType` (4), `CardStateViewType` (4), `StackItemViewType`/`…ListType` (2), `GameEntityViewType` (1) | **54** | emit the id — Tier B's scheme, reused |
| scalar collections: `StringListType` (6), `GenericMapType` (6), `StringMapType` (3), `IntegerMapType` (2), `StringSetType` (1), `IntegerSetType` (1) | **19** | arrays and objects of scalars |
| `EnumType` | **7** | the enum name as a string |
| **bespoke**: `ColorSetType` (4), `ManaCostType` (2), `ManaMapType` (1), `CounterMapType` (1), `CardTypeViewType` (1), `CombatViewType` (1), `KeywordCollectionViewType` (1), `IPaperCardType` (1), `ObjectType` (1) | **13** | a hand-written encoder each — 9 distinct types |
| | **214** | sums exactly |

So the long pole in the state channel is **13 properties over 9 types**, not
214. `CombatViewType` is the nastiest (`DeltaPacket.CombatData` already models
it as parallel int-id band lists, `DeltaPacket.java:86-92`), and `ObjectType` is
the one genuine unknown because it is untyped by construction.

### Two architectures, and the cheap one does not need the fork

**(a) Our own `IToClient` inside the server.** Implement the interface over a
WebSocket, register it in `FServerManager`. This is what D9 and the board
describe. Item 2 measured what it costs: widening `RemoteClientGuiGame`'s
constructor and prising `FServerManager`'s registry off `Map<Channel, …>` — 45
`RemoteClient` and 25 `Channel` references in that one file. **It is a fork
change, so it is blocked on O1**, and O1 is an operator action.

**(b) An adapter process that is a real Forge client on one side.** Speak
Forge's Netty protocol *as a client* using stock `FGameClient`, and WebSocket
JSON to the browser. **Zero fork changes. Nothing blocked on O1.**

**`IToClientSpike.java` is already the skeleton of (b).** It holds a real
`FGameClient` whose `IGuiGame` receives all 45 server→client methods, and
`FGameClient implements IToServer` (`FGameClient.java:30`) for the 15 going the
other way. Replacing `RecordingGui`'s two recording overrides with 38
JSON-emitting ones *is* the bridge. That is why this lane recommends (b) for
Wave 7 and treats (a) as a later consolidation, if ever.

The cost of (b) is an extra JVM hop per player and the Java-serialization
protocol staying in the middle. Both are acceptable: the hop is loopback (item
1 measured 8–14 ms round trip including the reply, on a cold JVM), and the
protocol staying put is the *point* — it is what keeps `forge/` stock.

### One hazard to carry into Wave 7

`ReplyPool.get(index)` is an **untimed** `FutureTask.get()`
(`ReplyPool.java:29-37`). A blocking ask to a browser that closes its tab
parks a Forge game thread **forever**. The only unblock is `cancelAll()`, called
from exactly two places, both in `FServerManager` (`:463` on the AFK timeout,
`:1231` on convert-to-AI). A WebSocket bridge must arm one of those, or its own
timeout, on every one of the **15** blocking methods.

This is the same correlation-with-timeout problem `@hadoku/room-ask` (P4, lane F
of Wave 5) already solves, and the board currently lists that package as having
**no consumer**. It has one now: this is it. Recording it here because the board
should stop calling `room-ask` speculative.

## The verdict: the transport is a week, the client is a month

Asked plainly — week or month?

**The bridge itself is a week.** Not because it is easy in the abstract, but
because the three things that would have made it a month are already done and
were measured, not assumed:

1. The seam works headless and both directions cross a socket — item 1, today,
   exit 0, from a 31-second build.
2. The state channel is already an id-keyed property diff, so no object-graph
   serializer has to be written — `DeltaPacket.java:28-29`.
3. Only 13 of 214 view properties need a bespoke encoder, and 121 need none.

Architecture (b) needs no fork change, so it is **not blocked on O1** and can
start immediately.

**The browser client is a month, and the month is the React UI.** D7's NO-GO
means ~14 prompt components over a board renderer, drawn by us with no WotC
trademarks, and that is where the time goes. The wire is the small half.

**What would change this verdict:** Tier C is entirely unexercised — see below.
If a real match's delta stream turns out not to survive a JSON round trip, the
week becomes a month and the month becomes a quarter. That is the one experiment
Wave 7 should run first, and it is cheap now that the harness is standing.

## Not verified

Listed with the command that would settle each, per the wave protocol. Nothing
below is implied to work.

- **No match was ever started.** The spike proves the *transport* seam and the
  *lobby* path. `setGameView`, `openView` and `applyDelta` — all of Tier C —
  **never fired**. This is the single biggest gap in this document. Settle it by
  extending the spike to seat two AI players and start a game
  (`UnifiedNetworkHarness.java:178-240` does exactly this), then asserting the
  client's `DeltaLoggingGuiGame` counted non-zero delta packets.
- **No JSON encoder was written.** The tier table says what each method *would*
  need; none of it is implemented, so the 13-bespoke-encoder estimate is a
  reading of `TrackableProperty`, not a measurement of working code.
- **Payload sizes are unmeasured.** `server.getByteTracker()` is live
  (`NetworkByteTracker`, enabled by `TestUtils.java:57`) but the spike only
  prints its identity, and with no match running there is nothing meaningful to
  measure. Settle together with the match item above.
- **Architecture (b)'s per-player JVM cost is unmeasured**, and O3 (one JVM per
  match vs. one hosting many) is still open. The spike ran one server and one
  client in a *single* JVM.
- **`getChoices`' `FSerializableFunction` is unexercised.** Wave 3 answered it
  in principle — render labels server-side, send strings, which
  `WireClassFilter.java:45` already names as the fix. No code here tests it.
- **Reconnect / `requestResync` over a WebSocket is untested.** The Forge side
  exists (`FServerManager.java:1090-1130`, `DeltaSyncManager.onResyncRequested`)
  and maps well onto this repo's `{epoch, seq}` envelope and `classifySeq`, but
  "maps well" is a reading, not a test.
- **The EDT override is reasoned, not run.** `shouldDispatchToGuiThread` is
  `protected` and overridable (`GameProtocolHandler.java:30`); nothing here
  overrode it.
- **`-DskipTests` compiling the harness is true for this build**, and is
  standard Maven behaviour, but it is a property of the build config rather than
  something guaranteed — if `maven.test.skip` ever gets set upstream,
  `run.sh spike` fails with "No compiled net harness", which it checks for
  explicitly.

## Lines owed to `docs/FORGE_ANALYSIS.md`

This lane does not own that file. These are the facts that belong in it, each
with its source, for the manager to place:

- **VERIFIED** — `IToClient` has **zero consumers**. `grep -rn 'IToClient'` over
  `forge-gui/src/main/java/forge/gamemodes/net/` returns exactly two lines:
  `server/IToClient.java:5` (the declaration) and `server/RemoteClient.java:16`
  (the only implementation). The substitutable seam D9 assumes does not exist yet.
- **VERIFIED** — `RemoteClientGuiGame` depends on four `RemoteClient` methods
  that are not on `IRemote`: `setGui` (:78), `isLibgdx` (:87), `getIndex` (:205),
  `setCodecTracker` (:301). The last reaches into the Netty pipeline
  (`RemoteClient.java:210-215`).
- **VERIFIED** — `FServerManager` keys its client registry on the Netty type:
  `Map<Channel, RemoteClient> clients` (`FServerManager.java:80`); 45
  `RemoteClient` and 25 `Channel` references in that file.
- **VERIFIED** — `DeltaPacket` is an id-keyed property diff, not an object graph:
  `Map<Integer, Map<TrackableProperty, Object>>` (`DeltaPacket.java:28-29`), with
  `(typeTag, id)` packed by `makeDeltaKey` (`DeltaPacket.java:61-70`).
- **VERIFIED** — `TrackableProperty` is **214** constants over **27** distinct
  `TrackableTypes`; 121 are Boolean/Integer/String. A whole-file anchored grep
  returns **218**; the four extras are `:270`, `:271`, `:274`, `:294`.
- **VERIFIED** — the client dispatches protocol methods on the Swing EDT:
  `GameClientHandler` passes `super(true)` (`:38`) to `GameProtocolHandler`'s
  `runInEdt` (`:19`). Observed live as `AWT-EventQueue-0` under
  `-Djava.awt.headless=true`.
- **VERIFIED** — `ReplyPool.get` is an untimed `FutureTask.get()`
  (`ReplyPool.java:29-37`); the only unblock is `cancelAll()`, called from
  `FServerManager:463` and `:1231`.
- **VERIFIED** — 15 of 45 SERVER methods block, re-derived from
  `sendAndWait`/`syncAndSendAndWait` call sites in `RemoteClientGuiGame.java`.
  15 + 28 fire-and-forget + 2 dead = 45.
- **CORRECTION, not about Forge** — `CLAUDE.md`'s "**Maven ✗** — the host has no
  `mvn`" is stale. `mvn` is Apache Maven 3.9.16 at `~/.local/bin/mvn`, and a
  Temurin JDK 21 is at `~/.local/opt/jdk-21.0.12.1+1`, both from Wave 1 lane B
  (`9f6f953`). Neither is on `PATH`, which is why `which javac` finds nothing.

## The vendored tree is pristine

Nothing was written into `forge/`. The spike compiles one file, into
`$WORK_DIR/classes` outside the repo, and builds Maven `target/` dirs only in
the scratch copy at `~/.cache/w1-spike/forge`. `run.sh` refuses to run with
`FORGE_DIR` pointing at the vendored tree.

```console
$ git -C forge status --porcelain ; echo "exit=$?"
exit=0                                  # no output
$ git -C forge log -1 --format='HEAD %H'
HEAD 2cd497cfbeb6df4e2a013c916aaab9de5ecf9795
```

Same HEAD the wave started at, clean.
