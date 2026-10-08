# Wave 60 §R — evidence

AD10, Playtest 14: *"i played 'Cry of Contrition' which has haunt. i expect to see the
'haunt' keyword on my creature. … is there an easier way to always get that effect name
to popup rather than having to hardcode all of them?"*

Run 2026-10-08, local (claws proof still owed by the manager — see "What the manager
still owes" below). Jar: `702b207eda874df8bae60435284f40836ed8799c.jar`. Res: the main
checkout's `forge/forge-gui/res`. Work dir: `~/.cache/cardtable-play-work/w60-R` (disk,
never tmpfs).

## What changed

| file | what |
| --- | --- |
| `apps/ui/src/play/adapter.ts` | `BoardCard.relations?: BoardCardRelation[]` (new `RelationKind`/`BoardCardRelation` exports), `BoardCard.abilityText?: string \| null`. `RELATION_PROPS` (6 rows: `HauntedBy`→`hauntedBy`, `Haunting`→`haunting` (single id), `EncodedCards`→`encoded`, `ImprintedCards`→`imprinted`, `ChosenCards`→`chosen`, `MustBlockCards`→`mustBlock`), `nameOfCard` (shallow name lookup off `view`/`face`, deliberately NOT through `toBoardCard` — haunt is symmetric and that would recurse), `readRelations`, `readAbilityText` (strips Forge's `<span style="color:gray;">` gray-tag markup — real on this bridge, see below). Both new fields wired into `toBoardCard`'s return. |
| `apps/ui/src/play/adapter.test.ts` | New describe block: capture-carries-none proof (same pattern `AttachedCards` used), HauntedBy/Haunting pairing by resolved name, the other four kinds, the hidden-id → `null` name case, Forge's `-1` dropped off `Haunting`, `AbilityText` CRLF+gray-tag normalisation (using the capture's OWN real gray-tagged text — Ral's Staticaster, id 2 — no synthetic wire value needed), and the `null`-for-absent case (Island, id 24, has none). |
| `apps/ui/src/play/Relations.tsx` (new) | `Relations` component: one `<li className="board-card__counter" data-relation="…">` per relation, inside its own `<ul className="board-card__relations">`. `relationLabel` (exported for the test): joins resolved names (`"Haunted by Cry of Contrition"`), or draws the kind alone (`"Haunted"`) when every id in that relation is unresolved. |
| `apps/ui/src/play/Relations.test.ts` (new — **not** `.tsx`, see below) | 7 tests: `relationLabel` (resolved name, joined names, hidden-id-alone, mixed resolved/unresolved) and `Relations` (no relations → nothing, hand-typed `BoardCard` missing the field entirely → nothing, one pill per relation reusing `.board-card__counter`). |
| `apps/ui/src/play/card.css` | `.board-card__relations` + `.board-card__relations > .board-card__counter`: a new overlay band centred along the BOTTOM edge (the four corners — marks, chosen-type, counters, the P/T badge — are already claimed; the type-pill band sits at `top: 22%`), reusing `.board-card__counter`'s existing pill rule rather than redefining it. |
| `apps/ui/src/components/CardTile.tsx` | New optional `liveText?: string \| null` prop. `shownText = liveText != null && liveText.trim() !== card.oracleText.trim() ? liveText : card.oracleText`; `rulesLines` now keys off `shownText`. This is also the inspector's own text source — see "Where the inspector draws from," below. |
| `apps/server/src/play/scenarios/w60-haunt.state` (new) | Alice: Cry of Contrition + Mountain in hand, Swamp + Memnite on the battlefield. An uncontested turn-1 Main 1. No `.state` key exists for a haunt relation (`GameState.java` has none) — the pairing is reached by actually casting the card, same as a real board would. |
| `e2e/w60-relations.spec.ts` (new) | Casts Cry of Contrition for real, targets alice herself (the discard), answers the own-hand discard choice, answers Haunt's own separate "choose target creature to haunt" trigger by clicking Memnite, then asserts the pill text on BOTH `alice.page` and `bob.page`: Memnite reads "Haunted by Cry of Contrition"; the now-exiled Cry of Contrition reads "Haunting Memnite"; and it is never also in the graveyard. |
| `apps/ui/src/play/Board.tsx` | **Out-of-row**, pre-named by the manager's note. Three minimal, non-structural additions inside the EXISTING `CardOnBoard` function (the battlefield card render), nowhere near the hand or the stack: one import (`Relations`), one new prop on the already-present `<CardTile card={entry.card} />` call (`liveText={entry.abilityText}`), and one new JSX line (`<Relations entry={entry} />`, unconditional — not gated on `onBattlefield`, because the haunting card's own pill reads while it sits in EXILE). |
| `apps/ui/src/play/live/parity.test.ts` | **Out-of-row**, not this lane's file, but the pin it holds is a mechanical consequence of this wave's own sanctioned change — see "The parity pin," below. Re-recorded `BASELINE_SHA256`/`BASELINE_LENGTH` (42983 → 42876, -107) with the file's own full accounting convention; its own header already states the protocol for exactly this case ("Re-recording the two numbers belongs with the commit that makes the markup change — or, when that commit does not own this file, immediately after it, naming it"). |

**Made dead / deleted:** nothing. This is pure addition — no prior code drew a relation or
a live ability text, so nothing it replaces.

## Every relation kind drawn, and the one gap

All six kinds `tier-c.ts` types as `CardViewCollectionType`/`CardViewType` are drawn:
`hauntedBy`, `haunting`, `encoded`, `imprinted`, `chosen`, `mustBlock`. None of the six
are in the committed `adapter.test.ts` fixture's own capture (0 occurrences in any of the
27 packets — checked directly, same proof `AttachedCards`/`EntityAttachedTo` needed in
wave 33), so every kind but `hauntedBy`/`haunting` is exercised only by writing the wire
property into the real state by hand (`adapter.test.ts`'s own new describe block) — real
Forge only proves `hauntedBy`/`haunting` (the e2e spec), because only Cry of Contrition
was in scope this wave.

**The one relation the wire decodes that the board still cannot show: `PairedWith`**
(soulbond, `CardViewType`, single id — `tier-c.ts` types it the identical way `Haunting`
is typed). It is not in `RelationKind`'s union and `RELATION_PROPS` has no row for it —
the brief's own six kinds name `hauntedBy`/`haunting`/`encoded`/`imprinted`/`chosen`/
`mustBlock` and stop there, and `PairedWith` was not one of them. Adding it is the exact
same one-row addition every other kind already is (`{ key: 'PairedWith', kind: 'paired',
single: true }` plus one more `RelationKind` member and two label-map entries) — left
undone only because it was outside this wave's named scope, not because it is hard.

## What the live `AbilityText` actually is, and the parity pin

`CardStateView.getAbilityText()`/`Card.getAbilityText(CardState)` (`forge-game/src/main/
java/forge/game/card/Card.java:2813-2816`, read directly from the checked-out
`forge/`) is Forge's CURRENT, computed ability text — not a copy of the printed Oracle
text. It wraps keyword-granted reminder text in `<span style="color:gray;">…</span>`
when `GameRules.useGrayText()` is on, which it is on this bridge by default:
`HostedMatch.startGame` (`forge-gui/src/main/java/forge/gamemodes/match/
HostedMatch.java:83`) sets it from `ForgePreferences.UI_GRAY_INACTIVE_TEXT`, whose own
default is `"true"` (`ForgePreferences.java:111`), and `apps/server/src/play/bridge/
PlayBridge.java` drives the match through `HostedMatch` — confirmed by reading both
files, not assumed. `readAbilityText` strips that markup with a plain `<[^>]*>` regex;
the committed fixture (Ral's Staticaster, id 2) already carries the real gray-tagged
string on the wire, no synthetic value needed to prove the strip.

Showing `abilityText` in place of `oracleText` whenever they differ — exactly the
brief's own rule, taken generically rather than scoped to haunt — moved
`live/parity.test.ts`'s byte-for-byte pin on the committed fixture: 4 of its cards
(Oxidda Golem, Pyrite Spellbomb, Ral's Staticaster, Ral's Dispersal) carry a live
`AbilityText` that reads differently from their printed `OracleText` — reordered
clauses, a dropped reminder-text parenthetical, or Forge's ability-text generator
phrasing a sentence slightly differently from its oracle-text generator for the same
effect — none of them a haunt relation (the fixture has none). None is a content LOSS a
player would notice during play; it is Forge's own live description, matching what
Forge's own GUI has always shown. Measured the strong way (`diff --word-diff` on the
fixture rendered with `liveText={null}` vs `liveText={entry.abilityText}`, every changed
region accounted for) and re-recorded with the file's own existing convention and its
own already-written protocol for a change landing in a file this lane does not own — see
`parity.test.ts`'s own header for the full accounting, item by item.

## Where the inspector draws from

**Not `apps/ui/src/play/live/Inspector.tsx`** — no such file exists. The expanded-card
view is `apps/ui/src/play/inspect/index.ts` (`mountInspector`), and it draws by CLONING
the already-rendered `CardTile` DOM node wholesale (its own header: *"the enlarged card
is the `CardTile` the seat already drew, CLONED and sized up… so the rules text is not a
fetch away — it is already in the tile this module enlarges. No second source of card
data exists here"*). So the actual text source is `apps/ui/src/components/CardTile.tsx`
itself — `liveText` is a new prop there, and `Board.tsx`'s one new prop on the existing
`<CardTile>` call is the only wiring the inspector needed; `inspect/index.ts` is
untouched.

## `.test.ts`, not `.test.tsx`

The brief's own row names `Relations.test.tsx`. The repo's root `vitest.config.ts` globs
only `apps/*/src/**/*.test.ts` (checked directly) — no `.tsx` test file exists anywhere
in this workspace, and `prompts/RulesText.test.ts` is itself `.ts` (plain
`createElement`, no JSX) for the identical reason despite testing a component. A `.tsx`
test file would never be collected by `pnpm exec vitest run` or by CI's `check`. Filed as
`Relations.test.ts`, using the same `createElement`/`@testing-library/react` pattern
`RulesText.test.ts` already established — not a file this lane is allowed to fix by
editing the shared root config mid-wave.

## Mutation

`readRelations` forced to `return []` immediately: `adapter.test.ts` — **3 failed, 47
passed** (every test that writes a relation property into the state and reads it back).
`Relations`'s own `relations` forced to `const relations: BoardCardRelation[] = []`:
`Relations.test.ts` — **1 failed, 6 passed** (the one test with real relation data on an
`entry`; the "no relations" tests pass either way, correctly). Both reverted; both suites
green again after (50/50, 7/7).

## Real-Forge proof (local; claws still owed)

`e2e/w60-relations.spec.ts`, against the real jar, twice (`--repeat-each=2`): **2/2
passed**, ~8s each. Full build+test run inside `/tmp/claude-1000/w60-e2e.lock`, work dir
on disk per the brief.

Diagnosed and fixed two real bugs along the way, both left as comments in the spec so a
future reader does not re-discover them the slow way:

1. A seat-scoped selector built as `` `${a}, ${b} li.board-card` `` — the comma only
   groups at the TOP level, so `li.board-card` bound to the LAST clause alone, and the
   first clause matched the ZONE SECTION itself, never a card. Fixed by dropping seat
   scoping entirely: the scenario leaves exactly one of each named card on the whole
   board, so scoping by `data-zone` alone is both correct and simpler.
2. Cry of Contrition's own discard (from ALICE'S OWN hand) renders through
   `match.selectables`/`SelectionPrompt` (`data-testid="live-selection-host"`, a card's
   own `prompt-choice` checkbox answers it immediately on click) — a *different* Forge
   surface from the generic ask-driven `[data-testid="live-prompt"]` `answerPrompt`
   already drains. Haunt's own later "choose target creature" ask, by contrast, IS the
   plain board `data-selectable` click (S, wave 33's rule, confirmed again here) — the
   two steps of one card's own resolution use two different UI surfaces. The driving
   loop now handles both every iteration.

## What could NOT be verified

- The claws proof (`verify/w60-R`, `forge.yml -f only=e2e`) — not run; the brief reserves
  that for the manager after landing. The spec is proven locally against the same jar
  pin (`702b207e…`) and res the claws use.
- `encoded`/`imprinted`/`chosen`/`mustBlock` against REAL Forge — only `hauntedBy`/
  `haunting` had a real card in scope this wave (Cry of Contrition). The other four are
  proven only by `adapter.test.ts`'s hand-written wire fixtures (the committed capture
  has none of the six, by actual grep of every packet).
- Multiple simultaneous relations on one card (e.g. a card both encoded AND imprinted) —
  the data shape supports it (`relations` is an array), `Relations.tsx` draws one pill
  per entry either way, but no fixture or real card in this wave's scope exercises two
  relations on the SAME card at once.

## Decisions made because the brief was ambiguous

- **`relations`/`abilityText` are OPTIONAL on `BoardCard`** (`relations?:`/
  `abilityText?:`), not the brief's own literal non-`?` type. `BoardCard`'s own header
  comment already documents this exact policy for every field added after `counters`:
  hand-typed `BoardCard` fixtures elsewhere (`Board.test.ts`, `inspect/index.test.ts`,
  `live/numbers.test.ts`, `prompts/choices.test.ts` — none of them this lane's row) would
  otherwise fail to typecheck for a field they have no reason to restate. Consumers read
  `entry.relations ?? []` / `entry.abilityText ?? null`.
- **Names resolved in `adapter.ts`, not in `Relations.tsx`.** The brief's own sentence —
  "Names resolve through the board's own lookup" — read as pointing at the adapter's
  EXISTING resolution mechanism (`StackEntry.targetLabel` already resolves a target id to
  a name the identical way, in `toBoardView`), not as a new instruction to build a
  whole-board id→name lookup and thread it down through `Board.tsx`'s props into
  `CardOnBoard`/`Relations` — the manager's own note capped Board.tsx edits at "the
  smallest possible," and plumbing a new cross-zone lookup prop through several
  functions neither H nor M touches this wave would have been a much larger, riskier
  change than resolving names where the wire's full `state` is already in scope.
  `nameOfCard` is deliberately NOT `toBoardCard` itself (haunt is symmetric; that would
  recurse) — a shallow name-only read off the same two objects `toBoardCard` reads its
  OWN name from.
- **`.board-card__relations` centres along the bottom edge**, not stacked above/below an
  existing corner. The brief named no position; the four corners were already fully
  claimed before this wave (marks, chosen-type, counters, the P/T badge) and the
  type-pill band already occupies `top: 22%`, so the one genuinely free strip is between
  the two bottom corners.
- **`parity.test.ts` re-recorded, not left red.** Not this lane's own file (not in the
  row, not named in the manager's notes), but the file's own header already states the
  protocol for a change that moves its pin from outside the files it owns, and the user's
  own working agreement ("don't call work done with anything red," "fix the code, not the
  test") rules out either disabling the assertion or leaving `check` red over a pin that
  is stale for a legitimate, sanctioned reason.
