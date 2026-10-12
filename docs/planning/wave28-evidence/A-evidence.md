# §A evidence — the play surface

> The `.png` screenshots this file names were removed from the repository on
> 2026-10-11; the written descriptions stand on their own.

Wave 28, lane A. Items 4-render, 6, 7, 8, 9, 10, 11-render, 12-backs, 13, 14, 15.
Every number below is a command that was run and an exit code that was read.

---

## 1. The screenshot, and how it was taken

`A-state-layer-1280x800.png` — 1280×800 at device-scale 2, **with card art
loading**, one frame carrying all four things the done-when names:

| what | where in the frame |
| --- | --- |
| a tapped attacker | Cathar Commando, viewer's creature lane — turned a quarter, `▲6 / ▲4` |
| a creature with +1/+1 counters | the same card: a compact `+3` badge, bottom-left, in the badge's buffed blue |
| a damaged creature | Thraben Inspector, opponent's lane — `1 / ▼1` in a badge that reads hurt |
| a token | Wolf, viewer's lane — the spark mark, the sleep mark, and a dashed edge |

Also in it: the blocking shield (Containment Priest), two more sick creatures, a
named counter (`2 charge`, Lion Sash), the seat counts as symbols, both portraits
anchored to the centre line, the graveyard's cards at the box's width, the
opponent's hand as card backs, and the stack at its roomy height.

**Not through the e2e play harness.** `e2e/play/browser.ts:43-47` aborts every
request whose hostname is not `127.0.0.1`, which is why the committed wave-27
screenshot is artless. The route used instead is lane C's, and it is recorded
here because the block that produced it was temporary and is **not committed**:

1. a temporary `apps/ui/src/play/__shot.test.ts` built a `BoardView` over real
   cube-pool cards (`../draft/pool.json` — the fixture's own precon cards have no
   rows in `art-ids.json`, so they draw the text tile), set the states, rendered
   `<Board>` with `renderToStaticMarkup` and wrote the markup out;
2. a temporary `apps/ui/src/play/__shot.html` beside it `<link>`ed the REAL
   stylesheets by relative path — `../styles.css` (which pulls the vendored
   Mana/Keyrune faces), `./board.css`, `./card.css`, `./live/live.css`,
   `./live/gestures/gestures.css` — inside a `.live` of 1280×800;
3. headless Chromium (`playwright@1.62.1`) loaded it over `file://`, waited for
   `networkidle`, **measured** everything claimed below, and shot it.

Both temporary files were deleted before the commit; `grep -rn '__shot' apps/ e2e/ docs/`
returns nothing (exit 1).

### What the browser measured, rather than what was assumed

```
art          8 images, every one naturalWidth×naturalHeight 488×680, from cards.scryfall.io
failed       []                      <- zero failed requests
board        1264 × 784
page scroll  1280 × 800              <- the canvas does not scroll
turned       ["201", "102", "103"]   <- two tapped lands and the ATTACKER
marks        ["sick", "blocking", "sick", "token"]
counters     ["2 charge", "+3"]
damaged      ["power 1, toughness 1, 1 damage marked"]
faces        theirs mid y=351, ours mid y=429     <- 78px apart, hugging the centre line
graveyard    box 41px wide, card 41px wide        <- the card IS the box
```

The stack's three states, measured in the same page by toggling the attribute and
emptying the list:

| state | `.board__mid` box | `.stack` visibility |
| --- | --- | --- |
| one item, no question | 759, 98, **305 × 148** | visible |
| one item, a question open | 759, 98, **305 × 92** | visible |
| **empty** | 759, 98, **305 × 148** | **hidden** |
| refilled | 759, 98, 305 × 148 | visible |

The empty stack's BOX does not move — that is `visibility`, not `display`, and it
is the property `e2e/table-fit.spec.ts` compares across its four stack shots.
Refilling the list by DOM alone brings it back, which is what that spec's probe
does.

---

## 2. Suites, exit codes read directly

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
pnpm vitest run apps/ui/src/play --exclude '**/*.jvm.test.ts'
#   18 files passed, 581 passed / 0 failed, EXIT 0   (561 before this lane: +20 cases)
pnpm --filter @hadoku/ui run typecheck     # EXIT 0
pnpm exec eslint apps/ui/src/play --ext .ts,.tsx     # EXIT 0
```

Jar-gated, one file at a time, under `jvm.lock`, all three env vars, against the
real jar — **four runs, all green, no re-run needed**:

| suite | result |
| --- | --- |
| `live/flow.jvm.test.ts` | **exit 0, 7 passed — 3 runs out of 3** after the manager found it flaky (2 red in 2); see §3 |
| `live/combat-drag.jvm.test.ts` | **exit 0, 1 passed** |
| `live/prompts.jvm.test.ts` | **exit 0, 3 passed** |
| `live/board-play.jvm.test.ts` | **exit 0, 1 passed** |

---

## 3. What was done about the suites lane B moved

`docs/planning/wave28-evidence/B-tests-A-must-reaim.md` measured the attribution;
none of it was re-run.

### `flow.jvm.test.ts` — hardened three times over. Still NOT pinned. **3/3 green.**

**The manager's verification found it flaky after the first fix**, 2 red in 2 runs
(suite-level, at `:359` and at `:489` — both land-drop call sites), against a tree
whose only base movement was a docs-only `origin/main`. The failure was specific,
not a timeout shaped like nothing:

```
Error: timed out waiting for the land to be on the battlefield, untapped (Preordain run)
{"seat":0,"at":"3/COMBAT_DECLARE_ATTACKERS","battlefield":[],
 "hand":["Preordain #11",…,"Volcanic Island #30",…],
 "acts":["ok:2/DRAW","ok:2/MAIN1",…,"ok:3/UPKEEP"],
 "refused":["play land #30"]}
```

Two faults, one class — **an action taken on a fact that has since moved**, the
same class as the selection loop below:

1. **`atOwnMain` is Forge's prompt MESSAGE, parsed, and the message can be a
   window behind its own buttons.** `jvm-harness.ts:158-165` bumps ONE
   `notes.version` for four different frames, so an `updateButtons` arriving alone
   advances it while `notes.prompt` still holds the previous window. `holdSeat0`
   is `atOwnMain`, so a stale read makes the hold answer **false at the one stop
   the scenario exists to keep** — and `advance` then presses OK and passes seat 0
   out of its own main. That is `acts` ending `ok:2/MAIN1` in the dump above.
   Under the old default the seat stopped at every priority window and this was
   effectively unreachable; `skipNonStopPhases: 'always'` passes seven phases in a
   burst, so the window changes several times inside one 100 ms tick.
2. **The retry loop could not recover.** Its `drive` was `retryLand` ALONE, and
   `retryLand` correctly returns early when the seat is not at its own main — so
   once seat 0 had drifted past MAIN1, NOTHING advanced either seat and the wait
   could only run out its 60 s. (The manager read this as "`retryLand` does not
   re-check the phase"; it did. The defect is that nothing else was driving.)

The fix, and it keeps the suite on the product's real default:

- **`settle(hands)`** runs once per seat per tick, inside `until`'s own loop so it
  runs whatever `drive` a step passes (including `() => {}`). A seat is *steady*
  when `notes.version` did not move between two ticks — one tick of latency, and
  the message and the bar are the same window's by construction. This is the
  "pair the prompt and the buttons before acting" that
  `board-play.jvm.test.ts:265-278` does with `stats.replies` and this file had no
  equivalent of.
- **`advance` stands down on an unsteady seat** entirely, so it can no longer
  press OK into a window it never saw.
- **Every `atOwnMain` decision became `atSteadyOwnMain`** — both holds, all four
  step predicates.
- **`retryLand` became `playLand`**, which makes the FIRST drop as well as the
  retries, re-checks `atSteadyOwnMain` at the instant it clicks, and records the
  first as a real `click` (a refusal is data) and later ones as `clickAgain`.
- **Both land-drop waits now keep the game moving** (`playLand(x); keepMoving()`),
  so a seat that drifted comes back round to its own main and drops there instead
  of hammering a closed window. `holdSeat0` still holds seat 0 at its own main, so
  re-acquiring it does not race the drop. Budget raised 60 s → 120 s because
  re-acquiring can now legitimately cost a turn.
- **`why()` prints `steady` and `version`**, so the next failure of this shape is
  diagnosable from one dump.

Nothing pinned, nothing weakened, nothing deleted. The file's header now carries
the three timing hazards and where each fix lives.

**Three consecutive runs, one file at a time under `jvm.lock`, real jar:
`3/3 green`** — exit 0, 7 passed, at 37.2 s / 37.5 s / 37.4 s, under a host load
average of **9.23 on 12 cores** (the manager's two reds ran at 5.20 and took 75.6 s
and 91.0 s — they were burning their deadlines). The `refused.length <= 2` bound
at `:570` is inside those passes.

### The pre-existing selection bug, fixed in the same file

`advance` took `[...boardInteraction(...).selectable][0]` every tick **with no
memory of what it had already picked**. Forge does not remove a card from the
offered set when you choose it — the set is what MAY be chosen, not what is left
— so a `min: 2` cleanup discard got card #53 clicked six times, the selection
never reached its minimum, `enable1` never came alive and the whole scenario died
in `beforeAll`. All seven cases skipped, under the wave-28 default and under the
one before it alike.

`Hands` now carries `picked: Map<string, number[]>`, keyed by turn and prompt,
exactly as `game-driver.ts:135-139` and `combat-drag.jvm.test.ts:391-394` already
do. **That was the fix for the RED**, and it was necessary but not sufficient —
the two timing faults above are what made the suite flaky rather than dead.
`flow.jvm.test.ts:506`'s claim — *"a turn never advances past a main phase
unattended"* — is reached and asserted for the first time in this wave, and under
the product's real default.

### `combat-drag.jvm.test.ts` and `prompts.jvm.test.ts` — **pinned**, and written down

Both pin `EVERY_PRIORITY_POLICY` on every seat before anything is driven, with a
section in each file's own header saying so:

- `combat-drag.jvm.test.ts` — *"This suite PINS `EVERY_PRIORITY_POLICY`, and here
  is why that is honest"*, plus the call at the match setup.
- `prompts.jvm.test.ts` — *"These scenarios PIN `EVERY_PRIORITY_POLICY`…"*, plus
  the call at all three match setups.

The argument, in both: **neither suite tests the stop set.** One exists to prove
that an attack and a block are declared BY DRAGGING and that Forge agrees; the
other, that fifteen prompt shapes are asked, drawn, answered and accepted without
a desync or a leak. The stop set is asserted directly, and now in more places
than before, by `apps/server/src/play/auto.test.ts` and `auto.jvm.test.ts`.
`board-play.jvm.test.ts:217` is the precedent — it pins `STRICT_PAYMENT_POLICY`
for the same kind of reason and says so in its header.

**The product's real default is exercised, by the suites that are about it.** It
is also exercised by `flow.jvm.test.ts`, which is NOT pinned and is about turn
flow.

---

## 4. Mutation counts, naming the suite

Each mutation applied alone, the suite run, the file restored.

| # | mutation | suite | reverted | restored |
| --- | --- | --- | --- | --- |
| M1 | `data-attacking` removed from the card | `apps/ui/src/play/Board.test.ts` | **1 failed / 123 passed (124)** | 124 passed |
| M2 | the seat counts back to `hand 5` / `library 46` | `Board.test.ts` | **2 failed / 122 passed (124)** | 124 passed |
| M3 | the empty-stack rule deleted | `Board.test.ts` | **1 failed / 123 passed (124)** | 124 passed |
| M4 | a pile card back to a fixed 2rem | `Board.test.ts` | **1 failed / 123 passed (124)** | 124 passed |
| M5 | `StateMarks` and `Counters` not rendered | `Board.test.ts` | **6 failed / 118 passed (124)** | 124 passed |
| M6 | the roomy stack band set to the compact one | `Board.test.ts` | **1 failed / 123 passed (124)** | 124 passed |
| M7 | Forge's `label2` painted verbatim in declare-attackers | `apps/ui/src/play/live/LiveBoard.test.ts` | **1 failed / 88 passed (89)** | 89 passed |
| M8 | the log back to plain text | `LiveBoard.test.ts` | **3 failed / 86 passed (89)** | 89 passed |
| M9 | the prompt title not split | `apps/ui/src/play/prompts/choices.test.ts` | **1 failed / 25 passed (26)** | 26 passed |
| M10 | the native radio not restyled | `choices.test.ts` | **1 failed / 25 passed (26)** | 26 passed |

---

## 5. The decisions the brief asked to be written down

### Forge's `label2` during declare-attackers: the shortcut goes, the undo stays

There is no alpha-strike affordance in this repo and there never was. What the
operator saw is **Forge's own label, painted by us**:

```
forge-gui/.../match/input/InputAttack.java:89
  String alphaLabel = canCallBackAttackers() ? localizer.getMessage("lblCallBack")
                                             : localizer.getMessage("lblAlphaStrike");
res/languages/en-US.properties:472   lblAlphaStrike=Alpha Strike
```

**Decision: during declare-attackers, the second button is not offered while this
seat has declared nothing, and IS offered once it has.**

- `Alpha Strike` attacks with everything. That is the shortcut the operator asked
  to be rid of, so it is not offered: the button is disabled and reads `Cancel`.
- `Call Back` takes back the attackers already declared. That is the only undo
  this UI has for a declaration, and removing an undo is a different act from
  removing a shortcut. Only the second was asked for, so `Call Back` comes back.

The two are told apart by **Forge's own `Attacking` on our own board**, which is
exactly the predicate `InputAttack.canCallBackAttackers()` switches on — never by
the label's text, which is localized. A client that reads Forge's prose to decide
what a button means is a client that breaks in French.

The button stays in the DOM, disabled. It is not removed: the control cluster is
a fixed box with a fixed slot per child, and `e2e/table-fit.spec.ts` fails a frame
in which that box is not the box it was in every other frame.

### Tokens: a drawn token face, not an art id

**Decision: a token wears a deliberate token treatment on the board; it does not
get an art id in this wave.**

`wolf-token` has no row in `art-ids.json`, so `scryfallIdFor` misses and
`CardTile` falls back to its TEXT tile — which is a whole card (name, type, rules,
stat), not an empty one. Giving tokens ids means editing
`apps/ui/src/draft/art-ids.json` or `packages/carddata/src/art/`, and **neither is
this lane's file**; `apps/ui/src/components/CardTile.tsx` is not either.

What this lane can do, and did: make the artless tile read as DELIBERATE. A token
carries the spark mark in the corner and a dashed leading edge (`card.css`
`[data-token]`), so the message is "the game made this" rather than "the picture
failed".

**How it interacts with item 15:** it is the same mechanism, not a second one. The
token treatment is one of the three marks the state layer draws, in the same
corner strip as `blocking` and `sick`, and it composes — the Wolf in the
screenshot wears the token mark and the sleep mark together. The day a token gets
an art id, the art arrives underneath the same mark and nothing here changes.

### Summoning sick, blocking, token — the channels, and why not a fourth outline

A card can already wear two outlines the gesture lane draws: a **solid accent
ring** for "Forge is offering this" (`button.board-card__face`, `card.css`) and a
**dashed accent outline** for "you pointed at this as an attacker"
(`gestures.css`). So nothing in the state layer is an outline and nothing in it is
drawn in the accent:

| state | channel | why |
| --- | --- | --- |
| summoning sick | the whole face **desaturates** (`grayscale(.7) brightness(.82)`) | a saturation channel says the same thing to a colour-blind viewer as to anyone else, and it is the one treatment that cannot be lost under a photograph |
| blocking | a **drawn shield** in the top-left corner capsule | a mark, not an outline |
| token | a **drawn spark** in the same strip, plus a dashed card edge | ditto |

Every mark is a 14px capsule with its own opaque background, because the thing
underneath is a photograph and an unbacked glyph over art is unreadable. Each
carries its word visually hidden, so the state is still SAID to anything that
cannot see the picture — the same split the P/T badge makes between its `▲`/`▼`
and its accessible name.

The marks are geometry we drew (inline `<svg>` paths), for the same reason
`PT_MARK` is `▲`/`▼` rather than a named glyph: no font can fail to have them.

### The avatar (item 4) — render half only

`BoardPlayer.avatarId?: string` is additive and optional. `PlayerFace` draws
`avatarSquareUrl(player.avatarId)` when there is one and the generated SVG mark
when there is not — one null check is the whole fallback, exactly as lane D's
`D-avatar-field.md` §3 prescribes. The URL is only ASKED for when there is an id,
because `watchpartyOrigin()` reads `globalThis.location` and `live/parity.test.ts`
renders this component under `react-dom/server`, where there is none.

**Nothing populates the field in production, and it will not until the play-wire
hop lands.** The board builds `BoardPlayer` out of Forge's `PlayerView`;
`MatchScreen.tsx` hands `LiveBoard` a match id and a socket and nothing else. The
remaining hop is `routes.ts` (D's, done) → `play/socket.ts` (B's) →
`play/match.ts` (B's) → `adapter.ts` (A's), and the join key already exists —
`socket.ts:648` sends `seats[].playerId`, a Forge player id, and `BoardPlayer.id`
is a Forge player id. Not attempted. `adapter.ts`'s own field doc says all of
this, so the next reader finds it at the field.

### The seats moving closer (item 10) — what it reverses, and what survives

The operator: *"lets push them closer together. bottom avatar anchored top of that
box, top avatar anchored bottom of that box."* "That box" is `.seat__who`; the
opponent's is the LOWER cell of their seat and the viewer's is the UPPER cell of
theirs, so the instruction brings both faces in to the centre line. Measured:
theirs at y=351, ours at y=429, in an 800px canvas.

That **reverses wave 20's anchoring**, which put them as far apart as the canvas
allowed. What wave 20 was actually about survives untouched: telling ours from
theirs rests on `(you)` beside the name, on `data-viewer` on the seat and the
face, and on the brighter ink the viewer's mark is drawn in.

### The graveyard (item 9) — two changes, and the one that was refused

*"the graveyard is unecessarily small, i think the cards can expand to fit the
width of that box."*

1. The pile is a **size container** and its card is `100cqw`, so the card IS its
   box instead of a fixed 2rem inside it. `--peek` follows the card width at the
   ratio it had, so the strips scale with it.
2. `.seat__piles` is no longer two EQUAL columns: the graveyard takes 1.5 of 2.5
   shares. It is the pile that fills up; exile is usually empty.

Net, measured in the browser: **32px → 41px**, a 28% wider card.

**Refused: widening `--who-w`.** It is what every other track on the table is
proportioned against, and the width would come out of the battlefield, where
`e2e/table-fit.spec.ts`'s crowd thresholds (`MIN_GROUPED_CARD_PX`) were derived.

### The log (item 11) — what it can and cannot colour

`data-log-kind` on each line, from a documented classifier over a **small
vocabulary that is ours**: `paid …` / `<seat> paid …` (`auto.ts`'s
`paymentLine`), `full control on`/`off` (`match.ts`'s `say`), `played …`
(`noteAutoAnswered`), and whatever Forge sends through `showMessage`, which falls
to `said` and draws plain.

**There is no damage line on this channel yet, and that is not fixable here.**
Forge's own `GameEventAddLog` is modelled in `packages/forge-wire` and cannot
reach us: `bridge/PlayBridge.java:538` sends `"events": []` on every delta, on
purpose, because per-event visibility rules do not exist. The `damage` ink is
there and asserted; what will light it is the events arm, and when that arrives an
`AddLog` carries a `GameLogEntryType` and a `sourceCard` — a kind and a card id,
structured — which replaces the classifier rather than needing to be bent into it.

`data-log-who` marks the opponent's lines, off the attribution `sayToTable`
already puts on them: it attributes the copy it sends the opponent and leaves the
actor's own unattributed, so an unattributed line is by construction your own.

Card names hover to the card. The name index is built from the **viewer's own
`BoardView`** — every card in it is already on this viewer's screen, and an
opponent's hand is a count there, so the hover cannot reveal anything a click
could not. A name the board does not hold is left as text. `pointer-events: auto`
on the name span is a deliberate, narrow hole in the logbook's
`pointer-events: none`; everything else in the panel stays untouchable so the drag
gesture under it is unshadowed. The tile is rendered only while hovered or
focused, so the panel's `textContent` is still the log's own words.

---

## 6. Files outside this lane that this change touches or breaks — NAMED, NOT FIXED

### `e2e/table-fit.spec.ts` — **will go red in two places.** Nobody owns it.

Line numbers are as of `60409a6`, the manager's commit that took up §C's
deck-chooser recipe in this file and in `e2e/arrow.spec.ts`. **That clears the
blocker B and C both reported** — `selectOption` on `deck-mine` is gone from both
specs — so this spec is runnable again, and the two things below are what stands
between it and green.

1. **`:1683-1684`** — the face geometry, and this is item 10 being done:
   ```ts
   expect(them.mid, `${where}: their face is in the top third of the canvas`).toBeLessThan(board.top + third);
   expect(you.mid, `${where}: our face is in the bottom third of the canvas`).toBeGreaterThan(board.bottom - third);
   ```
   Measured after the change, at 1280×800: theirs y=351, ours y=429, in a canvas
   whose thirds are 267 and 533. Both fail. They assert wave 20's anchoring, which
   the operator reversed on 2026-09-28.

   What should replace them, and it is the claim that still holds: the two faces
   do not overlap each other (`them.bottom <= you.top` — **still true**, they are
   in different seats across the centre line) and neither shares a pixel with the
   stack (`clear(face, stack)` — **still true**, the faces are in the ~5.6% left
   column and the stack is at 59.4% across). A "closer together" assertion would
   be `you.mid - them.mid` under, say, a third of the canvas.

2. **`:1140-1146`** — the crowd probe builds a chip strip by hand:
   ```ts
   const chips = document.createElement('ul');
   chips.className = 'board-card__chips';
   chips.innerHTML = '<li class="board-card__chip">summoning sick</li><li class="board-card__chip">2 damage</li>';
   copy.appendChild(chips);
   ```
   `.board-card__chips` no longer exists in `board.css`, so that markup is now
   UNSTYLED and in flow: it adds height to the copied card and the battlefield can
   breach its own `scrollHeight` check. The clause it belongs to — *"the fifth
   carries status chips, because those change a card's box"* — is obsolete: the
   state layer is out of flow and clipped by construction, which
   `Board.test.ts`'s *"nothing the state layer draws can change a card's box"*
   asserts directly. **Delete those lines.**

The whole spec is jar-gated, so neither is in CI's `check`; it runs in the
`forge-e2e` job on this host.

### `e2e/arrow.spec.ts` — nothing from this lane. Already re-aimed at §C's chooser by `60409a6`.

It drives the targeter arrow over `[data-card-id]` and reads no state chip, no
seat count and no log line, so nothing this lane changed reaches it.

### Not touched and not broken, checked

- `apps/ui/src/components/CardTile.tsx`, `ManaPip.tsx`, `apps/ui/src/symbols/`,
  `apps/ui/src/styles.css`, `apps/ui/src/chrome/`, `apps/ui/src/screens/`,
  `packages/carddata/src/art/`, `forge/`, both `package.json`s — **no edit**.
- `apps/ui/src/room/avatar.ts` — **imported, never edited** (`avatarSquareUrl`).
- `adapter.ts` is **add-only**: one optional field on `BoardPlayer`. No exported
  signature moved, so `e2e/play.spec.ts:123` (`toBoardView`) and
  `e2e/play/hands.ts:36` (`manaCostTokens`) are unaffected.
- `live/LiveBoard.tsx` props and `live/match.ts` exports are **add-only**;
  `match.ts` was not edited at all. `apps/ui/src/screens/MatchScreen.tsx:31-32`
  compiles unchanged (`pnpm --filter @hadoku/ui typecheck`, exit 0).
- `apps/ui/src/components/ManaPip.test.ts` and
  `packages/carddata/src/art/ids.test.ts` pin `adapter.ts` from directories no
  lane owns; both untouched by an added optional field.

---

## 7. What could NOT be verified, with the command that would settle it

- **`e2e/table-fit.spec.ts` was not run**, and it IS runnable now that `60409a6`
  cleared §C's `selectOption`. It was not run because the two failures above are
  arithmetic rather than a guess — the faces were measured in a browser at y=351
  and y=429 against thirds at 267 and 533, and `.board-card__chips` is simply not
  in `board.css` any more (`grep -n chip apps/ui/src/play/board.css` finds three
  lines of prose and no rule) — and a jar slot spent confirming them is a jar slot
  not spent on the four suites this lane owns. Once `:1683-1684` and `:1140-1146`
  are taken up by whoever owns that file:
  ```sh
  flock -x /tmp/claude-1000/w28-locks/jvm.lock env \
    CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w28-A-play \
    pnpm --filter @hadoku/e2e exec playwright test -c playwright.config.ts table-fit.spec.ts
  ```
- **`e2e/play.spec.ts` was not run.** Lane B ran it green after applying §C's
  one-line recipe; nothing this lane changed alters what it drives (it walks cards
  by `data-card-id` and reads `life`, `player`, `board-mid`, none of which moved).
  Settled by:
  ```sh
  flock -x /tmp/claude-1000/w28-locks/jvm.lock env … \
    pnpm --filter @hadoku/e2e exec playwright test -c playwright.config.ts play.spec.ts
  ```
- **The avatar has never been drawn from a real `avatarId`**, because nothing
  populates the field. It is proved in jsdom against a fixture only. It becomes
  real when the play-wire hop lands (§5 above).
- **`prompts/search.jvm.test.ts` was not re-run.** It reads `.prompt__title`'s
  `textContent` at `:79` but only prints it as diagnostics — no assertion reads
  `Seen.title` — so the split title cannot move it. Settled by running that one
  file under the jvm lock.

## 8. w29

- **Item 12's second half** — seeing the opponent REARRANGE their hand. The
  arrangement store (`ARRANGED`, `Board.tsx`) is per-viewer by construction with
  no wire path; sharing it is a design question about what a rearrangement tells
  the table, not a CSS one.
- **The avatar's play-wire hop** — four files, three of them other lanes' this
  wave. `D-avatar-field.md` §2 has the table and the join key.
- **Forge's own game log** — the `events` arm plus a per-event visibility rule,
  which is a bridge change (`PlayBridge.java:538`). It is what would give the log
  a damage line.
