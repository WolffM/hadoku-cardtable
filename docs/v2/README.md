# Cardtable v2 — the high-fidelity table

**Status: PARKED until v2** (operator, 2026-10-03: *"we can't do art yet, we gotta park that for v2. write it up in a doc though."*). Nothing here is scheduled; v1's alpha comes first. Started 2026-10-02 at the operator's request: *"i'm
gonna want a pretty huge batch of effects, art, and animations before we can ship v2. gotta start
scaffolding what to hand off to the art team… i would like it if we could figure out a way to build
the board in more of a 'hearthstone-like' way in which we can put fun doodads and stuff around the board
that is clickable while players are waiting around."*

## What v1 is, and what v2 adds

v1 (waves 1–35) is the **simple mode**: the operator's words, *"essentially the 'simple mode' for low-end
PCs. once this is perfect, we can worry about the high-fidelity graphics mode."* It is DOM and CSS, it
has almost no animation, and it must keep working unchanged: v2 is a second mode, not a replacement.

v2 adds, behind a **Graphics: Simple / High** setting in the header gear:

1. **Effects and animation** (tapping, attacks, damage, spells, deaths, tokens, the coin flip, victory),
   from an art team. Brief: [`ART_BRIEF.md`](ART_BRIEF.md).
2. **A board with room to play with**: themed tables with clickable doodads to fidget with while the
   other player thinks (Hearthstone's best idea). Today's board has no room for it. Design round:
   [`BOARD_DESIGN_ROUND.md`](BOARD_DESIGN_ROUND.md).
3. **The engineering that both need**, which is ours and comes first (below).

## Three tracks, and their order

| track | who | can start | blocked by |
| --- | --- | --- | --- |
| A. Board design round | operator + tracker (mockups) | now | nothing |
| B. Art and effects | the art team | now, from `ART_BRIEF.md` | the board's final layout, for board art only |
| C. Engineering prerequisites | waves | after v1's alpha | nothing |

Art for cards' effects (B) does not depend on the board layout and can start at once. Board art
(tables, doodads) waits for the design round to pick a layout.

## Track C — the engineering v2 needs (found in the code, 2026-10-02)

- **An events channel.** Forge's game events are fully modelled (`packages/forge-wire/src/events/`: 41
  classes, validated against 330,942 real events: `GameEventCardTapped`, `AttackersDeclared`,
  `CardDamaged`, `CardChangeZone`, `SpellAbilityCast`, `SpellResolved`, `PlayerLivesChanged`…), but
  **the server sends every browser `events: []`** (`apps/server/src/play/visibility.ts:478,501`).
  Events can carry hidden information (a draw names the card), so each needs per-seat redaction, the way
  state already has it. Every animation in the art brief hangs off one of these events.
- **A render layer for High mode**, over the DOM board: effects play in a canvas/WebGL layer positioned
  over the cards, so Simple mode is untouched and High mode can be turned off. Proposed: PixiJS (WebGL,
  sprite sheets, particles) loaded only when High is on. To decide in track C.
- **An asset loader** reading from `cdn.hadoku.me` through a manifest, with fallbacks: a missing effect
  plays nothing, never breaks the game. (`AGENTS.md`: art is a lookup, never a URL; no image bytes in
  the repo or the bundle.)
- **A performance budget**: High mode holds 60 fps on the operator's reference machine with a full
  board; Simple mode stays the default on anything that cannot.
- **The doodad runtime**: client-only, never sent to Forge, never to the other player (see the design
  round's question 2).

## Ground rules that bind the art (from `AGENTS.md` and `docs/LICENSING.md`)

- **No WotC trademarks**: no Magic logo or wordmark, no card frames, no planeswalker symbol, no set
  symbols drawn by us. Plane names and their imagery (Lorwyn, Zendikar, Innistrad…) are WotC's too: the
  boards are **original** places.
- **No money, ever.** The app never charges or takes donations. How the art team is credited and
  licensed is a decision for the operator (see `ART_BRIEF.md` §1), and the licence must let us host the
  assets on `cdn.hadoku.me`.
- **No image bytes in the repo or the bundle.** Assets go to the CDN and are referenced by key.
