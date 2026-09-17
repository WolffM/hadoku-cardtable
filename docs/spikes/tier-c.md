# PR-4 spike 3 — Tier C: does the delta stream survive a JSON round trip?

Wave 7, lane A. The experiment `docs/spikes/itoclient.md` (Wave 6, lane F) named
as the one that could change the plan:

> **Tier C is entirely unexercised.** If a real match's delta stream turns out
> not to survive a JSON round trip, the week becomes a month and the month
> becomes a quarter. **That is the one experiment Wave 7 should run first.**

It survives. Cleanly, and by a wider margin than lane F's static sizing
predicted. The week stands.

Everything here is an **overlay** under `scripts/spike/tierc/`. No Java was
written into `forge/`; the vendored submodule is byte-for-byte pristine
afterwards — see the last section.

## What this settles

| # | Question | Answer |
| --- | --- | --- |
| 1 | Do `setGameView` / `openView` / `applyDelta` fire in a real match? | **Yes.** All three, every game. Wave 6 saw none of them |
| 2 | Does the client count non-zero delta packets? | **Yes** — 48 from the stock harness, 658 over 12 captured games |
| 3 | Does a captured `DeltaPacket` survive a JSON round trip? | **Yes. 73,549 of 73,549 values, zero failures, zero unrepresentable** |
| 4 | What fails? | **Nothing in the state arm.** The events arm is not a failure but a different problem — it is opaque Java bytes, not state |
| 5 | Week, month or quarter? | **The state channel is days, not a week.** The new long pole is the events arm and the React UI |

## The headline, and why it is bigger than "it round-trips"

**Not one live object reference crosses the wire.** By the time a `DeltaPacket`
reaches the client, every `CardView`, `PlayerView`, `StackItemView`,
`CardStateView`, `CombatView` and collection of them has already been flattened
to an `Integer`, a `List<Integer>`, an `int[]{typeMarker,id}` or a
`DeltaPacket.CombatData` of parallel int-id lists. The server does this itself,
in `DeltaSyncManager.toNetworkValue` (`DeltaSyncManager.java:356-401`):

```java
// Object references → Integer ID
if (type == TrackableTypes.CardViewType || type == TrackableTypes.PlayerViewType)
    return ((TrackableObject) value).getId();
...
// Collections of objects → List<Integer> of IDs
if (type == TrackableTypes.CardViewCollectionType || type == TrackableTypes.PlayerViewCollectionType) { … }
// CardStateView slot reference → ordinal of CardStateName
if (type == TrackableTypes.CardStateViewType) return csv.getState().ordinal();
if (type == TrackableTypes.CombatViewType)   return combatViewToCombatData((CombatView) value);
```

Measured, not read: across 73,549 property values in
658 packets from 12 complete games, the census
(`scripts/spike/tierc/out/census.tsv`) contains **zero** rows with a `ref` or
`refs` JSON tag. The codec has both; nothing ever reached them.

This matters for lane C. `docs/spikes/itoclient.md` sized Tier C as *"54
properties are entity refs — emit the id, Tier B's scheme reused"*. **Those 54
need no encoder at all**, because the server has already emitted the id. What
crosses the wire is scalars.

## The whole value surface is 21 Java classes plus `null`

73,549 values, 133 distinct (property, runtime class) pairs, and only **21
distinct runtime classes** in the value position (plus `null`, which is a value
in its own right here). That table is the contract lane C's Tier C arm is
waiting for.

| values | fidelity | JSON tag | runtime class |
| ---: | --- | --- | --- |
| 21171 | PLAIN | `str` | `java.lang.String` |
| 13956 | PLAIN | `int` | `java.lang.Integer` |
| 6446 | PLAIN | `list` | `java.util.ArrayList` (already ids) |
| 4628 | PLAIN | `map` | `com.google.common.collect.RegularImmutableMap` |
| 4558 | PLAIN | `bool` | `java.lang.Boolean` |
| 3552 | PLAIN | `enum` | `forge.card.ColorSet` — **an enum**, `ColorSet.java:38` |
| 3043 | PLAIN | `cardtype` | `forge.card.CardType` |
| 2902 | DERIVED | `manacost` | `forge.card.mana.ManaCost` |
| 2487 | PLAIN | `enum` | `forge.game.zone.ZoneType` |
| 2315 | PLAIN | `enum` | `forge.card.CardRarity` |
| 2314 | PLAIN | `enum` | `forge.card.GamePieceType` |
| 2308 | PLAIN | `set` | `java.util.Collections$UnmodifiableSet` |
| 2254 | PLAIN | `null` | (absent value — a real state, see below) |
| 637 | DERIVED | `keywords` | `forge.game.keyword.KeywordCollectionView` |
| 532 | PLAIN | `enum` | `forge.game.phase.PhaseType` |
| 250 | PLAIN | `map` | `java.util.HashMap` |
| 150 | PLAIN | `combat` | `forge.gamemodes.net.DeltaPacket$CombatData` (parallel int-id lists) |
| 15 | DERIVED | `multiset` | `com.google.common.collect.HashMultiset` of `CounterType` |
| 12 | PLAIN | `set` | `java.util.TreeSet` |
| 12 | PLAIN | `enum` | `forge.game.GameType` |
| 6 | PLAIN | `ints` | `int[]` (`GameEntityView` as `{typeMarker, id}`) |
| 1 | DERIVED | `papercard` | `forge.item.PaperCard` |

The three columns after the class are what a JSON bridge has to do:

- **PLAIN** — self-describing JSON. Any client in any language rebuilds it from
  the text: booleans, numbers, strings, enum names, arrays, objects.
  **128 of 133 pairs.**
- **DERIVED** — the JSON carries the information, but rebuilding the *Java*
  object needs a Forge-side parser (`ManaCost.deserialize`,
  `Keyword.getInstance`) or Forge's card database. A browser either
  re-implements the parser or holds the text.
  **5 pairs: `ManaCost` (2902 values), `KeywordCollectionView` (637), the `CounterType` keys of a counter multiset (15), `PaperCard` (1).**
- **UNSUPPORTED** — no JSON form without inventing a schema. **Zero.**

## Reproducing it

`FORGE_DIR` must be a **scratch copy**. Maven writes `target/` into whatever it
builds, and D2/O1 keep the vendored submodule stock. `run.sh` refuses the
vendored path outright, after resolving symlinks with `pwd -P`.

```sh
export FORGE_DIR=~/.cache/w1-spike/forge      # a copy, never ./forge
export PATH="$HOME/.local/bin:$PATH"          # for mvn; it is not on PATH by default

bash scripts/spike/tierc/run.sh build         # only if the copy has no fat jar yet
bash scripts/spike/tierc/run.sh match         # phase 1 — stock harness, stock counter
bash scripts/spike/tierc/run.sh capture -Dtierc.games=12   # phase 2 — capture + round trip
bash scripts/spike/tierc/run.sh mutate        # the three mutations, all must exit non-zero
bash scripts/spike/tierc/run.sh verify-pristine
```

Exit codes read directly with `; echo $?`, never through a pipe:

| Command | Exit | Note |
| --- | --- | --- |
| `run.sh match` | **0** | 0 failed / 3 passed. One 14-turn game, 16.2 s |
| `run.sh capture -Dtierc.games=12` | **0** | 0 failed / 30 passed. 12 complete games |
| `run.sh mutate` | **0** | all three mutations exited non-zero, as required |
| `run.sh match -Dtierc.remoteClients=0` | **1** | mutation A — 2 failed / 1 passed |
| `run.sh capture -Dforge.deltasync=false` | **1** | mutation B — the state arm goes to 0 |
| `run.sh capture -Dtierc.mutate=corrupt-value` | **1** | mutation C — 1 value differs, 1 failed |
| `run.sh verify-pristine` | **0** | 0 tracked changes, 0 `target/` dirs |
| `FORGE_DIR=./forge run.sh capture` | **2** | *"FORGE_DIR is the vendored forge/ tree … Refusing"* |
| `run.sh capture` with `FORGE_DIR` unset | **2** | refuses rather than defaulting to the vendored tree |

The two refusals are the load-bearing part — the one way this spike can do real
damage is to let Maven write `target/` into the vendored submodule. Transcript:
`scripts/spike/tierc/out/guards.txt`.

Every transcript in `out/` is named `.txt` rather than `.log` deliberately: the
repo's `.gitignore` line 22 is a bare `*.log`, so a committed `.log` transcript
is silently dropped and the evidence this document cites stops existing. That
was caught by `git check-ignore -v`, not by `git add`, which says nothing.

The toolchain is Temurin **JDK 21.0.12.1+1** at `~/.local/opt/jdk-21.0.12.1+1`
and Maven **3.9.16** at `~/.local/bin/mvn`, both deliberately off `PATH` (D14).
`run.sh` resolves the JDK itself; `mvn` needs the `PATH` export above, and is
only needed for `build`. This spike reused Wave 1's already-built copy at
`~/.cache/w1-spike/forge` (`forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar`,
39 MB, plus `target/test-classes/forge/net/`) and never invoked Maven at all.

### The two phases, and why they are separate

**Phase 1 (`MatchPhase.java`) contains none of our code on the measured path.**
It calls the stock `UnifiedNetworkHarness` the way Forge's own
`NetworkPlayIntegrationTest` does and reads
`GameResult.deltaPacketsReceived` — the number the stock
`HeadlessNetworkClient.DeltaLoggingGuiGame` counted, summed in
`collectRemoteClientMetrics`. A sceptic can see the non-zero count comes from
upstream code.

**Phase 2 (`CapturePhase.java`) needs the packet objects**, and
`DeltaLoggingGuiGame` is a private inner class with no hook to reach them. So
phase 2 stands up the same game shape by hand — server, lobby, AI host, one
remote slot, `server.convertToAI` on the remote player exactly as
`UnifiedNetworkHarness.swapRemotePlayersToAi()` does — and connects a client
whose `IGuiGame` is ours. Everything between the two ends is production Forge:
`FServerManager`'s Netty server, `FGameClient`'s real TCP connection,
`RemoteClientGuiGame` building the deltas, and `NetworkGuiGame.applyDelta`
applying them (we call `super`).

**The round trip runs inside `applyDelta`, before `super.applyDelta`.** A packet
analysed after the fact is a packet whose values have since been rewritten in
place by the tracker, and the comparison would be meaningless.

## Item 1 — the state channel opens, and deltas flow

```console
$ FORGE_DIR=~/.cache/w1-spike/forge bash scripts/spike/tierc/run.sh match ; echo "exit=$?"
-- stock UnifiedNetworkHarness.GameResult --
  description             = 2-player network
  decks                   = [Elvish Predation, Sunburst]
  gameStarted             = true
  gameCompleted           = true
  turnCount               = 14
  winner                  = Alice (Host AI)
  gameDurationMs          = 16228
  errorMessage            = null
  clientOpenViewCalled    = true
  clientSetGameViewCount  = 3
  deltaPacketsReceived    = 48   <- client side
  fullStateSyncsReceived  = 1
  totalDeltaBytes         = 239020
  deltaPacketCount        = 0   <- server side
  sendErrors              = 0
  eventStateMismatches    = 0

  [PASS] a game actually started (gameStarted=true)
  [PASS] the client counted a NON-ZERO number of delta packets (48)
  [PASS] the state channel opened (openView=true, setGameView x3)

phase 1: 0 failed / 3 passed
exit=0
```

Full transcript: `scripts/spike/tierc/out/phase1-match.txt`.

Wave 6's gap is closed: `openView` fired, `setGameView` fired three times per
game (once as the full sync at `sequenceNumber >= 0`), and `applyDelta` fired
throughout.

One upstream quirk worth recording: the **server-side** counters in
`GameResult` (`deltaPacketCount`, `deltaBytesSent`, `fullStateBytesSent`) are
all `0` on this path. `UnifiedNetworkHarness.collectNetworkMetrics()` — the only
thing that reads `FServerManager.getByteTracker()` — is called from
`executeLocalGame` and **not** from `executeRemoteGame`. The client-side numbers
are the real ones; do not read the server-side zeros as "no traffic".

## Item 2 — the round trip, in full

```console
$ FORGE_DIR=~/.cache/w1-spike/forge bash scripts/spike/tierc/run.sh capture -Dtierc.games=12 ; echo "exit=$?"
  [PASS] CardType.toString() is not CardType.parse()-able, as documented: "Creature - Wurm" -> "Creature - - Wurm"
  [PASS] the encoder refuses a value with no JSON form: no JSON form for java.util.Random

-- codec self-test on fixtures: 0 failed / 22 passed --
  ... 12 games, every one played to completion, 13-32 turns each ...

-- delta stream --
  applyDelta calls        = 658
  setGameView calls       = 36
  full state syncs        = 12
  openView calls          = 12
  packets analysed        = 658
  packets with events     = 658
  packets carrying STATE  = 658
  [PASS] the client counted a NON-ZERO number of delta packets (658)
  [PASS] at least one packet carried object STATE, not just events (658)
  [PASS] our analysis threw nothing (0 errors)

-- JSON round trip over every value in every captured packet --
  values seen             = 73549
  round-tripped           = 73549
  failed: no JSON form    = 0
  failed: cannot rebuild  = 0
  failed: value differed  = 0
  packet skeleton ok      = 658/658   (seq, checksum, sampled ordinals, composite delta keys)

-- by fidelity, over distinct (property, value class) pairs --
  PLAIN       (any client can rebuild from the JSON)     = 128
  DERIVED     (needs a Forge parser or the card DB)      = 5
  UNSUPPORTED (no JSON form without inventing a schema)  = 0

-- (property, class) pairs that did NOT round-trip --
  (none)

  [PASS] every captured value round-tripped through JSON

phase 2: 0 failed / 30 passed  (deltas=658)
exit=0
```

Full transcript: `scripts/spike/tierc/out/phase2-capture.txt`.

### How a value is encoded

Every value is written as a tagged object, because JSON alone cannot tell an
`Integer` from a `Long` and the comparison has to be exact:

```json
{"t":"int","v":7}
{"t":"enum","c":"forge.game.zone.ZoneType","v":"Battlefield"}
{"t":"list","v":[{"t":"int","v":3},{"t":"int","v":9}]}
{"t":"cardtype","sup":["Legendary"],"core":["Creature"],"sub":["Wurm"],"all":false,"exc":[]}
```

Worked examples, both from the committed run:

- `scripts/spike/tierc/out/sample-newobjects.json` — the opening full sync,
  truncated to three objects (it carries hundreds).
- `scripts/spike/tierc/out/sample-delta.json` — a small mid-game packet, which
  is what the stream is mostly made of.

The packet skeleton — `sequenceNumber`, `checksum`, the sampled
`checksumProperties` ordinals, and the composite `(typeTag, id)` delta keys —
is ints and longs and round-trips trivially. That was never the open question;
`DeltaPacket.makeDeltaKey` (`DeltaPacket.java:61-70`) settled it.

### `CardType.toString()` is not `CardType.parse()`-able, and that is a trap

The first version of the codec encoded `CardTypeView` as its printed type line
and decoded it with `CardType.parse`. It was the only thing the whole spike ever
found broken, and it reported itself in the census as

```
FAIL  Type  forge.card.CardType  cardtype  seen=N ok=… enc=0 dec=0 cmp=…
  COMPARE: sent=[CardType] Creature - Wurm  got=[CardType] Creature - - Wurm
```

on roughly three-quarters of every creature's `Type` value.

`CardType.toString()` inserts `" - "` between the types and the subtypes
(`CardType.java:589-612`); `CardType.parse()` splits on spaces and classifies
the literal `"-"` as a subtype (`CardType.java:806-826`). They are **not
inverses in stock Forge**, and a bridge that assumed they were would corrupt
every creature's type line while looking plausible.

The codec now carries the three token sets explicitly — `sup`, `core`, `sub`,
plus the all-creature-types flag and its exclusions — which is both correct and
what a browser client actually wants. A fixture in `JsonDelta.selfTest()` pins
the upstream behaviour so nobody "simplifies" it back, and it runs before every
match (`scripts/spike/tierc/out/phase2-capture.txt`, first lines):

```
[PASS] CardType.toString() is not CardType.parse()-able, as documented: "Creature - Wurm" -> "Creature - - Wurm"
```

That fixture fails loudly if Forge ever makes the two inverses, which is the
only way this encoding choice should ever be revisited.

This is the only value-encoding failure the whole spike found, and it was ours,
not Forge's wire's.

## Item 3 — the events arm is a different problem, and it is now the long pole

A `DeltaPacket` carries two things, and conflating them is easy. Alongside the
state maps it carries `List<Object> events`, and every item is a
`TrackableSerializer.WrappedEvent(byte[] data)` — a `GameEvent` that has
*already* been Java-serialized, with its `TrackableObject` references swapped for
`IdRef` markers (`TrackableSerializer.java:171` and `:179-196`).

```
-- events arm (carried as opaque Java-serialized bytes, NOT as state) --
  event items             = 32604
  bytes survived base64   = 32604
  failed: no JSON form    = 0
  failed: cannot rebuild  = 0
  failed: bytes differed  = 0
  JSON text for events    = 14490485 chars
    32604 x forge.gamemodes.net.TrackableSerializer$WrappedEvent
```

**A clean byte count is not "events round-trip".** Base64 carries the bytes
through JSON intact — that is measured and true — but the payload is a Java
object stream. A browser that base64-decodes it holds bytes it cannot read.
Tier C's events need a **per-event JSON schema**, and this run measured how
many: 36 distinct `GameEvent` classes fired across
12 games, out of **58** declared in
`forge-game/src/main/java/forge/game/event/`.

The 36, by delivery count over 12 games — the shape of the work:

| ≥1000 deliveries | 100–999 | <100 |
| --- | --- | --- |
| `Zone` 13821 · `CardStatsChanged` 5300 · `PlayerPriority` 4162 · `TurnPhase` 2709 · `CardTapped` 1182 · `CardChangeZone` 1045 · `ManaPool` 1024 | `AddLog` 566 · `CombatChanged` 298 · `SpellAbilityCast` 254 · `SpellRemovedFromStack` 254 · `SpellResolved` 253 · `TurnBegan` 213 · `AttackersDeclared` 211 · `CombatEnded` 201 · `TurnEnded` 201 · `PlayerStatsChanged` 196 · `LandPlayed` 158 · `PlayerDamaged` 122 | `PlayerLivesChanged` 97 · `BlockersDeclared` 87 · `CardDamaged` 60 · `Shuffle` 35 · `CardDestroyed` 31 · `PlayerControl` 24 · `CardCounters` 17 · `GameStarted`/`GameFinished`/`GameOutcome`/`FlipCoin` 12 each · `TokenCreated` 11 · `CardAttachment` 9 · `CardSacrificed` 7 · `Mulligan` 5 · `RollDie` 2 · `Scry` 1 |

(All prefixed `GameEvent` in `forge.game.event`. Full counts in
`scripts/spike/tierc/out/phase2-capture.txt`.)

That is the honest new estimate for the events arm: roughly 36
small record schemas, most of them two or three id fields. It is a day or two of
transcription, not a quarter — but it is work lane F's tiering did not name,
because `applyDelta` was counted as one method.

## Item 4 — the mutation tests

Three mutations, all against this spike's own sources and its own scratch runs.
None disables a guard, and none runs anything against the vendored tree.
Transcript: `scripts/spike/tierc/out/mutations.txt`.

| # | Mutation | What it breaks | Broken | Restored |
| --- | --- | --- | --- | --- |
| A | `run.sh match -Dtierc.remoteClients=0` | no remote client connects, so no delta can reach one | **exit=1**, `phase 1: 2 failed / 1 passed`, `deltaPacketsReceived = 0`, `openView=false` | **exit=0**, `phase 1: 0 failed / 3 passed`, 48 deltas |
| B | `run.sh capture -Dforge.deltasync=false` | `RemoteClientGuiGame.useDeltaSync=false` — the server stops building **state** deltas | **exit=1**, `phase 2: 2 failed / 6 passed`, `packets carrying STATE = 0`, `values seen = 0`, and note the packet count was still **79** | **exit=0**, `phase 2: 0 failed / 30 passed`, 658 packets, 658 carrying state |
| C | `run.sh capture -Dtierc.mutate=corrupt-value` | perturbs the first decoded value in `JsonDelta` | **exit=1**, `phase 2: 1 failed / 7 passed`, `[mutate] corrupting decoded value #1 (ArrayList)`, `failed: value differed = 1` | **exit=0**, `phase 2: 0 failed / 30 passed`, `failed: value differed = 0` |

`run.sh mutate` itself **exits 0 only if all three exited non-zero**, and fails
loudly otherwise — the run that found the problem below printed
`MUTATION A DID NOT BITE — the delta assertion cannot fail, so it is not a check.`

### Mutation B did not bite the first time, and that is a finding

The first attempt aimed `-Dforge.deltasync=false` at **phase 1**, expecting the
packet count to go to zero. It did not:

```console
$ run.sh match -Dforge.deltasync=false ; echo "exit=$?"    # the FIRST attempt at mutation A
  clientSetGameViewCount  = 33        (vs 3 with delta sync on)
  deltaPacketsReceived    = 30        (vs 48 with delta sync on)
  totalDeltaBytes         = 360       (vs 239020 with delta sync on)
  [PASS] a game actually started (gameStarted=true)
  [PASS] the client counted a NON-ZERO number of delta packets (30)
  [PASS] the state channel opened (openView=true, setGameView x33)
phase 1: 0 failed / 3 passed
exit=0                                 # expected: non-zero
```

Transcript: `scripts/spike/tierc/out/mutation-a-does-not-bite.txt`. Delta sync
is off and the packet count barely moves — but the delta *bytes* collapse from
239020 to 360, and `setGameView` goes from 3 to 33.

`RemoteClientGuiGame.useDeltaSync=false` stops the server **building state
deltas**. It does not stop it sending `ProtocolMethod.applyDelta`: the server
still ships `DeltaPacket.eventsOnly(...)` on the same method
(`RemoteClientGuiGame.java:607` and `:640`), and falls back to a full
`setGameView` per update — which is exactly what the 33 setGameView calls and
the 360 residual delta bytes are.

So **a packet count cannot tell delta sync from no delta sync**. Phase 2 now
asserts `at least one packet carried object STATE, not just events`, and the
mutation moves that one from 658 to 0 while the packet count stays non-zero (79). The assertion exists because the
mutation refused to bite, which is the entire point of running it.

### The census cannot be vacuous

"Zero UNSUPPORTED over 73,549 values" is only a result if
UNSUPPORTED is reachable. `JsonDelta.selfTest()` therefore ends with a negative
fixture:

```
[PASS] the encoder refuses a value with no JSON form: no JSON form for java.util.Random
```

and pins the bespoke Forge value types that a random pair of precons may simply
never produce — `ManaCost`, a `CounterType` multiset, a `PaperCard`, a
`KeywordCollectionView`, a `CardType`, a `DeltaPacket.CombatData`, a
`Map<Byte,Integer>` mana map — so they are checked on **every** run rather than
when the deck draw happens to cooperate. Self-test: **0 failed / 22 passed**, every run.

## The verdict: the state channel is days; the month is still the UI

Lane F asked week or month. Refining that with measurements rather than a
static type table:

| Tier | Lane F's estimate | After this spike |
| --- | --- | --- |
| A — 14 scalar methods | transcription | unchanged: transcription |
| B — 21 reference methods | mechanical once Tier C exists | unchanged, and *easier*: the id scheme it needs is the one the state channel already uses |
| C — `applyDelta` state arm | *the* unknown; 13 bespoke properties over 9 types | **days.** A working encoder/decoder exists: `JsonDelta.java`, 1150 lines with ~200 of comment, round-tripping 100% of a real match |
| C — `applyDelta` events arm | not separately sized | **1–2 days**, 36 record schemas |
| C — `setGameView` / `openView` | same unknown | same shapes; `setGameView` is the full sync and `openView` is a list of player ids |

**The week stands, and the state half of it is smaller than feared.** The month
is still the React UI — D7's NO-GO means ~14 prompt components over a board
renderer, drawn by us with no WotC trademarks. Nothing here changes that.

**What would still change the verdict** is in "Not verified" below. The one
structural risk left is `TrackableProperty.Object` (`TrackableTypes.ObjectType`,
a `TrackableType<Object>`), untyped by construction and never observed in any
run. If it turns out to carry arbitrary payloads, it needs a case-by-case
schema — but it is exactly one property of 214.

## For lane C, concretely

`packages/forge-wire/src/tier-c.ts` refuses to parse anything and points here.
That was the right call at the time. What it can now be built on:

1. `applyDelta`'s state arm is
   `{seq: number, checksum: number, checksumProperties: number[], newObjects: Record<deltaKey, Props>, objectDeltas: Record<deltaKey, Props>}`,
   where `deltaKey` is the `(typeTag << 28) | id` int from
   `DeltaPacket.makeDeltaKey` (`DeltaPacket.java:61-70`), and `Props` is a
   partial record over the 214 `TrackableProperty` names.
2. A property value is one of 22 shapes — see the table above.
   There is no entity-reference arm to write: ids arrive as numbers.
3. `null` is a real value, not an absent key. 23 of the
   133 pairs were `null` at least once (a cleared `CombatView`,
   an unset `HasPriority`); an encoder that drops nulls loses the "it is no
   longer true" signal.
4. Four value types (`ManaCost`, `KeywordCollectionView`, `CounterType` keys,
   `PaperCard`) are Forge-defined encodings. Carry the text; do not invent a
   structure for them.
5. The events arm is a **separate union** of 36-plus
   `GameEvent` records, not part of the state schema. Refusing that arm for now
   is still correct.

`scripts/spike/tierc/out/census.tsv` is the machine-readable form: one row per
(property, runtime class), with the JSON tag, counts, and any failure.
`coverage.tsv` has all 214 properties and whether this run saw each one.

## Not verified

- **103 of the 214 properties were never observed**, because
  a match only exercises the cards that turned up and the decks are random
  precons. `scripts/spike/tierc/out/coverage.tsv` lists every one.
  Of the **27** distinct `TrackableTypes` those 214 properties declare, **24** were
  exercised. The three never touched are `GenericMapType`, `IntegerMapType` and
  `ObjectType`.
  The codec has no branch that would behave differently for them *except*
  `GenericMapType` (`Map<Object,Object>`) and `ObjectType`, which are the two
  that could genuinely surprise. Settle them with a game that reaches them:
  `run.sh capture -Dtierc.games=40`, or a Commander/planar game.
- **Coverage varies run to run.** Every number in this document comes from the
  single run whose transcript is committed at
  `scripts/spike/tierc/out/phase2-capture.txt`. Other runs this session covered
  slightly different property sets — 107, 111, 118, 125, 128 and 130 of 214
  across the runs made this session, all with the same verdict. Re-running
  changes the coverage figure, not the result: no run has ever produced a
  single UNSUPPORTED value, and the value types a lucky deck draw could hide
  are pinned as fixtures rather than left to chance.
- **Two players, constructed, precon decks, server-side AI on both sides.** No
  Commander variant was forced, no multiplayer, no planar, no draft. Forcing
  those is `UnifiedNetworkHarness.commander(true)` and `playerCount(3..4)`;
  `CapturePhase` does not expose either yet.
- **The comparison is value equality, not object identity.** A decoded
  reference compares as `(typeTag, id)`. That is the correct comparison for a
  `TrackableObject` — but it is a decision, not a measurement.
- **Nothing here proves a browser can *render* the JSON**, only that the JSON
  carries the information losslessly. The React side is untouched.
- **The events arm is verified byte-exact, not semantically.** No `GameEvent`
  was re-expressed as JSON; the 36-class histogram sizes
  that job, it does not do it.
- **`-DskipTests` compiling the harness** is standard Maven behaviour and is
  true for this build, but it is a property of the build config. If
  `maven.test.skip` is ever set upstream, `run.sh` fails with "No compiled net
  harness", which it checks for explicitly.

## Lines owed to `docs/FORGE_ANALYSIS.md`

This lane does not own that file. These are the facts that belong in it, each
with its source:

- **VERIFIED** — a `DeltaPacket` on the wire contains **no `TrackableObject`
  references**. `DeltaSyncManager.toNetworkValue`
  (`DeltaSyncManager.java:356-401`) converts `CardViewType`/`PlayerViewType`/
  `StackItemViewType` to `Integer`, their collection types to `List<Integer>`,
  `GameEntityViewType` to `int[]{typeMarker,id}`, `CardStateViewType` to a
  `CardStateName` ordinal, and `CombatViewType` to `DeltaPacket.CombatData`.
  Measured over 73,549 live values: zero object-reference rows in
  `census.tsv`.
- **VERIFIED** — the live value surface of the state channel is
  **21 Java classes**, listed in
  `scripts/spike/tierc/out/census.tsv`.
- **VERIFIED** — `CardType.toString()` is not accepted by `CardType.parse()`:
  `"Creature - Wurm"` re-parses to `"Creature - - Wurm"`
  (`CardType.java:589-612` vs `:806-826`).
- **VERIFIED** — `RemoteClientGuiGame.useDeltaSync=false` does **not** stop
  `applyDelta`. The server still sends `DeltaPacket.eventsOnly(...)` on that
  method (`RemoteClientGuiGame.java:607`, `:640`) and falls back to a full
  `setGameView` per update. Measured: 30 packets / 360 delta bytes / 33
  setGameView with it off, against 48 / 239020 / 3 with it on
  (`scripts/spike/tierc/out/mutation-a-does-not-bite.txt` vs `phase1-match.txt`).
- **VERIFIED** — `UnifiedNetworkHarness` never collects server-side byte
  metrics on the remote path: `collectNetworkMetrics()` is called from
  `executeLocalGame` only, so `GameResult.deltaPacketCount` and friends are
  always `0` for a networked game.
- **VERIFIED** — `forge.card.ColorSet` is an **enum** (`ColorSet.java:38`), so
  the four `ColorSetType` properties need no bespoke encoder. Lane F's static
  sizing counted them among the 13 that do.
- **VERIFIED** — a real 2-player constructed match fires
  **36 of the 58** `GameEvent` classes declared in
  `forge-game/src/main/java/forge/game/event/`.
- **VERIFIED** — `TrackableProperty` is 214 constants, re-derived at this
  wave's checkout: `sed -n '14,259p' TrackableProperty.java | grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\('` → 214.

## The vendored tree is pristine

Nothing was written into `forge/`. The spike compiles four files into
`$WORK_DIR/classes` outside the repo, and Maven was never invoked at all — the
scratch copy at `~/.cache/w1-spike/forge` was already built by Wave 1.

```console
$ bash scripts/spike/tierc/run.sh verify-pristine ; echo "exit=$?"
==> verify-pristine
forge/ pristine: 0 tracked changes, 0 target/ dirs (both checked).
forge/ HEAD 2ad70eb447a22efe5b80904c07188311da034a42
exit=0
```

`assert_forge_pristine` checks for `target/` dirs **and** asks git, because
Forge's own `.gitignore` line 33 covers `target` and `git status --porcelain`
alone reported "pristine" through the whole Wave 6 incident.

**The HEAD above is `2ad70eb4`, not the wave's `2cd497c` pin.** That is lane B
moving the submodule, as the wave file said it would; it is not damage, and the
tree is clean at whatever commit it is standing on. The Forge copy this spike
built and ran against is a separate checkout at `~/.cache/w1-spike/forge`, whose
HEAD was `2cd497cfbeb6df4e2a013c916aaab9de5ecf9795` — the pin — for every
measurement in this document.
