# Draft pods — the operator's plan, and how it is built

The operator's words are quoted verbatim so the goal cannot drift through
paraphrase. Everything under **Design** is ours and may change; the quotes may
not.

## The ask (2026-10-17, verbatim)

> lets get back to thinking about draft. to do this we need three big new
> features:
>
> 1. large rooms that can support multiple different games simultaneously for
>    when we have a pool of 8 players and we need at least 4 games going on at
>    the same time. It would be cool if it were easy for people to swap between
>    alternate boards and see them from spectator's perspective.
>
> 2. actually getting draft mode to look good and feel good.
>
> 3. deck editor (this will also be useful for playing games with sideboard
>    enabled)
>
> nothing totally crazy. (1) will need some reshuffling to how rooms work and
> some extra logic for doing pairings and assigning players to new rooms for
> their matches.
>
> (2) was pretty close to ready last i checked, just needed the glue for
> actually building the deck and then playing it.

## Rulings (2026-10-17, verbatim)

> 1. Best-of-3 for pod matches
> 2. play the person across the table, then pairing by score
> 3. let's keep the option for AI open, but for now let's just give them a by
>    in the round.
> 4. well, we're still not doing multiplayer. and spectators don't need
>    'seats' however, we probably should reuse the 'seat' UI for getting people
>    into the draft pod. so yeah, in this case we go up to 8 seats
> 5. naw just draft deck building and sideboarding between matches (for both
>    1v1 constructd and draft)
>
> 5b. this also means we now need another setting aside from 'smoothening'
> that is also 'sideboarding' for a room. sideboarding will only happen if
> it's toggled on and players select rematch, or if the room is bo3. oh i
> guess that means we need anothe rsetting for bo1 or bo3 for 1v1 constructed.
> default still bo1. bo1+sideboarding can still be enabled and triggered via
> rematch. bo3 just means that rematch is forced after a round ends.

## What existed on 2026-10-17

- **Draft:** the engine is ours (`packages/draft`, O2), 8 × 3 × 15, bots fill
  the empty seats. `draft.spec` has two browsers draft a pod to "Draft complete".
  It is hidden from the create form ("Coming Soon", `271260aa`). Nothing after
  `PodScreen`'s "Draft complete" leads to the builder. A pool exists only while
  the drafter holds a pod seat (120 s hold).
- **Builder:** `apps/ui/src/deck/DeckBuilder.tsx` (`#/deck/<podId>`) is a real
  limited builder, but its Start plays the AI with a library deck. A friend
  match on a drafted pool gets the fixed `draftedDeckOf` (45 picks + 17 basics,
  not editable).
- **Rooms:** one `matchId` per room (`lobby.ts`), `TABLE_SEATS = 2`
  (`routes.ts`), start gate keyed by room. The match layer is already keyed by
  match id, and any friend socket can watch any match.
- **Matches:** one game. `sideboard` is answered `null` by the bridge
  (`PlayBridge.java`); `SideboardPrompt` and its schemas are built and never
  reached.

## Design

### Room settings

| setting | values | default | notes |
| --- | --- | --- | --- |
| `handSmoothing` | on/off | on | exists |
| `matchLength` | `bo1` / `bo3` | `bo1` | a draft room is always `bo3` |
| `sideboarding` | on/off | off | `bo3` implies on |

- **bo1:** Rematch is optional, as today. With `sideboarding` on, a Rematch
  opens the sideboard step before the next game.
- **bo3:** Rematch is forced. After a game the room goes straight into the
  sideboard step, then the next game, until someone has two wins. The loser of
  the previous game chooses play or draw.

### Games of a match are separate Forge matches

Each game is a fresh Forge match started by the room. A "match" (bo3) is a room
concept: the pairing, a list of game results, and the score. Sideboarding is a
room step **between** Forge matches, using the deck editor against the player's
75 (a library deck's `[Sideboard]`, or the rest of a drafted pool plus basics).

This keeps bo1 + Rematch and bo3 on one path and keeps the Java bridge as it is.
Forge's in-match `sideboard` ask stays answered with `null`. The unreached
`SideboardPrompt`, its rules and `packages/forge-wire/src/sideboard.ts` are
**deleted** by the lane that ships the sideboard step.

### Tables

A room holds `tables: { id, seats: [memberId, memberId], matchId | null, games: GameResult[] }[]`.
A constructed 1v1 room is the one-table case, and that is the migration default
for stored rooms. Seats, ready, start and lock are per table. Spectators hold no
seat (ruling 4).

### Pods

A draft room runs in phases: **lobby → drafting → building → rounds → done**.

- **Lobby:** the existing seat UI (Sit here / Stand up), up to 8 seats.
- **Drafting:** as today.
- **Building:** each drafter builds in the deck editor. Pools and built decks
  are stored on the server per pod member, not in the pod seat, so a reload or
  a walk-away does not lose them.
- **Rounds:** `ceil(log2(humans))` rounds, each a bo3.
  - **Round 1: across the table.** Humans are ordered by pod seat, and human
    *i* plays human *i + ⌈H/2⌉*. With an odd *H*, the last one gets the bye.
  - **Later rounds: by score.** Match points (win 3, draw 1), and no repeat
    pairing while another is possible.
  - **A bye** goes to the lowest-ranked player who has not had one. It counts
    as a match win (2–0). The AI-opponent option stays open but is not built
    (ruling 3).
- **Standings** are shown in the room between rounds and at the end.

### Watching

Players are taken to their own table's match. Everyone else gets a **board
strip**, one entry per live table, and switches boards without leaving the
room. The chat stays keyed to the **room**, not the match, so switching boards
does not switch chat rooms. That is a change from today's `cardtable-m-…`.

### Deck editor

One editor, two modes:

1. **Limited build** from a pool, with basics and a 40-card floor.
2. **Sideboard** between games: swap cards between the main deck and the 75.

There is no constructed deck editing or card search (ruling 5).

## Order

1. **Glue: a draft you can finish and play.**
   - Unhide draft.
   - "Draft complete" → editor → the deck is saved on the server.
   - A drafted-pool room uses the built deck.
   - Pools are persisted.
   - One e2e: draft → build → a real Forge game.
2. **Match length and sideboarding for 1v1.** The two settings, the sideboard
   step, a forced Rematch, the bo3 score. Delete the dead `SideboardPrompt` path.
3. **Tables and pods.** Multi-table rooms, the 8-seat pod lobby, pairings and
   rounds, byes, standings, the board strip, chat keyed to the room.
