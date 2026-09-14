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
`FutureTask` in `ReplyPool` keyed by event id, and the rules engine is stopped
until that specific player answers. Client→server methods are **almost** all
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
