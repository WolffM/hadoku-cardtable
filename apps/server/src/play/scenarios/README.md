# Scenarios

A scenario is a Forge puzzle file's `[state]` section, verbatim — nothing more.
`GameState.parse` (forge-game, `GameState.java`) reads it line by line, one
`key=value` per line, and `GameState.applyToGame` applies it once the match's
mulligan step is over and before either seat is given priority (the start-game
hook — see `bridge/PlayBridge.java`'s `hostMatch()`). `human…` keys apply to
seat 0, `ai…` keys to seat 1 — both ordinary human-controlled seats here, never
Forge's own AI.

A `.state` file may use `#` comment lines, but **no blank lines**:
`GameState.splitLine` reads `line.charAt(0)` unconditionally, so an empty line
in the section throws. (Blank lines are fine between file-level sections in a
real `.pzl`, where `FileSection.parseSections` has already stripped them before
`Puzzle.loadGameState` ever sees the list — nothing strips them for a scenario
assembled as raw text, so this file format is stricter than a `.pzl`.)

## The keys a test needs

Life, hand, battlefield, turn/phase — see `forge/forge-gui/res/puzzle/*.pzl`
in a checkout that has the submodule (this worktree does not); every key below
was instead read from `forge-build`'s `GameState.java` (the parse-side,
`parseLine`) and `GameState.applyGameOnThread`/`setupPlayerState` (the apply
side) in `~/.cache/cardtable-w8/forge-build`.

| Key | Applies to | What it does |
| --- | --- | --- |
| `turn=N` | the game | `Game`'s turn counter (cosmetic unless a card reads it). |
| `activeplayer=human\|ai` | the game | whose turn it is. |
| `activephase=PHASE` | the game | **jumps** the phase pointer with `PhaseHandler.devModeSet` — no phase-begin/end effects run, so nothing already in play "reacts" to landing here. `PHASE` is a `PhaseType` enum name (`MAIN1`, `UPKEEP`, `COMBAT_DECLARE_ATTACKERS`, `COMBAT_DECLARE_BLOCKERS`, …). |
| `activephaseadvance=PHASE` | the game | **walks** forward from `activephase` to `PHASE` with `PhaseHandler.devAdvanceToPhase`, running `onPhaseEnd`/`onPhaseBegin` for every step crossed — this IS how a trigger that fires "at the beginning of \_\_\_" (upkeep, draw, …) actually fires. Use `activephase` for the step just BEFORE the one you want triggers from, and this for the one you want them from. |
| `human…life=N` / `ai…life=N` | that seat | starting life (applied after state effects; a value `<= 0` is force-set again at the very end, so a scenario *can* start a seat dead-adjacent). |
| `human…hand=Card;Card` | that seat | clears the zone first, every seat, every zone — the hand this scenario hands you is the WHOLE hand. |
| `human…battlefield=Card;Card\|Prop:Val` | that seat | ditto, for the battlefield. A card can carry `\|Tapped:True`, `\|Attacking` (attacks the opponent directly — see below), `\|Id:N` (so another line can reference this exact object), and more (`GameState.java:1235`, `processCardsForZone`). |
| `human…library=Card;Card` | that seat | ditto. **Leave this empty and a draw step loses the game outright** (an empty library is a loss on the next draw) — every scenario here gives both seats a small library of basic lands so a stray draw during a test does not crash it. |
| `human…graveyard=` | that seat | ditto; empty is fine and is what every scenario here uses. |
| `human…counters=KEY=N,KEY=N` | that seat | player-level counters (poison, energy, experience, …), applied via `GameState.applyCountersToGameEntity` (`GameState.java:1127-1134`). `KEY` is a `CounterEnumType` constant NAME, not a display label (`POISON`, `ENERGY`, `EXPERIENCE` — `CounterEnumType.java:496-500`); `CounterType.getType` resolves it case-sensitively against the enum before falling back to a keyword or custom counter. Used by `poison.state`. |

### Combat, specifically

Setting `activephase=COMBAT_DECLARE_ATTACKERS` or `COMBAT_DECLARE_BLOCKERS`
does one more thing beyond the jump: `GameState.applyGameOnThread` reads every
battlefield card's `|Attacking` marker (no `:ID` → attacks the DEFENDING
PLAYER directly) into `Combat`, fires `GameEventAttackersDeclared`, and — only
when the target phase is `COMBAT_DECLARE_BLOCKERS` — calls
`PhaseHandler.devAdvanceToPhase(COMBAT_DECLARE_BLOCKERS)` **itself**, which is
exactly the walk that opens the real `InputBlock` for the defender if they
have anything able to block.

**Do NOT set `activephase=COMBAT_DECLARE_BLOCKERS` directly if the defender
has a creature you need Forge to actually offer.** `GameState.applyGameOnThread`
runs this combat block BEFORE its own unconditional `checkStateEffects(true)`
— so landing straight on `COMBAT_DECLARE_BLOCKERS` makes Forge decide who may
block one state-effects pass before a scripted creature's characteristics
have ever been settled. Measured: a real, untapped, non-sick creature placed
this way was offered as a blocker ZERO times (`wave33-evidence/s3-blockers.md`
has the full repro). `no-creatures.state` and `one-creature.state` instead
set `activephase=COMBAT_DECLARE_ATTACKERS` (which does not have this problem:
`handleCombat` only calls `devAdvanceToPhase` when the target phase IS
`COMBAT_DECLARE_BLOCKERS`), and the test itself drives the one remaining step
— the attacker's own priority stop at Declare Attackers Step — through the
NORMAL game loop, by which point state effects have run.

**And do NOT set `activephase=COMBAT_DECLARE_ATTACKERS` at all if you need
Forge's own LIVE declare-attackers input** (clicking a creature to attack,
seeing "Call Back", clicking it again to undeclare — `attackers-declared.state`'s
claim). `handleCombat` runs for `COMBAT_DECLARE_ATTACKERS` UNCONDITIONALLY,
whether or not any card carries `|Attacking` — an empty attack is still a
manual `GameEventAttackersDeclared` the same way a scripted one is — so
landing there at all skips the real `InputAttack` entirely; there is no live
window for a browser to click into. `attackers-declared.state` instead lands
at seat 0's own Main Phase 1 (an ordinary, no-combat-key landing, exactly
like `own-spell.state`), with the creature untapped and non-sick on the
battlefield (Memnite's default — `GameState.java:1286` sets `c.setSickness(false)`
unconditionally on every card it creates, only reset by an explicit
`|SummonSick` marker, so no scenario here has ever needed one), and the test
presses priority forward through the ordinary main loop so Forge's own phase
transition opens the real window.

### Why this is safe to call from the start-game hook, on the game thread

`HostedMatch.startGame`'s `game.getAction().invoke(() -> … match.startGame(…))`
already dispatches onto Forge's game thread (`GameAction.java:280-294`); the
hook (`PhaseHandler.setupFirstTurn`, `:1018-1021`) runs synchronously on
whatever thread called `startFirstTurn` — the SAME game thread. Blocking
inside the hook (an `InputBlock` ask, an upkeep trigger's `order` ask, …)
*parks that game thread*, exactly as every ordinary ask during play already
does — there is nothing phase-advance-specific about it. `GameState.applyToGame`
itself re-wraps the call in `game.getAction().invoke(() -> applyGameOnThread(game))`
(`GameState.java:582-583`), and `GameAction.invoke` checks
`ThreadUtil.isGameThread()` first and runs the proc INLINE when already on it
(`GameAction.java:2526-2531`) — so this never leaves the thread it started on
and cannot deadlock. See `wave33-evidence/s1-harness.md`.

### What the first priority window offers

The first priority window after a scenario applies offers exactly what the
scripted zones make castable, every time. Every scripted card is a NEW object
to each seat's client. The client resolves card ids when its netty thread
decodes a frame, but it registers a delta's new objects later, on the seat's
`seat-N-ui` thread. So without help, an actionable set naming the scripted
cards could arrive with those cards dropped. To prevent that, the hook asks
Forge for a full-state resync (`resyncSeats` in `bridge/PlayBridge.java`). The
client registers a full state on the netty thread before it decodes the next
frame. `scenario-start.jvm.test.ts` checks this against the real jar. The cause
is in `docs/planning/wave37-evidence/A-repro.md`.

## The scenarios

| File | Proves | Used by |
| --- | --- | --- |
| `lone-spell.state` | seat 1 casts a 0-cost creature; seat 0 holds a counterspell and 3 untapped Islands with the stack holding exactly that one spell. | Q7 |
| `two-spells.state` | seat 1 holds TWO different 0-cost creatures and casts both (holding priority across both casts — see the note below); seat 0 holds a counterspell and 3 untapped Islands. | Q7, second half — "with two on the stack an arrow picks one" |
| `no-creatures.state` | seat 0 has a creature attacking the player directly; seat 1 has NO creature, landing in the Declare Blockers window with nothing to assign. | Q10 |
| `one-creature.state` | as above, but seat 1 holds one untapped, non-sick creature able to block. | Q12 |
| `two-triggers.state` | **VERIFIED wave 34.** Seat 0 controls Dark Confidant AND Phyrexian Arena — two DIFFERENT upkeep triggers (not two of the same card; see the file's own header for why that matters: `PlayerControllerHuman.orderSimultaneousSa` only prompts when the triggers' own text differs or `OrderDuplicates` is set, so two identical Dark Confidants never produced an ask at all, by design). Lands in the opponent's Cleanup Step; a driver passes ordinary priority stops through Untap to seat 0's own Upkeep, where both triggers are queued together. | Q8 |
| `choose-x.state` | Seat 0 holds Fireball (`{X}{R}`) and five untapped Mountains — paying `{R}` leaves exactly 4 mana for X, a known, checkable slider bound (min 0, max 4). Seat 1 is the spell's only legal target and holds nothing to respond with. | §G item 1 (the Choose X slider) |
| `poison.state` | Seat 0 lands in an ordinary, uncontested Main Phase 1 with POISON, ENERGY and EXPERIENCE counters all already non-zero (`humancounters=POISON=3,ENERGY=7,EXPERIENCE=2`; poison kept under the lethal ten). | §B item 1 (the energy line clips) |
| `own-spell.state` | seat 0 holds a 0-cost creature and enough untapped lands; after casting, the stack holds exactly that spell. | Q17 |
| `attackers-declared.state` | seat 0's own uncontested Main Phase 1, with one untapped, non-sick creature on the battlefield and NOTHING pre-declared — the test presses priority forward so Forge's own live `InputAttack` opens for real. | Q14 |
| `ponder.state` | seat 0 holds Ponder and 3 untapped Islands, nothing else on the stack. | Ponder's stack text |
| `auto-target.state` | seat 0 holds Doom Blade and enough mana; seat 1's battlefield holds exactly ONE creature — the only legal target for it. Confirmed: `TargetCards` reaches the wire once the target is selected (a card click — `setSelectables`/`setHighlighted`, not an `ask` — see `wave33-evidence/s3-blockers.md`). | the auto-target arrow (first list's item 8) |
| `glint-hawk.state` | seat 0 controls Shivan Dragon (a permanent with one REPEATABLE, non-tap, no-target activated ability — `{R}: +1/+0` — that uses the stack) and three untapped Mountains, enough to activate it more than once; seat 1 has nothing. | Q18 — how Forge identifies a stack ABILITY (source = the permanent still on the battlefield, and still offered for a SECOND activation while the first sits on the stack) versus a stack SPELL. The original draft used Prodigal Sorcerer's tap ability, which taps itself away on activation — the source is never offered again while its own ability is on the stack, so the e2e built on it could never actually reach Q18's bug (`docs/planning/wave33-evidence/q18-mutation.md`). |
| `secluded-glen.state` | seat 0 holds Secluded Glen and one Faerie card (Faerie Seer), an uncontested turn-1 Main Phase 1, empty battlefields. | wave 35 §S item 1 (R13) — whether playing the land ever asks the seat to reveal a Faerie, or whether it is decided without a question reaching the wire; see `wave35-evidence/s1-secluded-glen.md`. |
| `river-of-tears.state` | seat 0 has River of Tears on the battlefield and an Island plus Faerie Seer in hand, Main 1, turn 1: `e2e/w68-untap.spec.ts`'s second test plays the Island, taps the River by a click for {B} (its sub-ability) and clicks it again — Forge's Undo — which must untap it with nothing left floating, on both screens (ledger AB8; fork `cardtable/w58-undo`). |
| `thoughtseize.state` | seat 0 holds Thoughtseize and an untapped Swamp; seat 1 holds TWO nonland cards (Elvish Mystic, Goblin Guide) and a land (Mountain) — two real choices, not one, so the server's own "one option" `getChoices` shortcut (`onlyAnswer`) does not collapse the discard choice before it can be observed. | wave 35 §S item 3 (R4) — diagnosing and then folding Thoughtseize's three steps into one; see `wave35-evidence/s3-thoughtseize.md`. |
| `raise-the-alarm.state` | seat 0 holds Raise the Alarm (`{1}{W}`, two 1/1 Soldier tokens) and two untapped Plains, an uncontested turn-1 Main Phase 1. | lane E, wave 35 — the R14 token-art e2e spec (a token needs an `<img>`). |
| `bolt-player.state` | seat 0 holds Lightning Bolt (`{R}`, "deals 3 damage to any target") and one untapped Mountain, an uncontested turn-1 Main Phase 1; no creature on either battlefield, so the only legal targets are the two players. | lane E, wave 35 — the R7 drag-to-a-player-casts-at-them e2e spec. |
| `land-into-middle.state` | seat 0 holds Island in hand (land drop still available) and already has TWO lands on the battlefield — Forest and Mountain, different names so a drop's resulting ORDER is readable from the names, not just a count — an uncontested turn-1 Main Phase 1. | lane E, wave 35 — the R9 "any slot" spec: a drop lands in the slot under the pointer, mid-row, not just appended. |
| `land-only-pass.state` | seat 0 holds Raging Goblin (`{R}`) and TWO untapped Mountains (one stays untapped after casting); seat 1 holds nothing and has two untapped Mountains of its own, an uncontested turn-1 Main Phase 1. | wave 35 §S follow-up — the `decideStop`/R15 land-exclusion regression lane E found in `play.spec.ts` ("a spell resolves unattended"); see `auto-pass-land.jvm.test.ts`. |
| `shockland.state` | seat 0 holds Steam Vents, no land played, uncontested Main Phase 1; playing it opens the card's own "pay 2 life?" (InputConfirm Yes/No). | wave 36 T4 (the confirm pop-up) |
| `cavern.state` | seat 0 controls Cavern of Souls, uncontested Main Phase 1; applying it asks seat 0 for a creature type (Cavern's own replacement) right after the mulligan. | wave 36 T7 (ChosenType on the card) |
| `nothing-left.state` | seat 0's own Main Phase 2, after combat: an empty hand and one Memnite (no activated ability), so nothing — not Forge's actionable set, not a possible attack — holds the turn. | End Turn's highlight (`e2e/w35.spec.ts` R5, part 1b), beside `attackers-declared.state`, where the same board in Main Phase 1 must NOT highlight it. |
| `prompts-arc-lightning.state` | seat 0 casts Arc Lightning off three Volcanic Islands at bob's Memnite and bob: `openZones` and `assignGenericAmount`. | `apps/ui/src/play/live/prompts.jvm.test.ts` |
| `prompts-double-block.state` | seat 0 attacks with one Memnite into seat 1's two; both block: `assignCombatDamage`. | `prompts.jvm.test.ts`, `combat-drag.jvm.test.ts` |
| `prompts-brainstorm.state` | seat 0 casts Brainstorm over three different names: `tempShowZones` and `order`. | `prompts.jvm.test.ts` |
| `attack-window-idle.state` | seat 0 attacks with Grizzly Bears beside an untapped Celestial Colonnade (its animation unaffordable off three lands), a land and a sorcery in hand; seat 1 has no creature. | `e2e/attack-window.spec.ts` — no second OK after the attack |
| `attack-window-play.state` | the same attack holding Giant Growth with two Forests up. | `e2e/attack-window.spec.ts` — the window is kept for a real play |

Every scenario sets `turn=1`, both seats' life to 20, and a small library of
basic lands for both seats (so an incidental draw never loses the game) unless
its own claim needs otherwise. None uses `activeplayer=ai`/`activephase=` to
mean "Forge's own AI" — both seats are human-controlled; "ai" is only the
`.pzl` convention for seat 1's keys (`GameState.getPlayerState`).

### `two-spells.state`: getting TWO stack items from the SAME caster

Casting a second spell while the first is still on the stack needs the caster
to ACT again before the server auto-passes their priority window for them
(`match.ts`'s `maybeAutoPass`, Q17's default: a caster does not stop on its
own spell unless it has something left to do). A driver that reacts to wire
frames one macrotask later is normally too late — the auto-pass command is
sent in the same synchronous handling of the `updateButtons` frame that
precedes it. Two ways around that, neither requiring a scenario change:

- **Full control.** Turn on seat 1's full-control escape hatch
  (`forge:full-control` / `Match.setFullControl(1, true)`) before casting the
  first spell. Full control never auto-passes for that seat, so the server
  waits for an explicit click after EACH cast — cast the first 0-cost
  creature, wait for the stack-1 priority window, cast the second, THEN seat
  0 sees `Stack: 2 to Resolve`.
- **A stricter stop policy** (`CARDTABLE_PLAY_STOP_POLICY`, `auto.ts`'s
  `STRICT_PAYMENT_POLICY`/a custom one) that does not auto-pass on an empty
  actionable set — less surgical than full control, since it affects every
  window for that seat, not just this one.

Either way, seat 0's Mana Leak then answers `getChoices` with BOTH stack
items as choices (`min: 0, max: 1`, same shape as `lone-spell.state`'s ask but
with two `choices` entries) — the UI's job is drawing the arrow to whichever
one the player picks.
