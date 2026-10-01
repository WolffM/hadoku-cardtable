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

**Only what a person can judge.** Everything a test can prove has been moved out of this
list on purpose, so a play-test is not spent re-checking it. If any of the "tests prove
it" items below looks wrong in play, that is a bug in the test and worth telling me.

**You have to look (feel, size, appearance):**

1. **Drag (Q4):** a card follows your pointer with our own ghost, shows where it will land, and snaps to a slot. Does it *feel* right? Do lands start in the back row and everything else in front?
2. **Left column (Q9):** avatar, then the counts, then a tall graveyard; the opponent mirrored, nothing upside-down. Is the graveyard tall enough? (It measures about half the column.)
3. **Card size on a small board (Q4):** with six or fewer permanents the cards are now *smaller* than before (the board is always two tiers). Do you want that?
4. **Phase rail (Q3):** centred, un-bulleted, grows in combat. Are the rows still visibly stretched out of combat?
5. **Active player ring (Q1)** and **`Start`** at turn 0: no test checks the ring.
6. **Your own spell no longer holds priority (Q17):** cast a creature and the stack resolves without you holding priority. This is a behaviour change; say if you want it back.
7. **Header gear (Q15):** one gear holds board layout and "always stop at end step"; the old settings button is gone.

**Tests prove it (do not spend a game on these):** End Turn passes phases at once (Q5, real Forge, 5-11 ms gaps); blockers can be assigned (Q12, found and fixed: the server pressed OK twice, it was not summoning sickness); no Declare Blockers stop without creatures (Q10); P/T bottom-right (Q13); the opponent's hand matches yours (Q2); arrows snap to eight points (Q11); avatar change reaches the game (Q6); z-order of labels under popovers (Q16).

**Shipped but never exercised in a real game by any test (be suspicious):** Mana Leak with one spell on the stack answering itself (Q7), pulling attackers back (Q14), ordering of simultaneous abilities (Q8). These are why the next wave builds scripted scenarios first.

**From w31, still unchecked by you:** mulligan order, Gitaxian Probe at 0 mana, reload mid-decision, second browser spectates, gone-match page, stale rooms.

---

## Playtest 1 — 2026-09-30, before w29 closed (build ≤ 0.25)

Numbering is the operator's (there was no item 19).

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | mulligan broken: only `Auto` live, hand dead | 1 | shipped w30, w31 | `de0928f` (flag reaches the seat), `be615f1` + fork `917bb193` (order); real-Forge tests | take a mulligan: hand lights up, pick a card | |
| L2 | the end step waits on the opponent | 1 | shipped w30 | default off, setting in w30 (`5b6c73e`); **moving to the header menu in w32 (Q15)** | end a turn with a land played; it should not stop at their end step | |
| L3 | picker `OK` / `Clear choice` below the panel, not at the bottom of a scroll | 1 | planned w33 | w33 lane G: OK and Clear below the panel, the list scrolls inside | open any selector; OK is visible without scrolling |  |
| L4 | poison/infect counters shown nowhere | 1 | planned w33 | w33 lane B: poison (and energy/experience) beside the counts |  |  |
| L5 | delete `Leave`; `Concede` is enough | 1 | shipped w30 | w30 lane A | no `Leave` button | |
| L6 | arrow snapping/effect not shown when casting | 1 | partly | w29 staging area; **8-point snap is Q11, w32** | cast a targeted spell; the card shows in staging with the arrow starting there | |
| L7 | avatars not showing | 3 (L7, P3b, Q6) | partly | w29 carried the field; w31 fixed the 404 and the account read; **unset avatar waits on watchparty; live change is Q6, w32** | | |
| L8 | an auto-targeted effect still needs its arrow on the stack (Fiend Hunter) | 1 | planned w33 | w33 lanes B, G: the stack entry carries its targets (`TargetCards`, on Forge's wire) and an arrow is drawn |  |  |
| L9 | graveyard double-stacked | 3 (L9, P2, Q9) | reopened → P2, Q9 | w30 made it one stack; the layout was then reported again | | |
| L10 | z-order: cards, then effects on cards, then popups | 2 (L10, Q16) | open → Q16 | w32 | counters and P/T sit under any open popup | |
| L11 | one undivided board, type-separated as the alternate | ≥3 | shipped w30 | `5b6c73e`, `fc56164`; board `single` is the default | cards sit on one surface, no lane labels | |
| L12 | holding priority after casting | 2 (L12, Q17) | open → Q17 | w32 diagnoses first; not `passStackWindows` | cast a spell; you do not keep priority | |
| L13 | `Choose X` as a slider, capped at available mana | 1 | planned w33 | w33 lane G: a slider; the cap is whatever Forge's ask carries |  |  |
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
| Q1 | drop "0 Nobody"; show `Start`; ring the active player's avatar | 1 | shipped w32 | `5312231` (Start, no name), `4744c57` (ring); `w32.spec` Q1 passes. **No test asserts the ring on the active avatar** | the active player has a circle round their avatar; turn 0 reads `Start` |  |
| Q2 | opponent's hand the same card size, mirrored | 1 | shipped w32 | `4744c57`; mutation-tested (opponent hand 4rem: 4 fail) | their hand cards are the same size as yours |  |
| Q3 | phase names centred and un-bulleted; rail grows in combat | 1 (follow-up on P1) | shipped w32 (test flaky) | `5312231`; the e2e that measures it fails **3 of 5 runs**: out-of-combat rail rows measured 17.5 px against 15.4 px in combat (tolerance 2). The rows still differ slightly | rail names centred, un-bulleted; grows in combat. **Are the rows still visibly stretched out of combat?** |  |
| Q4 | lands back row, others front; free placement; own drag ghost and snap indicator | 2 (with P11) | shipped w32 | `4744c57`: pointer drag with our own ghost, indicator and snap; two-tier default placement; frames `wave32-evidence/q4-drag-*.png`. **Touch not tried on a device** | drag a card: our ghost, a landing indicator, snaps to a slot; lands in the back row, the rest in front, filling left to right |  |
| Q5 | skipped phases should not crawl | 1 | shipped w32 | `9a70f47`; real Forge: End Turn gaps 5-11 ms against 206-211 ms reverted (`endturn.jvm`, 3 of 3 re-run by the tracker) | click End Turn: the phases go by at once |  |
| Q6 | an avatar change does not reach the game | 1 | shipped w32 | `d2fc75b`, `9a70f47`; `w32.spec` avatar test (mutation: fails reverted). A **cleared** avatar is not noticed (watchparty) | change your avatar in the chat; your face in the game changes |  |
| Q7 | Mana Leak: arrow to a stack item; shortcut when one target | 1 | shipped w32, **not verified in a browser** | `3b9c22c`, `ea309c1`; unit tests only. The e2e that should drive it **passed vacuously** (the game never reached a stack ask) | cast Mana Leak against one spell on the stack: it should answer itself; with two, drag an arrow to the one you mean |  |
| Q8 | "order simultaneous abilities" only in full control | 1 | shipped w32 (unit tests only) | `9a70f47`; `auto.test` mutation 3 fail. Never driven against real Forge | two triggers at once: no ordering question unless you are in full control |  |
| Q9 | one column: avatar, counts, graveyard the rest; opponent mirrored | 3 (with L9, P2) | shipped w32 (look at it) | `4744c57`: graveyard takes the rest of the column; **measured 50.6% of the column at 1280x800** (information only). Opponent mirrored | avatar, counts, then a tall graveyard; the opponent mirrored, nothing upside-down |  |
| Q10 | no Declare Blockers stop without creatures | 1 | shipped w32, **e2e vacuous** | `9a70f47`; unit + `blockers.jvm` (3 of 3 re-run by the tracker). The browser test never met a blockers window | attack into a player with no creatures: no Declare Blockers stop |  |
| Q11 | arrow snaps to 8 points on the card edge | 1 | shipped w32 | `3b9c22c`; `gestures.test` + `arrow.spec` pass | a target arrow ends on a corner or edge midpoint of the card, not its centre |  |
| Q12 | could not assign blockers at all | 1 (related to L15) | shipped w32 (root cause found and fixed) | **Not summoning sickness.** `9a70f47`: Forge sends the block input's buttons before its prompt, and the server pressed OK a second time, skipping "Select creatures to block". Re-run by the tracker: reverting the fix fails `blockers.jvm` on exactly that prompt, restoring it passes | be attacked with a creature on your side: "Select creatures to block" appears and you can assign blockers |  |
| Q13 | P/T bottom-right | 2 (with L14) | shipped w32 | `4744c57`; mutation-tested (P/T top: 1 fails) | P/T sits in the card's bottom-right corner |  |
| Q14 | click or box-select attackers to pull them back | 1 | shipped w32, **unverified against real Forge** | `3b9c22c` + `9a70f47`; unit tests only | in Declare Attackers, click an attacker, or drag a box over several: they come back |  |
| Q15 | settings into the header menu; explain Cancel; layout is mine only | 1 | shipped w32 | `5312231`: settings in the header gear (button and panel deleted), Cancel only when Forge enables it, layout applies to your board only (`4744c57`); `w32.spec` header-menu helpers pass | one gear in the header holds board layout and "always stop at end step" |  |
| Q16 | card labels under popovers | 2 (with L10) | shipped w32 (accent text remains) | `d2fc75b` `--z-*` scale used by B, L, G. **`--accent` is still used as text** in `live.css`, `prompts.css`, `board.css` (w33) | card labels and P/T sit under any open popover |  |
| Q17 | holding priority on my own spells | 2 (with L12) | shipped w32; **operator approved the change 2026-10-01** | `9a70f47`: your own spell no longer holds priority (`priority.jvm` 3 of 3 re-run). **This is a behaviour change only you can approve**: after casting you do not get priority back to cast a second spell on top, unless in full control | cast a creature: the stack resolves without you holding priority. Is that what you wanted? |  |
| Q18 | an activated ability on the stack (Glint Hawk Idol) shows as clickable; only the card on the board should be activatable | 1 | planned w33 | **root cause found:** for an ability, `sourceCardId` is the permanent, which Forge offers for its own activation, so `StackItem` (`Board.tsx:1858`) draws a button whose click is `onSelectCard(sourceId)`, the same action as clicking the card. Not cosmetic. w32 was already dispatched; its lane-G manager was told as information for Q7 (stack targets share the collision) **Planned w33 lane B** | click a stack ability: nothing happens |  |

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
