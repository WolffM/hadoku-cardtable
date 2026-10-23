# The table card

One component for a table's game wherever a room has games — a constructed room between games,
a draft pod's table, a tournament's bracket. It replaces the constructed room's "Return to game"
box (`room-table-link`) and the pod bracket's match card (`PodBracket.tsx`'s `Card`).

## The operator's words (2026-10-23)

> it would be nice if the 'Return to game' button had options for concede and abandon. that would
> allow us to resolve games without having to close rooms.
>
> also would be cool if the 'return to game' was a more interesting visual instead. how does it look
> for draft and touranment rooms? i would expect at minimum something like a half/half box showing
> the decks that each person is currently playing, and the current score, and the current phase of
> the game (start of game, mid game, end of game, sideboarding, etc)
>
> i would like this to be consistent across all rooms that can hve games in them
> (constructed/draft/tournament)

The design canvas (private, the operator's): https://claude.ai/artifact/2kcH8EbB9jHoVvoCqMXY8X —
the operator, on it: *"looks awesome, love it"*.

## What the design says

- **Half and half**, one side per seat: the deck's art crop across the top (a card of the deck,
  through the art lookup — never a URL), the player's avatar and name, the deck's name and colour
  pips, and during a game life and cards in hand.
- **The series score** in the middle, with its length (Best of 3).
- **A phase strip** across the top: Start · Mid · End · Sideboard, with the game number and a
  detail (Mulligans; Turn 7 · Bob's combat; Bob wins on turn 11; Waiting on Alice).
- **The foot**: the primary action (Return to game, Sideboard, Watch), and the seat's own
  resolve actions.
- **Two sizes**: full (a constructed room, a player's own table) and compact (every table on a
  pod or tournament hub; yours outlined in the accent).

## Resolving a game

Each confirm shows the score before and after it; no explanatory text.

| action | where | what it does |
| --- | --- | --- |
| Concede game | every room, a seated player | the other seat wins this game; a Bo3 goes on to sideboarding |
| Abandon | a constructed room | the series ends with no result; the table goes back to seating |
| Drop match | a draft pod or tournament | the series is forfeited and recorded as a loss (a bracket needs a result) |

These meanings are proposed, not yet ruled on; ask before building past them.

## What the wire does not carry yet

`RoomTable` (`packages/shared/src/room-tables.ts`) has seats, wins and the series phase. The card
also needs, per table: each seat's deck (name, colours, a featured card's id for the art), and
while a game runs its turn number, active seat and step, and each seat's life and hand size —
from the match's projector, published as the room's table view changes. Concede exists only inside
a match (`match.concededBy`); Abandon and Drop are new room actions.

## Order

1. The wire: a table's decks and live game summary on `RoomTable`, with a schema test.
2. The room actions: concede game, abandon (constructed), drop match (pod/tournament).
3. The card, full and compact, in all three rooms; the old box and bracket card deleted.
