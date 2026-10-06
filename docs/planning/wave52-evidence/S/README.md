# Wave 52 §S — evidence

Run 2026-10-06 on hokon, Node 24.18.0. Jar: the w52 build (sha256 `984f247a…a6a3`, fork
`cardtable/w52-mana` @ `e5db0510`). Res: the main checkout's `forge/forge-gui/res` (the fork's
two commits are Java only). Work dir: `~/.cache/cardtable-play-work/w52-s` (disk, never tmpfs).

## What changed

| ask | fact on the wire | decision |
| --- | --- | --- |
| Signet must not hold priority | `setWeaklySelectable.manaOnly`: offered cards whose every playable ability is a mana ability | `PromptFacts.nonManaSources` (was `nonLandSources`) drops own lands AND `manaOnly` ids |
| (A) Augur's upkeep stops | `setWeaklySelectable.phaseRestricted`: own battlefield permanents with a playable non-mana ability whose `ActivationPhases` restriction is set | `StopPolicy.stopForPhaseAbility`: a skipped phase is not skipped while it is non-empty |
| (B) the chosen cost confirms itself | `showPromptMessage.confirmAbility`: `InputConfirm.sa`'s host card and id | `StopPolicy.costConfirm: 'accept'` (default) + `chosenCostConfirm`: Yes only for the ability chosen from `getAbilityToPlay` since the last `Priority:` prompt; the prompt is withheld and its buttons re-sent disabled |

All three are read by `PlayBridge.java` off Forge's objects (`Card.getAllPossibleAbilities(player,
true)`, `SpellAbilityRestriction.getPhases()`, `InputConfirm.sa`), never off card text. The schemas
are strict and additive (`tier-b.test.ts` pins both: old frames parse, unknown keys and wrong ref
kinds are refused). A bridge read that throws omits the field, which reads as "no such card": the
stop the server always made.

### Why `manaOnly` is a wire fact and not read from the card views

The brief asked to decide from what the server already receives if possible. It is not: the card
views carry types, `OrigProduceMana` (land types only) and the ability TEXT. "An artifact whose
only abilities are mana abilities" would mean parsing `AbilityText` prose, which `auto.ts`'s own
rule forbids. Forge knows it exactly (`SpellAbility.isManaAbility`), so the bridge says it.

### Why `phaseRestricted` leaks nothing

The fact names only permanents on the seat's own battlefield, and a permanent and its rules text are
public. Whether the restriction is met now depends on the phase and whose turn it is (public), and
the card being in Forge's offer (it is affordable: Augur's sacrifice costs nothing but itself, and
an ability with a mana cost is affordable from lands and a pool everyone can see). Nothing in the
hand enters into it: the control test holds a castable Dark Ritual and no Augur, and its upkeep is
passed exactly as wave 28 decided. A stop here tells the table "Augur is in play during your
upkeep", which the table already sees.

## Real-Forge suites

- `w52-s-augur.jvm.test.ts` — Augur + Mirri's Guile + two Swamps, walked from UNTAP:
  - the first empty-stack upkeep window is a stop (no pass before it);
  - Mirri's optional trigger confirm reaches the seat (asked, declined);
  - choosing Augur's sacrifice: `auto-confirmed` once, and no "Sacrifice Augur of Skulls?" prompt is
    ever sent to the seat;
  - `phaseRestricted` named exactly Augur.
  - Control (`w52-s-instant.state`): Dark Ritual offered in the upkeep, `phaseRestricted: []`, the
    upkeep `auto-passed` once.
- `w52-s-signet.jvm.test.ts` — seat 1 holds Azorius Signet + two Islands and an empty hand while
  seat 0's Raging Goblin is on the stack: the offer names the Signet (the new jar), `manaOnly` equals
  the whole offer, seat 1 is `auto-passed`, the Goblin resolves.

Consecutive runs, final code: augur ×3 + signet ×3 all green (`Tests 3 passed (3)` ×3), then augur
×3 again after the buttons-order fix (`2 passed` ×3).

## Mutations (reverted, re-run, restored)

| mutation | unit (`auto.test.ts`, 190 tests at the time) | real Forge |
| --- | --- | --- |
| the Signet counts as actionable (`manaOnly` dropped from `nonManaSources`) | 3 failed | `w52-s-signet`: 1 of 1 failed |
| the restriction fact's read dropped (`phaseRestricted: []`) | 1 failed | `w52-s-augur`: the Augur case failed, 1 of 1 |
| the "just chosen" check dropped (null check and the host/ability match) | 5 failed | `w52-s-augur`: 3 of 3 runs failed on "Mirri's Guile's optional trigger was put to the seat" |

Restored after each: `auto.ts` byte-identical to the saved copy (`cmp`), suites green.

## Found on the way

- **Forge asks `getAbilityToPlay` for a trigger too.** Mirri's upkeep trigger arrives as a
  one-ability `getAbilityToPlay` (`s0-1`, host Mirri's Guile, ability 235) before the trigger's
  priority window. It sets the "chosen" ability, and the `Priority:` prompt that follows clears it,
  which is what keeps a trigger's own "may" from being answered.
- **The first B build flashed the question.** `InputConfirm` sends its Yes/No buttons before the
  prompt, so an answer decided on the prompt left a live Yes on the seat's bar for one round trip.
  The real-Forge suite caught it as a race (the driver saw the prompt and pressed it too). The prompt
  is now withheld and the buttons re-sent disabled; the decision also runs when the buttons arrive
  after the prompt (unit-tested both orders). Before that fix the mutation run was red only 1 of 2.
- **The UI's `nothingToDecide` (`apps/ui/src/play/live/match.ts`) still counts own lands only.**
  It drives the End Turn highlight (R5). With a Signet offered, End Turn is not highlighted for that
  seat. It is outside this lane's files, and the server's auto-pass (what the operator felt) is
  fixed, so it's left for the next wave: fold `manaOnly` into `LiveMatch` and read it there.
