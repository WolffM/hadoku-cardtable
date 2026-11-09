# Forge upstream sync, 2026-11-08

The operator asked for our fork brought up to current Card-Forge, keeping every engine change of
ours and going through every upstream commit to judge whether it's worth bringing in. This doc is
that ledger and the plan taken.

## Where we started

| | |
| --- | --- |
| cardtable's pin | `f216faf58e` (WolffM/forge `cardtable/act-gate-concede`) |
| fork base | upstream `2cd497cfbe` (2026-09-11) |
| upstream `master` synced to | `960c343030` (2026-11-08 20:47Z) |
| upstream commits since the base | **1,272** (1,117 non-merge, 155 merges) |
| our commits on the base | **62** |

What upstream brings: **714 new card scripts, 3,108 changed ones**, 7 new edition files (among them
Marvel Darkhold Destiny and its Commander set, Nauctis The Sunken Realm, Alchemy Reality Fracture,
the Unfinity sticker sheets), about 70 rules fixes, Flat Monte Carlo AI, a memento-based undo,
Two-Headed Giant, and a rewritten selection/zone protocol.

## The ledger

Every upstream commit, one row each: [`forge-upstream-sync-2026-11-08-ledger.csv`](forge-upstream-sync-2026-11-08-ledger.csv)
(`n,sha,date,author,area,verdict,ours,why,subject`). How it was made: each commit was first classed by
the paths it touches (card scripts / editions / tokens → `cards`; desktop, mobile, adventure, quest →
`gui-only`); the remaining 318 engine, AI, net, gui-shared and build commits were read diff by diff in
four batches and given a verdict and a one-line reason. A sample was re-checked against the diffs by
hand.

| area | want | neutral | conflicts with ours | don't want | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| cards | 687 | 1 | | | 688 |
| engine rules / engine | 53 | 7 | 17 | 1 | 78 |
| engine refactor | 14 | 1 | | | 15 |
| AI | 74 | 1 | 2 | | 77 |
| net protocol | 16 | 3 | 15 | | 34 |
| gui-shared | | 2 | 1 | | 3 |
| build / tests | 2 | 16 | | 1 | 19 |
| gui-only (not shipped) | | 203 | | | 203 |
| merges | | 155 | | | 155 |
| **total** | **846** | **389** | **35** | **2** | **1,272** |

The two "don't want"s cost nothing: `896a4a14b0` (a rule 111.8 workaround) was reverted upstream the
same day (`43327867d9`), and `e7fca28931` only comments out an upstream test we don't run.

### Every conflict, and what we kept

| upstream | area | what it does | kept |
| --- | --- | --- | --- |
| `e6f4f67a3f` `a9a9280534` `78b4334393` `04328e5fdc` `6c1810dd0b` (UndoManager, GameMemento, undo mode prefs) | engine | Undo becomes a whole-game memento rewind, checkpointed at every priority; `InputPassPriority`'s Undo button and `PlayerControllerHuman.tryUndoLastAction` drive it | **Ours.** Our UI, `untap-question.jvm`, `w52-mana` and the click-to-untap gestures are built on the stack's mana-ability undo (`MagicStack.undo`, which upstream kept), its `Undo (N)` label and click-a-tapped-source-to-untap in any order. `canUndoLastAction`/`tryUndoLastAction` and the label are ours again; the bridge sets `UI_UNDO_MODE` off so a JVM hosting several matches stores no per-priority mementos. Upstream's UndoManager stays in the jar, unused by us. |
| `89e02b88da` (AITimeoutTracker) | AI | One deadline for every AI decision, declaring attackers included | **Upstream's**, strictly better: it covers every decision, not only attacks. Our attack budget (`5eff8436fe`) is dropped; that commit's other half, an AI search unwinding when its game ends from another thread (`Game.throwIfOver`), is kept beside upstream's `check()` calls. |
| `81628c048c` (Flat Monte Carlo) | AI | A Monte Carlo rollout swaps the JVM-wide random | **Both**, fixed: the rollout now binds its seeded random to its own thread (`MyRandom.bind`), so it never draws from the real game's random or races another match. Flat MC itself is turned off by the bridge for this landing (see "Not turned on yet"). |
| `e6f4f67a3f` (counting random in `MyRandom`) | engine | The JVM-wide random counts its draws for the undo barrier | **Both**: the global stays wrapped and counted; a game's own random (ours) is bound per thread and not counted, which only matters to UndoManager, off for us. |
| `da9e24cb3a` `0b0f7ecc51` `9fb0151711` (HostingServer, ProtocolGuiGame) | net | The process's one hosting server becomes `HostingServer` | **Both**: `HostingServer` now holds a set of servers and finds the AFK timeout by the game's own server (`Server.hosts(game)`), so one process still hosts several matches (ours, `005e8186c3`). |
| `bd73aaeeae` `1233219956` (token image pipes in GameState) | engine | Same bug our `47dd04f860` fixed, escaped as `%7C` | **Upstream's** writer; our reader also accepts the `/` form, so a snapshot saved before the sync still restores. |
| `8cd226407b` (getMonarchSet) | engine | Same fix as ours (`eb396bffd7`) | Identical; nothing to choose. |
| `7b413a3e08` (InputBase `isBusy`), `a198319ac4` (payment highlight CME) | engine | `showMessageInitial` gains an early return; the payment highlight goes read-only | **Both**: upstream's `isBusy` plus our untappable offer, re-expressed as `InputBase.getActionable()`; the payment highlight keeps ours (`InputPayMana.paysWith`), which uses the read-only predicate upstream asks for. |
| `ea5fe47050` `02977f7dd1` `e8ca48ddf41` (Selection) | net | `setSelectables` / `clearSelectables` / `setHighlighted` / `setWeaklySelectable` / `clearWeaklySelectable` become one `setSelection(Selection)` | **Upstream's**, ported in the bridge (below). |
| `78e501880e` `17c1ba9214` `87cb532e9f` (zones and reveals) | net | `openZones`/`restoreOldZones`/`tempShowZones`/`hideZones` leave the protocol; reveals become `showRevealedCards` | **Upstream's**, ported in the bridge (below). |
| `8848e873cb` `2ca9b8cab4` `3ead7e68d5` | net | `showWaitingTimer` → `awaitNextInput`; remembered actions become macro calls; `GuiGameEvent` carries encoded args | **Upstream's**, ported in the bridge. |
| `a9f362f4ef` `fb3cc67c56` (view properties) | net | `WasDestroyed`, `Needs{Tap,Untap,Transform}Animation`, `AvatarLifeDifference`, `HasBackSide`, `RevealedCardsCollection` leave `TrackableProperty` | **Upstream's**; `forge-wire`'s tables follow. Nothing of ours reads them as a feature (the server's visibility list and one UI test fixture name two of them). |
| `dcf3ef1118` `08729fba73` `c3d29388be` (concede, left players) | engine/net | Concede and a departed player's priority are reworked | **Upstream's**, with our ActGate (`ad902a1e74`, `f216faf58e`) on top: applied without a textual conflict; `concede-deal.jvm` and `stale-act.jvm` prove it. |
| `6ccb3eec4a` `8ac4649ab0` `4028fd1b46` `54353f6fb8` `84f4983c1c` `789bda3c2a` `c176445a91` | engine | Triggering objects, `LandsPlayedMyLastTurn`, cleanup, Two-Headed Giant, Karn restart | **Upstream's**; applied under ours without a textual conflict. Proven by the real-Forge suites (restore, mana, mulligan), not by reading. |
| `ad902a1e74` vs upstream `awaitInput` | net | Upstream lets a GUI override how an input waits | **Ours** (`ActGate.await`): only upstream's own desktop test overrides it. |

## Our 62 commits

[`forge-upstream-sync-2026-11-08-ours.csv`](forge-upstream-sync-2026-11-08-ours.csv) maps each one to
the feature that relies on it, its proof, and any upstream equivalent. All 62 were rebased onto
upstream `master`, in order, as WolffM/forge `cardtable/upstream-2026-11-08`, plus three commits of
rebase fixes. Each conflicted one names its resolution in its own commit or in the table above.

| feature | our commits | upstream equivalent | outcome |
| --- | --- | --- | --- |
| concede + ActGate (acts one at a time) | `373191af6f` `865ffee13d` `ad902a1e74` `a77e5ea8e1` `f6f65d7fab` `f216faf58e` | none | kept |
| mana offers (`AvailableActions.scan`, Signets, Phyrexian, lands' own abilities) | `917bb19323` `9729168da1` `e5db05107c` `7ddd4daa9d` `e171d76c83` `09aeb16402` `6e9517c7dd` `ccf02d50e6` `608dbc4efe` `933e527904` `a6d4830a8f` `ed4d9f6082` | none | kept |
| untap on click + mana undo | `127c0ad3a0` `2358f2c122` `702b207eda` `575c48cb92` `64f1b3b1d9` `b782c375d8` `8964ade2fa` `9e5f5b756a` | UndoManager (different mechanism) | kept; UndoManager off |
| mulligan, hand smoothing, cost choice first | `e27f6eb400` `c837010936` `d6901eb6a1` `df73b8df24` `cab6fc555e` | none | kept |
| multipick / ChosenSet | `039f8fddd3` `7454cb1113` `66ff9c1d5d` `09cefb5e87` `bffc03c9d0` `aa13a597cd` | `SameNameAsEach` (different) | kept, beside upstream's |
| per-game random, AI caches, several matches per process, bind + login | `a401b5d0bf` `7878fe7546` `005e8186c3` `2ea11debdc` `5feb9cf1cd` `886d7812f1` | counting random, HostingServer | kept, merged |
| AI attack time budget | `5eff8436fe` (half) | AITimeoutTracker | **dropped** for upstream's; the game-ended half kept |
| snapshots + restart turn (GameState) | `47dd04f860` and the eleven `GameState` commits of 2026-11-05 | token pipe fix | kept |
| death causes | `b6b2deffe2` | none (`WasDestroyed` removed upstream) | kept, minus the removed property |
| headless `forge server`, no crash reports | `1f19a230b9` `2ad70eb447` | none | kept (the bridge doesn't load `Main`) |

## The plan: A, rebase and port

**Why A, not B.** B ("newest upstream before the protocol rewrite") would stop at 2026-09-27: the
first protocol break (`78e501880e`, zones to the client) lands sixteen days after our base, and
the selection fold follows in October. That would bring in about 120 of 1,272 commits. And the
rewrite turned out to be separable after all. Our Node server never speaks Forge's network protocol. `PlayBridge.java`'s
`SeatGui` is Forge's client-side `IGuiGame`, and it turns each call into a JSON frame of our own
(`notify("setSelectables")`, …). So the protocol port is a translation **inside the bridge**:
`setSelection(Selection)` diffs against the last selection it saw and sends the same
`setSelectables` / `clearSelectables` / `setHighlighted` / `setWeaklySelectable` /
`clearWeaklySelectable` frames as before, so `forge-wire`, the server and the UI keep their wire. Only
the removed view properties and the zone/reveal calls change what a frame can carry.

Steps:

1. **Fork** — done: `cardtable/upstream-2026-11-08` on WolffM/forge = upstream `960c343030` + our 62 +
   rebase fixes. It compiles, and the fork's own engine tests pass on a claw (`MyRandomTest`,
   `GameRandomTest`, `SearchEndsWithGameTest`, `ChosenSetTest`, `ActGateTest`, the Flat MC tests).
2. **Bridge port** — `PlayBridge.java` against the new jar: the Selection translation, zones and
   reveals, `getGamestate` and the other removed overrides, `RemoteClientGuiGame` → `ProtocolGuiGame`
   where the bridge names the class (stack frames included), `UI_UNDO_MODE` off,
   `MATCH_AI_FLAT_MONTE_CARLO` off.
3. **forge-wire** — the removed properties leave `tier-c.ts`; the new ones (`TargetStackItems`,
   `SharedTeam`, …) are added; `tier-b.ts` follows the method set.
4. **Prove** — jar built on a claw; a verify branch with the pin moved; every jar suite
   (`only=jvm`) and the full Forge e2e (`full=true`); every red read from its artifact.
5. **Land** — the pin, the bridge, `forge-wire` and the docs in one commit, with the jar installed
   under `~/.local/share/cardtable/jars/<pin>.jar` before it.

## Found while proving

The rebase compiled and the fork's own tests passed; the real-Forge suites then found what the
protocol change does to a seat that is Forge's client inside our bridge. Each is fixed at its cause:

| what broke | cause | fix |
| --- | --- | --- |
| Seats sat on "Waiting for …" with dead buttons | Forge now composes that prompt on the client, 250 ms after `awaitNextInput`; its own client cancels it when the next prompt arrives (`CMatchUI.showPromptMessage`) | `SeatGui.showPromptMessage` cancels it too |
| Target selections never opened; held selections never released | Forge sends a prompt's selection after the prompt, and the client decodes it only after the deltas before it (`GameClientHandler.decodeArgs`), while the server releases a selection on the prompt that follows it | fork: `InputBase.showMessageInitial` also sends the selection ahead of `showMessage` (dropped when unchanged); bridge: priority and payment actionable sets are read from the host-side scan (`SeatController.lastActionable`) and sent ahead of their prompt, an empty set included |
| Counterspell could not target a spell | a networked seat picks stack targets from its stack view (`ProtocolGuiGame.canPickStackTargets` true) | fork: `ProtocolGuiGame.pickStackTargets`, set off by the bridge, keeps Forge's `chooseCardFromStack` ask |
| A board with a spell on the stack crashed the game | `GameState.applyToGame` marks the stack resolving with nothing resolving; upstream's `isResolving(Card)` lost its null guard | fork: the guard is back |
| A dropped seat left the match waiting | Forge's client reconnects on its own and tells its lobby nothing meanwhile; Forge's server keeps the seat | bridge: `onReconnectStateChanged` fails the match at once, every client stops retrying, and `endGame` concedes a silent seat on the host |
| A second target pick answered the first | the bridge resent a selection whose player list shrank after a pick | an offer goes out once per input |
| Upstream's own tests: 4 reds of 2,193 | our features (ActGate's wait, our variable-amount undo, our real `forge server`) | `ActGate.await` takes the GUI's `awaitInput`; two tests adapted to our semantics, named in their commits |
| `by-hand-payment.jvm` | Forge's Auto now chains one Signet | a board with two Signets, one paying the other: Auto-dead on the old pin and the new |
| A chosen card re-sent the offer (`sac-autopick`, `tk-tinker`); a combat declaration's set reached the wrong input | a selection reaches the seat's GUI after the host has moved to the next input, and the bridge read the open input when it arrived | fork: `Selection.input` names the sending input; bridge: the offer and the actionable set are keyed to it, and an offer whose input is gone is never sent |
| The keep question with dead buttons (`w89c`, `tf-thopter-sword`, `tk-tinker` vs the AI) | the client's 250 ms "Waiting for …" fired between an input's bar and its prompt; Forge cancels it only on the prompt | `SeatGui.awaitNextInput` composes the wait itself, dropped once a prompt or bar follows, and holds the next input's frames while it is out |
| End Turn showed no yield bar (`cancel-payment`, `yield-cancel`) | the yield line comes from the client's copy of the yield state, which never heard of an End Turn pressed as Cancel; and a yield shorter than 250 ms was never shown | `SeatGui.currentYieldMessage` reads the host's `YieldController`; a yield's bar goes up at once |
| `[nightly] H3`: a quiet seat failed its match | `FGameClient` drops its server after 45 s with nothing read, whatever the host's timeout | fork: the client's read timeout is the server's (`forge.net.heartbeatTimeout`, a day on our JVMs) |
| `w68-pay.spec` paid itself | the same Signet change as `by-hand-payment` | the spec moves to `by-hand-signets` |

## Not turned on yet

- **Flat Monte Carlo AI.** Upstream's default (`MATCH_AI_FLAT_MONTE_CARLO`, Max on desktop) runs
  rollouts within the AI's 5 s deadline for every decision. That changes CPU per match on a host
  running several matches per JVM, and AI pacing in e2e. The bridge keeps today's AI for this landing.
  Turning it on is one preference, after a capacity measurement (`capacity` telemetry, a soak).
- **Reconnecting a dropped seat.** Forge's client can now come back; the bridge still fails the match at
  once, as before. Letting a loopback seat reconnect is its own change.
- **UndoManager.** Off: our undo is the stack's. If players want "undo the last spell", that's
  upstream's mechanism to turn on, as its own decision.

## Upstream's own, not ours

- `c176445a91` (#12477) drops the `SameNameAsEach` guard `936c2faf27` (#12381) had added to
  `ChangeZoneEffect` ("with nothing to name, no search takes place"), and master at `960c343030` still
  lacks it: a "for each …, search" with nothing to name now searches. Verified in the diff; upstream's
  rules code, left as upstream has it.
