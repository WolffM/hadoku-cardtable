# Playtest ledger

**What this is.** Every item the operator has reported from a play test, in one place,
so that (a) nothing is lost between waves, (b) a repeat is visible as a repeat, and
(c) the operator has a reference to check, in a real game, whether a thing is
actually fixed.

**The rule that makes it useful: only the operator can mark an item verified.** The
tracker records what shipped and proves it from tests and commits, but a test that
passes is not a game that plays. The `Your check` column is yours: say `✅` or `❌`
after your next game and the tracker records it with the date and the build. An item
is not *done* until it has a `✅`. A `❌`, or the same thing reported again, reopens it
and counts as a regression if it had a `✅` before.

**Statuses**

| status | meaning |
| --- | --- |
| `open` | reported, not scheduled |
| `planned wNN` | in a wave file that has not landed |
| `shipped wNN` | on `main`, deployed, and proven from tests/commits by the tracker. **Not yet checked by you.** |
| `partly` | some of it shipped; the rest is named in the item |
| `reopened` | shipped, then reported again or marked ❌; the new report's ID is in the item |

**Builds.** A report is tagged with the build it was played on, so "it was already
fixed" can be answered from the version. Playtest 1 was before w29 closed, playtest 2
on `0.26.x` before w31, playtest 3 on `0.27.0` (w31).

**Asked** is how many times the operator has raised the same thing, counting across
lists. Three or more is a signal that the fix keeps missing what was meant.

**Not imported yet:** the 2026-09-28 lists (waves 25–28) live in the board's wave
sections, not here. Say the word and they come in.

*Last updated: 2026-09-30, after wave 31 landed and wave 32 was planned.*

---

## Check these in your next game

**Only what a person can judge**, and only what no known bug will get in the way of. Everything
a test proves has been left out on purpose so a play-test is not spent on it. Updated after wave 33.

**Look and feel:**

1. **Drag (Q4):** our own ghost, a landing indicator, snaps to a slot; lands in the back row, the rest in front, filling left to right. Does it *feel* right?
2. **Left column (Q9):** avatar, counts, then a tall graveyard; the opponent mirrored. Is the graveyard tall enough (it measures about half the column)?
3. **Card size on a small board (Q4):** six or fewer permanents now give smaller cards (you approved this; check you still like it).
4. **Phase rail (Q3):** centred, un-bulleted, grows in combat, rows the same height out of combat.
5. **Active player ring (Q1)** and `Start` at turn 0.
6. **Header gear (Q15):** one gear holds board layout and "always stop at end step".
7. **Picker (L3):** OK and Clear stay visible with a long list.
8. **Poison counters (L4):** appear when you have them; the energy line is known to clip.

**Do not spend a game on these (known gaps):** responding to an opponent's spell with **Full Control on** (does nothing: wave 34), the **order of simultaneous triggers** (Q8, never exercised), **Ponder** (its follow-up questions are sometimes answered for you), the **Choose X slider** (L13, unit-tested only), and **two spells on the stack with an arrow** (Q7's second half).

**Tests prove it:** End Turn passes phases at once (Q5); blockers can be assigned (Q12); no blockers stop without creatures (Q10); pulling attackers back (Q14); your own spell does not hold priority (Q17); a stack ability is not clickable (Q18); an auto-target arrow (L8); P/T bottom-right; opponent hand size; eight snap points; avatar change reaches the game.

**From w31, still unchecked by you:** mulligan order, Gitaxian Probe at 0 mana, reload mid-decision, second browser spectates, gone-match page, stale rooms.

---

## Playtest 1 — 2026-09-30, before w29 closed (build ≤ 0.25)

Numbering is the operator's (there was no item 19).

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | mulligan broken: only `Auto` live, hand dead | 1 | shipped w30, w31 | `de0928f` (flag reaches the seat), `be615f1` + fork `917bb193` (order); real-Forge tests | take a mulligan: hand lights up, pick a card | |
| L2 | the end step waits on the opponent | 1 | shipped w30 | default off, setting in w30 (`5b6c73e`); **moving to the header menu in w32 (Q15)** | end a turn with a land played; it should not stop at their end step | |
| L3 | picker `OK` / `Clear choice` below the panel, not at the bottom of a scroll | 1 | shipped w33 | `461b52a`: OK and Clear stay below a scrolling list; mutation: un-wrapping the body fails 3 of 4. **Unit and screenshot only** | open any selector with a long list: OK is visible without scrolling |  |
| L4 | poison/infect counters shown nowhere | 1 | shipped w33 (unit and screenshot only) | `b165952`: poison/energy/experience beside the counts; no scenario sets poison. **The energy line is clipped under the opponent's side column at 1280×800** | poison counters appear when you have them |  |
| L5 | delete `Leave`; `Concede` is enough | 1 | shipped w30 | w30 lane A | no `Leave` button | |
| L6 | arrow snapping/effect not shown when casting | 1 | partly | w29 staging area; **8-point snap is Q11, w32** | cast a targeted spell; the card shows in staging with the arrow starting there | |
| L7 | avatars not showing | 3 (L7, P3b, Q6) | partly | w29 carried the field; w31 fixed the 404 and the account read; **unset avatar waits on watchparty; live change is Q6, w32** | | |
| L8 | an auto-targeted effect still needs its arrow on the stack (Fiend Hunter) | 1 | shipped w33 | `461b52a` + `b165952`: the stack entry carries its targets; an arrow is drawn; `w33.spec` Doom Blade 10 of 10, mutation: the arrow disabled fails 2 of 2 | an effect with one target (Fiend Hunter) shows its arrow on the stack |  |
| L9 | graveyard double-stacked | 3 (L9, P2, Q9) | reopened → P2, Q9 | w30 made it one stack; the layout was then reported again | | |
| L10 | z-order: cards, then effects on cards, then popups | 2 (L10, Q16) | open → Q16 | w32 | counters and P/T sit under any open popup | |
| L11 | one undivided board, type-separated as the alternate | ≥3 | shipped w30 | `5b6c73e`, `fc56164`; board `single` is the default | cards sit on one surface, no lane labels | |
| L12 | holding priority after casting | 2 (L12, Q17) | open → Q17 | w32 diagnoses first; not `passStackWindows` | cast a spell; you do not keep priority | |
| L13 | `Choose X` as a slider, capped at available mana | 1 | shipped w33 (unit tests only) | `461b52a`: a slider; Forge's own X max is already the available mana. **No scenario asks for X**; the screenshot shows OK faint at X=0 | Choose X is a slider capped at the mana you have |  |
| L14 | P/T drawn bottom-right, over where it normally sits | 2 (L14, Q13) | open → Q13 | w32 | | |
| L15 | blockers: an arrow from each attacker; blockers highlight blue | 1 (Q12 is a related, different symptom) | open → Q12 | w32 (Q12 first needs a repro) | | |
| L16 | delete `Call Back` | 1 | shipped w30 | w30 lane A | no `Call Back` button | |
| L17 | the wolf-run arrow defaults to my own portrait | 1 | shipped w29 | w29 §A item 17, per the wave file; **not re-verified by the tracker** | | |
| L18 | I could concede after the game had ended | 1 | shipped w31 | `685d598` + `ef0f07d`; `w31.spec.ts` | game over: Concede is off | |
| L20 | `sound on` should be an icon | 1 | shipped w31 | `9e5bb0c` | speaker icon, not words | |

## Playtest 2 — 2026-09-30, on `0.26.x`, before w31 landed

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | combat phases collapsed outside combat | 2 | shipped w31 → follow-up Q3 | `ef0f07d`; `w31.spec.ts` | one combat step out of combat, six in it | |
| P2 | card/deck counts; graveyard ≥ 75% of the left column | 3 (L9, P2, Q9) | reopened → Q9 | w31 made the piles 4fr/1fr **inside the hand's cell**; the operator meant the whole column | | |
| P3 | life under the avatar; names not `Seat N`; no `(you)` | 1 | shipped w31 | `78308ab`, `685d598` | names, life under the face, no `(you)` text | |
| P3b | only one avatar works in game; the unset case | 3 | partly | the 404 and the account read fixed in `9e5bb0c`; **unset avatar waits on watchparty** (`WATCHPARTY_ROSTER_FOR_HOST.md`, not yet sent) | your avatar on your face at match start | |
| P4 | colours follow the theme | 1 | shipped w31 | `9e5bb0c`, `dadd324`; **`--accent` as text is under 3:1 in two light themes (open, w32 R)** | switch themes | |
| P5 | delete `Regroup` | 1 | shipped w31 | `78308ab` | no `Regroup` button | |
| P6 | page boundary; remove the black canvas border | 1 | shipped w31 | `ef0f07d`, `78308ab`; edges measured 0 px off the header | table and chat edges line up with the header | |
| P7 | mulligan asks *keep?* again after putting a card back | 1 | shipped w31 | fork `917bb193`, jar installed; real-Forge test fails on the old jar, passes on the new | see "next game" 1 | |
| P8 | Gitaxian Probe unplayable at zero mana | 1 | shipped w31 | fork `917bb193`; the old jar offers `[]`, the new jar offers it | see "next game" 2 | |
| P9 | stack height; Ponder's text unreadable | 1 | partly | readable when no question is open; **with a question open the band still clips (w32 B)** | | |
| P10 | reload with a decision open soft-locks | 1 | shipped w31 | `685d598`; `w31.spec.ts` (London bottom pick across a reload) | see "next game" 3 | |
| P11 | drag is too hard, no animation, browser ghost | 2 (P11, Q4) | planned w32 | wave 32 lane B, last task | | |
| P12 | the log's own hover display | 1 | shipped w31 | `ef0f07d` | hover a card name in the log | |
| X1 | a second browser on a held seat is a spectator | 1 | shipped w31 | `685d598` + `ef0f07d`; `w31.spec.ts` | see "next game" 4 | |
| X2 | a second browser renamed the account to "Himmel" | 1 | shipped (watchparty) | `@wolffm/watchparty-ui` 0.39.20, watchparty `477124f7`; cardtable bump `0553bb8` | open a second browser; your name stays | |
| X3 | "why can I still join a gone match" | 1 | shipped w31 | `ef0f07d`; the **server side is separate**: a redeploy still kills live matches (`treekill`, open in `hadoku_site`) | old match link shows a reason and a way back | |
| X4 | "why are old rooms still listed" | 1 | shipped w31 | `9e5bb0c` (30-minute rule) | | |

## Deck screen — 2026-09-30, fixed directly (`0.26.1`)

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | extra mana symbols under the chosen deck | 1 | shipped | `7bba643` | pick a deck: one colour row | |
| D2 | the "source" link | 1 | shipped | `7bba643` (attribution kept in each `.dck` and `decks/README.md`) | no source link | |
| D3 | Random and Ready at the top | 1 | shipped | `7bba643` | both above the deck list | |
| D4 | the "built for … but the pool is …" note | 1 | shipped | `7bba643` | no era note | |

## Playtest 3 — 2026-09-30 evening, on `0.27.0` (w31), match `m-96b0a5e2f90d`

All planned in **wave 32** (`docs/planning/wave32-2026-10-01.md`).

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | drop "0 Nobody"; show `Start`; ring the active player's avatar | 1 | shipped w32; ring now tested w33 | `5312231`, `4744c57`; the ring is asserted by `w33.spec` (10 of 10) | the active player has a ring round their avatar; turn 0 reads `Start` |  |
| Q2 | opponent's hand the same card size, mirrored | 1 | shipped w32 | `4744c57`; mutation-tested (opponent hand 4rem: 4 fail) | their hand cards are the same size as yours |  |
| Q3 | phase names centred and un-bulleted; rail grows in combat | 1 (follow-up on P1) | shipped w32; rows fixed w33 (unit tests only) | `9bd535b`: rail rows are one measured height (`--live-h`). **No e2e fails when the fix is reverted**; the 2.16 px "flake" was the test (a second page never resized), fixed in E | rail rows the same height in and out of combat |  |
| Q4 | lands back row, others front; free placement; own drag ghost and snap indicator | 2 (with P11) | shipped w32 | `4744c57`: pointer drag with our own ghost, indicator and snap; two-tier default placement; frames `wave32-evidence/q4-drag-*.png`. **Touch not tried on a device** | drag a card: our ghost, a landing indicator, snaps to a slot; lands in the back row, the rest in front, filling left to right |  |
| Q5 | skipped phases should not crawl | 1 | shipped w32 | `9a70f47`; real Forge: End Turn gaps 5-11 ms against 206-211 ms reverted (`endturn.jvm`, 3 of 3 re-run by the tracker) | click End Turn: the phases go by at once |  |
| Q6 | an avatar change does not reach the game | 1 | shipped w32 | `d2fc75b`, `9a70f47`; `w32.spec` avatar test (mutation: fails reverted). A **cleared** avatar is not noticed (watchparty) | change your avatar in the chat; your face in the game changes |  |
| Q7 | Mana Leak: arrow to a stack item; shortcut when one target | 1 | shipped w32; half-verified w33 | e2e asserts the outcome (the lone spell is countered, no target ask), 10 of 10. **The two-spells half (an arrow picks one) is unobservable: see the Full Control bug below** | a lone spell answers itself |  |
| Q8 | "order simultaneous abilities" only in full control | 1 | shipped w32, **still unverified** | `auto.test` only. The scenario could not reach the position (a state jump never materialises Upkeep triggers); the test was deleted, not left red | two triggers: no ordering question unless in full control |  |
| Q9 | one column: avatar, counts, graveyard the rest; opponent mirrored | 3 (with L9, P2) | shipped w32 (look at it) | `4744c57`: graveyard takes the rest of the column; **measured 50.6% of the column at 1280x800** (information only). Opponent mirrored | avatar, counts, then a tall graveyard; the opponent mirrored, nothing upside-down |  |
| Q10 | no Declare Blockers stop without creatures | 1 | shipped w32; now exercised w33 | real Forge scenarios (`scenario-blockers.jvm`) and e2e 10 of 10 | attack into a player with no creatures: no blockers stop |  |
| Q11 | arrow snaps to 8 points on the card edge | 1 | shipped w32 | `3b9c22c`; `gestures.test` + `arrow.spec` pass | a target arrow ends on a corner or edge midpoint of the card, not its centre |  |
| Q12 | could not assign blockers at all | 1 (related to L15) | shipped w32; now exercised w33 | scenario e2e 10 of 10 (blockers assignable, the block prompt appears) | be attacked: "Select creatures to block" appears |  |
| Q13 | P/T bottom-right | 2 (with L14) | shipped w32 | `4744c57`; mutation-tested (P/T top: 1 fails) | P/T sits in the card's bottom-right corner |  |
| Q14 | click or box-select attackers to pull them back | 1 | shipped w32; now exercised w33 | `502b289`: opens Forge's live attack input so a declared attacker can be called back; scenario e2e 10 of 10 | click a declared attacker: it comes back |  |
| Q15 | settings into the header menu; explain Cancel; layout is mine only | 1 | shipped w32 | `5312231`: settings in the header gear (button and panel deleted), Cancel only when Forge enables it, layout applies to your board only (`4744c57`); `w32.spec` header-menu helpers pass | one gear in the header holds board layout and "always stop at end step" |  |
| Q16 | card labels under popovers | 2 (with L10) | shipped w32 (accent text remains) | `d2fc75b` `--z-*` scale used by B, L, G. **`--accent` is still used as text** in `live.css`, `prompts.css`, `board.css` (w33) | card labels and P/T sit under any open popover |  |
| Q17 | holding priority on my own spells | 2 (with L12) | shipped w32, approved; now exercised w33 | `w33.spec` Q17 10 of 10; mutation: the actionable refresh removed fails 3 of 3 | cast a creature: the stack resolves without you holding priority |  |
| Q18 | an activated ability on the stack (Glint Hawk Idol) shows as clickable; only the card on the board should be activatable | 1 | shipped w33 | `b165952`, `57664ab`: a stack ability is never selectable by its card id. e2e with a real activated ability (Shivan Dragon) 10 of 10; with the first scenario (a tap ability) it passed vacuously and was reworked | click a stack ability: nothing happens |  |

---

## Deck library — 2026-10-01, reported on `0.27.0` (nine "Standard eras", all from the same range)

Not a play-test item: the operator's review of the deck picker. **Selection is ready for review; nothing is integrated yet** (`docs/planning/deck-selection/review/README.md`).

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| DL1 | duplicate decks never get in (4 Tempered Steel lists: keep the one that went furthest) | 1 | planned | rule in `tools/select_decks.py`: same cards (60%), same colours and 45%, or same archetype name and 30% count as one deck; the best finish stays | one deck per archetype in an era | |
| DL2 | colour balance, with a lean toward what was best | 1 | planned | the 96 selected decks play W 40, U 42, B 41, R 41, G 41 | each colour is about equally represented | |
| DL3 | style balance (aggro, midrange, combo): a few of the rarest, fewer of the most common | 1 | planned | aggro 32, midrange 25, control 26, combo 13; style is a heuristic, see the table in the review | | |
| DL4 | eras: no empty ones, a whole block at a time; yearly "power summer" 2008–2016 | 1 | planned | nine eras, one per year, the Standard just before the fall rotation. **2009 (4 decks) and 2010 (8) are thin** (mtgtop8 coverage and the July core-set rotation) | the era list is nine years, not nine mid-season snapshots | |

## Regressions

None recorded yet, because nothing has had a `✅` from you to regress from. When an
item you have checked comes back, it is listed here with both dates and builds.

| item | ✅ on | build | reported again | build | note |
| --- | --- | --- | --- | --- | --- |

## How the tracker keeps this

- **At every wave landing:** each shipped item moves to `shipped wNN` with the commit
  and the one-line "check it by", and the "next game" list at the top is rewritten
  from what just landed.
- **At every new list:** each item is checked against this ledger first. A repeat
  bumps `asked` on the original and gets a cross-reference, instead of becoming a
  fresh row that looks new.
- **Verification is yours.** The tracker never writes a `✅`.
