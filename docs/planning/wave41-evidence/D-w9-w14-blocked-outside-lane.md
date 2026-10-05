# W9 and W14 — blocked outside this lane's row

Both items need data `apps/ui/src/play/live/gestures/*` cannot manufacture:
Forge's own wire protocol does not publish per-player or per-planeswalker
target/defender legality, and the file that would have to change to add it
(`apps/ui/src/play/live/match.ts`'s `boardInteraction`, and for W14's
persistent arrow also `apps/ui/src/play/adapter.ts`/`apps/ui/src/play/fold.ts`
plus a new `packages/forge-wire` field) is not in this lane's row. Per the
wave file: *"If the persistent attack arrow (W14) or anything else genuinely
needs a file outside this row … STOP and report which file and why — do not
edit it."* This is that report.

## W9 — "the arrow for 'grasp of darkness' should not snap to player avatars. player is not a valid target for that spell so the arrow should not snap."

### The gesture layer already does the one thing it can: snap only to what `boardInteraction` offers

`targets.ts`'s `targetUnder` checks `offered.selectablePlayers.has(id)`
before ever treating a player's face as a drop target, and this is already
pinned by an EXISTING test in `gestures.test.ts` ("a player is a legal
target for the whole selection, but the arrow only snaps to their FACE —
never their whole seat by default") — whose own doc comment says plainly:
*"`boardInteraction` makes BOTH players selectable for the whole of an open
selection … so a portrait being a LEGAL target is not by itself what draws
the arrow at one."* That test's own assertion —
`expect(boardInteraction(m).selectablePlayers.size, 'both seats are legal
targets throughout the selection').toBeGreaterThan(0)` — is the data this
report is about: it is unconditional, for ANY open selection, regardless of
what the spell can actually target.

### Root cause: `match.ts`'s `boardInteraction`, lines ~1031-1032

```ts
const players = new Set<number>();
if (selection !== null) for (const p of view.players) if (!match.spent.players.has(p.id)) players.add(p.id);
```

Every player is added whenever ANY selection is open — never narrowed by
what the selection's own cards say about the spell. `match.ts`'s own header
explains why, and that it is deliberate, not an oversight (`match.ts:128-142`):
Forge's `setSelectables` carries CARDS ONLY
(`packages/forge-wire/src/tier-b.ts`'s `SetSelectablesSchema`, verified
against `IGuiGame.java:272`); `InputSelectTargets.onPlayerSelected` validates
a player only AFTER it is clicked (confirmed by reading
`forge/forge-gui/.../input/InputSelectTargets.java:334-360`:
`sa.canTarget(player)` is the real legality check, and it runs only once a
click has already happened). There is no wire signal that distinguishes "this
creature-only removal spell" from "Lightning Bolt, which can hit a player" —
both open the identical `setSelectables(cards=[...], min, max)` shape.

### Why the fix cannot be narrower than match.ts

The existing design keeps `selectablePlayers` non-empty for every open
selection PRECISELY so a real player-can-be-targeted spell (the existing
`bolt-player.state` scenario, wave 35's R7) still offers a face. A
gesture-layer-only fix (narrowing `targetUnder`'s player hit-test further)
cannot distinguish Doom Blade from Lightning Bolt either — the data it
would need (does THIS spell's target restriction include players) does not
exist on the client at all. Removing the blanket offer in `boardInteraction`
would fix Doom Blade and break Lightning Bolt-at-a-player in the same edit;
threading real per-spell legality through needs either a bridge change
(Forge does not publish it) or a project decision to accept a different
approximation — both outside a 2-hour gesture-layer lane.

### Mutation test (the half this lane could prove)

Reverted `targets.ts`'s `data-player-face`-only hit-test to also match the
whole `[data-testid="player"]` seat (the ORIGINAL item-17.1 bug). Result:
the existing pinned test fails — `expected 'player:1' to be undefined`,
received `'player:1'` — confirming the hit-test narrowing this lane already
has is load-bearing. Restored: passes. (Counts folded into the closing
report: reverted 1 of 1 fails, restored 1 of 1 passes.)

### Real-Forge reproduction — attempted, not completed within the time budget

Scenario `apps/server/src/play/scenarios/w41-grasp.state`: Doom Blade
("Destroy target nonblack creature", mandatory) with TWO legal creature
targets (one Memnite per side), so Forge opens a genuine
`InputSelectTargets` ask rather than auto-targeting the lone-choice
shortcut. A throwaway diagnostic spec (`e2e/w41-diag.spec.ts`, deleted before this
report closes — `e2e/arrows.spec.ts` is this lane's only committed file
under `e2e/`) was written to drive it: cast Doom Blade, wait for both
Memnites to show `data-selectable` (confirming a genuine two-target
selection, not an auto-target), hover each player's `data-player-face`, and
click the opponent's face to see whether `selectPlayer` actually leaves the
browser. It never ran: the shared `/tmp/claude-1000/heavy.lock` was held by
w42's own verification run for 45+ minutes while this lane was waiting on
it, and by the time this lane stopped waiting, w43, w44 AND w45 were ALSO
queued behind the same hold (`ps` showed all four `flock -x
/tmp/claude-1000/heavy.lock …` waiters at once) — a cross-wave
infrastructure problem, not a defect in this lane's own work, and worth the
tracker's attention in its own right.

This half is UNVERIFIED by a live run. The code-level diagnosis above (every
claim cited to a specific line in Forge's own source or this repo's own
pinned test) is the evidence that exists; it was not additionally confirmed
against a running match within this lane's time budget.

## W14 — "player doesn't show as a valid target [for attacking], and after attackers tap a persistent arrow should be showing as to what they are attacking"

### Half 1 — the defending player / an opposing planeswalker as a drop target

Read `forge/forge-gui/.../input/InputAttack.java` directly:
`onPlayerSelected` (`:169`) and the planeswalker branch of `onCardSelected`
(`:230-236`) both exist and both work on Forge's side — clicking a legal
defender (a player, or a card `defenders.contains(card)`, i.e. a
planeswalker or battle) calls `setCurrentDefender`. But
`pushAttackerCandidates` (`PlayerControllerHuman.java`, the ONLY thing
`InputAttack` calls `setWeaklySelectable` with) offers only
`attackingPlayer.getCreaturesInPlay()` — never a defender, player or
planeswalker alike. And `boardInteraction`'s own `players` set is gated on
`selection !== null` (see W9 above), which `InputAttack` never opens either.
So neither a defending player's face nor an opposing planeswalker's card
ever reaches `offered.selectable`/`offered.selectablePlayers` during
declare-attackers, by the same wire gap as W9 — again `match.ts`, not this
lane's file.

**Not purely academic**: even if `boardInteraction` were widened, this
lane's OWN `commit.ts` would still send the frames in the WRONG ORDER for a
planeswalker. `InputAttack.onCardSelected`'s planeswalker branch only sets
the CURRENT DEFENDER (`:232`) — it does not declare anything — and the
ATTACK is declared by the creature's OWN click afterwards, read against
whatever `currentDefender` now is (`:238-256`). `commit.ts`'s generic
card-target branch sends the DRAG SOURCE (the creature) first, then the
drop target (the planeswalker) second — backwards, the same shape
`isBlockAssignment` already exists to fix for blocking. This half IS fixable
inside this lane's `commit.ts` once the data gap closes, and is written
down here rather than attempted blind: a fix that cannot be exercised
against real Forge (because the planeswalker is never offered in the first
place) is not provable, and an unprovable change is not this lane's to ship.

### Half 2 — the persistent post-declaration arrow

`StackEntry`/`BoardCard`'s own `attacking` field
(`apps/ui/src/play/adapter.ts:203,837`, off Forge's `Attacking` BooleanType,
`packages/forge-wire/src/tier-c.ts:339`) is a bare boolean — WHICH defender
each attacker is attacking is not on the wire at all. Forge's own
`TrackableProperty` has the field (`AttackersWithDefenders`,
`GenericMapType`, confirmed by reading
`forge/forge-gui/.../trackable/TrackableProperty.java:233`), but nothing in
`packages/forge-wire`, `apps/ui/src/play/fold.ts` or `apps/ui/src/play/adapter.ts`
reads it — none of which are this lane's files. Drawing a per-attacker arrow
without it would mean GUESSING the defender whenever more than one exists
(exactly the planeswalker case the brief's own proof asks for), which is
inventing a fact the wire does not carry — the one thing every file in this
lane explicitly refuses to do (`match.ts`'s own header: *"we implement no
rules"*). For the DEGENERATE case (no planeswalker, exactly one possible
defender) the arrow could be drawn correctly with zero new data, but that is
not what the brief's own proof requirement asks for, and building it without
being able to prove the interesting case felt like checking a box rather
than doing the work.

### Real-Forge reproduction — attempted, not completed within the time budget

Scenario `apps/server/src/play/scenarios/w41-planeswalker.state`: seat 0 has
one untapped, non-sick Memnite and an uncontested Main Phase 1 (same shape
as the existing `attackers-declared.state`, so the test presses priority
forward and Forge's own live `InputAttack` opens for real); seat 1 controls
Jace Beleren. The same throwaway diagnostic spec would have pressed priority
to the declare-attackers window, read Jace Beleren's own `data-selectable`
(expected: absent, per the Java analysis above), and dragged Memnite onto
Jace Beleren to see what — if anything — gets sent. It never ran, for the
same lock-contention reason as W9's reproduction above. UNVERIFIED by a live
run; the code-level diagnosis is the evidence that exists.

## The diagnostic script

`e2e/w41-diag.spec.ts` was written to drive both reproductions above, and
never produced output (see each section). It is NOT a committed file — this
lane owns no path whose job is "prove a bug that cannot be fixed here", and
leaving a permanently-red (or permanently-skipped-for-the-wrong-reason) spec
in the suite is worse than not having one. Deleted before this report
closes.
