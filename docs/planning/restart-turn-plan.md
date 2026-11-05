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
| monarch, initiative | `Game.getMonarch`, `getHasInitiative` | small: `GameCopier` copies both |
| day/night | `Game.getDayTime` | small: `GameCopier` copies it |
| emblems, effect cards in the command zone | command zone `Card`s with no printed card | medium |
| static effects not a card's own (`DetachedCardEffect`) | `Game.getStaticEffects` | medium: `GameCopier` copies them |
| control changes and their timestamps | `Card` controller list | hard: `GameCopier` has a TODO for it |
| delayed triggers | `TriggerHandler` delayed triggers | hard: they hold abilities and remembered objects |
| a player's turn history (spells cast, life lost, creatures died) | `Player` counters | medium; the snapshot is taken at the turn's start, so only "last turn" history matters |

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

`control` is flagged on suspicion: `GameState` writes `Owner:` and re-applies the controller, but
whether that survives Forge's layer system is unproven, so it refuses until its round-trip spec
says otherwise. The same goes for any kind: it comes off the list only with a spec behind it.

## Deleted / made dead

Nothing is replaced: restart is new. `perCallerLimit`'s bucket becomes a shared
`costlyActLimit` so the socket act and the HTTP routes count the same way, with no second copy.
