# Restart turn

The operator, 2026-11-05: *"a 'restart turn' button above the concede button. only clickable
as the active player. it sends a prompt to the opponent for whether or not they want to allow
it. if they allow it, the active players turn is reset to the untap step at exactly the state
the game was then."*

## Rulings (operator, 2026-11-05)

1. **The AI always says yes.** Against Forge's AI the restart happens on the press, with no ask.
2. **The clock is not rewound.** Time spent in the restarted turn stays spent.
3. **Everywhere.** Every room, every mode, tournaments and gauntlet included. No room setting.
4. **"Exactly the state" is the bar.** Every game keeps a snapshot of the start of every turn,
   and a turn whose snapshot cannot hold the whole game is a gap to close, not a turn to live
   with.

## What already exists

- **The snapshot.** `PlayBridge.TurnSnapshot` writes the game as Forge's own `GameState` text as
  every turn's upkeep begins: the untap step has run, the stack is empty, no upkeep trigger has
  fired. It names the untap step as the phase and asks for the upkeep (`activephaseadvance`), so
  a restore runs that upkeep exactly once. `Match.latestSnapshot` keeps the current turn's.
- **The restore.** `MatchRegistry.restore(id)` is failover's: the same match id, seats' owners,
  room settings, clock, stops and auto-yields, opening on the snapshot under a new epoch; every
  client drops what it holds and resyncs. Planned moves already run it under a live match, and
  `host.ts`'s `placeFor` never places the new game on a JVM still holding the old one's id.

So a restart is a consent flow in front of `registry.restore(id)`. In-place
`GameState.applyToGame` on the running game was considered and rejected: it is untested here,
it fights Forge's parked inputs, and what the turn had already done can outlive it.

## Part 1: the button and the ask

**Wire** (`packages/shared/src/match-wire.ts`):
- `forge:restart-turn`, client → server: `{ matchId, act: 'ask' | 'allow' | 'decline' | 'cancel' }`.
- `forge:restart-state`, server → every socket of the match: `{ matchId, turn, ask: { from } | null,
  declined: boolean, lossy: boolean }`. Sent on every change and after every join and resync.

**Server** (`match.ts`, `socket.ts`):
- `Match.restartAct(seat, act)` holds the one open ask. An ask is refused unless the match is
  running, the seat is a human one whose turn it is, the latest snapshot is this turn's and holds
  the whole game, no ask is open, and no ask was declined this turn.
- An AI opponent allows at once. A human one is asked; the game keeps running meanwhile (an
  allow undoes everything since the upkeep anyway, so nothing needs pausing). No answer in
  `RESTART_ASK_MS` (30 s) is a decline. A new turn closes an open ask.
- Allowed, the match calls its `restartTurn` dep, which is the registry's `restore(id)` for that
  match. Logged as `restart-asked`, `restart-answered`, `restart-turn` on the match log.
- Each ask is a costly act (`costly-act` / `rate-limited`, `act: 'restart-turn'`): against the AI
  every press starts a JVM's worth of work.

**UI** (`LiveBoard.tsx`):
- `Restart turn` sits between Full control and Concede (`live-restart-turn`), in the desktop
  cluster and the portrait action bar. Enabled only on my turn, with a live game, no ask open,
  none declined this turn, and a whole snapshot.
- The opponent gets a sheet built like Concede's (`live-restart-ask`): "Restart turn?", Allow /
  Decline, Decline the default. No explanatory text. Answerable with a Forge decision open: it
  is not an answer to Forge.

**Proof**: a real-Forge suite (`restart-turn.jvm.test.ts`) plays a land, asks, allows, and checks
the restored game's own snapshot equals the one it came from and the land is back in hand; and a
decline leaves the game untouched. An e2e spec presses the button and allows from the other seat.

## Part 2: a snapshot that holds the whole game

`GameState` is a puzzle-file format. What it cannot write (`match.ts`'s `restoredSpec` doc lists
it, read off `GameState.initFromGame`/`applyToGame`):

| kind | where Forge keeps it | difficulty |
| --- | --- | --- |
| monarch, initiative | `Game.getMonarch`, `getHasInitiative` | **carried** (slice 1) |
| day/night | `Game.getDayTime` | **carried** (slice 1) |
| speed, radiation effect cards | `speed=`, a player's RAD counters | **carried** (slice 1: they already came back from those lines; the round trip proves it) |
| the other managed effect cards (`effect:keyword`, `blessing`, `enduring-story`, `contraption-sprocket`) | `Player`'s effect-card fields | small to medium each |
| emblems, effect cards in the command zone | command zone `Card`s with no printed card | **carried** (slices 5 and 6) when an Effect ability made it and its host is a written card holding that ability: emblems, boons, adventures, and effects with a duration, whose end is put back where it waited |
| static effects not a card's own (`DetachedCardEffect`) | `Game.getStaticEffects` | medium: `GameCopier` copies them |
| control | `Card`'s base controller and timestamped temporary controllers | **carried in layers** (slice 2), with conditions on the source card (slice 3); `control-condition` names only UntilTheEndOfYourNextTurn, UntilSourceUnattached, StaticCommandCheck |
| delayed triggers | `TriggerHandler` delayed triggers | **carried** (slice 4) when the host is in a written zone with its SVar and what it remembers is cards, players or numbers |
| a player's turn history (spells cast, life lost, creatures died) | `Player` counters | medium; the snapshot is taken at the turn's start, so only "last turn" history matters |
| commands waiting to end something ("until it leaves", "until your next turn"), in a phase or on a card | `Phase` buckets, `Card` command lists | **named** (slice 7): every one no line writes is `command:<ApiType or class>`; **carried** (slice 8): an effect card's end, and a return (Banisher Priest) |

Steps:
1. **Measure** (shipped with part 1). `PlayBridge.TurnSnapshot.lossy` marks each snapshot with
   what the game holds that the text cannot (`lossy: [kinds]`): `monarch`, `initiative`,
   `day-night`, `delayed-trigger`, `control` (a permanent its owner does not control), and the
   cards `GameState` itself skips: `detached-effect`, `emblem`, `effect` (no paper card). Delayed
   triggers are private to `TriggerHandler` and read by reflection, as the bridge already reads
   other Forge internals; a failed read is `delayed-trigger-unread`, a refusal. The server logs
   `snapshot-lossy` and refuses a restart of that turn (the button greys). The log tells us
   which gaps real cube games hit.
2. **Close them one kind at a time** in our fork (`WolffM/forge`), most frequent first, each as an
   extension of `GameState`'s text with a round-trip spec: build the state, snapshot, restore,
   snapshot again, the two texts equal. Each kind closed comes off the `lossy` list.
3. Failover restores get every fix for free: they lose exactly the same things today.

Not a shortcut: Forge's own `GameSnapshot` (`EXPERIMENTAL_RESTORE_SNAPSHOT`, the in-memory copy that
rolls back a cancelled spell) was read as a possible base and rejected. It skips delayed triggers,
has its static-effect copy commented out, carries a list of TODOs, and lives only in memory, so it
cannot serve failover.

### Slices 1 to 3 (fork `cardtable/snapshot-whole` @ 6889146e, one pin)

The real-Forge proofs found four bugs before anything landed: day/night written backwards (Forge's
`getDayTime()` is true for night), `Player.addCounterInternal` crashing on a player's RAD counters
(an upstream bug that killed any restored game with them), and the two control bugs in slice 2.

### Slice 1

- `GameState` writes and applies `monarch=`, `monarchbeginturn=`, `initiative=` (`P<n>|<set>`) and
  `daytime=`; the holder's effect card is recreated, so no "becomes the monarch" trigger runs.
  Under `setRestore` an absent line is nobody.
- `GameState.unwritten(game)` replaces the bridge's own scan, so what the text cannot carry is
  listed beside the text: the card kinds it skips, every managed effect card it does not recreate by
  name (`effect:speed`), control, and delayed triggers (`TriggerHandler.hasDelayedTriggers`, no
  reflection).
- Speed and radiation count as carried: `speed=` and RAD counters already recreate their cards.
- Upstream fix on the way: `Player.getMonarchSet` dereferenced the effect card when it was null.
- Forge's `getDayTime()` is true for NIGHT (`Game.isNight`). The first cut had it backwards, and its
  own round trip agreed; only the real-Forge spec's "night stays night" caught it.
- Proof: `restore.jvm.test.ts`, "the monarch, the initiative, night, speed and radiation come through
  a restart".

A kind comes off the list only with a spec behind it.

### Slice 2: control in its layers

Forge holds control as a base controller (who the permanent was put onto the battlefield under)
plus timestamped temporary controllers, from a static ability (an Aura) or a resolved effect; the
newest temporary one wins only if it is newer than the base. `Owner:` alone wrote the effective
controller back as the base with the newest timestamp, so a creature under Control Magic stayed
stolen after the Aura left a restored game.

- Written now: `BaseController:` and one `GainedControl:` per control a resolved effect gave, in
  timestamp order. A static's control is not written (statics give it again); the base goes back
  below every timestamp (a static's is its host's layer timestamp, 0 on a card the text made), so
  the static outranks it as it did. The layers go on once every player's zones are set: put on as
  each card was read, a card whose base is the other player was moved to that player's battlefield
  and then cleared from the game by that player's setup.
- Not carried: control with `LoseControl$` (Sower of Temptation's "for as long as", "until it
  untaps"), whose condition is an anonymous command. `ControlGainEffect` marks it
  (`Card.markConditionalControl`) and `unwritten` names it `control-condition`, where part 1 refused
  every stolen permanent as `control`. Carrying it means naming each condition kind
  (`LeavesPlay` of a source card is the common one) and re-registering its command: slice 3.
- Proof: `restore.jvm.test.ts`, "stolen permanents come through a restart in their layers".

### Slice 3: control that ends on its source

Counted in the card scripts at the pin: of the `LoseControl$` uses that outlast a turn (EOT's 127 and
EndOfCombat's 1 end before the next upkeep), 39 of 42 watch only the effect's source card —
`LeavesPlay`, `Untap`, `LoseControl` (Sower of Temptation, Old Man of the Sea, Merieke). Those are
carried: `ControlGainEffect` records each control's kinds and source (`Card.ControlCondition`),
`GameState` writes `ControlUntil:<kinds>@<source id>` after its `GainedControl:`, and the apply puts
the same command back on the same source (`ControlGainEffect.restoreConditionalControl`).
`control-condition` now names only the other three: UntilTheEndOfYourNextTurn (5 scripts), which
the end-of-turn handler keeps; UntilSourceUnattached (1); StaticCommandCheck (2).

Proof: Sower of Temptation's own ability comes through a restart with its condition written again
on the restored Sower; a `CustomScript` precast of UntilTheEndOfYourNextTurn is refused.

## Deleted / made dead

Nothing is replaced: restart is new. `perCallerLimit`'s bucket becomes a shared
`costlyActLimit` so the socket act and the HTTP routes count the same way, with no second copy.

### Slice 4 (fork d3601870): delayed triggers, and the restore race

- `delayedtrigger=<host>|<activator>|<delayed, thisturn or P<n>>|<intrinsic>|<remembered>|<params, Base64>`,
  one per waiting trigger; the apply rebuilds it from its parameters with its `Execute` SVar from the
  host. Pacts, Casey Jones and the other "at the beginning of your next upkeep" cards come back.
  What stays `delayed-trigger`: a host outside the written zones (a copy, a token), without its SVar,
  or a trigger remembering anything but cards, players and numbers.
- **The restore race, found by this slice's proof.** The restore advanced to its upkeep inside
  `GameState.applyToGame`, before the bridge resynced the seats. An upkeep trigger was then put to
  the stack and a seat was asked about it while its client still held the old view: the card did not
  resolve, the answer came back null and Forge dropped the trigger. It lost Casey Jones's discard in
  about half the local runs, and every failover since snapshots began was exposed to it for any
  upkeep trigger. `GameState.setDeferAdvance`/`advanceDeferred` leave the advance to the bridge,
  which runs it after `resyncSeats`. 4 of 4 runs after, the whole suite 11 of 11.

### Slices 5 and 6 (fork 0f7769b2, then 9ebf0e09, one pin): emblems and effect cards, with their durations

- `effect=<Base64 of key=value lines>`, one per effect card an Effect ability made with `Duration$
  Permanent`: the ability (`host`, a card id; `at`, its place among every ability the host's states
  hold) and what the card holds that the ability does not say again: who it remembers, its choices,
  its name and image. The apply makes it again with `EffectEffect.buildEffect`, the builder
  `EffectEffect.resolve` itself now uses, so the card is the one the ability makes, with its
  triggers, statics and "forget when it moves" triggers. Emblems, boons and adventures come back.
- Slice 6, durations: the command that ends an effect's duration was an anonymous lambda; it is now
  `SpellAbilityEffect.ExileEffectCommand`, so the text can find where it waits and write that, never
  the duration: `until=phase:<phase>:<at, until, until:P<n>, untilend:P<n> or register:P<n>>` or
  `card:<id>:<leavesplay, untap, …>` (`Phase.placesOf`, `Card.commandPlacesOf`), put back with
  `Phase.putAt`/`Card.addCommand`. Reading the duration again on apply would be wrong: "until the end
  of your next turn" made on your own turn waits in `register`, and after your turn ends in
  `untilend`, which a restore on your next turn would re-derive as `register` and keep a turn too long.
- Still `effect`/`emblem`: one whose end waits elsewhere (a state-based-action check) or on a card the
  text does not write, one that changed after it was made (SVars, counters, text changes), one its
  host imprints, one remembering a spell or a last-known copy, and one whose host is not a written
  card (a token that died, a copy). Effect cards other APIs make (`createEffect` callers besides
  Effect) stay `effect`.
- `|OnAdventure` (upstream's own line, written for every exiled adventure card, which let a card
  exiled by other means be cast) is now written only for a card an adventure effect remembers that
  no `effect=` line carries.
- Proof: Elspeth, Knight-Errant's emblem and Swiftspear's Teachings's boon through a restart (the
  emblem's indestructible checked on the restored board), and Lovestruck Beast on an adventure, cast
  from exile after the restart. Both fail on d3601870 with `effect`/`emblem` lossy. Then Chronomantic
  Escape (until its next turn) and Reckless Impulse cast off-turn (until the end of seat 0's next
  turn, waiting in `untilend`) through a restart of that turn: both end on time, gone by turn 5.
  The round trip caught `Phase.putAt` dropping the player from `until:P<n>` before it shipped.

### Slices 7 and 8 (fork 9bc0ae06, then 3eb6c118): every waiting command named, returns carried, and a player's keyword card kept

- **A silent loss, found reading slice 6's command lists.** A command waiting to end something (Banisher
  Priest's "until it leaves the battlefield", a pump "until your next turn") is an anonymous lambda in a
  phase bucket or on a card. No text line writes them and nothing named them, so a restore dropped them
  and the restored game was not the game: a Priest bolted after a failover left its exile for good.
- Slice 7 names them: `GameState.unwritten` lists every command waiting in a phase, on a card or for a
  state-based-action check that no line writes, as `command:<origin>`. A duration's end is registered
  through `addUntilCommand`, which now wraps it in `SpellAbilityEffect.UntilCommand` (the command, the
  ApiType that made it, how often it ran); others are named by the class that registered them. A card's
  command lists are never pruned, so "until end of turn or until it leaves" leaves a copy behind once
  the turn ends: a wrapped command that has run is spent and not named. The lose-control command is a
  named `ControlGainEffect.LoseControlCommand`, already accounted for by `control-condition`.
- Slice 8 carries the return: `SpellAbilityEffect.ReturnCommand` (was a lambda) as
  `return=<Base64: host, ability, moved cards still waiting by zone, where it waits>`, rebuilt on the
  restored host with its until-leaves list. A `ReturnAbility` return stays `command:ChangeZone`: its
  trigger is made from the host as it was then, which the text does not hold.
- **A second silent loss, found by this slice's Leyline case.** A player's keywords from statics
  (Leyline of Sanctity's hexproof) live on a keyword card in the command zone, which holds their
  statics (hexproof is a `CantTarget` there). A restore sets the battlefield, whose statics make that
  card, and then sets the command zone from its text, which took the card out while
  `Player.keywordEffect` still pointed at it: the keyword stayed, its static did not, and the player
  could be targeted. `Player.getKeywordCard` now puts its card back in the zone. A keyword card holding
  only statics' keywords (static id not 0) is no longer `effect:keyword`; one with a resolved
  ability's keyword (`PumpEffect`, `ProtectAllEffect`) still is.
- Proof: Banisher Priest's exile through a restart, then a Lightning Bolt on the Priest brings the
  Bears back; Leyline of Sanctity's keyword card is back in the command zone after a restart; a pump
  until your next turn is named `command:Pump` and refuses the restart; no other
  case in the suite picked up a `command:` kind (the spent copies are not named).
