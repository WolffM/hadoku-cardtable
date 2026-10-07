# Wave 53 §P — prompt words (Y18)

Operator, 2026-10-06, live match `m-6ce49e226aef`: *"i played vensor and the
decision box has this as the title: 'Select target permanent or
Card.inZoneStack' thats a bit ugly, can we give that friendly words? it also
has an ugly '<-- CARDS ON THE BATTLEFIELD -->' slot at the beginning. maybe
instead of doing that just use a vertical line seperator?"*

## 1. Where the ugly text comes from (Forge, read, not modified)

`forge/forge-gui/res/cardsfolder/v/venser_shaper_savant.txt:7`:

```
SVar:VensersBounce:DB$ ChangeZone | ValidTgts$ Permanent,Card.inZoneStack | TgtZone$ Stack,Battlefield | Origin$ Battlefield,Stack | Destination$ Hand
```

No `TgtPrompt$` and no `ValidTgtsDesc$` on this card at all — confirmed by
`grep -rl 'ValidTgts\$ Permanent,Card.inZoneStack\|ValidTgts\$ Card.inZoneStack,Permanent\b' forge-gui/res/cardsfolder | while read f; do grep -q 'TgtPrompt\$\|ValidTgtsDesc\$' "$f" || echo "$f"`
which returns **only** `venser_shaper_savant.txt` — the one card in the whole
cardsfolder with this exact `ValidTgts$` shape and no author override, so it
is the only card that reaches a client with Forge's raw builder output
unfixed.

The builder itself:

- `forge-game/src/main/java/forge/game/spellability/TargetRestrictions.java:136-150`
  (constructor): no `TgtPrompt$` → `this.uiPrompt = "Select target " + validTgtsDesc`,
  and `validTgtsDesc = Lang.getInstance().buildValidDesc(Arrays.asList(validTgts), maxTargets != "1")`.
- `forge-core/src/main/java/forge/util/Lang.java:226-242` (`buildValidDesc`/`formatValidDesc`):
  a token is lowercased only when it is exactly one of five bare words
  (`Player`, `Opponent`, `Card`, `Spell`, `Permanent`) or `CardType.isACardType`
  says so — a **core** type (`Creature`/`Artifact`/`Land`/`Enchantment`/
  `Planeswalker`/`Instant`/`Sorcery`/`Battle`/`Tribal`), never a subtype and
  never a `Type.Qualifier` expression. Anything else is appended VERBATIM.
  `Card.inZoneStack` (a `Card` whose zone is the Stack — i.e. a spell) is
  exactly such an expression, so Venser's own `uiPrompt` reaches the wire as
  `"Select target permanent or Card.inZoneStack"`.
- `forge-core/src/main/java/forge/util/Lang.java:97-115` (`joinHomogenous`):
  2 items join as `"A or B"`; 3+ items as `"A, B or C"` — **no comma before
  the last union word**. Confirmed by hand-tracing the loop (`remaining`
  decremented before the `remaining == 1` check fires).

**Which real ask this is, on our own wire** (not `setSelectables` — read
closely, because `SelectionPrompt.tsx`'s own module header implies every
target ask is a selection, and Venser's is not):

- `TargetSelection.java`'s `chooseTargets` (`:182-193`): `TgtZone$
  Stack,Battlefield` means `zones.size() != 1`, so it takes the **`else`**
  branch — `chooseCardFromList`, never `InputSelectTargets`/`setSelectables`.
- `chooseCardFttromList` (`TargetSelection.java:199-297`) groups candidates by
  zone and splices a marker string before each non-empty group —
  `"--CARDS ON BATTLEFIELD:--"`, `"--CARDS IN STACK:--"`, `"--CARDS IN
  EXILE:--"`, `"--CARDS IN GRAVEYARD:--"`, `"--CARDS IN LIBRARY:--"`,
  `"--CARDS IN ANTE:--"` (`:228-250`) — into the SAME list of `Object`s it
  hands `controller.getGui().one(message, choicesFiltered)` (`:265-266`),
  where `message = tgt.getVTSelection()` with **no card-name prefix** (unlike
  `InputSelectTargets.showMessage()`, which prepends `sa.getHostCard() + " - "`).
- `one()`/`oneOrNone()` are both thin wrappers over `getChoices`
  (`forge-gui/src/main/java/forge/gamemodes/match/AbstractGuiGame.java:762-779`).
- `PlayBridge.java`'s own `choices()` (`apps/server/src/play/bridge/PlayBridge.java:1403-1425`)
  turns every item in that list into an ordinary `{key, label, ref}` option —
  the marker string included, as `{label: "--CARDS ON BATTLEFIELD:--", ref:
  null}`, because it has no way to know the string is not really an option.

So Venser's ask reaches our client as a **`getChoices`** ask (`ChoicePrompts.tsx`'s
`GetChoicesPrompt`), its `message`/title is the raw, unfixed `uiPrompt`
above, and its `choices` array carries the zone-header strings as phantom,
`ref: null` options alongside the real `CardView` ones.

## 2. The fix

`apps/ui/src/play/prompts/lookup.ts`:

- `translateTargetWords(text)` — a pure substring translation. Finds every
  substring shaped like a raw `ValidTgts$` token (`/\b[A-Z][A-Za-z0-9]*(?:[.+][A-Za-z0-9_]+)+\b/g`
  — a capitalised identifier with at least one `.`/`+` qualifier; Forge's own
  bare recognised words have no dot and are already lowercase by the time
  they reach us, so they never match) and replaces each one with words, using
  Forge's own vocabulary wherever another real card's author already wrote it
  by hand for the identical qualifier (cited inline in `lookup.ts` and in the
  shape table below). Everything else — Forge's own "or"/"and/or"/", " joins
  included — passes through untouched, so running this over ANY prompt text
  is safe: prose with no raw token in it comes back unchanged.
- `isZoneDividerLabel(label)` — `/^--.+--$/`: true only for the marker
  strings `chooseCardFromList` splices in, never a card name or `[FINISH
  TARGETING]`.
- `plainRulesText` now runs `translateTargetWords` first, so every EXISTING
  caller (`ChoicePrompts.tsx`'s per-choice labels and ability names,
  `OrderPrompt.tsx`, and — through `LiveBoard.tsx`'s own existing
  `plainRulesText(match.prompt ?? '')` calls, unowned this wave but already
  wrapping every `says`/`ConfirmPrompt`/`SelectionPrompt` message — the
  board's own status line and every selection's title) gets the translation
  for free, with no change to those files.

`apps/ui/src/play/prompts/ChoicePrompts.tsx` (owned):

- `GetChoicesPrompt`'s title: `ask.message` → `plainRulesText(ask.message)`.
- `ChooseSingleEntityPrompt`/`ChooseEntitiesPrompt`'s title: `ask.title` →
  `plainRulesText(ask.title)` (these never carry a `ValidTgts$` token today —
  that ask shape carries `GameEntityView`s, never a raw Java `String` — but
  translating defensively costs nothing, since a string with no raw token is
  unchanged).
- `GetChoicesPrompt`'s choice list: a choice whose `ref` is `null` and whose
  `label` is `isZoneDividerLabel` renders as `<li className="prompt__divider"
  role="separator" aria-hidden="true" />` — no tick, no `data-testid`, so it
  can never enter `chosen`/the reply, and no text at all (the wave's own "no
  text of ours" rule — not even the zone's own name).

`apps/ui/src/play/prompts/SelectionPrompt.tsx` (owned): defensively runs
`plainRulesText` on its own `message` prop too (idempotent — a caller that
already translated it, as `LiveBoard.tsx` does today, sees no change), because
`InputSelectTargets.showMessage()`'s own `tgt.getVTSelection()` can carry the
identical raw-token bug for a pure-battlefield target ask, not only Venser's
stack-spanning one.

`apps/ui/src/play/prompts/prompts.css` (owned): `.prompt__cards > li.prompt__divider`,
`.prompt__list > li.prompt__divider` — a bare `border-top` rule line, `grid-column:
1 / -1` so it spans every column of the card grid; specificity bumped
(class + element, matching the base `.prompt__cards > li`/`.prompt__list >
li` rules' own) to actually clear their padding/background/border, which a
plain `.prompt__divider` alone does not beat.

## 3. The shape table (`lookup.test.ts`)

Every `raw` input below is Forge's own real default-builder output for the
cited card's real `ValidTgts$` (no override), computed by hand against
`Lang.java`'s `buildValidDesc`/`formatValidDesc`/`joinHomogenous` — not
invented. Where another card's author independently wrote a `TgtPrompt$` for
the identical qualifier, it is cited as the source of the `expected` column's
wording.

| shape | raw (Forge's own builder output) | words | source |
| --- | --- | --- | --- |
| `Permanent,Card.inZoneStack` | `Select target permanent or Card.inZoneStack` | `Select target permanent or spell` | `venser_shaper_savant.txt:7` (no override — the operator's own repro) |
| `Card.inZoneStack` alone | `Select target Card.inZoneStack` | `Select target spell` | `futurist_spellthief.txt:7`'s own `TgtPrompt$` |
| `Card.inZoneStack+Creature,Card.inZoneStack+Planeswalker` | `Select target Card.inZoneStack+Creature or Card.inZoneStack+Planeswalker` | `Select target creature spell or planeswalker spell` | `subtlety.txt:8`'s own `TgtPrompt$` |
| a bare recognised word | `Select target player` | `Select target player` (unchanged) | `Lang.java:233-242` already lowercases it |
| `Creature.YouCtrl` | `Select target Creature.YouCtrl` | `Select target creature you control` | many cards' own `TgtPrompt$` (e.g. the `Ally.YouCtrl` family) |
| `Creature.OppCtrl` | `Select target Creature.OppCtrl` | `Select target creature an opponent controls` | cards' own `TgtPrompt$`, e.g. `"Choose target creature an opponent controls."` |
| `Land.nonBasic` | `Select target Land.nonBasic` | `Select target nonbasic land` | `smolder`-shaped cards' own `TgtPrompt$` |
| `Permanent.YouCtrl+nonLand` | `Select target Permanent.YouCtrl+nonLand` | `Select target nonland permanent you control` | cards' own `TgtPrompt$` |
| `Creature.attacking` | `Select target Creature.attacking` | `Select target attacking creature` | `Zombie.attacking`-shaped cards' own `TgtPrompt$` |
| `Creature.tapped` | `Select target Creature.tapped` | `Select target tapped creature` | cards' own `TgtPrompt$` |
| `Creature.powerGE3` | `Select target Creature.powerGE3` | `Select target creature with power 3 or greater` | cards' own `TgtPrompt$` |
| `Creature.Other,Card.inZoneStack` | `Select target Creature.Other or Card.inZoneStack` | `Select target another creature or spell` | `aang_swift_savior_aang_and_la_oceans_fury.txt:8`'s own shape; `.Other` cards' own `TgtPrompt$`/`ValidTgtsDesc$` read "another …" |
| a synthetic 3-item list | `Select target Instant.YouOwn, Sorcery.YouOwn or Card.inZoneStack` | `Select target instant you own, sorcery you own or spell` | `joinHomogenous`'s own 3-item join, traced by hand |
| a mana-value comparison composed with `inZoneStack` | `Select target Permanent.cmcGE1 or Card.inZoneStack+cmcGE1` | `Select target permanent with mana value 1 or greater or spell with mana value 1 or greater` | `CardProperty`'s own `cmcGE`/`.inZoneStack` grammar |
| `with<Keyword>` | `Select target Creature.withFlying` | `Select target creature with flying` | generic regex (no cube card hits this through the default builder) |
| an unrecognised qualifier | `Select target Creature.ExiledWithSource` | `Select target creature exiled with source` | long-tail fallback — humanised, never raw CamelCase |

Full test: `apps/ui/src/play/prompts/lookup.test.ts`, `describe('translateTargetWords
— Forge's ValidTgts expressions, in words')` (16 cases) + `describe('isZoneDividerLabel')`
(9 cases).

## 4. Unit test runs

A plain vitest unit run (TS only, no `dist/`, no JVM) needs no `heavy.lock`
(the coordinator's own correction mid-wave — builds/e2e/jvm/`check` still do).
With `CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES` unset:

```
$ pnpm exec vitest run apps/ui/src/play/prompts/lookup.test.ts
 ✓ apps/ui/src/play/prompts/lookup.test.ts (30 tests) 8ms
 Test Files  1 passed (1)
      Tests  30 passed (30)
```

Every file this lane touches, plus every reader checked in §8, green:

```
$ pnpm exec vitest run apps/ui/src/play/prompts/ --exclude "**/*.jvm.test.ts"
 Test Files  14 passed (14)
      Tests  300 passed (300)

$ pnpm exec vitest run apps/ui/src/play/live/LiveBoard.test.ts apps/ui/src/play/live/match.test.ts apps/ui/src/play/live/gestures/gestures.test.ts
 Test Files  3 passed (3)
      Tests  407 passed (407)

$ pnpm exec vitest run --exclude "**/*.jvm.test.ts" apps/ui
 Test Files  56 passed (56)
      Tests  1529 passed (1529)
```

No regression anywhere in the UI package.

## 5. Mutation

`translateTargetWords` temporarily changed to `return text;` (no replace at
all), `lookup.test.ts` rerun, restored, rerun again:

```
# translation OFF
 ❯ apps/ui/src/play/prompts/lookup.test.ts (30 tests | 16 failed) 15ms
   Test Files  1 failed (1)
        Tests  16 failed | 14 passed (30)
```

Every one of the 16 failures is a `translateTargetWords`/`plainRulesText`
table-test case (all 14 `isZoneDividerLabel` cases and the two tokenless
pass-through cases still pass unaffected, as expected — the mutation only
touches the translator). Restored:

```
# translation back on
 ✓ apps/ui/src/play/prompts/lookup.test.ts (30 tests) 8ms
   Test Files  1 passed (1)
        Tests  30 passed (30)
```

## 6. The real-Forge e2e proof

`e2e/w53-prompt-words.spec.ts`: start the scenario `w53-p-venser`, have bob
(ai) cast a cheap instant (`Opt`) first, have alice (human) cast Venser,
Shaper Savant in response (Flash), pass priority on both sides until
Venser's own ETB target ask opens, then assert the rendered `.prompt__title`
reads exactly `"Select target permanent or spell"` and that at least one
`li.prompt__divider` (no tick, `tabIndex === -1`) splits the battlefield
group from the stack group, with the tick count equal to the real-card-row
count (the dividers excluded).

**It was blocked, then unblocked.** `apps/server/src/play/scenarios/*.state`
is the only mechanism this codebase's e2e specs use to put a named card in a
hand deterministically (`e2e/play/scenario.ts`'s own module header: "a match
whose
opening state Forge is TOLD, not dealt" — `readScenario` is a straight
`readFileSync` off that directory; there is no "custom deck, no scenario"
e2e path anywhere in this codebase to fall back to, and a random `decks: [dck,
dck]` draw cannot deterministically put the ONE card in the whole cardsfolder
that reproduces this bug into an opening hand). `grep -rl Venser apps/server/
src/play/scenarios/*.state` finds nothing, and no other card shares Venser's
exact `ValidTgts$ Permanent,Card.inZoneStack` shape with no override (checked
in §1) — so no substitute card reproduces the real bug either. Lane P's own
brief is explicit: *"You do NOT own a new `.state` file … if that is
impossible, stop and report which file you need."* This is that report.

**The file needed**, proposed verbatim (the `.state` shape is read off
`w46-b-counterspell.state` and `w52-e-signet.state`, both already in the
tree):

```
# wave 53 §P — Venser, Shaper Savant's own target ask with no TgtPrompt$
# override (venser_shaper_savant.txt:7 — ValidTgts$ Permanent,Card.inZoneStack
# is the one shape in the whole cardsfolder with no author override, so it is
# the only card that reproduces Y18 against a real jar). Bob (ai) casts Opt
# first; Alice (human) holds Venser and enough mana (2UU, Flash) to cast it
# in response — both a battlefield permanent (an Island) and a spell on the
# stack (Opt) are legal targets at once when Venser's own trigger asks.
turn=1
activeplayer=ai
activephase=MAIN1
humanlife=20
ailife=20
humanhand=Venser, Shaper Savant
humanbattlefield=Island;Island;Island;Island
humanlibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain
humangraveyard=
aihand=Opt
aibattlefield=Island
ailibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain
aigraveyard=
```

**The wave manager wrote this file**, verbatim to the proposal above, at
`apps/server/src/play/scenarios/w53-p-venser.state` (manager-owned; this lane
still does not edit it).

**First run, red — a second ask the helper did not know about.** The spec's
own diagnostic dump (added per the memory note, "a frozen status line is
usually an unhandled ask, not a dropped press") caught it directly:

```
[w53-P diag] alice: says="Priority: Alice
Turn: 1 (Bob)
Phase: Main phase, precombat
Stack: 2 to Resolve." promptMethod=getAbilityToPlay enabledOkCount=0
[w53-P diag] bob: says="Waiting for Alice..." promptMethod=null enabledOkCount=0
```

Alice was stuck on a lone `getAbilityToPlay` ask (Venser's own cast), not
silence and not the target ask — `rules.ts`'s `autoAnswer` would normally
settle a one-ability offer on its own, **except** full control (which this
test turns on for alice, matching every other spec in this directory that
inspects a prompt by hand) suppresses every auto-answer, the same fact
`e2e/w49-counterspell.spec.ts`'s own `answerLoneAbility` exists for. The
server's own log (`play-server-stack-*.jsonl`) confirmed the ask was real and
open (`"evt":"seat-departing","seat":0,...,"openAsks":1` at teardown) — this
was never a product bug, only a test helper that did not yet click through
every ask Venser's own cast can open. Added the same `answerLoneAbility`
click to `passUntilGetChoices`'s poll loop. Second run, green.

**3 runs, 0 SKIPPED**, on the merged tree (post-w51, rebuilt under the lock
first):

```
=== RUN 1 ===
  ✓  1 w53-prompt-words.spec.ts … (10.1s)
  1 passed (12.5s)
=== RUN 2 ===
  ✓  1 w53-prompt-words.spec.ts … (10.2s)
  1 passed (12.5s)
=== RUN 3 ===
  ✓  1 w53-prompt-words.spec.ts … (10.5s)
  1 passed (12.8s)
THREE_RUN_RESULT pass=3 fail=0
```

None of the three titles carry `— SKIPPED:` (`forge.ok` was true throughout —
`CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES` were set for every run).

## 7. `pnpm run check`

Run once, jar env unset, under the lock, on the merged (post-w51) tree:
**exit 1.** `typecheck` (every workspace project, `apps/ui`/`e2e` included)
and the full test suite both ran clean; the failure is `lint`:

```
apps/server/src/play/auto-pass-land.jvm.test.ts
  75:50  error  'landPayer' is defined but never used. Allowed unused vars must match /^_/u
```

That file is lane E's (`apps/server/src/play/auto-pass-land.jvm.test.ts`,
explicitly listed in its own lane row), mid-edit at the time this ran
(`git status`: `MM`) — not a file this lane touches, and not a regression
from anything in this report. Nothing in `apps/ui/src/play/prompts/`,
`e2e/w53-prompt-words.spec.ts`, or this evidence directory is implicated.

## 8. Readers checked (grep `Select target` / the zone marker)

`grep -rn "Select target\|CARDS ON\|CARDS IN\|inZoneStack" e2e/ apps/ui/src`
(excluding this lane's own new files) found:

- `e2e/w33.spec.ts:580` — a comment only, no assertion.
- `apps/ui/src/play/live/match.test.ts` (×4) and `apps/ui/src/play/live/
  gestures/gestures.test.ts:1794` — mock `message`/`prompt(...)` strings
  already plain prose (`'Select targets'`, `'Select target card'`, `'Select
  target spell'`), no dot/`+` qualifier in any of them, so `translateTargetWords`
  is a no-op against every one — unaffected.
- `apps/ui/src/play/prompts/selection.test.ts` (×5) — same: `'Select target
  Zombie creature card'`, and `'…Select target artifact, enchantment or
  land'` (`World Breaker`, already hand-authored prose) — no raw token
  in either, unaffected. (`SelectionPrompt`'s new internal `plainRulesText`
  call is idempotent on prose with nothing to translate.)
- `apps/ui/src/play/prompts/worldbreaker.jvm.test.ts:116` and
  `sanctum-worldbreaker.jvm.test.ts:100` — read Forge's own ALREADY-correct
  `TgtPrompt$` text for World Breaker (the card has one), never the
  default-builder path this fix touches.
- `apps/ui/src/play/live/LiveBoard.test.ts:3541,3594` — `'Select targets for
  Lightning Bolt'`, synthetic test prose, no raw token.

**No existing reader asserts on the raw/buggy text or on the zone-marker
string.** Nothing outside this lane's own files needed a change.

## 9. Decisions made because the brief was ambiguous

- **Composed the translation into `plainRulesText` rather than adding a
  second call site everywhere.** `plainRulesText` already runs on every
  existing prompt/says/ability-label surface (including, via `LiveBoard.tsx`'s
  existing unowned calls, `SelectionPrompt`'s own `message` and the board's
  status line) — composing means every one of those gets the Y18 fix for
  free with zero changes to files this lane does not own. Exported
  `translateTargetWords` separately too, for `lookup.test.ts`'s own table
  test and for a caller that wants only this half.
- **Did not chase every `CardProperty` qualifier.** Covered every shape the
  brief named by name, the whole `YouCtrl`/`OppCtrl`/`YouOwn`/`OppOwn`/`Other`/
  `non<Type>`/zone/`power`-`toughness`-`cmc`-comparison/`with<Keyword>`
  family (all confirmed against real cards' own hand-authored `TgtPrompt$`
  text — §3's table), and gave the long tail (`ControlledBy`,
  `ExiledWithSource`, `counters_*`, …) a humanising fallback instead of a
  dedicated word each: every real card using one of those already carries its
  own override (confirmed — `grep`'d the whole cardsfolder for each), so the
  fallback is insurance against a FUTURE card, not a reproduction of a
  present bug.
- **`isZoneDividerLabel` keys on the label shape (`/^--.+--$/`), not a zone
  name allowlist.** Forge's own marker set is six strings today
  (`TargetSelection.java:228-250`); matching the shape rather than an
  enumerated list means a seventh (if Forge ever adds one) is caught too,
  with no change needed here.
- **Added `answerLoneAbility` to the e2e helper, matching `e2e/
  w49-counterspell.spec.ts`'s own.** Not a brief ambiguity so much as a gap
  the brief's own §P item 3 didn't call out: full control (needed so nothing
  auto-answers the GENUINE ask this test inspects) also suppresses the
  one-ability auto-answer Venser's own cast opens first. Diagnosed from the
  spec's own diagnostic dump + the server's `openAsks` log, per the memory
  note, not guessed.
