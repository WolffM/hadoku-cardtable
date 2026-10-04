# §A — a cast stays hidden until it is on the stack (V3)

> The operator, playtest 6: *"it shouldn't be revealed to the opponent yet when we do
> this. only once something is actually on the stack should it be shown to the
> opponent."*

**Finding: V3 already holds.** Measured against a real Forge jar, the opponent's
socket never receives the cast card's name, face, or any object naming it before the
same wire delta that places it on the stack (or, on a cancel, never at all) — including
under GENUINE manual, tap-one-land-at-a-time payment (§6, added after the manager's
follow-up questioned whether the first pass's single auto-paid tap was representative
of how the operator actually plays). No `visibility.ts` change was needed. This file is
the measurement; `cast-hidden.jvm.test.ts` pins it as a regression test.

## 1. Reading Forge's own order first

`forge/forge-game/src/main/java/forge/game/player/PlaySpellAbility.java`, `playAbility`
(the method every cast — spell or ability — runs through):

- **`:619-626`** — for a spell (not a copy), the card is moved to the Stack zone
  **immediately**, in the JVM's own object graph:
  ```java
  if (ability.isSpell() && !c.isCopiedSpell()) {
      fromZone = game.getZoneOf(c);
      if (fromZone != null) zonePosition = fromZone.getCards().indexOf(c);
      ability.setHostCard(game.getAction().moveToStack(c, ability));
      ability.changeText();
  }
  ```
  This happens **before** targeting is set up (`ability.setupTargets()`, `:677`) and
  **before** the cost is paid (`payment.payCost(...)`, `:683`).
- **`:675-679`** — `announceType()`, `announceValuesLikeX()` (the X slider, additional
  costs' "Announce" param), `setupTargets()` and `canCastTiming()` all run AFTER the
  move to the stack, as part of `preCostRequisites`.
- **`:681-713`** — the stack is frozen, the cost is paid, and if
  `!prerequisitesMet` (the player cancelled, or a requisite failed), the ROLLBACK runs:
  `GameActionUtil.rollbackAbility(ability, fromZone, zonePosition, payment, c)` — the
  card returns to its original zone and position. `PlaySpellAbility.playSpellAbility`
  (`:119-136`) has its own second-layer rollback for the face-down/flip cases on top of
  this.
- **`:725-728`** — only once `prerequisitesMet` and the ability is fully paid does
  `game.getStack().addAndUnfreeze(ability)` run — the moment a human player would call
  "the spell is cast."

So **by Forge's own object graph, the card is zone=Stack from the very start of the
cast attempt** — well before the human has chosen a target or paid anything, and
`visibility.ts`'s `PUBLIC_ZONES` already includes `Stack` (by design, matching
`CardView.java:630-637`). If the bridge pushed a wire delta reflecting that object graph
at any point in this window, the card would be revealed to the opponent before the cast
is actually committed — exactly the operator's complaint. The question the measurement
had to answer: does it?

## 2. Measuring the wire, three ways, against the real jar

All three runs use `scenarios/bolt-player.state` (seat 0 holds Lightning Bolt and one
untapped Mountain, turn 1 main phase 1; "any target" lets it hit the opponent directly)
and `apps/server/src/play/scenario.ts`'s harness, whose `state(seat)`/`sent` already
reflect each seat's **own per-seat `createProjector()` output** — i.e. exactly what that
seat's browser would receive over the wire (`match.ts:1084`, `sendState` projects before
`emit`). So this measurement is over the PROJECTED stream, not Forge's raw one — it is
the thing a real opponent's socket would see.

### 2a. Happy path: cast to completion

Seat 0 selects Lightning Bolt, targets seat 1 (the opponent) via `selectPlayer`,
`answerAsks()` drains the mana-payment confirmation (unambiguous, server auto-pays).
Every frame sent to EITHER seat from the click onward, in order (seed 4040; full capture
kept at `/tmp/claude-1000/w40-A/measure-frames-happy.txt` during the run — not committed,
tmpfs):

```
+58ms  seat0 PROMPT "Lightning Bolt (81) - ... Select any target"
+85ms  seat0 PROMPT "Lightning Bolt (81) - ... Pay Mana Cost: {R}"
+95ms  seat0 applyDelta  (Mountain tapped, mana pool)
+95ms  seat1 applyDelta  (SAME: Mountain tapped, mana pool — no card 81 content)
+100ms seat1 applyDelta  newObjects: card 81 {Name:"Lightning Bolt", Zone:"Stack", ...},
                         stack item {SourceCard:81, TargetPlayers:[1]}, its face
                         {OracleText:"Lightning Bolt deals 3 damage...", ...}
+101ms seat0 PROMPT "Priority: A\nTurn: 1 (A)\nPhase: Main phase, precombat\nStack: 1 to Resolve."
+106ms seat1 PROMPT "Priority: B\n...\nStack: 1 to Resolve."
+119ms (resolves; card 81 moves to Graveyard, still fully named — public zone, correctly)
```

**Seat 1 received NOTHING naming card 81 at any point before +100ms** — not at the
`Select any target` prompt (+58ms, seat 0 only), not at `Pay Mana Cost` (+85ms, seat 0
only), not at the mana-tap delta (+95ms, sent to both, but contains no card-81 content
at all). The FIRST and ONLY frame that names the card to seat 1 is the one that
ALREADY shows `Zone: "Stack"` — the reveal and the stack-placement arrive in the same
delta, within ~1ms of the caster's own "Stack: 1 to Resolve" prompt.

### 2b. Cancel path: abort at the target step

Same scenario, seed 4041. Seat 0 selects Lightning Bolt, and the INSTANT the "Select any
target" prompt appears (before any target is chosen), presses Cancel
(`selectButtonCancel`) instead.

```
+45ms  seat0 openZones (ask)
+68ms  seat0 PROMPT "... Select any target"
+88ms  seat0 restoreOldZones   ← the rollback
+94ms  seat1 applyDelta  newObjects: card 81 {Owner:0, Controller:0, Zone:"Hand"}  — NO Name, NO face
+94ms  seat0 applyDelta  (same event, seat 0's own copy: full card, back in Hand)
+95ms  seat0 PROMPT "Priority: A\n...\nStack: Empty"
```

The card returns to Hand. Seat 1's copy of that event is **already correctly redacted**
by the EXISTING `visibility.ts` rule (`HIDDEN_KEEP` — zone `Hand`, controller ≠ viewer →
`Owner`/`Controller`/`Zone` only, no `Name`). More importantly: **at no point between the
click and the rollback did seat 1 receive anything at all mentioning card 81** — the
string `"Lightning Bolt"` does not appear anywhere in seat 1's frames for this run
(checked by serialising every frame sent to seat 1 and searching the whole transcript).

### 2c. A second mechanism, for corroboration: Fireball's ask-driven targeting

`scenarios/choose-x.state` (Fireball, `{X}{R}`, "divided evenly among any number of
targets" — a `getChoices` ask rather than a click-to-target). With the harness's plain
`answerAsks()` default for `getChoices` (seed 4042), the cast is abandoned by FORGE
ITSELF for want of a valid target selection (the spell returns to Hand, same as 2b, via
a completely different ask mechanism than Lightning Bolt's click-target). Seat 1 never
saw `"Fireball"` at all (`seat1 first saw "Fireball" at +NEVER`, logged during the run).
This is not the primary case the brief asked for (Lightning Bolt in `bolt-player.state`)
and is not part of the committed suite, but it corroborates that the "no delta until
commit" behaviour is not an artifact specific to the click-to-target path.

## 3. Why: where the conclusion sits

Forge's own object graph has the card on the Stack from the first line of the cast
(§1). The bridge/engine does not push a wire delta reflecting that move to EITHER seat
until the whole `playAbility` call finishes — committed (stack, §2a) or rolled back
(hand, §2b) — regardless of how many interactive steps (target prompts, mana payment,
asks) happen in between. This is Forge's/the bridge's own update-flushing behaviour, not
something `visibility.ts` decides — `visibility.ts`'s existing rules (`PUBLIC_ZONES`
includes `Stack`; `Hand` is private to its controller) are sufficient once a delta
exists; the measurement is that no in-between delta exists to redact in the first place.

**No `visibility.ts` change was made.** The per-brief instruction ("If the other seat
learns nothing until the stack, V3 is already true: say so with the evidence and stop")
applies.

## 4. The regression test

`apps/server/src/play/cast-hidden.jvm.test.ts`, four cases against the real jar:

1. *"the other seat sees nothing between the first ask and the spell landing on the
   stack, then sees it there"* (`bolt-player.state`) — casts to completion; asserts, over
   seat 1's OWN frame sequence (not cross-referenced against seat 0's timing, to avoid a
   false failure from near-simultaneous-but-differently-ordered frames), that the FIRST
   frame naming the card already shows `Zone: "Stack"`.
2. *"the other seat sees nothing at all when the cast is cancelled at the target step"*
   (`bolt-player.state`) — cancels before any target is chosen; asserts the string
   `"Lightning Bolt"` never appears anywhere in seat 1's frames for the run.
3. *"manual payment, one land tap at a time … the opponent sees nothing between taps"*
   (`auto-target.state`, §6 below) — casts Doom Blade, targets Memnite, taps ONE Swamp,
   confirms it is actually tapped (never a fixed delay — see §6), THEN checks seat 1's
   frames up to that point, THEN taps the second Swamp and lets it resolve.
4. *"cancel AFTER tapping the first of two lands, before the second"* (`auto-target.state`,
   §6) — same as 3 through the first tap, then cancels instead of tapping the second;
   asserts `"Doom Blade"` never appears anywhere in seat 1's frames for the run.

All four pass 3/3 serially (`heavy`, `--fileParallelism=false`).

## 5. Mutation test

To prove the regression test is non-vacuous (it would actually catch a real early-reveal
regression), `visibility.ts`'s Hand-privacy rule was temporarily broken:

```diff
- if (zone === 'Hand' && controller === who) return true;
+ if (zone === 'Hand') return true; // MUTATION
```

i.e. make every hand visible to every seat — the natural stand-in for "a leak was
reintroduced somewhere upstream of the Hand/Stack split this suite depends on", since
with this measurement finding (no in-between delta exists at all), there is no narrower
single line inside `visibility.ts` to break that would specifically simulate a mid-cast
leak; the Hand/Stack boundary is the whole mechanism the suite is pinned against.

- **Reverted (mutation applied):** `cast-hidden.jvm.test.ts` **4 of 4 fail**
  (the opponent is shown the hand's cards, including both cast cards, immediately
  at game start, long before any cast). Also caught by the EXISTING
  `visibility.test.ts` suite: **3 of 24 unit tests fail** (7 of 28 total across both
  files).
- **Restored exactly** (`git diff apps/server/src/play/visibility.ts` empty):
  **28 of 28 pass** (both files).

## 6. The manager's follow-up: manual, tap-by-tap payment (how the operator actually plays)

The manager's objection to §2a: that happy-path run had exactly ONE mid-cast delta (the
server's own `unambiguousPayment: 'forgeAuto'` policy auto-pressed Forge's Auto for a
cost payable from a single Mountain, in one server-side action). The operator plays by
clicking lands one at a time; **each manual tap is its own delta, sent while the card is
already `Zone: Stack` internally (§1)** — exactly the window where a leak could live
that a single auto-paid tap would never exercise.

**Policy override, so the SERVER never preempts a manual tap:** `MANUAL_PAYMENT_POLICY`
(`{ ...DEFAULT_STOP_POLICY, unambiguousPayment: 'ask' }`). `decidePay` (`auto.ts:1098`)
returns `null` unconditionally for `'ask'`, regardless of source count — unlike the named
`STRICT_PAYMENT_POLICY` (`'auto'`), which could still auto-resolve a FORCED two-source
payment (both Swamps needed, no excess) via `plannedSources`, defeating the point of the
measurement.

**Scenario:** `auto-target.state` (Doom Blade, `{1}{B}`, two Swamps; Memnite the one
legal nonblack-creature target — reused from lane S's wave 33 work, no new `.state` file,
per the manager's constraint).

**What tapping a land during payment actually sends:** clicking a Swamp sends the SAME
`selectCard` wire call as any other card click — Forge's `InputPayMana.activateCard`
auto-activates its sole mana ability without a separate ability choice in the UI sense,
but it DOES still raise a `getAbilityToPlay` ask (answered plainly by `answerAsks()`,
picking the one ability). **Each tap's own `playAbility` (the mana ability itself) is
NOT reentrant**: a second `selectCard` sent before the first tap's ability call finishes
makes the bridge log `"Should wait till previous call to playAbility finishes."` — the
first attempt at this measurement used a fixed 500ms wait between taps and hit exactly
this race under host load, producing a spurious "timed out waiting for the spell to
resolve" failure with zero bearing on V3. Fixed by waiting for the FACT (`tapped ===
true` on that specific Swamp), never a timer — the same lesson `docs/WAVE_WORKTREE.md`-
adjacent files in this repo keep re-learning about this host.

**The measurement, tap 1 alone (seed 4043, before the second tap):**

```
promptAfterTap1 = "Doom Blade (81) - Destroy Memnite (92).\n\nPay Mana Cost: {1}"
seat 1 frames received between tap 1 landing and tap 2 starting: 0
leaked "Doom Blade": 0
```

**Zero frames at all** reached seat 1 in the window between the first Swamp finishing its
tap and the second Swamp being touched — not even an untargeted land-tap delta (unlike
`bolt-player`'s single-Mountain case, where the land-tap delta WAS sent to both seats,
just with no card-81 content). The first and only frame that ever names `"Doom Blade"` to
seat 1, over the WHOLE run from the click, is `seq=6`, already carrying
`Zone: "Stack"` and the stack item's `TargetCards: [92]` (Memnite) — same shape as
§2a, now confirmed under genuine two-tap manual payment:

```json
{"newObjects":{"81":{"Zone":{"v":"Stack"},"Name":{"v":"Doom Blade"}, ...},
 "<stackItem>":{"ActivatingPlayer":{"v":0},"TargetCards":[{"v":92}], ...}}}
```

**Cancel mid-pay (seed 4044):** taps the first Swamp (waits for the fact, as above), then
presses Cancel before touching the second. Doom Blade rolls back to hand. `"Doom Blade"`
never appears anywhere in seat 1's frames for the whole run (0 leaked).

**Conclusion: V3 holds under genuine manual, tap-by-tap payment too.** The mechanism is
the same one §3 already identified — the bridge does not flush a delta reflecting the
cast card's state until `playAbility` commits or rolls back — and it holds independent
of how many separate land-tap round-trips happen along the way, because each tap's own
delta carries only that land, never the spell.

**Item 3 of the manager's follow-up (Fireball, X=1, manual pay) was not attempted.**
Fireball's targeting goes through a `getChoices` ask rather than a card click (§2c), and
driving it to a successful X=1 cast (rather than Forge abandoning it, as in §2c) needs
answering that ask with a specific, non-default reply plus a correct `Announce` value —
not attempted given the manager's own phrasing ("if you can drive it") and the stronger,
structurally-identical result already in hand from Doom Blade's two-tap case. Flagging
this as unattempted rather than silently skipping it.
