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

**The rendered page** (filterable by status, same content as this file):
https://claude.ai/artifact/AWidhZWnRVwpn1K2xEGwY6. This markdown is the source of
truth; the page is generated from it by `docs/planning/playtest-ledger-html.py` and
republished to that URL on every change.

*Last updated: 2026-09-30, after wave 31 landed and wave 32 was planned.*

---

## Check these in your next game (shipped in w31, never yet checked by you)

One line each; the same lines are in the tables below.

1. **Mulligan (L1, P7):** mulligan once. You are asked *keep?* on seven cards, you keep,
   **then** you put one on the bottom. No second *keep?* after the card goes back.
2. **Gitaxian Probe (P8):** with no untapped land, the Probe is clickable; casting it
   asks to pay 2 life.
3. **Reload mid-decision (P10):** reload the page while the bottom-a-card step (or a
   target choice) is on screen. The decision comes back and you can answer it.
4. **Second browser (spectator):** open the same match in another browser on the same
   account. It says it is watching and nothing it does counts. Close the first
   browser: the second becomes the player.
5. **Names and faces (P3):** the seat names are the players' names, not `Seat 1`; life
   is under the avatar; no `(you)` text.
6. **Regroup (P5):** the button is gone.
7. **Combat rail (P1):** outside combat it shows one combat step; in combat, six.
8. **Log hover (P12):** hovering a card name in the log shows the same big card you get
   from the board, not a second popup.
9. **Theme (P4):** switch themes; the board and room follow the theme's colours.
10. **Avatar at match start (P3b):** your own chosen avatar is on your face when the
    match starts.
11. **Concede after the end (L18):** once the game is over, Concede is off.
12. **Sound (L20):** the sound control is a speaker icon.
13. **Gone match:** open an old match link: it says why and offers a way back to the
    room; no board and nothing to "join".
14. **Stale rooms:** a room nobody has touched for 30 minutes is not listed.

---

## Playtest 1 — 2026-09-30, before w29 closed (build ≤ 0.25)

Numbering is the operator's (there was no item 19).

| ID | item | asked | status | evidence | check it by | your check |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | mulligan broken: only `Auto` live, hand dead | 1 | shipped w30, w31 | `de0928f` (flag reaches the seat), `be615f1` + fork `917bb193` (order); real-Forge tests | take a mulligan: hand lights up, pick a card | |
| L2 | the end step waits on the opponent | 1 | shipped w30 | default off, setting in w30 (`5b6c73e`); **moving to the header menu in w32 (Q15)** | end a turn with a land played; it should not stop at their end step | |
| L3 | picker `OK` / `Clear choice` below the panel, not at the bottom of a scroll | 1 | open | queued for w33 | open any selector; OK is visible without scrolling | |
| L4 | poison/infect counters shown nowhere | 1 | open | queued for w33 | | |
| L5 | delete `Leave`; `Concede` is enough | 1 | shipped w30 | w30 lane A | no `Leave` button | |
| L6 | arrow snapping/effect not shown when casting | 1 | partly | w29 staging area; **8-point snap is Q11, w32** | cast a targeted spell; the card shows in staging with the arrow starting there | |
| L7 | avatars not showing | 3 (L7, P3b, Q6) | partly | w29 carried the field; w31 fixed the 404 and the account read; **unset avatar waits on watchparty; live change is Q6, w32** | | |
| L8 | an auto-targeted effect still needs its arrow on the stack (Fiend Hunter) | 1 | open | queued for w33 | | |
| L9 | graveyard double-stacked | 3 (L9, P2, Q9) | reopened → P2, Q9 | w30 made it one stack; the layout was then reported again | | |
| L10 | z-order: cards, then effects on cards, then popups | 2 (L10, Q16) | open → Q16 | w32 | counters and P/T sit under any open popup | |
| L11 | one undivided board, type-separated as the alternate | ≥3 | shipped w30 | `5b6c73e`, `fc56164`; board `single` is the default | cards sit on one surface, no lane labels | |
| L12 | holding priority after casting | 2 (L12, Q17) | open → Q17 | w32 diagnoses first; not `passStackWindows` | cast a spell; you do not keep priority | |
| L13 | `Choose X` as a slider, capped at available mana | 1 | open | queued for w33 | | |
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
| Q1 | drop "0 Nobody"; show `Start`; ring the active player's avatar | 1 | planned w32 | lanes L and B | | |
| Q2 | opponent's hand the same card size, mirrored | 1 | planned w32 | lane B | | |
| Q3 | phase names centred and un-bulleted; rail grows in combat | 1 (follow-up on P1) | planned w32 | lane L | | |
| Q4 | lands back row, others front; free placement; own drag ghost and snap indicator | 2 (with P11) | planned w32 | lane B, last | | |
| Q5 | skipped phases should not crawl | 1 | planned w32 | **root cause found:** Forge's own ~205 ms sleep per skipped phase; the skip applies **only on End Turn** (your ruling) | | |
| Q6 | an avatar change does not reach the game | 1 | planned w32 | lanes S and R | | |
| Q7 | Mana Leak: arrow to a stack item; shortcut when one target | 1 | planned w32 | lane G | | |
| Q8 | "order simultaneous abilities" only in full control | 1 | planned w32 | lane S | | |
| Q9 | one column: avatar, counts, graveyard the rest; opponent mirrored | 3 (with L9, P2) | planned w32 | lane B; **no percentage** (your ruling) | | |
| Q10 | no Declare Blockers stop without creatures | 1 | planned w32 | lane S; settled | | |
| Q11 | arrow snaps to 8 points on the card edge | 1 | planned w32 | lane G | | |
| Q12 | could not assign blockers at all | 1 (related to L15) | planned w32 | **not diagnosed**; lane S reproduces first | | |
| Q13 | P/T bottom-right | 2 (with L14) | planned w32 | lane B | | |
| Q14 | click or box-select attackers to pull them back | 1 | planned w32 | lane G | | |
| Q15 | settings into the header menu; explain Cancel; layout is mine only | 1 | planned w32 | lane L (settings, Cancel), lane B (own-board layout) | | |
| Q16 | card labels under popovers | 2 (with L10) | planned w32 | lanes B, L, G, R | | |
| Q17 | holding priority on my own spells | 2 (with L12) | planned w32 | lane S diagnoses | | |

---

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
- **Regenerating the page:** `python3 docs/planning/playtest-ledger-html.py
  docs/planning/playtest-ledger.md <out.html>`, then publish `<out.html>` to the URL
  above (`url` set, so the link does not change).
