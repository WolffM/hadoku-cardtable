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
7. **No Maven on hokon**, and upstream ships **no `mvnw` wrapper** (only
   `.mvn/maven.config`). Install Maven or vendor a wrapper before building.

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
