# v2 board design round — room for doodads

> **Parked for v2** (2026-10-03). See `README.md`.

**Goal:** a board that still plays a whole game of Magic at 1280×800 with nothing scrolling, AND leaves
real estate for a themed table with **clickable doodads** to fidget with while the other player thinks.

**Output of the round:** one chosen layout, drawn to the pixel at 1280×800 and 1366×768, with its
doodad zones marked, and the operator's answers to the questions at the end. That drawing becomes the
brief for the board art (`ART_BRIEF.md` §4) and for the wave that builds it.

## Where we start: there is no free space today

Measured from `docs/planning/board-layout-2026-09-27.md` (1280×800):

| region | share of the canvas |
| --- | --- |
| left column (avatar, counts, graveyard) | x 0.3–6%, full height |
| hand, battlefield, battlefield, hand (four rows) | x 6.6–93.5%, y 6.5–95% |
| phase rail and controls (reserved right gutter) | x 84–93%, y 31–77% |
| stack and decision area (transient overlays) | x 59–83%, y 11–72% |
| watchparty chat (beside the board) | its own column |

Every pixel is a card row, a pile or a control. **Doodads need the layout to give something up**, so the
round is about what to trade, not where to squeeze.

## What Hearthstone does, and why it works

- The board is a **table seen from above** with a playing surface in the middle and four **corner
  zones** that are scenery, not game. Each themed board has 4–8 doodads in those corners.
- Doodads are **local fun**: clicking one plays an animation and a sound (a catapult fires, a mill
  turns, a fish jumps). They never touch the game. Some have a small secret (click 10 times).
- The playing surface **shrinks to fit**: the hand is a fan at the bottom edge, partly off-screen, and
  only lifts on hover. That is where most of the space comes from.

## Three directions to mock up

**1. The framed table.** Keep today's rows, but shrink the playing surface to ~76% of the width and
centre it, framed by a themed table edge. The two corners on each side become doodad zones; the phase
rail and controls move into the right edge of the frame.

```
+--+--------------------------------------------------+--+
|D |  their hand (fan, half off the top edge)         | D|
|  +--------------------------------------------------+  |
|av|  their battlefield                               |ph|
|gy|                                                  |as|
|  |- - - - - - - - - - - - - - - - - - - - - - - - - |e |
|av|  your battlefield                                |ct|
|gy|                                                  |rl|
|  +--------------------------------------------------+  |
|D |  your hand (fan, lifts on hover)                 | D|
+--+--------------------------------------------------+--+
```
Cost: smaller cards on a crowded board. Gain: four corners, and the frame is the theme's canvas.

**2. The fanned hand.** Keep the full width for the battlefields, and win the space from the hands: both
hands become fans that sit half off the screen edge (yours lifts on hover, theirs is just backs). That
frees most of the 16% each hand row uses today, and the doodads live in the bands left and right of each
fan.
Cost: your hand is one hover away. Gain: the biggest battlefields of the three.

**3. The diorama.** The battlefields sit on a tilted table (a slight perspective), so the far edge is
narrower and the four corners open up naturally, the way Hearthstone's board does. Most like
Hearthstone; the hardest to build, and High mode only (Simple mode keeps the flat rows).
Cost: a second layout to maintain. Gain: the most "game-like" table.

**Tracker's recommendation:** mock up all three, then pick between 1 and 2 for both modes; keep 3 as a
High-mode-only follow-up. Option 2 costs the least board space and works in Simple mode too.

## How the round runs

1. The tracker builds the three mockups as static HTML pages served by the dev harness at 1280×800 and
   1366×768, with a real mid-game board state (the scenario harness from wave 33 can set one up) and the
   doodad zones outlined. Evidence and screenshots go in `docs/v2/design-round/`.
2. The operator plays a few turns on each (they are clickable boards, not pictures) and picks one, with
   changes.
3. The chosen layout is drawn to the pixel and goes to the art team as `ART_BRIEF.md` §4's input.

Effort: one focused wave, after v1's alpha ships, so it does not compete with v1 polish.

## Questions for the operator (each with the tracker's recommendation)

1. **How many board themes for v2's first ship?** Recommend **three**, original places, picked to match
   the feel of the eras (a forest, a city, a wasteland), and more later.
2. **Do doodads stay local, or does the other player see you poking them?** Recommend **local only**
   (Hearthstone's choice): no wire traffic, no annoyance, nothing to cheat with. A shared "emote" can be
   a separate later feature.
3. **Does the board theme belong to the room, or to each player?** Recommend **the room** (the leader
   picks it, like the era), so both players sit at the same table.
4. **Is it OK that Simple mode stays the flat layout we have now?** Recommend yes: the design round
   changes High mode first, and Simple mode adopts the new layout only if it is no worse on a low-end
   machine.
