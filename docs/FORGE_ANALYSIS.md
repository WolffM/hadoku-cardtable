# Forge analysis

Read against a real clone: `Card-Forge/forge` @ `master`, shallow, 811 MB, cloned
2026-09-11 into `forge/`. Every claim below was checked in source. Where I did
not check something, it says so.

## Headline

**Forge's network layer is far more separable than its reputation suggests.**
The entire client↔server protocol is one closed enum of 60 methods, and the
entire transport seam is a 3-method interface. The game logic never learns that
a player is remote.

| Question | Answer | Evidence |
| --- | --- | --- |
| Is the protocol a closed set? | **Yes — 60 methods**, 45 server→client, 15 client→server | `net/ProtocolMethod.java` |
| How wide is the transport seam? | **3 methods** | `net/IRemote.java` |
| Is the view layer a closed type space? | **Yes — 214 typed properties** | `trackable/TrackableProperty.java` |
| Does the net stack need a GUI toolkit? | **No.** `FServerManager` imports zero Swing/AWT/libGDX | `net/server/FServerManager.java` |
| Can Forge run headless? | **Yes, and it's regression-tested** | `HeadlessStartupTest.java` |
| Is hidden information handled per-client? | **Yes, already** | `DeltaSyncManager`, `TrackableObject.hasConsumer` |
| Is cube draft supported? | **Yes, first-class** — 95 cube lists, 94 draft recipes | `res/cube/`, `res/draft/` |
| Is there a dedicated-server mode? | **Stubbed, not implemented** | `Main.java:111` |

### How the protocol counts were derived — verified 2026-09-14

These numbers were wrong in this document for two waves because they were copied
rather than counted, so the commands are here beside them. Run from the repo
root; `forge/` is gitignored until the fork exists.

```sh
P=forge/forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.SERVER' $P   # 45
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.CLIENT' $P   # 15
```

45 + 15 = **60**, and the enum body (lines 35–101) has one constant per line, so
matching lines and enum constants are the same thing *for this anchored regex*.

**The old "62" was an unanchored grep.** `grep -c 'Mode\.'` on the same file
returns **61**: the extra hit is `if (mode == Mode.SERVER …)` inside `getMethod()`
at `ProtocolMethod.java:136`, which is a use, not a declaration. Where 62 rather
than 61 came from is no longer recoverable; 60 is what the file contains.

Splitting the 45 server→client methods by whether they return a value — which is
what forces `sendAndWait` — uses the second constructor argument:

```sh
grep -E '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.SERVER' $P \
  | grep -cE '\(Mode\.SERVER, *Void\.TYPE'    # 30 fire-and-forget
grep -E '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.SERVER' $P \
  | grep -cvE '\(Mode\.SERVER, *Void\.TYPE'   # 15 blocking
```

## The transport seam is three methods

```java
// forge-gui/src/main/java/forge/gamemodes/net/IRemote.java  — verbatim, whole file
public interface IRemote {
    void send(NetEvent event);
    Object sendAndWait(IdentifiableNetEvent event);
    default void write(NetEvent event) { send(event); }
}
```

`IToClient` is `interface IToClient extends IRemote {}` — literally empty. So
"put a browser on the other end of Forge" reduces to: **write one class
implementing three methods against a WebSocket instead of a Netty channel.**

Everything above it is unchanged. `GameProtocolSender` wraps `(method, args)`
into a `GuiGameEvent` and calls `send`/`sendAndWait`; `RemoteClientGuiGame`
(659 lines) implements the GUI interface by delegating every call to that
sender. The rules engine calls the same `IGuiGame` methods it would for a local
player.

### `sendAndWait` is the constraint that shapes everything

45 of the 60 protocol methods are server→client, and **15 of those return a
value**:

```java
showConfirmDialog          (Mode.SERVER, Boolean.TYPE, ...)
getChoices                 (Mode.SERVER, List.class, ...)
order                      (Mode.SERVER, OrderResult.class, ...)
chooseSingleEntityForEffect(Mode.SERVER, GameEntityView.class, ...)
assignCombatDamage         (Mode.SERVER, Map.class, ...)
```

These are **blocking RPCs**. A Forge game thread calls `sendAndWait`, parks on a
future in `ReplyPool` keyed by event id, and the rules engine is stopped
until that specific player answers. (On what kind of future, see the
`ReplyPool` entry in "Facts from the spikes" below — the answer is a trap.) Client→server methods are **almost** all
`void` — 14 of the 15 are; the enum carries a comment saying why:

> *"these should all return void, to avoid awkward situations in which client and
> server wait for one another's response and block the threads that're supposed
> to give that response"*

Note the comment says *should*, and one constant does not comply —
`getActivateDescription (Mode.CLIENT, String.class, CardView.class)`. It is the
single client→server method that returns a value, and it is the reason
`getMethod()` skips the return-type check for `Mode.CLIENT`
(`ProtocolMethod.java:134-137`). Our JSON path must not assume client→server is
fire-and-forget:

```sh
grep -E '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.CLIENT' $P \
  | grep -vE '\(Mode\.CLIENT, *Void\.TYPE'   # 1 hit: getActivateDescription
```

**Consequence for us:** a broadcast-relay room server is not sufficient. The room
layer needs first-class **ask/reply with correlation ids, timeouts and
cancellation**. This is requirement #1 in the watchparty request.

## The view layer is a closed, typed property space

`TrackableProperty` is an enum of **214 constants**, each declared with its type:

```java
public enum TrackableProperty {
    PreventNextDamage(TrackableTypes.IntegerType),
    AttachedCards(TrackableTypes.CardViewCollectionType),
    Counters(TrackableTypes.CounterMapType),
    ...
}
```

`GameView`, `PlayerView`, `CardView`, `CardStateView` and `StackItemView` are all
`TrackableObject`s over this space. `DeltaPacket` ships
`Map<Integer, Map<TrackableProperty, Object>>` — changed properties only, keyed
by a packed `(type << 28) | id`.

**This is why a JSON encoder is tractable rather than open-ended.** It is a
mechanical mapping over 214 typed properties and 5 object types, not an arbitrary
Java object graph. `TrackableTypes` gives the per-property codec.

### Hidden information is already solved

This was the finding I most expected to go badly, and it doesn't.
`TrackableSerializer.replace()` gates what a given client is told:

```java
boolean receiverKnows = consumerId >= 0
        ? trackable.hasConsumer(consumerId)      // server: has this client been
                                                 // sent this object's properties?
        : tracker != null && tracker.getObj(...) != null;
```

`DeltaSyncManager` (626 lines) tracks, per connected client, which objects that
client has been told about. Your opponent's hand is not "filtered out at render
time" — it is **never placed in that client's delta**. Forge is not a
trust-the-client architecture.

**Consequence for us:** the room layer must support **per-recipient payloads**,
not just room broadcast. Watchparty broadcasts one payload to everyone; that is
structurally wrong for Magic. This is requirement #2.

## Headless: nearly free, and upstream left us the door open

`FServerManager`'s imports are Netty, jUPnP, `java.net`, `java.util`, and
`forge.ai`. **No Swing, no AWT, no libGDX.** Across all of `forge-gui/src/main/java`
only three files touch a GUI toolkit — `AutoUpdater`, `OperatingSystem`,
`JVMOptions` — none on the game or net path.

`HeadlessStartupTest` exists specifically to stop a display dependency creeping
back in, and its javadoc names the three console modes it guards: `sim`, `parse`,
**`server`**. And in `Main.java`:

```java
case "server":
    System.out.println("Dedicated server mode.\nNot implemented.");
```

The headless plumbing is done (`java.awt.headless` is forced for console modes,
and it's regression-tested); the dedicated-server body is an empty slot. Our fork
fills it in. That is also the most obviously upstreamable thing this project
will produce.

Only real wrinkle: `FServerManager` pulls in **jUPnP** to punch a port via UPnP.
We're behind cloudflared and must disable that path, not merely leave it unused.

## Cube draft is first-class, and it changes the plan

- `forge-gui/res/cube/` — **95** bundled cube decklists (`.dck`), and nothing
  else in the directory.
- `forge-gui/res/draft/` — **94** `.draft` definitions (Arena Powered Cube,
  various Pauper/Peasant cubes, Cube Tutor 360/720, …). The directory holds 96
  *entries*: those 94, a `rankings/` **directory**, and `rankings_cubecobra.txt`.
  Neither of the last two is a recipe.

  **95 cubes, 94 recipes** — `ArabianExtended.dck` has no recipe. Verified
  2026-09-14, from the repo root:

  ```sh
  find forge/forge-gui/res/cube  -maxdepth 1 -type f -name '*.dck'   -printf '.' | wc -c  # 95
  find forge/forge-gui/res/draft -maxdepth 1 -type f -name '*.draft' -printf '.' | wc -c  # 94
  find forge/forge-gui/res/draft -maxdepth 1 -mindepth 1 ! -name '*.draft' -printf '%y %f\n'
  #   d rankings
  #   f rankings_cubecobra.txt
  ```

  `-type f` is load-bearing: the earlier "96 cubes" counted directory entries in
  `res/draft/` and so counted `rankings/` — a directory — as a draft recipe.
- `forge-gui/src/main/java/forge/gamemodes/limited/` — 6,781 lines:
  `BoosterDraft` (925), `LimitedPlayer` (835), `CustomLimited` (252),
  `CubeImporter` (130), `WinstonDraft` (191), `ThemedChaosDraft` (202),
  `BoosterDraftAI`, `CardRanker`, `LimitedDeckBuilder`.
- `net/draft/BoosterDraftHost.java` (543) — networked draft already exists.
- `forge-gui/src/main/java/forge/gui/interfaces/IDraftEventHandler.java` — a
  draft-specific event interface, separate from `IGuiGame`.

**This revises the P1 plan in `ARCHITECTURE.md`.** I had assumed P1 would
reimplement pack generation in TypeScript with no Forge dependency. That
assumption was wrong and I'm flagging it rather than quietly keeping it: Forge
already has cube import, pack generation, bot drafters, and a networked draft
host. Reimplementing it buys a Forge-free P1; reusing it buys correctness and
95 ready cubes.

The call is now a real trade-off rather than an obvious one — see "Open
decisions" below. It does not change the *ordering* (draft still first), only
what sits underneath it.

## Scryfall ingest already exists upstream

`forge-gui/src/main/java/forge/gui/download/` has `ScryfallBulkDataSync.java`,
`ScryfallSetSync.java`, and `CdnUuidCache.java`, and `forge-gui` already depends
on **gson**. Card data ingest for P1 is not greenfield. (Card *images* are a
separate matter — see `LICENSING.md`.)

## What the browser UI actually has to implement

`IGuiGame` is ~80 methods, but that is not the UI's obligation. Only the **45
server→client `ProtocolMethod` entries cross the wire**; the rest are served
locally by `NetworkGuiGame` (651 lines) from delta state.

The 45 split **30 / 15** on return type, and that split is the one that matters,
because a non-`void` return is exactly what forces a blocking `sendAndWait`. It
is mechanical, not a judgement — the second constructor argument decides it, and
the two commands in "How the protocol counts were derived" above print 30 and 15.

- **30 return `Void.TYPE`** — fire-and-forget. 24 are view updates
  (`setGameView`, `applyDelta`, `showCombat`, `setCard`, `showManaPool`,
  `setHighlighted`, `updateButtons`, `message`, … mostly "re-render this"), and
  6 are chrome: `flashIncorrectAction`, `alertUser`, `enableOverlay`,
  `disableOverlay`, `showWaitingTimer`, `showErrorDialog`. That 24/6 line is the
  only judgement call here; the 30 is not.
- **15 return a value** — every one is a blocking RPC. Fourteen are player
  prompts: `getAbilityToPlay`, `assignCombatDamage`, `assignGenericAmount`,
  `showConfirmDialog`, `showOptionDialog`, `showInputDialog`, `confirm`,
  `getChoices`, `order`, `sideboard`, `chooseSingleEntityForEffect`,
  `chooseEntitiesForEffect`, `manipulateCardList`, `openZones`. **These are the
  UI.** Ship them one at a time; each one unlocks a class of cards. The
  fifteenth is `tempShowZones`, which returns the zone list it opened — it asks
  the client nothing, but it still blocks the game thread, so the JSON path owes
  it a reply like any other.

Client→server is only 15 methods and they're all small: `selectCard`,
`selectPlayer`, `selectAbility`, `selectButtonOk/Cancel`, `useMana`,
`undoLastAction`, `concede`, `alphaStrike`, `reorderHand`, `requestResync`, …
Fourteen are `void`; `getActivateDescription` is not (see above).

So the realistic UI statement: **a playable browser client is 14 prompt
components plus a board renderer over `CardView`.** That is a real project but a
finite, enumerable one — and it degrades gracefully, because an unimplemented
prompt can fall back to "open this game in Forge desktop".

## Known porting hazards

1. **`FSerializableFunction` crosses the wire.** `getChoices` and `one` take a
   `FSerializableFunction<T, String> display` — a *function* used to label
   choices. You cannot send a closure to a browser. Needs replacing with
   pre-rendered labels on the JSON path. **Not yet investigated in depth.**
2. **`ITriggerEvent`** is passed on `selectCard`/`selectPlayer`/`getAbilityToPlay`
   — a mouse-event abstraction. Needs a JSON shape (button, modifiers).
3. **`FSkinProp`** (icons) appears in dialog signatures — map to icon names.
4. **Java serialization is load-bearing** beyond the protocol: `DeltaPacket`
   carries `List<Object> events` of LZ4-compressed, Java-serialized `GameEvent`s
   (`TrackableSerializer.wrapEvents`). The JSON path needs its own event
   encoding, not just a `DeltaPacket` mapping.
5. **`ReplyPool.get(index)` will NPE** if a reply arrives for an uninitialized
   index, and `complete()` likewise. With an untrusted-ish browser peer sending
   arbitrary correlation ids, that's reachable. Harden on our path.
6. **jUPnP port mapping** must be disabled for a tunneled deployment.
7. **No Maven on the host**, and upstream ships **no `mvnw` wrapper** (only
   `.mvn/maven.config`). Install Maven or vendor a wrapper before building.
8. **Reading a JVM's stdout over a fifo with `fs.createReadStream` deadlocks
   Node.** Not a Forge fact — a Node one, and hazard 6 and 7's neighbour because
   it bites the host, not the port. `fs.read` on a blocking fifo fd parks one of
   libuv's 4 threadpool threads for as long as the fifo is empty; `net.Socket({ fd })`
   puts the same fd in the event loop and costs no thread. Measured in Wave 22 —
   see "Not Forge facts, but they decide whether a match can outlive its server"
   at the end of this document, which also has why the fifo is opened `O_RDWR`.

## Open decisions this analysis surfaces

1. **P1: reuse Forge's draft engine, or write our own in TypeScript?**
   Reusing means P1 already needs the JVM bridge, which was the thing draft-first
   was designed to defer. Writing our own means ~1–2k lines of TS and reimporting
   the `.dck` cube format (which is simple), with no JVM until P2.
   *Leaning: our own for P1, because the whole value of draft-first is being
   able to ship before the bridge exists — but import Forge's 95 cube lists
   verbatim, and steal its pack-generation rules rather than inventing them.*
2. **One JVM per match, or one JVM hosting many?** `FServerManager` is written as
   a single lobby+server. Per-match JVMs bound the blast radius of a rules-engine
   crash; a shared JVM is cheaper. Defer to P3, but it affects the room module's
   "backend attachment" lifecycle (requirement #3).
3. **Do we implement `case "server"` upstream-style and contribute it back?**
   Probably yes — it's a clean contribution and keeps our fork thinner.

---

## Facts from the spikes — Waves 6 and 7

Everything above was read. Everything below was **run**, or read to settle a
question a run raised, and each line names the file it came from. Two spikes
produced these: `docs/spikes/itoclient.md` (Wave 6 lane F, one real `IToClient`
call across a real socket) and Wave 7 lanes B and C
(`docs/spikes/forge-server.md`, `packages/forge-wire/`).

Wave 6 lane F ended with a list headed *"Lines owed to `docs/FORGE_ANALYSIS.md`"*
and did not own this file. **They were never placed** — this section is that
debt paid, plus what Wave 7 added. Facts are attributed to whoever verified
them, and re-derivations by the Wave 7 manager are marked.

### The transport seam

- **VERIFIED (W6)** — `IToClient` has **zero consumers**. `grep -rn 'IToClient'`
  over `forge-gui/src/main/java/forge/gamemodes/net/` returns exactly two lines:
  `server/IToClient.java:5` (the declaration) and `server/RemoteClient.java:16`
  (the only implementation). **The substitutable seam D9 assumes does not exist
  yet** — it is a seam in name only.
- **VERIFIED (W6)** — `RemoteClientGuiGame` depends on four `RemoteClient`
  methods that are **not** on `IRemote`: `setGui` (:78), `isLibgdx` (:87),
  `getIndex` (:205), `setCodecTracker` (:301). The last reaches straight into the
  Netty pipeline (`RemoteClient.java:210-215`).
- **VERIFIED (W6)** — `FServerManager` keys its client registry on the Netty
  type: `Map<Channel, RemoteClient> clients` (`FServerManager.java:80`); 45
  `RemoteClient` and 25 `Channel` references in that one file. So "implement
  `IToClient` over a WebSocket and slot it in" is a three-method job that does
  not work.
- **VERIFIED (W6)** — the client dispatches protocol methods on the **Swing
  EDT**: `GameClientHandler` passes `super(true)` (:38) to
  `GameProtocolHandler`'s `runInEdt` (:19). Observed live as `AWT-EventQueue-0`
  under `-Djava.awt.headless=true`. A browser has no EDT;
  `shouldDispatchToGuiThread` is `protected` and overridable
  (`GameProtocolHandler.java:30`), which is reasoned, not run.

### `ReplyPool`'s future is neither of the two things it looks like

- **VERIFIED (W7 manager, correcting both spikes)** — `ReplyPool`'s pool is
  `Map<Integer, CompletableFuture>`, but that `CompletableFuture` is **not**
  `java.util.concurrent.CompletableFuture`. It is a private nested class in the
  same file — `private static final class CompletableFuture extends
  FutureTask<Object>` (`ReplyPool.java:54`) — which shadows the JDK name. The
  file imports `java.util.concurrent.FutureTask` and never imports the JDK
  `CompletableFuture` at all.

  Both spikes got half of this. Wave 6 lane F wrote "`FutureTask`", which is the
  right mechanism and the wrong type name. Wave 7 lane C read the declaration and
  filed a correction to "`CompletableFuture`", which is the right type name and
  invites exactly the wrong semantics — the JDK class completes with
  `complete()` and composes without blocking, whereas this one is
  `FutureTask.set()` behind an override and blocks.

  **The part that matters is unchanged and is verified:** `get(index)` is an
  **untimed** `future.get()` (`ReplyPool.java:29-37`). A blocking ask to a
  browser that closes its tab parks a Forge game thread **forever**. The only
  unblock is `cancelAll()`, called from exactly two places, both in
  `FServerManager` (`:463` on the AFK timeout, `:1231` on convert-to-AI). A
  WebSocket bridge must arm one of those, or its own timeout, on every one of
  the **15** blocking methods.

### The state channel

- **VERIFIED (W6)** — `DeltaPacket` is an id-keyed property diff, not an object
  graph: `Map<Integer, Map<TrackableProperty, Object>>` for both `objectDeltas`
  and `newObjects` (`DeltaPacket.java:28-29`), with `(typeTag, id)` packed into
  one int by `makeDeltaKey` (`DeltaPacket.java:61-70`). **The shape of the state
  channel is already JSON-shaped**; what is unsolved is the value encoding.
- **VERIFIED (W6)** — `TrackableProperty` is **214** constants over **27**
  distinct `TrackableTypes`. 121 are Boolean/Integer/String and need no encoder;
  54 are entity refs; 19 are scalar collections; 7 are enum names; **13 over 9
  types need a hand-written encoder each**. A whole-file anchored grep returns
  **218** — the four extras are `:270`, `:271`, `:274`, `:294`.
- **UNRESOLVED** — whether a real delta stream survives a JSON round trip. That
  is Wave 7 lane A, and its verdict lands in `docs/spikes/tier-c.md`.
  `packages/forge-wire/src/tier-c.ts` refuses to model these three methods until
  it does, on purpose.

### Method-shape facts the wire contract turned up (Wave 7 lane C)

Each re-derived by the Wave 7 manager against the vendored tree at the pin.

- **VERIFIED** — `openZones`' `Map<PlayerView, Object>` argument
  (`ProtocolMethod.java:74`) is a **player set, not a map**. Every `.put(` site
  passes `null` — e.g. `TargetSelection.java:180`,
  `playersWithValidTargets.put(PlayerView.get(card.getController()), null)`. So
  the wire carries a list of player refs and no value.
- **VERIFIED** — `sideboard`'s reply is the **new maindeck**, and `null` is
  meaningful: `newMain = Objects.requireNonNullElse(resp, main.toFlatList())`
  (`PlayerControllerHuman.java:276`). A non-nullable reply would force a bridge
  to fabricate the current maindeck just to say "no change".
- **VERIFIED** — **`selectCard` cannot be an ask.** `IGameController.java:36`
  declares `boolean selectCard(...)`, but `ProtocolMethod.java:90` declares it
  `(Mode.CLIENT, Void.TYPE, …)` and CLIENT return values are unchecked
  (`ProtocolMethod.java:134-136`). A bridge that waited for that boolean would
  wait forever.

### The fork (Wave 7 lane B)

- **VERIFIED** — upstream `Main.java` called `Sentry.init` with the Forge
  project's **hardcoded DSN** before reading the mode argument, and re-filled
  that DSN whenever external configuration left it empty. Compiled proof: the
  stock `Main.class` at `2cd497c` carries
  `https://…@sentry.asgardsrealm.net/3` as a class constant. Removed on the fork
  at `1f19a230`; our `Main.class` carries no occurrence of either string.
- **VERIFIED** — `case "server":` is implemented on the fork (`2ad70eb4`) and
  **hosts a lobby headless**: a real `NioServerSocketChannel` bound, a real
  `FGameClient` seated, clean shutdown. It does **not** start a match: seat 0 of
  a `ServerGameLobby` is `LOCAL`, and `FServerManager.getGui(0)` answers a LOCAL
  seat with `GuiBase.getInterface().getNewGuiGame()` — a Swing GUI a headless
  process cannot supply.
- This answers open decision 3 below (*"Do we implement `case "server"`
  upstream-style?"*) in the affirmative for the shape, and leaves the
  contribute-back half open.

### The state channel, measured — Wave 7 lane A

`docs/spikes/tier-c.md` is the full report: two AI players, real matches over a
real socket, every `DeltaPacket` round-tripped through JSON inside `applyDelta`.
These are the lines it owed this file. The manager re-derived the source
citations against the vendored tree; the measurements are the lane's committed
transcripts under `scripts/spike/tierc/out/`.

- **VERIFIED — the delta stream round-trips.** 73,549 of 73,549 property values
  over 658 packets and 12 complete games: 0 unrepresentable, 0 undecodable, 0
  value mismatches, 0 UNSUPPORTED. Reproduced independently by the manager on a
  fresh run (5,864 / 5,864 values, 64 / 64 packets, exit 0). **The week does not
  become a month.**
- **VERIFIED — not one `TrackableObject` reference crosses the wire.**
  `DeltaSyncManager.toNetworkValue` (`DeltaSyncManager.java:356-401`) has already
  flattened every `CardView`/`PlayerView`/`StackItemView`/`CardStateView`/
  `CombatView` to an `Integer`, a `List<Integer>`, an `int[]{typeMarker,id}` or a
  `DeltaPacket.CombatData` before the packet is sent. The value census has zero
  ref rows. **Lane F's "54 entity-ref properties need the id emitted" need no
  encoder at all** — Forge already emitted the id.
- **CORRECTION to lane F's sizing — `forge.card.ColorSet` is an enum**
  (`ColorSet.java:38`, `public enum ColorSet implements Iterable<Color>,
  Serializable`). So `ColorSetType`'s 4 properties are enum names, not bespoke
  encoders, and lane F's "13 bespoke over 9 types" **over-counts by 4**. The live
  surface measured 128 PLAIN / 5 DERIVED (`ManaCost` ×2,
  `KeywordCollectionView`, a `CounterType` multiset, `PaperCard`) / 0
  UNSUPPORTED over 133 (property, class) pairs — 21 Java classes plus `null`.
- **VERIFIED — `CardType.toString()` is not accepted by `CardType.parse()`.**
  `toString` emits `" - "` as the subtype separator (`CardType.java:589-612`) and
  `parse` re-splits on it (`:806-826`), so `"Creature - Wurm"` re-parses to
  `"Creature - - Wurm"`. It broke roughly three quarters of every creature's
  `Type` value until the encoder carried the three token sets explicitly. A trap
  for anything that treats a Forge `toString()` as a wire format.
- **VERIFIED — `useDeltaSync=false` does not stop `applyDelta`, and a packet
  count cannot detect it.** With the flag off the server still sends
  `applyDelta` carrying `DeltaPacket.eventsOnly(...)`
  (`RemoteClientGuiGame.java:607`, `:640`) and falls back to a full
  `setGameView` per update. The packet count barely moves; the *state* arm is
  what went away. This is why the spike asserts "at least one packet carried
  STATE" rather than "packets > 0" — the first version of that mutation did not
  bite, and the non-biting run is committed at
  `scripts/spike/tierc/out/mutation-a-does-not-bite.txt`.
- **VERIFIED — `GameResult.deltaPacketCount` is always 0 on the remote path.**
  `UnifiedNetworkHarness` never collects server-side byte metrics there. Observed
  by the manager in a fresh run: `deltaPacketsReceived = 50` client-side,
  `deltaPacketCount = 0` server-side, same match. **Do not read that zero as "no
  traffic"** — it is a metric that was never wired up.
- **VERIFIED — the events arm is the new long pole, and it is days not
  quarters.** `DeltaPacket.events` carries `record WrappedEvent(byte[] data)`
  (`TrackableSerializer.java:171`) — `GameEvent`s that are *already*
  Java-serialized. Base64 carries the bytes through JSON intact (measured, 0
  failures), but a browser that decodes them holds bytes it cannot read. **36 of
  Forge's 58 `GameEvent` classes fire in a real match**; re-expressing those as
  record schemas is the work lane F did not name. Verified byte-exact, not
  semantically.
- **NOT OBSERVED — 103 of 214 `TrackableProperty` constants** never appeared: a
  match exercises only the cards that turned up. 24 of the 27 declared
  `TrackableTypes` were exercised; **`GenericMapType`, `IntegerMapType` and
  `ObjectType` were not**. `ObjectType` is untyped by construction and is the one
  structural risk left — one property of 214. Settle with
  `run.sh capture -Dtierc.games=40`, or a Commander or planar game.
  `scripts/spike/tierc/out/coverage.tsv` lists all 214.

## Facts from a real match in front of a real player — Wave 22

Same rule as the section above: each line names the file it came from, and every
citation here was re-derived by this lane against the vendored tree in the
deployed checkout (`forge/`, read-only) rather than copied from the lane that
reported it. Where a lane's own wording was wrong, the correction is marked.

### `setHighlighted` is a MARK, not an OFFER, and a London mulligan offers nothing

This is the fact Wave 22 paid for twice: a lane built a clickable set out of
`setHighlighted` on the belief that it was Forge saying "you may click these",
and it is not. What Forge publishes when a London mulligan is open is a
**prompt, two buttons and a boolean** — no selection, no actionable set, nothing
marked. So a client that starts its click loop from what Forge offered starts
nothing, which is why the operator had to press **Auto**. That is Forge's
design, not a bug in our UI.

- **VERIFIED (W22 lane L, re-derived here)** — the method takes
  `GameEntityView`, not `CardView`:
  `void setHighlighted(Iterable<GameEntityView> entities, boolean b)`
  (`IGuiGame.java:265`). It is one of the fire-and-forget server→client methods
  (`ProtocolMethod.java:70`, `Mode.SERVER, Void.TYPE`), so nothing waits on it
  and it can carry no answer.
- **VERIFIED (W22 lane L, re-derived here)** — the frame is **incremental, not a
  replacement**. `AbstractGuiGame.setHighlighted` (`AbstractGuiGame.java:325-337`)
  holds a `Set<GameEntityView> highlighted` (`:322`) and **adds** on `true`,
  **removes** on `false`, redrawing only what changed. There is no "here is the
  whole highlighted set" call, which is on its own enough to say it is not an
  offer: an offer has to be complete to be counted against a min/max.
- **VERIFIED (W22 lane L, re-derived here)** — `InputLondonMulligan.showMessage`
  (`InputLondonMulligan.java:57-70`) is the whole of what a seat is told when the
  mulligan opens: `game.getView().updateIsMulligan(true)` (`:60`),
  `updateButtons(owner, "lblOK", "lblAuto", …)` (`:65`) and the
  `lblReturnForLondon` prose (`:67`). **It highlights nothing and publishes no
  selection.**
- **VERIFIED (W22 lane Q, correcting the brief that sent this lane)** — the brief
  said `setCardHighlight` is called "only inside `onCardSelected`". It has **two**
  call sites in that file: `:123` in `onCardSelected`, and **`:92` in
  `onCancel`** — the handler for the button `showMessage` labels **Auto**, which
  fills the selection itself and then calls `onOk()` (`:100`). The claim that
  actually matters survives unchanged and is stronger for it: **both call sites
  are downstream of input Forge had already accepted**, and neither is reachable
  before the seat has acted. `resetCardHighlights()` (`:104`, in `done()`) is the
  only other highlight traffic.
- **VERIFIED (W22 lane L, re-derived here)** — what `onCardSelected` will accept
  is exactly a card in that player's hand: `player.getZone(ZoneType.Hand).contains(c0)`
  (`InputLondonMulligan.java:113`), with `cardSelectLocked` closing it after OK
  (`:114`). So the affordance our UI needs is *the seat's own hand*, and it is
  derivable without Forge naming it.
- **VERIFIED (W22 lane Q)** — neither "these are selectable" call is ever made by
  the mulligan. `setSelectables` has exactly **2** call sites and
  `setWeaklySelectable` exactly **4**, none of them in `InputLondonMulligan`:

  ```sh
  # from the repo root; the other hits of each name are the declaration in
  # IGuiGame, the impl in AbstractGuiGame and the proxy in RemoteClientGuiGame
  grep -rn 'setSelectables(' forge/forge-gui/src/main/java forge/forge-game/src/main/java
  #   InputSelectEntitiesFromList.java:57, InputSelectTargets.java:68        (2 callers)
  grep -rn 'setWeaklySelectable' forge/forge-gui/src/main/java forge/forge-game/src/main/java
  #   PlayerControllerHuman.java:1590, :1617, :1628, :1646                   (4 callers)
  ```

- **VERIFIED (2026-10-20, match m-e6863c7810f1)** — improvise, convoke and
  Waterbend ask through `InputSelectCardsForConvokeOrImprovise` (built at
  `PlayerControllerHuman.java:2685`, from `CostAdjustment.java:359`), an
  `InputSelectManyBase` that is neither of those two callers: it names its cards
  to no GUI call at all. Its legal picks are its `availableCards` field (`:29`,
  checked in `onCardSelected` at `:76`), min 0 and max
  `min(cmc, untapped)` (`:37`), and it never sends a `clearSelectables`. The
  bridge publishes and withdraws them itself (`PlayBridge.java`'s
  `syncConvokeSelectables`).

- **VERIFIED (W22 lane L, re-derived here)** — the signal that a mulligan IS open
  is a tracked boolean on the game view, not a prompt: `GameView.isMulligan()` /
  `updateIsMulligan(boolean)` (`GameView.java:141-146`) over
  `TrackableProperty.Mulligan` (`TrackableProperty.java:249`, `BooleanType`).
  `updateIsMulligan` has **exactly two call sites in the whole tree**, both in
  `InputLondonMulligan` — set at `:60`, cleared at `:105`
  (`grep -rn 'updateIsMulligan' forge/ --include=*.java` → 3 lines: the
  declaration and those two). Because it is a *property*, it arrives on the state
  channel and survives a resync like any other state; we model it at
  `packages/forge-wire/src/tier-c.ts:514`.
- **Consequence, recorded because it is Forge's and not ours:** a seat in a
  London mulligan is offered nothing up front. A client whose click loop is
  driven by what Forge named as clickable therefore cannot start it, and the only
  working button is Auto. Any browser client of Forge has to derive this one
  affordance from `Mulligan` plus the seat's own hand.

### Not Forge facts, but they decide whether a match can outlive its server

Filed here rather than in a spike doc because they are the two things that had to
be true before Wave 22 §E could exist, they were both discovered the expensive
way, and the next person to wire a JVM to a non-Java front end will meet both.
Neither is a claim about Forge's source: the first is about **our** bridge, the
second about **Node**. They are also hazard 8 under "Known porting hazards".

- **VERIFIED (W22 lane E, re-derived here)** — **our bridge exits on stdin EOF,
  and an `O_RDWR` fifo fd is what stops it.** `PlayBridge.readCommands`
  (`apps/server/src/play/bridge/PlayBridge.java:1617-1636`) loops on
  `IN.readLine()` and, when that returns null, counts down `STOP` (`:1634-1635`);
  `main` is parked on `STOP.await()` and then `Runtime.getRuntime().halt(0)`
  (`:1587-1593`). A spare does the same before its `start` line (`:1392-1395`).
  So a detached JVM reached over an inherited read-only pipe would end the match
  the moment the server let go. Both ends open the named pipes `O_RDWR`
  (`apps/server/src/play/host.ts`, `openJvmIo`), which on Linux succeeds with no
  peer and means neither side ever reads EOF, because each is its own last
  writer.
- **VERIFIED (W22 lane E, measured; not re-run here)** — **`fs.createReadStream`
  on a fifo parks a libuv threadpool thread for as long as the fifo is empty;
  `net.Socket({ fd })` puts the fd in the event loop and costs no thread.** The
  pool is 4 threads by default, and two matches plus a spare is three readers
  waiting on a quiet Forge. Lane E's first version deadlocked `host.test.ts` into
  ~130 s of timeouts, 12 of 14 failing, and could not even `process.exit()`; with
  `net.Socket` the same suite ran in 888 ms, 14/14. The comment is on
  `openJvmIo` in `apps/server/src/play/host.ts`. **This lane did not re-run
  either measurement** (lane Q owns no code and no suite); the numbers are lane
  E's, the mechanism is checked in the source.

## Forge's game log — 2026-10-12 (lane LG)

- **VERIFIED (read)** — `forge-game/.../game/GameLog.java` is an `Observable`;
  `GameLogFormatter` (same package) subscribes to the game's event bus and
  writes one `GameLogEntry(type, message, sourceCard)` per event it formats.
  Entry types: `GameLogEntryType.java` (19). Forge's desktop default verbosity
  is `MEDIUM` (`GameLogVerbosity.java`; `ForgePreferences.DEV_LOG_ENTRY_TYPE`),
  which leaves out `PHASE`, `MANA`, `INFORMATION`, `PLAYER_CONTROL`,
  `EFFECT_REPLACED`.
- **VERIFIED (read)** — what Forge's log does NOT record at all: draws, tap /
  untap, counters other than poison and rad, token creation (only the resolving
  spell's own text says "create"), a bounce or a search as a zone change (only
  the resolution text; `GameLogFormatter.visit(GameEventCardChangeZone)` logs
  battlefield → graveyard / exile only), and a countered spell's move.
- **VERIFIED (read)** — card names in log text are `CardView.toString()`,
  `"Name (id)"` (`CardView.java:1215`), except a cast's object, which is
  `getHostCard().getName()` with no id. A face-down card reads
  `"Face-down card (H<hiddenId>)"`. Forge's log is written as a public record:
  a morph cast says "Morph", a discard and a mill name their cards.
- **VERIFIED (measured, `e2e/lg-gamelog.spec.ts` on the CI runners)** — the bridge's
  `GameLogForward` observes the server's `GameLog` and rewords each entry per
  player with `CardView.canBeShownTo` on the card as it stands when the entry
  is written. One consequence is visible: Unsummon's resolution reads "Return a
  card to its owner's hand" to the caster, because the Elves are already in the
  opponent's hand when the line is written.
- **VERIFIED (read)** — the events those actions do fire, all on the game's
  event bus (`Game.subscribeToEvents`): `GameEventCardChangeZone(card, from, to)`
  for every move, from `GameAction.changeZone` (`GameAction.java:582`; a
  token's arrival has `from == null`); a draw is that move, which
  `Player.doDraw` follows with `setDrawnThisTurn(true)` — there is no draw
  event. `GameEventCardTapped(card, tapped)` from `Card.tap`/`untap`
  (`Card.java:4669`, `:4706`) and for a tapped card leaving the battlefield
  (`GameAction.java:537`). `GameEventCardCounters(card, type, old, new)` from
  `Card.java:1788`, `:1917`. `GameEventTokenCreated()` carries no card at all.
  `GameEventSpellResolved` fires AFTER the effect has run
  (`MagicStack.java:660`), so a resolution's own log line comes after the moves
  it made. A mana ability's `MANA` entry is `source + " - " + sp`
  (`MagicStack.java:321`), one per ability, for a human's clicks and the Auto
  payment alike (`ComputerUtilMana.java:776` adds through the same `MagicStack`).
- **VERIFIED (measured, `e2e/lg-gamelog.spec.ts` on the CI runners)** — the bridge's
  `GameLogForward` writes those actions into the same stream, held until the
  next entry Forge writes: one line per draw, payment ("Alice taps Island for
  {U}", replacing the per-ability `MANA` lines), untap step, token batch,
  counter change, and move between library, hand, battlefield, graveyard and
  exile. A held line whose cards the next entry names is dropped; one made
  during a resolution goes only to players it names a card to, and a token
  only if the resolution's line (outside reminder text) does not already name
  its kind.

## A resolving spell is in two places for one delta — 2026-10-14 (lane HO)

- **VERIFIED (read)** — `MagicStack.resolveStack` (`forge-game/.../game/zone/MagicStack.java:593`)
  runs the spell's effect first — a permanent spell's `sa.resolve()` moves its
  card onto the battlefield — and only then `finishResolving` → `remove(si)`
  (`:673`, `:791`), whose `game.updateStackForView()` takes the item off
  `GameView.Stack`. The card's `PlayerView` list and the stack are separate
  view objects, so a delta flushed in between carries the card in both.
- **VERIFIED (measured, `e2e/st-stack-resolve.spec.ts` on the claws, runs 38521280591
  and 38530007159)** — the other seat received those as two `applyDelta`
  frames 30–40 ms apart, and drew Grizzly Bears on the battlefield and on the
  stack at once. `apps/ui/src/play/adapter.ts` now drops a spell's stack entry
  once a zone list holds its card.

## A mana X is asked as ten numbers and "Other…" — 2026-10-15 (lane XW)

- **VERIFIED (read)** — `PlayerControllerHuman.announceRequirements`
  (`forge-gui/.../player/PlayerControllerHuman.java:370`) asks X with
  `getGui().getInteger(title, min, max, min + 9)`. For a mana X (`{X}{R}{G}`)
  `max` is `Integer.MAX_VALUE`: `AbilityUtils.getAnnouncementBounds`
  (`forge-game/.../ability/AbilityUtils.java:2987`) caps only by `XMax`/`AnnounceMax`,
  and `Cost.getMaxForNonManaX` only walks non-mana cost parts.
  `AbstractGuiGame.getInteger(…, cutoff)` (`forge-gui/.../match/AbstractGuiGame.java`)
  then lists `min..cutoff` plus `lblOtherInteger`, and asks for anything above
  in a second, free-text dialog.
- **VERIFIED (measured, `e2e/xw-kessig-x.spec.ts` on the claws, run 38859062729)** —
  Kessig Wolf Run with fourteen basics: the ask reached the browser as 0..9 with no
  mark, so X stopped at 9. `getInteger` runs on the server side
  (`RemoteClientGuiGame` is an `AbstractGuiGame`), so the bridge's seat sees only
  the cut-off `getChoices`; it lists on past the cutoff (`PlayBridge.java`'s
  `numberAsk`) and answers a higher pick through Forge's own "Other…" follow-up,
  where Forge still checks it against the true maximum. The fork's
  `PlayerControllerHuman.getAnnouncing()` (pin `ed4d9f60`) names the ability so the
  bridge can try its cost at each X with `ComputerUtilMana.canPayManaCost`.

## Where a card's condition is decided — 2026-10-15 (lane CA)

Forge has no "ability word" concept and no single "is this condition on" call.
A conditional ability is scripted in one of four places, and each has its own
checker. `PlayBridge.java`'s `ConditionsOn` asks each with Forge's own method.

- **VERIFIED (read)** — a static ability's `Condition$` (`Metalcraft`,
  `Threshold`, `Hellbent`, `Delirium`, `Ferocious`, `PlayerTurn` …),
  `CheckSVar$` and `IsPresent$` are decided in `StaticAbility.checkConditions`
  (`forge-game/.../staticability/StaticAbility.java:362`), which first
  requires the host to be in one of its active zones (`zonesCheck`, `:337`).
  Carapace Forger's metalcraft is `Condition$ Metalcraft`.
- **VERIFIED (read)** — a trigger's or a replacement's intervening "if"
  (`Delirium$ True`, `Revolt$ True`, `CheckSVar$`, `IsPresent$`, `LifeTotal$`
  …) is `CardTraitBase.meetsCommonRequirements(Map)` (`CardTraitBase.java:290`,
  protected), which reads the map it is handed, not the trait's own.
- **VERIFIED (read)** — a spell's or sub-ability's `Condition*$` params become a
  `SpellAbilityCondition` (`SpellAbilityCondition.setConditions`, `:73`),
  checked by `areMet(sa)` (`:255`); with no activating player set (a card in
  hand) it falls back to the controller and prints a line. An activated
  ability's `Activation$ Threshold`-style restriction is
  `SpellAbilityRestriction.checkOtherRestrictions` (`:349`), mixed in with
  loyalty and activation limits.
- **VERIFIED (read)** — a branching amount is an SVar, `Count$<Name>.<if>.<else>`
  (Galvanic Blast's `Count$Metalcraft.4.2`, Brimstone Volley's
  `Count$Morbid.5.3`) or `Count$Compare <svar> <cmp>.<if>.<else>`, evaluated in
  `AbilityUtils.xCount` (`:1575`, the branches at `:1614` and `:2251-2283`).
- **VERIFIED (read)** — an "instead" is scripted as two branches, the default one
  negated: Arrow Storm's 4 damage carries `ConditionSVarCompare$ EQ0` on the
  raid count, its 5 damage the default `GE1` (`res/cardsfolder/a/arrow_storm.txt`).
  The two branches compare the same count with comparisons that between them
  take every value exactly once, and the default is the one Forge's own
  `Expressions.compare` meets at 0 — Fiery Impulse's default 2 damage is
  `ConditionSVarCompare$ LT2` beside its spell mastery's `GE2`
  (`res/cardsfolder/f/fiery_impulse.txt`), which a list of "negated"
  comparators (`EQ0`, `LT1`) missed (2026-10-16, lane CF). A lone comparison
  met at 0 is not a default: Bloodghast's `LE10` on the opponent's life is a
  bonus (`res/cardsfolder/b/bloodghast.txt`).
- **VERIFIED (measured, `apps/server/src/play/condition-met.jvm.test.ts` on
  the claws, run 38860570475)** — a card with only a keyword (Ornithopter's
  Flying) carries traits with no condition parameter, and a checker that reads
  none answers `true`: "has a condition" must be asked apart from "is it met".

## Filtered hands, and the fork's mulligan half — 2026-10-16 (hand smoothing)

The rooms' hand smoothing setting (`MatchSpec.handSmoothing`) is Forge's own
"Filtered Hands" preference plus one fork commit.

- **VERIFIED (read)** — upstream's switch is a process-global boolean,
  `StaticData.setFilteredHandsEnabled` (`forge-core/.../StaticData.java:867`),
  set from `FPref.FILTERED_HANDS` (default `false`, `ForgePreferences.java:210`)
  by `FModel.initialize` (`forge-gui/.../model/FModel.java:255`). Global is safe
  for us because a match is one JVM; `PlayBridge.startMatch` sets it per match.
- **VERIFIED (read)** — upstream used it only for the opening hand:
  `GameAction.drawStartingHand` (pin `ed4d9f6`, `GameAction.java:2299`) took the
  library's top seven and the top seven of one reshuffle and kept whichever was
  closer to `landRatio × 7` (a tie kept the first). Mulligans never read it.
- **Fork `d6901eb` (`cardtable/hand-smoothing`)** — that logic moved to
  `forge.game.mulligan.HandSmoothing.strict`, and `AbstractMulligan.mulligan`
  calls `HandSmoothing.weighted` between its shuffle and its draw: the same two
  candidates, each kept with odds `1 / (1 + distance)`. For a 40-card, 17-land
  deck the expected distance of a hand is 0.92 lands unsmoothed, 0.77 weighted
  and 0.51 strict (computed, not measured).
- **VERIFIED (measured, `apps/server/src/play/hand-smoothing.jvm.test.ts` on the
  claws, run 38947333469)** — on one seed the smoothed opening hand is never
  further from the ratio than the unsmoothed deal (seed 7 seat 0: 0 lands → 3),
  and from an identical opening the smoothed mulligan redraws differ while two
  unsmoothed runs repeat exactly.

## An order's caption does not say where the cards go — 2026-10-16 (lane OL)

- **VERIFIED (read)** — `PlayerControllerHuman.orderMoveToZoneList`
  (`forge-gui/.../player/PlayerControllerHuman.java:1119-1180`) captions a library
  order "Closest to top" or "Closest to bottom" from
  `PlayerController.orderedMoveToTopOfLibrary` (`forge-game/.../player/PlayerController.java:205`),
  which reads only `LibraryPosition`/`RevealedLibraryPosition` and otherwise says
  "top". It reverses the answer exactly when it captions "Closest to top". A `Dig`
  moves its rest with `LibraryPosition2`, -1 by default (`DigEffect.java:125,455`),
  so Tezzeret, Agent of Bolas's +1 ("put the rest on the bottom") is captioned
  "Closest to top" and goes to the bottom.
- **VERIFIED (read)** — every caller moves the ordered cards one at a time
  (`GameAction.moveToLibrary` puts -1 at the end, `GameAction.java:887`), so the
  card moved first ends next to the rest of the library: the answer's first card
  when Forge does not reverse it, its last when it does. A scry's bottom group
  (`GameAction.scry`, `GameAction.java:2668-2672`) and a London mulligan's tuck
  are not reversed, so the first card is the highest of them; a scry's or
  surveil's top group is reversed and put on top, so the first is the top card.
- The bridge (`PlayBridge.java`'s `orderDestination`) sends the real zone, end and
  first-card direction on the `order` ask; `apps/server/src/play/order-destination.jvm.test.ts`
  checks it against real Forge.

## A look at a library's top, and what moves it — 2026-10-19 (lane FS)

- **VERIFIED (read)** — a look grants the looking player `PlayerMayLook` on exactly the cards it
  shows, its own library included: `PlayerControllerHuman.tempShowCard` → `Card.addMayLookTemp`
  (`forge-gui/.../player/PlayerControllerHuman.java:182-187`), taken back by `endTempShowCards`
  (`:198-205`). Jace, the Mind Sculptor's +2 is a `Dig` (`DigNum$ 1`, `DestinationZone$ Library`,
  `LibraryPosition2$ 0`): the digger is shown the top card (`DigEffect.java:344-354`) and asked
  `chooseEntitiesForEffect` with that card as its `delayedReveal`; what it does not choose goes back
  with `moveTo(Library, c, 0)`.
- **VERIFIED (read)** — a move within one hidden zone keeps the card object: `GameAction.changeZone`
  copies a card only when it is not `suppress`ed (`zoneFrom.equals(zoneTo)` for a non-token,
  `GameAction.java:154`) into a hidden zone (`:171-174`). So a scry's top card, a fate seal's kept
  card or Sensei's Divining Top's rearrangement reaches the wire as a reordered `Library` list, never
  as a new `CardView`; a card from the hand put on top (Brainstorm) is a new one.
- **VERIFIED (measured, `apps/server/src/play/fs-top-known.jvm.test.ts` on the claws, run
  39328402310)** — on main `abe771cb`'s server, the fate seal's card stays named in the looking seat's
  state at every one of the 13 state frames until its holder draws it; a scry of the seat's own
  library (Serum Visions keeping two) is missing from all 17 state frames after its look ends.

## An "any color" source's colour can be answered before it is asked — 2026-10-19 (lane LT)

- **VERIFIED (read)** — `ManaEffect.resolve` asks a `Produced$ Any` source's colour from the
  ability's express choice: an empty choice asks `chooseColor` of all five
  (`forge-game/.../ability/effects/ManaEffect.java:151-168`), and a choice of one colour makes
  `PlayerControllerHuman.chooseColor` return it without asking (`case 1`,
  `forge-gui/.../player/PlayerControllerHuman.java:2012-2022`).
- **VERIFIED (read)** — the AI payer writes that choice while it is still only weighing a source:
  `ComputerUtilMana.canPayShardWithSpellAbility` sets an any-colour source's express choice to the
  first of WUBRG that pays the shard (`forge-ai/.../ComputerUtilMana.java:1021-1035` — White for a
  generic shard), and `payManaCost` can then turn the source down (Black Lotus's `AILogic$
  BlackLotus` refuses a spell under four, `SpecialCardAi.java:125-146`; `ComputerUtilMana.java:705-709` excludes it).
  Before fork commit `6e71db52` only the sources it USED were cleared (`resetPayment`, test mode
  only), so a turned-down source kept the colour.
- **VERIFIED (read)** — a human player reaches that payer at every priority window: the fork's
  `AvailableActions.scan` prices each spell in hand with `ComputerUtilMana.canPayManaCost` under a
  swapped-in AI controller (`forge-ai/.../AvailableActions.java:318-326`), and the bridge's X bound
  does the same (`PlayBridge.java`'s `affordableX`).
- **VERIFIED (production, m-305dcd0165f1)** — with Mind Stone-and-up spells in hand, tapping Black
  Lotus sent no `getChoices` after the sacrifice confirm and floated {W}{W}{W}. Fork commit
  `6e71db52` snapshots every candidate's express choice when a payment starts and puts it back at
  every exit, test or real.

## A Room's doors are its current state — 2026-10-19 (lane RM)

- **VERIFIED (read)** — Forge keeps a Room's unlocked doors as a set (`Card.unlockedRooms`,
  `forge-game/.../card/Card.java:228`) and shows them as the card's current state, `Card.updateRooms`
  (`:8032`): neither unlocked is `EmptyRoom`, one is that door's `LeftSplit`/`RightSplit`, both are
  `Original`. `EmptyRoom` is nameless (`CardUtil.getEmptyRoomCharacteristic`, `CardUtil.java:215`).
  A Room put onto the battlefield without being cast is set empty (`GameAction.changeZone`,
  `GameAction.java:149-152`). The wire carries the state as `CurrentState`'s `CardStateName` ordinal
  (0 both, 5 left, 6 right, 9 none) beside `Room` and both halves (`CardView.updateState`,
  `CardView.java:1032`, `:1070-1071`). Unlocking fires `GameEventDoorChanged` and the `UnlockDoor`
  trigger (`Card.unlockRoom`, `:7993`).
- **VERIFIED (read)** — a door's unlock is a sorcery-speed ability the card makes on demand and caches
  per door (`Card.getUnlockAbility`, `:8060`; `CardFactoryUtil.abilityUnlockRoom`, "Unlock <door>"),
  offered for each locked door (`Card.java:7408-7414`). It is on no state's ability list, so a reader that
  finds an ability's face by walking `getStates()` finds none for it.
- **VERIFIED (measured, `apps/server/src/play/rooms.jvm.test.ts` on the claws, run 39343606183)** —
  both seats' state: a never-cast Room is `CurrentState` 9 and its whole face (ordinal 0) is never sent;
  cast Walk-In Closet is 5; after "Unlock Forgotten Cellar" it is 0. The offer leaves out an unlock the
  seat cannot pay for: with three Forests left only "Unlock Walk-In Closet" was offered (run 39343167782).

## A cost's sacrifice or discard is chosen before the targets — 2026-10-20 (lane BO)

- **VERIFIED (read, pin `6e71db52`)** — `PlaySpellAbility.playAbility` chooses targets
  (`ability.setupTargets()`, `forge-game/.../player/PlaySpellAbility.java:677`) before it pays the
  cost (`payment.payCost`, `:683`), and `CostPayment.payCost` asks each part's choice as it pays it
  (`part.accept(decisionMaker)`). So Bone Shards asked its target, then its sacrifice: the operator
  targeted his Woodfall Primus and then sacrificed it, and the spell fizzled (m-2ade17d9333d). Which
  KIND of additional cost (sacrifice or discard, `K:AlternateAdditionalCost`) is asked earlier still,
  in `chooseOptionalAdditionalCosts` (`getAbilityToPlay`, `:146`).
- **Fork `df73b8d` + `cab6fc5` (`cardtable/cost-choice-first`)** — the operator, 2026-10-20: "sacrifice first
  makes sense to me". `CostPayment.chooseObjectsBeforeTargets` (`CostPayment.java:157`) asks, right
  before `setupTargets` (`PlaySpellAbility.java:678`), every sacrifice or discard picked from a list
  (`isChosenBeforeTargets`: not this card, the whole hand, at random or the last drawn); `payCost`
  pays those choices after the targets (`:216`), re-asking only if a chosen object left its zone in
  between (a mana ability can sacrifice it). Only the question moves: nothing is paid before the
  targets (rule 601.2h stays after 601.2c), the chosen creature stays a legal target, and a cancel at
  the targets rolls the cast back through `rollbackAbility` with nothing paid. Only a payer whose
  `CostDecisionMakerBase.choosesCostObjectsFirst()` is true (the human's `HumanCostDecision`) asks
  this way; the AI is unchanged. A spell without targets now asks the sacrifice before its mana
  (Tinker). Exile, tap and return costs are still picked as they are paid, after the targets.
  `cab6fc5`: while a part is chosen early it is on `game.costPaymentStack`, as `payCost` puts every
  part it pays (`CostPayment.java:171`), so the bridge's `sacrificeAsked` names it a cost's sacrifice
  in either order and the server still takes the only legal one for the seat.

## A constrained search was asked one card at a time — 2026-10-27 (lane multipick)

Verified in `forge-game/src/main/java/forge/game/ability/effects/ChangeZoneEffect.java` at pin `886d7812`:
a hidden-origin search asks a human ONE multi-select (`chooseCardsForZoneChange`) only when
`allowMultiSelect` holds, and it excluded every search with a rule on the chosen set — `DifferentNames`,
`DifferentCMC`, `DifferentPower`, `ShareLandType`, `WithTotalCMC`, `WithTotalPower`,
`WithTotalCardTypes`. Those fell to the `for (i < changeNum)` loop of `chooseSingleCardForZoneChange`
windows titled "(i / n)", narrowing the list after each pick. Counted on that pin, as `ChangeZone`
script lines carrying the parameter: 20 / 1 / 1 / 1 / 5 / 1 / 1 cards (30 in all). The AI never takes
the multi-select (`allowMultiSelect` is false for an AI decider).

The fork (`7454cb11`) drops those exclusions and checks the chosen set instead
(`ChangeZoneEffect.meetsSearchConstraints`, the same `Card` tests the loop filtered with; card types
"among them" as a union of core types), asking again until it holds. Forge's GUI call carries no
ability, so the bridge's `SeatController.chooseCardsForZoneChange` holds it for the ask, which carries
the rules (`ChooseEntitiesForEffectSchema.rules`).

**The rest of the family — 2026-10-28 (lane multipick-2), fork `66ff9c1d`.** Re-counted on pin
`7454cb11` as script files carrying the parameter on that effect's line, the other effects that asked a
human one card at a time and could ask once:

| Effect | Cards | Forge (pin `7454cb11`) |
| --- | --- | --- |
| `ChangeZone` `ChangeType$ EACH a & b` | 17 | `ChangeZoneEffect.java:1120`: one `chooseSingleCardForZoneChange` per type × `ChangeNum`, removing what was chosen |
| `ChooseCard` `ChooseEach` | 9 | `ChooseCardEffect.java:131`: one `chooseSingleEntityForEffect` per type, optional unless `Mandatory` |
| `ChooseCard` `EachBasicType` | 3 | `ChooseCardEffect.java:119`: one per basic land type, not optional |
| `ChooseCard` `EachDifferentPower` | 1 | `ChooseCardEffect.java:194`: one per power among the choices, not optional (not in the first survey) |
| `ChooseCard` `WithTotalPower` | 2 | `ChooseCardEffect.java:146`: a loop of single picks, narrowed by the power left |
| `ChooseCard` `WithDifferentPowers` | 2 | `ChooseCardEffect.java:171`: a loop narrowed by `powerNE` |
| `Dig` `WithTotalCMC` | 3 | `DigEffect.java:263`: a loop narrowed by `cmcLE` (the first survey's 4 counted a `Play` line) |
| `Dig` `ForEachColorPair` | 1 | `DigEffect.java:290`: one per colour pair, not optional |
| `Dig` `WithDifferentPowers` | 1 | `DigEffect.java:307` (Rip-Spawn Hunter; not in the first survey) |
| `CopyPermanent` `WithDifferentNames` | 1 | `CopyPermanentEffect.java:210`: a loop narrowed by name, a confirm to stop |
| `ChooseSource` `Amount` | **0** | no `ChooseSource` script line on the pin carries `Amount$`; nothing to convert |

The fork's `forge.game.ability.effects.ChosenSet` now owns every set rule (AF411's
`ChangeZoneEffect.meetsSearchConstraints` moved into `ChosenSet.meets`, with the `With…` spellings). Each
effect above asks a human decider once (`chooseEntitiesForEffect`; a search through
`chooseCardsForZoneChange`) and re-asks until `meets` holds; an AI decider keeps its old loop. One card for
each kind is a **slot** rule (`ChosenSet.slots`): every chosen card must hold a slot of its own among those
it fits (`ChosenSet.matched`), so no kind is answered twice and no card is chosen for nothing. Where the
single asks could not be declined (`Mandatory`, `EachBasicType`, `EachDifferentPower`, `ForEachColorPair`),
`mustFill` also requires every slot some offered card fits to be **covered** by a chosen card that fits it
(`ChosenSet.fills`) — not held in the matching, so one card of two kinds answers both. A set with rules
always asks in a list, never by clicking cards on the table (`PlayerControllerHuman.useSelectCardsInput`),
because only the list checks the set.

**One card for two kinds — the rulings (2026-10-28, lane choose-each).** This paragraph said here that the
slot rule forbade Cataclysm's artifact creature as both kinds, and flagged that as unverified. It was wrong
about the code: `fills` is a cover, not a matching, and on pin `66ff9c1d` Forge takes Ornithopter as
Cataclysm's artifact *and* creature and the AI's Volcanic Island as Sundering Titan's Island *and* Mountain
(`chosen-sets.jvm.test.ts`, passing on that jar before any change; the fork's own `ChosenSetTest`
`chooseEachMustFillWhatItCan` already asserts `[Ornithopter, Forest]` meets Cataclysm beside Grizzly Bears).
The UI reads the same rule (`search-rules.ts`: `slotFit` is the matching, `fill` the cover). The official
rulings, from Scryfall's API (`/cards/named?exact=…` → `rulings_uri`), quoted with their dates:

| Family (cards on the pin) | Ruling | One card, several kinds? |
| --- | --- | --- |
| `ChooseCard` `ChooseEach` — Cataclysm | 2004-10-04: "If you control a permanent with more than one type, you can choose that same permanent for more than one of the choices if you want to. This makes it possible to select an artifact creature as both your artifact and creature, and then select a land and thereby keep only two cards." Also 2004-10-04: "…you can choose that permanent to be the representative of either type. … if you select a creature for your creature and an artifact creature for your artifact, you get to keep both of these creatures." | **Yes** |
| Cataclysmic Gearhulk | 2016-09-20: "A permanent with more than one type may be chosen as either of the types or both. For example, an artifact creature may be chosen as the artifact, the creature, or both. Choosing the same permanent twice this way has the same result as choosing it once." | **Yes** |
| Tragic Arrogance | 2015-06-22: "If a permanent has more than one of the affected types, it can count for any of them. … you could choose an enchantment creature as both the creature and the enchantment that you're sparing, even if the player controls another creature and/or another enchantment." | **Yes** |
| Liliana, Dreadhorde General | 2024-01-12: "…if a permanent has more than one permanent type, it can count for any of them. … you could choose an enchantment creature as both the creature and the enchantment that you're sparing, even if you control another creature and/or another enchantment." | **Yes** |
| Ajani, Nacatl Avenger | 2024-06-07: "A permanent with more than one type may be chosen as any of its types. For example, an artifact creature may be chosen as the artifact, the creature, or both." | **Yes** |
| Grenzo's Rebuttal | 2014-05-29: "If a permanent has more than one of the listed types, it can be chosen for any of them. For example, if the player to your left controls an artifact creature, you could choose it as the creature, the artifact, or both." | **Yes** |
| Mythos of Snapdax | 2020-04-17: "If you control a permanent with more than one type, you may choose it for each of those types. For example, you could choose an artifact creature as the artifact you keep and also as the creature you keep." | **Yes** |
| Revival Experiment (graveyard, `MinAmount$ 0`) | 2021-04-16: only what the permanent types are and that the cards are chosen on resolution. | Silent; it is not `Mandatory`, so the cover never applies and the matching alone holds (a card returned for one type) |
| Stick Together (`ChooseEach$ Party`) | none on Scryfall | Silent; not `Mandatory`, matching alone |
| `ChooseCard` `EachBasicType` — Global Ruin | 2004-10-04: "If a land counts as multiple basic land types, you can choose it for either or for both of those land types." | **Yes** |
| Sundering Titan (`Defined$ You`, `Choices$ Land`: every player's lands) | 2020-08-07: "If a land has more than one basic land type, it can be chosen more than once." Also: "…must choose one land for each basic land type (Plains, Island, Swamp, Mountain, and Forest), and then they are destroyed simultaneously." and "If one of the basic land types isn't present, it isn't chosen. If the only land of a certain type is one you control, you must choose it." | **Yes** |
| Planar Overlay | 2004-10-04: "If you have a land which counts as multiple land types, you can choose that land as each of those types. For example, a dual land could be chosen as two of your land types." | **Yes** |
| `ChooseCard` `EachDifferentPower` — Celestial Judgment | 2021-09-24: "If there are multiple creatures with the same power on the battlefield, you may choose any of them…" | Moot: a creature has one power, so its slots never overlap |
| `Dig` `ForEachColorPair` — Niv-Mizzet Reborn | 2019-05-03: "A \"color pair\" is exactly two colors." / "…you choose as many cards as you can…" | Moot: a card is exactly one pair, so its slots never overlap |
| `ChangeZone` `EACH` — Shard Convergence | 2009-02-01: "You may find \"dual lands\" with Shard Convergence. The Plains card you find, for example, can have a second subtype. … you may find a Hallowed Fountain (which has subtypes Plains and Island) as the Plains card, and another Hallowed Fountain as the Island card." | Each found card is a card of its own (no ruling lets one card be found twice); none of these searches is `Mandatory`, so the matching alone holds and Volcanic Island fills one slot |
| Conflux | 2018-03-16: "…you may find a white-blue card as the white card and another white-blue card as the blue card." | as Shard Convergence |
| Lotuslight Dancers | 2025-04-04: "…you may find a card that's black, green, and blue as the black card and still find a green card and a blue card." | as Shard Convergence |
| Guided Passage (`Mandatory$ True`, `Chooser$ Opponent`) | 2004-10-04: only "If you have no cards of any of the specified card types, then ignore those types…" | **Silent.** The one mandatory `EACH` search: its cover lets the opponent choose Dryad Arbor as the creature and the land. Forge's own loop removed each pick, so it did not. Kept as landed |
| (beside the family) Atraxa, Grand Unifier — `RepeatEach`, the `order` sheet's `oneEach` | 2023-02-04: "…you may choose to put it into your hand for any of its types. … If you choose it as the artifact card, you could also put into your hand a creature card, and vice versa." | No — one type each (`one-each.ts`), as built |

Decision: no rule changes. Every family whose rulings let one permanent answer several kinds is a
`Mandatory`/`EachBasicType` choice, where `fill` is already the cover; every family where a card is one
found card has no `fill`, so the matching is the whole rule. A per-rule flag would separate nothing the
rulings separate, so none was added. The one place the cover and Forge's loop disagree is Guided Passage,
whose rulings are silent; it stays as landed and is the operator's call.

**A search finds a different card for each kind — 2026-10-28 (lane slot-assign), fork `aa13a597`.** The
operator ruled on Guided Passage: Dryad Arbor as both the creature and the land is "a problem". Measured
first on pin `66ff9c1d` (`chosen-sets.jvm.test.ts`, the new Guided Passage case): the opponent's answer of
Dryad Arbor and Lightning Bolt from a library that also held a Forest and Grizzly Bears was taken at once, no
second ask. Guided Passage's rulings, from Scryfall's API (`/cards/named?exact=Guided Passage` →
`rulings_uri`), are only these two, both 2004-10-04: "If you have no cards of any of the specified card
types, then ignore those types and the opponent only selects cards of the types you do have." and "Yes, your
opponents get to look at all the cards in your library."

The mode now follows the ability's API, never a card name (`ChosenSet.distinct`):

| Family | Mode | Why |
| --- | --- | --- |
| `ChangeZone` `EACH` (Guided Passage, Shard Convergence, …), `Dig` `ForEachColorPair` (Niv-Mizzet Reborn) | **distinct** | a search, a reveal or a dig *finds* a card once; Shard Convergence's, Conflux's and Lotuslight Dancers' rulings each have a dual card found as one kind and another card as the other |
| `ChooseCard` `ChooseEach` / `EachBasicType` / `EachDifferentPower` (Cataclysm, Global Ruin, Sundering Titan, Planar Overlay, …) | **cover** | it *chooses* permanents; every ruling quoted above lets one permanent count as each kind it is |

With `mustFill`, a distinct set must hold as many slots, each with a different card, as any set of the
offered cards could (a maximum matching); so Dryad Arbor alone is enough only when no other creature or land
is offered. A cover set still needs every slot some card fits answered by a chosen card that fits it. Either
way every chosen card holds a slot of its own (`matched`). The slots now carry their kind's name
(`ChosenSet.named`: the `EACH` type as written, the basic type in WUBRG order, the power, the colour pair's
letters), which the bridge sends as the rule's `kinds` beside `distinct`.

The bridge's `SeatController.chooseEntitiesForEffect` holds the ability whenever `ChosenSet.constrains` it
(replacing AF411's `chooseCardsForZoneChange` hook, which went through it anyway), and the ask's `rules`
gain `slots` (`SearchRuleSchema`). A `Dig` with rules is not folded into the dig's order sheet
(`arrange.ts`'s `digAsk`): only the search prompt checks them.
