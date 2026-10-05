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

**Only what a person can judge**, and nothing a known bug will spoil. Updated 2026-10-03 after w36 + the tracker's direct fixes.
**You can play this one alone now:** make a room, stay alone, press **Play vs Forge AI**.

**Fixed since playtest 5, please re-check:** Secluded Glen's reveal enters it untapped (T12); declaring attackers takes **one** OK (T3); "Waiting for ___" no longer sits over your own reveal choice.

**New since the last game:**

1. **The bot (B1):** does Forge's AI play a sensible game with the deck it drew?
2. **The deck library (DL1–DL4):** nine summer eras; are the decks fun, varied, and different from each other? Note 2009 has 4 decks and 2010 has 8.
3. **Full Control:** turn it on and respond to the AI's spell with an instant; it should work now. If your first OK after casting seems to do nothing, press again and tell me (a known intermittent, see below).
4. **Ponder:** its look-at-three and shuffle questions should reach you.

**Look and feel, still unchecked:** drag (Q4), the left column (Q9), card size on small boards, the phase rail (Q3), the active-player ring (Q1), the header gear (Q15), the picker's OK (L3), poison counters (L4), the Choose X slider (L13).

**Do not spend a game on:** two spells on the stack with an arrow picking one (Q7's second half, not built yet).

**From w31, still unchecked:** mulligan order, Gitaxian Probe at 0 mana, reload mid-decision, second browser spectates, gone-match page, stale rooms.

---

## Playtest 1 — 2026-09-30, before w29 closed (build ≤ 0.25)

Numbering is the operator's (there was no item 19).

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | mulligan broken: only `Auto` live, hand dead | 1 | shipped w30, w31 | `de0928f` (flag reaches the seat), `be615f1` + fork `917bb193` (order); real-Forge tests | take a mulligan: hand lights up, pick a card | |
| L2 | the end step waits on the opponent | 1 | shipped w30 | default off, setting in w30 (`5b6c73e`); **moving to the header menu in w32 (Q15)** | end a turn with a land played; it should not stop at their end step | |
| L3 | picker `OK` / `Clear choice` below the panel, not at the bottom of a scroll | 1 | shipped w33 | `461b52a`: OK and Clear stay below a scrolling list; mutation: un-wrapping the body fails 3 of 4. **Unit and screenshot only** | open any selector with a long list: OK is visible without scrolling |  |
| L4 | poison/infect counters shown nowhere | 1 | shipped w33, w34 | `5ee8a83`: counters draw as P3 / E7 / XP2 inside their column (full word on hover); live `poison.state` screenshots; `w34.spec` counter specs fail when reverted | poison counters appear when you have them, inside your column |  |
| L5 | delete `Leave`; `Concede` is enough | 1 | shipped w30 | w30 lane A | no `Leave` button | |
| L6 | arrow snapping/effect not shown when casting | 1 | partly | w29 staging area; **8-point snap is Q11, w32** | cast a targeted spell; the card shows in staging with the arrow starting there | |
| L7 | avatars not showing | 3 (L7, P3b, Q6) | partly | w29 carried the field; w31 fixed the 404 and the account read; **unset avatar waits on watchparty; live change is Q6, w32** | | |
| L8 | an auto-targeted effect still needs its arrow on the stack (Fiend Hunter) | 1 | shipped w33 | `461b52a` + `b165952`: the stack entry carries its targets; an arrow is drawn; `w33.spec` Doom Blade 10 of 10, mutation: the arrow disabled fails 2 of 2 | an effect with one target (Fiend Hunter) shows its arrow on the stack |  |
| L9 | graveyard double-stacked | 3 (L9, P2, Q9) | reopened → P2, Q9 | w30 made it one stack; the layout was then reported again | | |
| L10 | z-order: cards, then effects on cards, then popups | 2 (L10, Q16) | open → Q16 | w32 | counters and P/T sit under any open popup | |
| L11 | one undivided board, type-separated as the alternate | ≥3 | shipped w30 | `5b6c73e`, `fc56164`; board `single` is the default | cards sit on one surface, no lane labels | |
| L12 | holding priority after casting | 2 (L12, Q17) | open → Q17 | w32 diagnoses first; not `passStackWindows` | cast a spell; you do not keep priority | |
| L13 | `Choose X` as a slider, capped at available mana | 1 | shipped w34, **one ruling open** | `11a7a22`: the slider reads Forge's real range and OK has contrast; `choose-x.jvm` 1/1 (tracker re-ran). **Not capped at your mana:** Forge itself offers 0-9 plus "Other" for a mana X and sends no mana figure. Capping needs a new field from the bridge, or your ruling that Forge's own range is fine | Choose X is a slider; OK is readable |  |
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
| P9 | stack height; Ponder's text unreadable | 3 (with T8) | reopened → T8 | readable when no question is open; **with a question open the band still clips (w32 B)** |  |  |
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
| Q4 | lands back row, others front; free placement; own drag ghost and snap indicator | 3 (with P11, R9) | reopened → shipped w32 | `4744c57`: pointer drag with our own ghost, indicator and snap; two-tier default placement; frames `wave32-evidence/q4-drag-*.png`. **Touch not tried on a device** | drag a card: our ghost, a landing indicator, snaps to a slot; lands in the back row, the rest in front, filling left to right |  |
| Q5 | skipped phases should not crawl | 1 | shipped w32 | `9a70f47`; real Forge: End Turn gaps 5-11 ms against 206-211 ms reverted (`endturn.jvm`, 3 of 3 re-run by the tracker) | click End Turn: the phases go by at once |  |
| Q6 | an avatar change does not reach the game | 1 | shipped w32 | `d2fc75b`, `9a70f47`; `w32.spec` avatar test (mutation: fails reverted). A **cleared** avatar is not noticed (watchparty) | change your avatar in the chat; your face in the game changes |  |
| Q7 | Mana Leak: arrow to a stack item; shortcut when one target | 1 | shipped w32; half-verified w33 | e2e asserts the outcome (the lone spell is countered, no target ask), 10 of 10. **The two-spells half (an arrow picks one) is unobservable: see the Full Control bug below** | a lone spell answers itself |  |
| Q8 | "order simultaneous abilities" only in full control | 1 | shipped w32; exercised w34 | `5c2192f`: a real-Forge scenario with two different upkeep triggers (Dark Confidant + Phyrexian Arena); `scenario-order.jvm` 2/2 (tracker re-ran). Two *identical* triggers never ask in Forge, which is why w33 could not reach it | two different triggers at once: no ordering question unless in full control |  |
| Q9 | one column: avatar, counts, graveyard the rest; opponent mirrored | 4 (with L9, P2, R3) | reopened → shipped w32 (look at it) | `4744c57`: graveyard takes the rest of the column; **measured 50.6% of the column at 1280x800** (information only). Opponent mirrored | avatar, counts, then a tall graveyard; the opponent mirrored, nothing upside-down |  |
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
| DL1 | duplicate decks never get in (4 Tempered Steel lists: keep the one that went furthest) | 1 | shipped w34 | `7029898`: one deck per archetype by the selection rules | one deck per archetype in an era |  |
| DL2 | colour balance, with a lean toward what was best | 1 | shipped w34 | 96 decks; colour spread as selected | each colour is about equally represented |  |
| DL3 | style balance (aggro, midrange, combo): a few of the rarest, fewer of the most common | 1 | shipped w34 | **2014 lost its only combo deck**: three chosen decks had a card mtgtop8 exports as "Unknown Card" and were swapped for the next alternate (2011 UB Control → Elves; 2014 UWr Control → Orzhov Control; 2014 Reanimator → Jund Aggro) |  |  |
| DL4 | eras: no empty ones, a whole block at a time; yearly "power summer" 2008–2016 | 1 | shipped w34 | `7029898`: exactly nine eras reach the picker (the loader reads only catalogued dates; tracker mutation: a directory scan fails 2 of 3); every card resolves in Forge at the pin (1151 card/set pairs); a real match starts in each era (9/9, tracker re-ran). Default era 2016 | the era list is nine summers, 2008–2016; pick decks from several eras |  |

## Playtest 4 — 2026-10-02, on `0.30.0` (w34), match `m-a1e09072057f`, two humans

Operator: *"honestly, things are looking very good. i think its almost ready for the first alpha
release."* Planned as **wave 35** unless noted.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | chat collapsible (like watchparty's own) and drag-to-resize | 1 | shipped (watchparty `0.40.5`, live in cardtable since 2026-10-03 13:01 UTC) | watchparty `d5099fb0`: Hide chat collapses to a 36 px rail; drag the left edge 240–640 px; remembered per viewer. See T11 for the width limit | collapse the chat and drag it |  |
| R2 | play/draw decision in the middle-right decision area, not the control bar; a coin-flip animation | 1 | planned w35 | | the coin flip and the play/draw choice appear where card decisions do | |
| R3 | left column: counts much closer to the avatar | 4 (with L9, P2, Q9) | planned w35 | | | |
| R4 | Thoughtseize: three steps (look at hand, choose, "looking at cards in your hand") should be one choice with the unchoosable cards greyed; the modal shows a scrollbar with nothing to scroll | 1 | planned w35, diagnose first | | cast Thoughtseize: one choice | |
| R5 | highlight End Turn when there is nothing left to decide | 1 | planned w35 | | | |
| R6 | a flicker when clicking End Turn | 1 | planned w35, diagnose first | | | |
| R7 | cast by dragging the card out, with a targeting arrow from it (not click → card vanishes → pick a target), for nearly all cards | 1 (related to L6) | planned w35 | the long pole | drag Thoughtseize toward a player | |
| R8 | the log button is an icon | 1 | planned w35 | | | |
| R9 | move a card to ANY slot; it still snaps to the left-most free one | 3 (with P11, Q4) | reopened, planned w35 | w32 built snapping, but to the next free slot, not the one under the pointer | drop a card in the middle of the row: it stays there | |
| R10 | a flicker of "Creature" and rules text when a creature taps to attack | 1 | planned w35, diagnose first | | | |
| R11 | remove the turn counter from the phase bar (the log has it) | 1 | planned w35 | | | |
| R12 | animations: tapping, creatures striking a face, floating combat text | 1 | **deferred to v2** (operator: *"we can ship that as part of v2… what we're building at the moment is essentially the 'simple mode' for low-end PCs"*) | | | |
| R13 | Secluded Glen's "you may reveal a Faerie" was decided for me | 1 | planned w35, diagnose first | **not a client or server auto-answer**: the match log shows no auto-answered choice, and every choice took a person 2.7–112 s. So it never reached the seat as a question (Forge decided, or the server pressed OK on an input) | play Secluded Glen with a Faerie in hand: you are asked | |
| R14 | Goblin Rogue token has no art | 2 (with T9) | planned w35 (not yet deployed when T9 was reported) | `art-ids.json` has **no token entries at all**: every token is art-less | make a token: it has art |  |
| R15 | lands cannot be tapped freely for mana before casting; show the pool as you tap; a card changed by an effect (Magus of the Moon) should show its new identity visually | 1 | planned w35 (lands need a **Forge fork change and a jar you install**) | **root cause:** Forge's clickable filter excludes every mana ability (`forge-ai/.../AvailableActions.java:82`, `!sa.isManaAbility()`), so a land is never clickable outside a payment. Not Magus | tap a land at priority: mana appears in your pool | |
| R16 | a real victory/defeat screen, not the "game over" toast; **Rematch** (back to the room's deck selection) and **Main menu** (to the lobby list); if the leader picks Main menu and the other Rematch, the other becomes leader | 1 | planned w35 | today it is one line, `<p class="board__over">game over</p>` (`Board.tsx:2648`); the adapter knows `gameOver` and each player's `hasLost`. **Rooms have no "leave" today** (members only accumulate), and a finished match holds its room for ten minutes, which would bounce a Rematch back to the old match: w35 lane R | win, lose and concede: a full result screen, not a toast |  |

## Playtest 5 — 2026-10-03 (01:02 UTC), match `m-b81d965aa0fb`, two humans

**Played on a half-landed build:** the server was still `0.30.0`, but wave 35's Forge jar (lands
tappable) had been installed into production at 09:59 PDT, before w35's server code that handles the
newly-offered lands. So every land was clickable at priority with the old auto-pass logic. Auto-passing
was NOT broken wholesale (153 auto-passes in 89 min, the same rate as the game before the swap), but an
oddity at a specific stop may come from it (T3 is the candidate). Nothing from w35 was live otherwise.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | the hover zoom (inspector) is misaligned | 1 | shipped w36 (partial), **needs your frame** | w36 G: battlefield, stack and tapped hovers measured pixel-exact at 1280×800 and 1366×768; a hand card was off by 7–10 px (fixed, `8d3e034`). **Not reproduced as you saw it**: a screenshot of the misalignment would settle it. | hover a card: the zoom sits where it should |  |
| T2 | show when you are waiting on the other player | 1 | shipped w36 | `f6503d4`: "Waiting for <name>…" while the opponent decides. Open: Forge's own status line can say the same thing at the same time (your call: hide one). | while they decide, the board says so |  |
| T3 | an extra OK after declaring attackers that makes no sense | 1 | **shipped `f7ad0b8`** (server 0.32.1, 2026-10-03) | Root cause in `apps/server/src/play/auto.ts`: `COMBAT_DECLARE_ATTACKERS` is in the default stop set, and `decideStop` honoured the stop set before the nothing-to-do rule, so the priority window right after the attack input was a second stop with `offered=[]`. New policy field `attackStopIsTheDeclaration` (default on, Full Control off): in your own Declare Attackers step the attack input *is* the stop; the window after it passes unless a non-land source is castable. Real-Forge case in `scenario-combat.jvm.test.ts` (one OK, then `auto-passed` in the same step); mutation: rule reverted → 3 unit + 1 jvm case fail. | declare attackers: one OK, no second | |
| T4 | a shockland's pay-2-life choice is yes/no on the control bar; never put yes/no there, always the big pop-up | 1 (related to R2) | w36 half-shipped (the bar's OK still reads Forge's `Keep` behind the pop-up, `LiveBoard.tsx` ≈:1800, pinned by `w36.spec.ts:171`) — w38 §U | `15c935a`, `f6503d4`: every Forge yes/no (mulligan Keep/Mulligan, a shockland's pay-2-life) is the decision-area pop-up; none on the bar. Real-Forge test on the jar. | play a shockland: the choice is a pop-up |  |
| T5 | the current phase's highlight should be stronger | 1 (the Q3 family) | shipped w36 | `f6503d4`: a stronger current-phase highlight. |  |  |
| T6 | cards grow to the full height of the hand | 1 | shipped w36 | `8888cc3`: hand cards fill the row's height. |  |  |
| T7 | Cavern of Souls does not show its chosen creature type | 1 | shipped w36 | `8888cc3`: a card with a chosen type shows it (Cavern of Souls). | the Cavern shows the type it named |  |
| T8 | the stack's scrolling is ugly; show what is happening on the stack without all the text | 3 (with P9, R-stack) | shipped w36 | `8888cc3`: each stack item is its art plus one line (who · what → at what), full text on hover; no scrolling text. |  |  |
| T9 | Spirit token has no art | 2 (with R14) | shipped w35, **check it** | R14: `art-ids.json` had no token entries at all; w35 lane B adds them. Not deployed when reported Now live in `0.31.0`: `art-ids.json` has 2,958 token keys including plain `Spirit Token` (36 printings) and `Goblin Rogue Token`. Not yet seen in a real game. | a Spirit token has art |  |
| T10 | (found by the w35 manager, not reported) the board arrangement is lost on a reload: a card you placed goes back to its default slot AND row (R9 lets a card sit in another type's row, e.g. Figure of Destiny in the lands row; a reload puts it back in its type row) | 0 | shipped w36 | `8888cc3`: the arrangement (slot and row) is kept per tab across a reload. Watch: a rematch in the same tab could inherit the last game's arrangement. | move a card, reload: it stays where you put it |  |
| T11 | (tracker) the chat can now be dragged to 640 px, but watchparty only guarantees the host 320 px; the board needs ~1000 px at 1280×800 | 0 | **measured 2026-10-03, no change** | Probed on a live scenario match with the chat at its 240 px minimum and its 640 px maximum (`Home`/`End` on the chrome's resize handle). At 1280×800 with the chat at 640 the table is 576 px wide: no page scroll, no clipped label, the same card sizes (68×95 battlefield, 85×118 hand), the button bar and phase rail where they always are; a battlefield row holds 6 cards instead of 11 and overflows into its own scroll. Same at 1366×768 (table 662 px). The width is the viewer's own slider, remembered per viewer, and the chrome already caps it at `frame − 320`. Nothing to fix unless you find 6-a-row too cramped — then the ask is a `maxChatWidth` prop on `RoomChrome` (watchparty), not a CSS override here. | drag the chat wide: the board still fits | |
| T12 | **regression from w36:** Secluded Glen enters TAPPED after you choose to reveal a Faerie | 0 | **shipped `812dea1`** (UI 0.32.1, deployed 20:23 UTC 2026-10-03) | Root cause from the wire, not the spectator lead (that was wrong): w36's Arena click-armed cast treated the *next* press as "resolve or cancel", and the Glen's reveal selection opens on a hand card — so the press that chose the Faerie landed as `selectButtonCancel` 54 ms after the asks arrived. `gestures/install.ts`: a press on a card an open selection names answers it, never cancels the armed cast. Also "Waiting for Bob…" no longer covers your own reveal (`myMoveNow`). R13 e2e 10/10 after; mutation: gesture case fails reverted. | play Secluded Glen with a Faerie in hand and reveal: it enters untapped | |

## Playtest 6 — 2026-10-04, on UI 0.32.7 (`f332c93`), the operator alone (V9, V10 added the same day)

Played on the first build deployed since `2556e8f`: the End Turn guard, the reveal art, the ring, the
yes/no pop-up and the click-cast fix were live; **the w39 drag redesign was not built** (approved in the
demo, https://claude.ai/artifact/3Y1E4pvAnWj1NgKbE5Hrx7, not yet a wave). V4 and V5 are that redesign.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | hovering a hand card: the zoom grows to the RIGHT, never the left, and its bottom-left corner sits on the hand card's top-left corner | 2 (with T1) | shipped w39 | today `placeInspector` (`apps/ui/src/play/inspect/index.ts`) puts it LEFT of the card (`left = hover.left - GAP - width`) | hover a hand card at 1280×800 |  |
| V2 | a cast in progress can be undone back to the hand: right-click, or Cancel on its first choice | 1 (with R7) | shipped w39 | Escape already cancels while Forge is asking (`ae1a236`); right-click and the first-choice Cancel are new | start Bolt, right-click before choosing a target |  |
| V3 | a card being cast is not shown to the opponent until it is actually on the stack | 1 | shipped w40 (measured already true) | `9e45655`: no frame naming the card reaches the other seat before the one that shows it on the stack, and none at all on a cancel — Bolt auto-paid, Doom Blade paid one land at a time, cancel at target, cancel between taps (`wave40-evidence/A-timeline.md`); `visibility.ts` unchanged; `cast-hidden.jvm` pins it, breaking hand privacy fails 3 of 4. **Wire only**: if the operator still sees the card early, it is the browser, not the server | cast with a target from a second browser, watch the first |  |
| V4 | dragging Evolving Wilds: it played the moment it passed the hand | 5 (P11, Q4, R7, R9) | shipped w39 | the play is sent at the "settle" over the battlefield edge (`install.ts`); w39 sends nothing until the release | drag a land past the hand and back |  |
| V5 | dragging another card: it locked by the hand and drew the targeter arrow | 5 (with V4) | shipped w39 | same settle; every settled card draws the arrow | drag a creature around without letting go |  |
| V6 | clicking a land tapped for mana (unspent) untaps it, without the Undo button — only THAT land, later taps stay (operator's choice, 2026-10-04) | 1 (related to R15) | planned w40 (engine) | Forge's undo is last-in-first-out (`MagicStack.undo()`), so untapping one land out of order needs a change in the fork | tap two lands, click the first |  |
| V7 | the log shows only the current turn; keep the whole game's log | 1 | shipped w39 | (to read: whether the logbook resets per turn by design) | play three turns, scroll the log |  |
| V8 | (tracker, from the operator's screenshot) a log line names a spell's mode text, "played Choose two — • Prevent all damage…", where the card's name belongs | 0 | shipped w39 | screenshot 2026-10-04, turn 6 | cast a modal spell (Choose two) |  |
| V9 | the log is shown over the main screen, not confined to the left side bar | 1 (with V7) | shipped w39 | today `live__logbook` is an overlay on the left edge (`LiveBoard.tsx` ≈:1713) | open the log during a game |  |
| V10 | the active player's ring is slightly off-centre on the avatar; make it a bit bigger and move the life total down a few pixels to make room | 2 (with Q1, the ring) | shipped w39 | `29d7235` made it a circle, measured only in an isolated page with the real CSS; the off-centre needs measuring on the real seat bar | your turn: look at your avatar |  |

## Playtest 7 — 2026-10-04 (evening), on UI 0.32.12 (`a567082`, w39 + w40), match `m-09487f336215`

The first game on the w39 drag. It ended in a soft-lock (W18). W3, W4 and W8 shipped the same evening.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | the coin toss is shown to BOTH players at once; the loser sees a waiting prompt; the same while the opponent decides a mulligan | 1 (with R2) | planned | the other seat sees nothing while one seat decides play/draw or a mulligan | second browser, watch the first decide |  |
| W2 | choosing cards for a mulligan: you cannot tell what is selected, everything is green | 1 | planned | selected and selectable share the accent | London mulligan bottom-pick |  |
| W3 | no text above a lifted card ("let go: play it") | 1 | **shipped `51fc65a`** (UI 0.32.13) | the verdict label is deleted; its tests now assert no label (the label came from the tracker's demo, not from an ask) | drag any card |  |
| W4 | right-click never opens the browser menu on the board | 1 (with V2) | **shipped `51fc65a`** | the board suppresses it always | right-click anywhere on the board |  |
| W5 | a card brought back over the hand and then left-clicked goes back into the hand | 1 | planned | (to read: the click-armed path after a float-back) | drag out, back over the hand, click |  |
| W6 | stacking cards makes a scroll bar on the board and reshapes the page — never a scroll bar on the board | 1 (the T11 / table-fit family) | planned |  | stack 3+ cards in one slot |  |
| W7 | dropping a card ON another to stack is too sensitive to left/right; on-top should be easier | 2 (with R9) | planned | the drop zones are thirds of the card (Board.tsx) | drag a land onto a land |  |
| W8 | the hover zoom always shows above everything; the control bar drew over it | 2 (with T1, Q16) | **shipped `51fc65a`** | new top layer `--z-zoom: 60`, tested above every other layer | hover a card near the control bar |  |
| W9 | the arrow for Grasp of Darkness snapped to a player avatar; only Forge's legal targets may take the arrow | 1 (with L6) | planned — **soft-lock cause** | the arrow snaps to any player face; in m-09487f336215 that sent a refused selectPlayer twice | cast a creature-only removal |  |
| W10 | in Main 2 with nothing castable, a land tapped once could not be untapped by a click; after Undo it could not be tapped again | 1 (with R15, V6) | planned (engine) | (to read: whether Forge stops offering the land once nothing is castable) | tap a land in Main 2 with nothing to cast |  |
| W11 | a revealed Forest drew a different (old) art than the other Forest | 1 (with V-reveal, 9eab80d) | planned | a revealed card whose face reached the seat late resolves art by name only, which picks the table's generic printing; the decode race (w40 B, unmeasured) is the root | reveal two basics from the library |  |
| W12 | four lands stacked in one slot: one of them is drawn smaller | 1 | planned |  | stack four lands |  |
| W13 | smooth animations everywhere, like the float-back: tapping lands, and the rest | 2 (with R12, deferred to v2 by you on 2026-10-02) | planned | R12 is back in scope by this ask | tap a land |  |
| W14 | attacking by arrow is awkward: the player is not shown as a valid target, and after attackers tap a persistent arrow should show what each attacks | 1 | planned |  | attack a planeswalker and a player |  |
| W15 | planeswalker loyalty shows as a changing value, like power/toughness | 1 | planned |  | activate a loyalty ability |  |
| W16 | Worldbreaker on the stack: the choice it needs was never explained — such decisions get the decision pop-up | 1 | planned |  | cast Worldbreaker |  |
| W17 | after a Worldbreaker choice the arrow came from the top-right of the screen, not from the card on the stack | 1 | planned | the arrow's origin falls back to (0,0)-ish when its source has no element | cast Worldbreaker, pick its target |  |
| W18 | Sanctum of Ugin's "you may sacrifice" showed an arrow instead of a yes/no; then the game soft-locked | 1 | planned — **soft-lock** | the lock itself (log, m-09487f336215): Relentless Dead's death trigger asked for a ZOMBIE CARD IN THE GRAVEYARD; the arrow offered players (W9), the browser sent selectPlayer twice, refused; no board element can pick a graveyard card or decline | the same board: Kozilek's Return killing Relentless Dead |  |

## Asks outside a play-test — 2026-10-02

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | add a bot so I do not have to play against myself | 1 | shipped `0.29.1` (live in `0.30.0`) | `f62ee46`: **Play vs Forge AI** when you are alone in a room; the bot plays a random library deck legal in the room's era. Server and UI guards each fail when reverted; a real-Forge AI seat with a library deck runs; a real browser reached the AI's own turn once | make a room, stay alone, pick a deck, press Play vs Forge AI | |

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
