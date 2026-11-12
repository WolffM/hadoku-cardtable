# Undo

The operator, 2026-11-11: *"lets get the undo feature that forge added in their last release. we
decided not to take their commit but let's get it anyway. we'll split the restart turn button and
the undo button. make sure we implement undo consistently."* — and: *"ideally there's a way to
just undo one spell or effect?"*

## Rulings (operator, 2026-11-11)

1. **Every undo asks the opponent**, through the same consent flow as Restart turn
   (`restart-turn-plan.md`). The AI always allows, on the press.
2. **Reach: back to when the opponent last had priority.** One rule for an AI and a human
   opponent. Forge's own barriers also apply (a draw, a mill, a reveal, scry or surveil, any
   random draw, a new phase).
3. **Clicking a tapped land still untaps that one land, in any order**, with no ask. That is our
   fork's stack undo (`MagicStack.undoableBy`, `InputBase.selectCard`, AF389). It stays exactly as
   it is.
4. **One press takes back one action**: one cast, activation or land drop, the last first. That is
   upstream's model, a whole-game snapshot at every priority prompt. Taking back an older spell
   while keeping a newer one is not offered, because the newer one may depend on it.

## What upstream has, and why the sync left it off

Read on `upstream/master` (f85f7b6717c, 2026-11-11):

- `forge-game/src/main/java/forge/game/undo/UndoManager.java` and `GameMemento.java`
  (#12226 e6f4f67a3fb, then 78b4334393e, 04328e5fdca, 6c1810dd0b4 and #12753 34ead737064):
  - `checkpoint(game, who)` runs before every human priority prompt
    (`PlayerControllerHuman.chooseSpellAbilityToPlay`). It captures the game reflectively, keeping
    reverse deltas.
  - `undo(game)` restores the previous checkpoint on the game thread. It also truncates the
    `GameLog`, fires `GameEventSnapshotRestored` and refreshes every view.
- Barriers clear the history:
  - `PhaseHandler`: phase begin, turn end, the opponent declaring attackers or blockers, an
    opponent who *acted*.
  - `Player`: a draw, a mill.
  - `PlayerControllerHuman`: a reveal, scry, surveil.
  - any `MyRandom` draw (`callCount`).
  - a different human getting a priority prompt.
- The 2026-11-08 sync (`~/.cache/cardtable-manager/forge-upstream-sync-closing.md`) kept our stack
  mana undo and turned UndoManager off. Upstream rewrote `tryUndoLastAction` / `canUndoLastAction`
  around the rewind, and that would have removed click-to-untap. **Main's pin (f216faf58e) does not
  carry UndoManager at all**: the sync branch `cardtable/upstream-2026-11-08` (c0275250da) never
  became main's pin.

## Part 1: the fork (`WolffM/forge`, branch `cardtable/undo`, off main's pin)

- **Port the undo files**: `game/undo/*` (with #12753's compact deltas and `GameMementoTest`), plus
  what they need:
  - `MyRandom.callCount`/`drainTrace`, made to count **our per-game random**, not only the global one
  - `GameLog.truncateTo`
  - `GameEventSnapshotRestored`
  - `Game.getUndoManager`
  - `PaperToken`'s change
- **Port every barrier call.**
- **Ruling 2:** in `PhaseHandler`'s priority loop, a barrier whenever a player who is not the
  recorded owner *receives* priority (AI included), not only when they act. Upstream's AI exception
  goes away.
- **Ruling 3: do NOT take upstream's `tryUndoLastAction` / `InputPassPriority` rewrite.** Ours stays
  the stack undo. The rewind is a new, separately named entry, e.g.
  `PlayerControllerHuman.rewindLastAction()`:
  - `requestUndo` + `restartPrompt`, restored on the game thread as upstream does
  - with its own `canRewind()`: owner, priority prompt open, depth ≥ 1
- **Mode** `FREE`, set by the bridge, not by `UI_UNDO_MODE` prefs.
- **Not wired:** the AI's `markForRollback`.
- **Memory:** `MAX_RETAINED_BYTES` is maxMemory/7 *per game*, and one JVM hosts several matches.
  - Make it a per-game budget the bridge sets.
  - Measure heap with the JVM's full match count before choosing it; ruling 2 keeps the history
    short.
  - Report it in `capacity`.
- **Docs:** facts go in `docs/FORGE_ANALYSIS.md` with their files.

## Part 2: bridge and server

- **The bridge reports `canRewind` per seat** on each priority prompt, and runs `rewind(seat)` on
  the game thread.
- **After a rewind, both seats and watchers must hold the restored game.** Check that DeltaSync
  sends what `refreshViews` changed; if it cannot, force a resync. The game log must drop the
  truncated lines on every screen.
- **Consent is Restart turn's machinery, generalised, not a copy** (`Match.restartAct`, `forge:restart-turn`,
  `forge:restart-state`):
  - one take-back ask at a time, of kind `restart` | `undo`
  - the same `RESTART_ASK_MS` timeout (30 s), which counts as a decline
  - the same sheet
  - `AI allows on the press`
  - logged as `undo-asked` / `undo-answered` / `undo` on the match log
- **When an undo ask lapses:**
  - An open undo ask is cancelled when the asker's history moves: they act, or a barrier falls.
  - A declined undo greys Undo until the history moves.
- **Rate limit:** a `perCallerLimit` act `undo`, cheaper than a restart (no JVM start).
- **Recording/replay** (`play/recording/`, which logs the acts Forge applied and refuses a rebuild
  unless the final boards match): a rewind is an act in the log, so a replay rebuilds through it.

## Part 3: UI

- **Undo | Restart turn** share the slot above Concede, in the desktop cluster and the portrait
  action bar (`live-undo`, `live-restart-turn`). Undo is enabled only when the server says my
  rewind is available and no ask is open.
- **The opponent's sheet** is Restart turn's (`live-restart-ask`), titled `Undo?`, with Allow and
  Decline. No explanatory text.
- **Forge's `Undo (N)` on the bar goes:** the bar no longer offers a second undo. A mana tap is
  taken back by clicking the land (ruling 3). `ManaFloatingAsk`'s Untap stays, as the same stack
  undo.
  - **Builder:** grep `e2e/` for every spec that presses the bar's Undo and move it to the land
    click.
- **Release note** in `docs/releases/pending/`.

## Proof

- **`undo.jvm.test.ts`, in real Forge:**
  - Cast a spell with lands tapped, press Undo; the AI allows. Hand, mana, lands and life are back,
    and the game log loses the cast.
  - Undo twice takes back two actions.
  - After the AI holds priority, nothing is offered.
  - A draw or a scry is a barrier.
  - Out-of-order land untap still works beside it.
- **The same suite, human vs human:**
  - A decline leaves the game untouched.
  - An ask is cancelled when the asker acts.
  - A timeout counts as a decline.
- **e2e, on a claw:** press Undo on one screen and Allow on the other. Both boards equal the state
  before the action, a watcher's too.
- **Heap:** N concurrent matches on one JVM, with and without the history.

## Order and claims

- **First:** the fork and the jar (built on a claw). No claim blocks them.
- **Then the pin**, after `show-latch` releases `forge`.
- **Server `play/match.ts`** after w103 releases it.
- **`apps/ui/src/play/live/match.ts`** after `lane-restart-reveals`.
- **Landing:** `scripts/lanes/claim.sh` first; land through `prove-and-land.sh`.
