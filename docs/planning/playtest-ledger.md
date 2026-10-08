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

*Last updated: 2026-10-08, wave 57 landed and deployed (4394b84): AB11, AB13, Z4 shipped.*

---

## Check these in your next game

**Only what a person can judge**, and nothing a known bug will spoil. Updated 2026-10-07 after the tracker's batch and wave 54 landed and deployed
(deploy tree `4207ea4`: UI 0.32.43, server 0.32.19).

**From Playtest 10 and 11, please re-check:**

1. **Placement (Z8):** drop a land three columns right of your others — the gap stays; drop into a gap — it fills.
2. **Arrows (Z9, AA13):** Cryptbreaker targeting itself and two neighbours — three visible arrows, drawn over the cards.
3. **Mulligan (Z2, AA1):** mulligan to six — your own pop-up names the count, no "Waiting for…".
4. **Auto-pay (Z4, AA6):** cast a spell your lands pay for — no Pay Mana Cost pop-up at all.
5. **The other seat (Z5, AA3–AA5):** Bella's pointer at the mirrored spot; her held card back at hand-card size; a
   placed card flies from the back to its slot.
6. **Words (AA7–AA9):** End Turn with no yield pop-up; "Select creatures to attack."; "Resolve?" over a stack.
7. **The log (Z11, AA11):** no scrollbar beside the status block; a click outside or Escape closes it.
8. **Piles (AA12):** an untapped land behind a tapped one stays upright.
9. **The stack band (AA10):** cast with Fast Mode off — the row never flashes at the top.
10. **Deck boxes (Z1):** open the picker — every box the same size, long names end in an ellipsis.
11. **Attackers (Z6):** attack with Lightning Angel (vigilance) — it is outlined; Memnite turns and is outlined.
12. **Picks (W2):** mulligan to six — the card you picked looks picked, the others only offered.
13. **Blocks (Z7, L15, W14's blocker half):** block, see the arrow from your blocker to the attacker, click the blocker again to undo, block again, confirm.

14. **No pop-up the server answers (Z4 ×3, AB11, w57):** cast Bitterblossom with lands up — no cost pop-up, no "Resolve?"; End Turn with a creature out — their board never lights (AB9).
15. **The mulligan pick (Z2 ×3, AB2):** mulligan to six — one sentence, one button, OK greys until the count is met.

**Watch for:** a "Waiting for…" flash right after both keep (AB3, a client banner, not yet fixed); a card dragged out of hand stalling at the battlefield edge (AC1, fixed, intermittent before).

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
| L15 | blockers: an arrow from each attacker; blockers highlight blue | 2 (Q12 is a related, different symptom) | partly — blocker→attacker arrows shipped w54 `ed410ff` (deployed `4207ea4`); 'blockers highlight blue' not done | see Z7 for the arrows; Q12 still needs its repro | block: an arrow from your blocker to the attacker |  |
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
| R15 | lands cannot be tapped freely for mana before casting; show the pool as you tap; a card changed by an effect (Magus of the Moon) should show its new identity visually | 2 | Magus half shipped w53 T (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)): a pill over the type bar, printed line on hover | **root cause:** Forge's clickable filter excludes every mana ability (`forge-ai/.../AvailableActions.java:82`, `!sa.isManaAbility()`), so a land is never clickable outside a payment. Not Magus **Playtest 9 (2026-10-06), asked again for the Magus half: "cards like Magus of the moon and Urborg tomb of yawgmoth change the types of cards … put one of our overlay pills over the type bar". The wire carries `ChangedTypes`; nothing compares it with the printed line.** | tap a land at priority: mana appears in your pool | |
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
| V6 | clicking a land tapped for mana (unspent) untaps it, without the Undo button — only THAT land, later taps stay (operator's choice, 2026-10-04) | 2 (related to R15) | half shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)): the land tapped LAST untaps on a click (Forge's Undo); out-of-order untap still needs `MagicStack.undo` | Forge's undo is last-in-first-out (`MagicStack.undo()`), so untapping one land out of order needs a change in the fork **Playtest 9 (2026-10-06), asked again: the LIFO half (the land just tapped = Forge's Undo) is the gesture lane's; out-of-order untap still needs `MagicStack.undo` changes.** `0243673` (d28788c), 27/27 gesture specs in real Forge. | tap two lands, click the first |  |
| V7 | the log shows only the current turn; keep the whole game's log | 1 | shipped w39 | (to read: whether the logbook resets per turn by design) | play three turns, scroll the log |  |
| V8 | (tracker, from the operator's screenshot) a log line names a spell's mode text, "played Choose two — • Prevent all damage…", where the card's name belongs | 0 | shipped w39 | screenshot 2026-10-04, turn 6 | cast a modal spell (Choose two) |  |
| V9 | the log is shown over the main screen, not confined to the left side bar | 1 (with V7) | shipped w39 | today `live__logbook` is an overlay on the left edge (`LiveBoard.tsx` ≈:1713) | open the log during a game |  |
| V10 | the active player's ring is slightly off-centre on the avatar; make it a bit bigger and move the life total down a few pixels to make room | 2 (with Q1, the ring) | shipped w39 | `29d7235` made it a circle, measured only in an isolated page with the real CSS; the off-centre needs measuring on the real seat bar | your turn: look at your avatar |  |

## Playtest 7 — 2026-10-04 (evening), on UI 0.32.12 (`a567082`, w39 + w40), match `m-09487f336215`

The first game on the w39 drag. It ended in a soft-lock (W18). W3, W4 and W8 shipped the same evening.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | the coin toss is shown to BOTH players at once; the loser sees a waiting prompt; the same while the opponent decides a mulligan | 1 (with R2) | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w42 (`f2c7bea`) | the other seat sees nothing while one seat decides play/draw or a mulligan | second browser, watch the first decide |  |
| W2 | choosing cards for a mulligan: you cannot tell what is selected, everything is green | 2 | shipped w54 `bc72c9e` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07)) | a picked card carries `data-picked` and `aria-pressed`, drawn with the accent badge and a check; an offered-only card keeps the ring alone. Untested: a battlefield card both picked and type-chosen shares the top-right corner | mulligan to six: the card you picked looks picked |  |
| W3 | no text above a lifted card ("let go: play it") | 1 | **shipped `51fc65a`** (UI 0.32.13) | the verdict label is deleted; its tests now assert no label (the label came from the tracker's demo, not from an ask) | drag any card |  |
| W4 | right-click never opens the browser menu on the board | 1 (with V2) | **shipped `51fc65a`** | the board suppresses it always | right-click anywhere on the board |  |
| W5 | a card brought back over the hand and then left-clicked goes back into the hand | 1 | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w41 (`dce7179`) | (to read: the click-armed path after a float-back) | drag out, back over the hand, click |  |
| W6 | stacking cards makes a scroll bar on the board and reshapes the page — never a scroll bar on the board | 1 (the T11 / table-fit family) | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w43 (`8058baa`) |  | stack 3+ cards in one slot |  |
| W7 | dropping a card ON another to stack is too sensitive to left/right; on-top should be easier | 2 (with R9) | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w43 (`8058baa`) | the drop zones are thirds of the card (Board.tsx) | drag a land onto a land |  |
| W8 | the hover zoom always shows above everything; the control bar drew over it | 2 (with T1, Q16) | **shipped `51fc65a`** | new top layer `--z-zoom: 60`, tested above every other layer | hover a card near the control bar |  |
| W9 | the arrow for Grasp of Darkness snapped to a player avatar; only Forge's legal targets may take the arrow | 1 (with L6) | landed `7042fd2` (the bridge names a selection's legal players; real Forge: Doom Blade none, Bolt both) | the arrow snaps to any player face; in m-09487f336215 that sent a refused selectPlayer twice | cast a creature-only removal |  |
| W10 | in Main 2 with nothing castable, a land tapped once could not be untapped by a click; after Undo it could not be tapped again | 2 (with R15, V6) | shipped w52 E (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | (to read: whether Forge stops offering the land once nothing is castable) **Playtest 9 (2026-10-06), asked again: cause read in the fork — `tryUndoLastAction` re-publishes the stale `cachedActionableCards` (`PlayerControllerHuman.java:1572/1664/2697`). See Y-rows below.** **w52:** fork `127c0ad3` drops `cachedActionableCards` on Undo; `w52-mana.spec` 3/3, revert fails both Island cases. | tap a land in Main 2 with nothing to cast |  |
| W11 | a revealed Forest drew a different (old) art than the other Forest | 1 (with V-reveal, 9eab80d) | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w45 (`e5d6dfd`) | a revealed card whose face reached the seat late resolves art by name only, which picks the table's generic printing; the decode race (w40 B, unmeasured) is the root | reveal two basics from the library |  |
| W12 | four lands stacked in one slot: one of them is drawn smaller | 1 | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w43 (`8058baa`; stacked cards equal each other but ~24 px narrower than a lone card) |  | stack four lands |  |
| W13 | smooth animations everywhere, like the float-back: tapping lands, and the rest | 2 (with R12, deferred to v2 by you on 2026-10-02) | planned: w44 landed and reverted (`1b032aa`/`ded7996`) — a tapping card snaps to position:absolute mid-turn and overflows the battlefield (table-fit caught it) | R12 is back in scope by this ask | tap a land |  |
| W14 | attacking by arrow is awkward: the player is not shown as a valid target, and after attackers tap a persistent arrow should show what each attacks | 1 | partly — the blocker half shipped w54 `ed410ff` (deployed `4207ea4`); the attacker half (per-defender legality on the wire) still planned (engine) | see Z7 | attack a planeswalker and a player |  |
| W15 | planeswalker loyalty shows as a changing value, like power/toughness | 1 | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w43 (`8058baa`) |  | activate a loyalty ability |  |
| W16 | Worldbreaker on the stack: the choice it needs was never explained — such decisions get the decision pop-up | 1 | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w42 (`5447042`) |  | cast Worldbreaker |  |
| W17 | after a Worldbreaker choice the arrow came from the top-right of the screen, not from the card on the stack | 1 | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w41 (`dce7179`) | the arrow's origin falls back to (0,0)-ish when its source has no element | cast Worldbreaker, pick its target |  |
| W18 | Sanctum of Ugin's "you may sacrifice" showed an arrow instead of a yes/no; then the game soft-locked | 1 | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w42 (`5447042`: the off-board picker with decline, and "you may sacrifice" as yes/no; the in-browser Sanctum/Worldbreaker e2e flaked and carries over) | the lock itself (log, m-09487f336215): Relentless Dead's death trigger asked for a ZOMBIE CARD IN THE GRAVEYARD; the arrow offered players (W9), the browser sent selectPlayer twice, refused; no board element can pick a graveyard card or decline | the same board: Kozilek's Return killing Relentless Dead |  |
| W19 | a very slight clipping of the ring around the avatar | 3 (with Q1, V10) | shipped (deployed f27d1cc, 06:00 UTC 2026-10-05) — w43 (`8058baa`) | w39 grew the ring to 6 px past the mark; `.seat__ident` keeps 4 px of room inside the bar's `overflow: hidden` | your turn: look at your avatar's ring |  |

## Playtest 8 — 2026-10-05, on UI 0.32.21 (`6744c3c`), match `m-234c5f46dd94` vs Forge AI

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| X1 | attacking a planeswalker: the arrow draws while dragging from the attacker, but the planeswalker is not selectable as the target | 2 (with W14) | shipped w46 + `d6512e2` (deployed `c9db0ee`, UI 0.32.23, 2026-10-06) | w46 B offers defenders and draws the lasting arrow (`02a512f`); the 1-in-5 "attack went to the player" was Forge running each client message on its own thread, fixed by sending the attacker only after Forge marks the defender (`979dc16`; real Forge 24/24, was 3 failed in 16). CI 37399576613 green | attack a planeswalker by arrow; the arrow stays on Jace through blocks |  |
| X2 | declaring blockers took two clicks | 1 | shipped w46 (deployed `c9db0ee`, UI 0.32.23, 2026-10-06) | w46 C (`9bba2cf`): a defender with nothing castable confirms the block once; holding an instant with mana up keeps the stop (correct Magic). Suite `w46-block-stop.jvm` proven both ways | block with one creature: one click |  |
| X3 | the stack's look: a small gallery/carousel where it is now, and the top item shown in an expanded big view below it | 4 (with P9, R-stack, T8) | shipped w46 (deployed `c9db0ee`, UI 0.32.23, 2026-10-06) | w46 A (`6d5503a`), the approved demo built in: top leftmost, numbered, card pinned only when it covers nothing, else a hover peek. Open: the counterspell arc's browser test moved to the next wave | cast two spells in response |  |

## Playtest 9 — 2026-10-06, on UI 0.32.24 (`de5ccb8`, w49 + w50), match `m-6ce49e226aef`, two humans

Reported live, partly to the tracker and partly to the other cardtable session, which relayed its items with
evidence. W10, V6 and R15 above were asked again and are bumped there, not repeated here.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| Y1 | Azorius Signet is not tappable at priority, even with mana in the pool | 1 | shipped w52 E (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | `AvailableActions.cardHasActionable` (`:92-110`) offers a mana ability only when its cost is exactly `{T}`; the Signet is `{1},{T}`. Live stream: 0 priority sets named it, 4 payment sets did Fork `e5db0510` (pin) offers a {T}+mana ability at priority; jar `984f247a` installed 21:58:56Z. | with a Signet and an Island untapped, click the Signet at priority |  |
| Y2 | Augur of Skulls' upkeep-only ability: the auto-pass skips the upkeep | 1 | shipped w52 S (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | `auto.ts` `skipNonStopPhases: 'always'` (:419). The wanted rule is narrow: a battlefield permanent with an ability restricted to THIS phase and activatable now Bridge `phaseRestricted` fact; `w52-s-augur.jvm` 3/3, mutation fails. | hold Augur with two Swamps: your upkeep stops |  |
| Y3 | Augur: after choosing the sacrifice ability it asks again whether to sacrifice | 1 | shipped w52 S (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | `StopPolicy.costConfirm` is `'ask'`: Forge's cost confirm arrives untagged (`HumanCostDecision.java:1295-1310`) `costConfirm` accepts the cost of the ability just chosen; optional "may" triggers still ask. | activate Augur's sacrifice: no second question |  |
| Y4 | the stack carousel sits far above the decision box; it should be right above it | 1 | shipped w51 (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | Smallpox's sacrifice pop-up at mid-right, the thumbnail at the top of the column w51 §A.6: the stack band hangs from the question's measured top (6px gap at 1280×800 and 1366×768). | cast Smallpox: the thumbnail sits on the pop-up |  |
| Y5 | a land dragged out of the hand snaps back while its question is open | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | the card parks at its release point until Forge has it on the battlefield `232ae42` (landed in `2851ad3`). | drag a shockland onto the board: it hovers where you let go while "pay 2 life?" is up, and lands from there |  |
| Y6 | a creature snaps back to hand; its own caster's stack draws it | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | same parking; an uncontested permanent's spell is not drawn on the caster's stack `232ae42` (landed in `2851ad3`). | drag a creature out with the opponent holding nothing: no snap-back to hand, no stack |  |
| Y7 | Smallpox's arrow came from the last played Island, not the spell | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | `clickOrigin` prefers `match.promptCard` over the stale `lastSelectedCard` `232ae42` (landed in `2851ad3`). | when the opponent's spell makes you choose, the arrow leaves from that spell |  |
| Y8 | the log does not include triggers | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | server line `triggered <card> — <Forge's stack description>` per seat `56c5b5c` (landed in `2851ad3`). | with Dark Confidant in play, your upkeep adds "triggered Dark Confidant — …" to your log, and "<name> triggered …" to theirs |  |
| Y9 | not a fan of the blue highlight; use the theme colours | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | every non-mana `--c-*` in card/live/board CSS is now `--accent` / `--danger` / `--success` `2b10d8f` (landed in `2851ad3`). | switch theme: the stack ring and owner strip, buffed/hurt numbers, counters and log colours follow it |  |
| Y10 | stack thumbnails shift upward on hover; a small outline instead | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | `.stack__item` hover is a 1px outline, no transform `2b10d8f` (landed in `2851ad3`). | hover a stack thumbnail: an outline, no lift |  |
| Y11 | graveyard cards lift on hover | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | no raise on hover `2b10d8f` (landed in `2851ad3`). | hover a graveyard card: only the enlarged view |  |
| Y12 | a vigilant attacker (Lightning Angel) is drawn tapped | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | vigilance attackers stay upright `1787231` (landed in `2851ad3`). | attack with Lightning Angel: it stays upright |  |
| Y13 | the opponent cannot see the resolving spell while it asks them something; "wherever the opponent played it should be visible to both players" | 1 | folded into Y17 (the stack redesign) | the item was still in `Game.Stack` when the selection opened (seat 1 frames 563-575) | the opponent casts Smallpox: you see it |  |
| Y14 | lands are not tappable when stacked on each other | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | undiagnosed: which element takes the press inside a pile `1272821`: the pile's list swallowed every press. Proven in `stacking.spec.ts`. | tap a land in a pile |  |
| Y15 | draw a box to tap lands, the way boxes declare attackers | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | the marquee starts only while `declaringAttackers` (`install.ts`) `0243673`: the marquee taps lands outside attack declaration too. | drag a box over your untapped lands: they tap |  |
| Y16 | dragging a card off a pile resizes the whole board (about 175 px of empty space at the bottom) | 1 | shipped (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | undiagnosed: `useArrangeDrag`'s ghost/indicator, or the pile rules `1272821`: the drag ghost kept `data-pile-size` and was laid out in flow. | drag the Overgrown Tomb off a pile |  |
| Y17 | stack redesign: no stack for a single pending item, the big view only on hover, a better look overall | 2 | shipped (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | builds on Y13 **Approved** (demo https://claude.ai/artifact/BUeXnHbHkeqtxFccyHQSfd): a lone pending spell is drawn as the card for both seats; the stack row only at 2+; a lone trigger is a pulse on its source. **Condition, verbatim:** "i honestly really just want one of these. you can't ever be hovering over more than one thing so just having a single distinct 'expanded view' i think would be the cleanest … if theres a decision window up … the expanded view needs to stack to the left of that decision window." `.stack__big` is deleted; thumbnails use the inspector (reverses w36 T8). Y13 folds in. **Playtest 10: "things go to the stack when theres no response" — the redesign landed (`d0393cc`), pending deploy.** `4abda9f`: one spell is the card, a lone trigger pulses its source, the row at two or more, one expanded view. | — |  |
| Y18 | Venser's decision title reads "Select target permanent or Card.inZoneStack"; the "<-- CARDS ON THE BATTLEFIELD -->" slot should be a separator line | 1 | shipped w53 P (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | Forge's generated `ValidTgts$` prompt with no `TgtPrompt$`, and Forge's zone-header pseudo-choice `01f3429`. | cast Venser, Shaper Savant |  |
| Y19 | Next Phase only on the control box; every "OK" is a decision pop-up; the same four buttons always, greyed when they do not apply | 3 | shipped w51 + `f1002bd` (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | the bar's button one is Forge's own for every input **Playtest 10: asked again — "keep the same set of words in the controlbar ALWAYS, except for Undo/end turn", "change Ok to 'Next Phase'". Built in w51 (`cc4561d`) and 03e1022 (no pop-up after a mana tap); deploying.** Four fixed buttons; every other answer a pop-up; after a mana tap Next Phase stays live and passing loses the floating mana. | cast a spell in response: no "OK" on the control box |  |
| Y20 | loading 2005 decks is very slow | 1 | shipped `f5f1fc0` (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | the picker made 338 `POST /check` per era (about 100/s through the edge); now one `GET /tables/legal/:format` | open a 2005 era |  |
| Y21 | the hover view of a card inside a pop-up renders under the pop-up; show it to the pop-up's left | 1 | shipped `f5f1fc0` (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | the panel lived in the board overlay (z 20) under the pop-up (z 40); now a sibling of the pop-up, left first | hover a card in a "put into hand" choice |  |
| Y22 | "Choose order of cards to put into the library": drag instead of the Place button | 1 | shipped `f5f1fc0` (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | Place, Place all and Remove are gone; drag in, drag out, click as the short form | Brainstorm or Ponder |  |
| Y23 | mana pool shows "U1"; show the mana symbol and the number | 1 | shipped `f5f1fc0` (deployed `e91c052` (UI 0.32.31, server 0.32.11, 2026-10-06)) | `ManaPip` (Mana font) beside the count | tap an Island |  |
| Y24 | the room chat names you "Frieren" (and Bella the default); prefs look lost | 1 | filed on watchparty (#149) | prefs rows intact (the board reads them); `RoomChrome` gets no `sessionId` from embedding hosts since watchparty-ui 0.40.9, so its read misses | open a room: the chat shows your name |  |
| Y25 | cards on the board are a bit blurry | 1 | answered — no work unless asked | the board loads Scryfall's 488 px image for ~60-115 px tiles; a 146 px source for board-size cards was offered | — |  |
| Y26 | End Turn sometimes still sleeps through the first skipped phases | 0 (found by CI) | shipped w53 E (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | `PlayBridge.act` sends `setYieldPref(SKIP_PHASE_DELAY)` then `selectButtonCancel` as two Forge messages, each run on its own server thread (X1), so under load the click applies first. CI `w32.spec.ts:109` (172/171/216/3 ms) and `endturn.jvm` (61 ms) Ordered in the bridge (the skip written into the live YieldController before the click); the known_flaky pin is removed. | press End Turn mid-turn: no pause between the skipped phases |  |
| Y27 | a land Forge did not take stayed hidden in your hand for the rest of the game, so a later discard could not pick it | 0 (found by CI) | shipped `e91c052` + shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | second half: a card Forge offers in a selection while it sits parked goes home at once (the cleanup discard's first offered card was the land just put down, hidden at its park point); the park's clock keeps running whatever the card did meanwhile | play a land Forge refuses, then discard at end of turn: the land is pickable |  |
| Y28 | End Turn is not highlighted for a seat whose only offer is a mana rock (Signet) | 0 (w52 follow-up) | shipped w53 T (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | `nothingToDecide` counts lands only; w52's `manaOnly` fact is not folded into it | hold only a Signet and lands with nothing to cast |  |

## Playtest 10 — 2026-10-06 (night), on UI 0.32.31 (`e91c052`), two humans

Relayed by the other cardtable session, reconciled against this ledger. W2, Y17, Y19 and L15 were asked again and
are bumped above, not repeated here.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| Z1 | deck selection: every deck box the same size, whatever text is in it | 1 | shipped w54 `be90f1b` (deployed `5c401c8` (UI 0.32.39, 2026-10-07)) | `.deckpick` grid rows of one height (190 px), the name clamped to two lines with the full name in `title`; every box 370×190 at 780 wide, 202×190 at 1800 (evidence D/boxes.md) | open the deck picker: every box the same size |  |
| Z2 | during your own London bottom-pick the status line says "Waiting for Bella…"; it should say Forge's own "Select # cards to put on the bottom" | 3 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `choosingMulligan` (Forge's `Mulligan` game bool) is your move in `myMoveNow`; the London pick is the decision pop-up with Forge's own 'Select N card(s) to put on the bottom' and its OK gated on the count **Playtest 12 (2026-10-07), asked a THIRD time: the count in Forge's text changes to 'Return 0 card(s)' after the pick, and the Auto button is noise. See AB2.** | mulligan to six: no 'Waiting for…', the pop-up names the count |  |
| Z3 | during the mulligan bottom-pick you can drag an arrow from a hand card | 1 (with W2) | shipped `9649c97` (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | the gesture layer aims from a hand card while a mulligan selection is open | mulligan to six and try to drag a hand card: it only selects |  |
| Z4 | the Pay Mana Cost pop-up flashes up even when the server is about to auto-pay it | 3 | shipped w57 `94e69bf` (deployed `4394b84` (UI 0.32.53, server 0.32.24, 2026-10-08 00:00Z)) | see AB11 (the third ask): the window the server pays is never drawn | cast a spell your lands auto-pay: nothing pops |  |
| Z5 | show the opponent moving and aiming cards (and maybe the cursor), but never reveal a card until it is committed to the stack | 1 | shipped `43312fe` + shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | follow-ups from Playtest 11: the card back is 0.95× a hand card (AA3); the pointer is mirrored for the battlefield (AA5); the placed card travels from the back's last position to its slot (`landCastGhost`, AA4) | watch Bella play a land: back follows the cursor at hand-card size, then flies to the slot |  |
| Z6 | after declaring attackers there is no visible change (Lightning Angel has vigilance, so nothing turns); mark committed attackers, e.g. a red border | 1 | shipped w54 `bc72c9e` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07)) | `[data-attacking]` gets a 2 px outline in the danger token whether or not the card turns; non-vigilant attackers keep their quarter turn (evidence C/marks.md, real Forge: Serra Angel and Memnite). Unmeasured by the lane: that the offered ring itself is unchanged (it draws on `.card`, the probe read `.board-card__face`) | attack with Lightning Angel: it is outlined |  |
| Z7 | blockers cannot be undone; they should work like attackers: an arrow to what they block, and a second click undoes it | 1 (with L15, W14) | shipped w54 `ed410ff` (deployed `4207ea4` (UI 0.32.43, server 0.32.19, 2026-10-07)) | `boardInteraction` offers your creatures already blocking (from the wire's `AttackersWithPlannedBlockers`), a second click is Forge's own `InputBlock.removeBlockAssignment`; an arrow joins each blocker to its attacker while declaring and after Forge confirms (evidence B/blockers.md; claws runs 37585304819, 37587439228, 37585523092) | block, click the blocker again: the block is undone and the arrow goes; block again and confirm |  |
| Z8 | free card placement: put a card in a specific slot with gaps, not filled left to right | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | a release at an empty column keeps the empty columns before it (`DropTarget` `at`, gap `<li>`s in `Arrangement`); trailing gaps trimmed; a card leaving a column leaves it open | drop a land three slots right of your others: the gap stays |  |
| Z9 | arrows to an adjacent card, or to the source itself, are too short to see (Cryptbreaker targeting itself and two neighbours) | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `aimAt`: a target within 72 px of the tail takes the tip at its centre, drawn over the cards; a target containing the tail arcs bottom→top | target an adjacent creature, and Cryptbreaker itself |  |
| Z10 | decision boxes show costs as letters ("B"); show the mana symbols | 1 | shipped `68bb3d4` (deployed `68bb3d4` (UI 0.32.38, server 0.32.14, 2026-10-07)) | `RulesText` draws `{…}` with `ManaPip` in titles, confirm/payment lines, selection instructions and choice labels; aria-labels keep words. Mutation (no glyphs) → 5 fail | pay a cost by hand: the line shows symbols |  |
| Z11 | a tiny scrollbar beside the log's status block | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `.live__logbook > .live__says` no longer its own scroll region (max-height none, overflow visible) | open the log: no scrollbar beside the status block |  |

## Playtest 11 — 2026-10-07, on UI 0.32.38 (`68bb3d4`), two humans, reported to the tracker session directly

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| AA1 | the mulligan is still awful: 'Waiting for Bella…' after one mulligan, then 'Return 0 card(s) to the bottom' | 2 (= Z2) | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | see Z2 | mulligan to six |  |
| AA2 | regression: while 'Waiting for Bella…' is up, hovering a hand card no longer raises it above the hand; a hover must not depend on what is on screen | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | the inspector's modal anchor skips a hand card (`inspect/index.ts` `inHand`) and the pregame wait is not a modal for it | hover your hand during any pop-up |  |
| AA3 | the phantom card (the opponent's card back) is too large; make it 5% smaller than a hand card | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `presence.ts` sizes the back from `[data-zone="hand"][data-owner="them"] li` × 0.95 | watch Bella hold a card |  |
| AA4 | the card back follows the mouse but a placed card does not come from it; it is just put down | 2 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `handoff()` in `presence.ts`: a new id in their battlefield or stack within 2 s of the back going flies from the back's last spot to its slot (`landCastGhost`), motion only **Playtest 12 (2026-10-07), asked again: on release the card appears at once and the back stays on the cursor until it moves. See AB6.** | watch Bella play a land |  |
| AA5 | the opponent's cursor does not match what they hover; it must be mirrored like the board | 2 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `placeSpot` flips y for battlefield spots **Playtest 12 (2026-10-07), asked again: the seams — board/board and board/hand — drift. See AB4.** | watch Bella hover her own lands |  |
| AA6 | the cost pop-up still shows up despite the shortcut handling it | 2 (= Z4) | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | see Z4 | cast a spell your lands auto-pay |  |
| AA7 | no 'Yielding until next turn' text and no cancel: End Turn is locked in, no pop-up | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `YIELDING` gates the decision pop-up off for Forge's yield window (`lblYieldingUntil*`) | press End Turn: nothing to cancel |  |
| AA8 | 'Select creatures to attack Sorin… or select player/card you wish to attack.' is too wordy: 'Select creatures to attack.' | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `lookup.ts` `ATTACK_PROMPT` | declare attackers with a planeswalker out |  |
| AA9 | the priority block ('Priority / Turn / Phase / Stack: 1 to Resolve.') in the pop-up: just 'Resolve?' | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `decisionMessage`: Forge's priority block over a stack reads 'Resolve?'; the log keeps Forge's block | hold priority with a spell on the stack |  |
| AA10 | the A │ B │ C stack layout still flashes briefly when a card joins the stack | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | the band had no measured decision edge for the frame between a spell reaching the stack and its pop-up; a spell on the stack now hangs the band from the last measured edge, with a 44% fallback before any | cast with Fast Mode off: no jump |  |
| AA11 | clicking outside the log, or Escape, closes it | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `LiveBoard` pointerdown-capture outside the logbook/toggle, and Escape | open the log, click the board |  |
| AA12 | an untapped card put behind a tapped card displays as tapped | 1 | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | each card in a pile turns on its own `data-tapped` (`card.css` `> .board-card__face`) | stack an untapped land behind a tapped one |  |
| AA13 | arrows to a neighbour or to the source are hidden under the card; draw them on top | 1 (with Z9) | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | see Z9 | Cryptbreaker targeting itself |  |
| AA14 | a release ON a pile selected the pile's land too, so from the third land on nothing landed (found by table-fit) | 0 (found by CI) | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | the press that resolves a lift swallows the click that follows it (`gestures/install.ts`); reproduced in `gestures.test.ts` (two selects before, one after) | play lands onto a full row |  |
| AA15 | main's forge-e2e red on every host: `play.spec.ts:659` (the presence label in the board text after a refresh) and `table-fit.spec.ts:721` (the presence name widened the shell) | 0 (found by CI) | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `.board__overlay { overflow: clip }`; play.spec reads the board without `.presence`; table-fit's placement pin follows Z8 | n/a — CI |  |
| AA16 | `scripts/link-worktree-node-modules.sh` with a relative path built dangling @hadoku links (forge-claws) | 0 (fleet) | shipped `b79e398` (deployed `dfc218d` (UI 0.32.42, server 0.32.18, 2026-10-07): the exact-sha deploy of `b79e398` itself was skipped by the gate bug fixed in `dfc218d`) | `realpath` on the argument | n/a |  |
| AA17 | `docs/planning/wave35-evidence/s3-thoughtseize.md:201` points at a deleted /tmp evidence path (forge-claws) | 0 (fleet) | open | docs only | n/a |  |

## Playtest 12 — 2026-10-07, on UI 0.32.43 / server 0.32.21 (`14ecc8e`, deployed 16:26Z), match `m-45b21c9f6cbd`, two humans

Server-side evidence for this match is in production's structured log (`pm2 logs cardtable`, 118 lines for the match id): 62 auto-passes, 4 auto-pays, 10 pace marks. The operator asked for telemetry that makes a report reproducible: AB13.

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| AB1 | the deck lists: some decks' art loads fast, others extremely slowly — a static list, cache and serve it | 1 | shipped w56 `54e23cd` (deployed `9011bdd` (UI 0.32.46, 2026-10-07)) | every option's art is warmed with `Image()` the moment an era's options are known (`prefetchCardImages`), de-duplicated across eras; evidence D/art.md: cold vs warm paint times on hokon's own network | open the picker on a cold cache: every box's art within a second |  |
| AB2 | the London pick says 'Return 1 card(s)…' then 'Return 0 card(s)…' once a card is picked; drop the Auto button, keep the text, grey OK until the count is met | 3 (= Z2, AA1) | shipped w55 `d53ca7d` (deployed `9011bdd` (UI 0.32.46, 2026-10-07)) | the London pick holds Forge's first 'Return N card(s)…' sentence for the whole pick, no second button, OK as Forge enables it (`MULLIGAN_BOTTOM_PICK`) | mulligan to six: one sentence, one button, OK greys until the count is met |  |
| AB3 | after keeping, 'Waiting for Hadoku' flashes for a second though both seats already kept | 1 | open — watch (client) | not a forwarded Forge window: `LiveBoard`'s own `isWaitingForOpponent`/`myMoveNow` banner between Forge's mulligan end and the first priority prompt (w55 S handoff §AB3); a client gap state, not in w57's files | mulligan, then keep: does 'Waiting for…' flash? |  |
| AB4 | the opponent's cursor drifts at the seams: board/board and board/hand | 2 (= AA5) | shipped w55 `10ad82c` + `afa7c79` (deployed `bd124d6`/`41b994f` (UI 0.32.49, server 0.32.23, 2026-10-07)) | the pointer is placed in board coordinates across seams, never scaled by a zone the pointer has left | watch Bella cross the centre line and the hand edge |  |
| AB5 | the opponent's hand must be drawn the way they see it (a two-row stack when their window is tall) | 1 (with Z5) | shipped w55 `10ad82c` + `afa7c79` (deployed `bd124d6`/`41b994f` (UI 0.32.49, server 0.32.23, 2026-10-07)) | `PresenceMessage.handRows`: their hand is laid out with the row count their window produced | resize one browser tall: the other sees two rows |  |
| AB6 | placement animation: on release the card appears at once and the back stays on the cursor until it moves | 2 (= AA4) | shipped w55 `10ad82c` + `afa7c79` (deployed `bd124d6`/`41b994f` (UI 0.32.49, server 0.32.23, 2026-10-07)) | presence sends on `pointerup` at once; the back goes on release; the hand-off flight starts from the release spot | play a card and hold still: the back goes, the card flies |  |
| AB7 | free placement works, "but it doesn't seem to at all reflect" — the note ends there; the tracker's reading: the opponent does not see where you placed it | 1 (with Z8) | open — question | the arrangement is per viewer and never on the wire | place a card at a gap, ask Bella where it is |  |
| AB8 | a tapped River of Tears cannot be untapped by clicking it again (Swamps can); any mana source whose mana went unused should untap | 1 (with R15, V6) | open — engine | Forge offers Undo only for a mana ability it can undo; River of Tears' ability carries a condition and a sub-ability (`river_of_tears.txt`), which Forge treats as not undoable, so no `Undo (N)` button and `undoableTap` has nothing to offer | tap River of Tears, click it again |  |
| AB9 | the opponent's board flashes highlighted as End Turn skips through declare attackers | 1 | shipped w55 `42235d2` (deployed `42235d2` (UI 0.32.51, 2026-10-07)) | `boardInteraction` offers opponents as defenders only while Forge's own attack bar ("Alpha Strike"/"Call Back") is live, so End Turn's skipped declare-attackers step lights nothing; real-Forge spec `e2e/w55-withheld.spec.ts` (red before, green after, with and without the server hold) | press End Turn with a creature out: their board stays dark |  |
| AB10 | a suspended card (Ancestral Vision) in exile shows no counters; show them as an overlay pill | 1 | shipped w56 `d097183` (deployed `9011bdd` (UI 0.32.46, server 0.32.22, 2026-10-07)) | the exile pile's top card draws its counters, a suspended card's Time first; real Forge: Ancestral Vision's Time counter drops by one at upkeep (tracker re-ran `w56-exile` on a claw, green). Unverified: a BURIED exiled card's counters on hover | suspend Ancestral Vision: the pile shows the Time counter |  |
| AB11 | Bitterblossom: the Pay Mana Cost pop-up AND a 'Resolve? OK' pop-up, both answered by the server anyway; "decision popups should not display if it's being automated; the delays should not impact whether a decision is displayed" | 3 (= Z4, AA6) + 1 | shipped w57 `94e69bf` (deployed `4394b84` (UI 0.32.53, server 0.32.24, 2026-10-08 00:00Z)) | the server holds Forge's prompt until its buttons, decides once on the pair, and forwards both or neither; a second prompt flushes the first; InputAttack's per-click refreshes are never held (the 2 s lag); a re-shown confirm is withheld. Proof: full forge-jvm green (108 passed, 2 pinned), the 15 e2e specs 62/62 on a claw; mutation: forward-then-decide restored → 15 failed. Bitterblossom evidence in wave57-evidence | cast Bitterblossom with lands up: no cost pop-up, no 'Resolve?' |  |
| AB12 | floating combat numbers and animation for damage and life gain — a design ask | 1 | shipped w56 `ac20a5f` (deployed `da345c0` (UI 0.32.50, 2026-10-07)) | `numbers.ts` in the overlay root, from view deltas: −N in `--danger` at the hit seat's face or the creature's P/T corner, +N in `--success`, 700 ms rise, stagger, pop; counter ticks with the old value struck through (tracker re-ran `w56-numbers` on a claw, green). Not wired: Fast Mode (LiveBoard → Board → installNumbers); no Healing Salve gain scenario yet | Bolt a face: −3 floats at their face on both screens |  |
| AB13 | capture telemetry per game so a report can be reproduced | 1 | shipped w57 `94e69bf` (deployed `4394b84` (UI 0.32.53, server 0.32.24, 2026-10-08 00:00Z)) | `prompt-forwarded`/`prompt-withheld` log events (window kind, decision, seat) and a per-match ring of decided windows written to `$CARDTABLE_PLAY_WORK_DIR/<matchId>/frames.jsonl` on match end; measured on a real match in the closing note | n/a — read the server log after a game |  |
| AB14 | a piled creature's P/T and counters drew the pile fan (6 px) below its own card (found by table-fit) | 0 (found by CI) | shipped `ff95769` (deployed `ff95769` (UI 0.32.48, 2026-10-07)) | `.board-card__pt`/`__counters` anchor to the face's bottom (`calc(2px + var(--pile-fan))`), not the pile box's; proven 3/3 on a claw | stack two creatures: the top one's P/T sits on its own card |  |
| AB15 | e2e drivers raced Forge on slow claws: w35's Ponder spec pressed the payment twice (the second press was the priority stop), w46-stack's boltOpponent pressed OK while a dropped first cast was still parked | 0 (found by CI) | partly — w35 shipped `19eca39`; w46-stack open (two driver rewrites tried on a claw, 2/6 and 2/6 still red: the first cast is dropped by Forge, not by the driver — in w57's scope if the prompt-path change moves it) | the Ponder loop waits for the payment window to give way; boltOpponent waits out a parked cast and presses the card again only once it is home | n/a — CI |  |
| AB16 | w56 leftovers: inspector counters for a buried exiled card; a Healing Salve gain scenario for `w56-numbers`; Fast Mode wiring into the numbers layer; `scenarios/README` `exile=`; `scripts/land.sh` cannot `pnpm install` (GitHub Packages refuses both host tokens — every land today used the linked-node_modules path) | 0 (w56 notes) | open | docs/planning/wave56-2026-10-07.md closing notes | — |  |

## Playtest 13 — 2026-10-07 (late), a small test on UI 0.32.51 (`42235d2`)

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| AC1 | the drag is smooth from the hand to the battlefield edge, then "gets stuck" once over it (intermittent: "as i'm trying it now it appears to be working") | 1 | shipped `5083c31` (deployed `5083c31` (UI 0.32.52, 2026-10-07)) | the placement preview measured every slot and pile and moved the indicator on EVERY pointer move once the card was over the battlefield — a layout per move; it now runs once per animation frame with the latest point, and clears at once on release (`gestures/install.ts` `previewAt`; drag/played-card/stacking/arrow specs 20/20 on a claw) | drag a card across a full board: it follows the pointer all the way |  |
| AC2 | the opponent's hand reorganises into two rows the moment they pull a card out, and their cards shrink | 1 (with AB5) | shipped `5083c31` (deployed `5083c31` (UI 0.32.52, 2026-10-07)) | `handRowsOf` counted every `<li>` of the hand, and a held card is drawn at the pointer, so its top read as a second row for exactly as long as the card was held; held cards are excluded (`presence.ts`; presence spec 3/3 on a claw) | watch Bella drag a card out: her hand stays one row |  |

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
