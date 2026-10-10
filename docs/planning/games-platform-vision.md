# Games platform — the operator's vision, and where it stands

The north star for the work after cardtable's alpha. **Read this before
planning anything that touches more than one game.** The operator's words are
quoted verbatim below so the goal cannot drift through paraphrase; the status
table under them is the only part that should change.

## The directions (2026-10-09, verbatim)

> a couple of big designs to shift. the next phase for this project is being
> to lift and shift it to two locations: games-host, and submodule inside
> watchparty.
>
> this effort should be coupled with bomberman as well, and from bomerman we
> want to grab the code related to highscores and profile stats. i know its
> rust code, so we probably have to transplant but my hope is that this code
> can be reused, shared and potentially added to our fleet of packages that we
> use for future games. at the moment we have:
> 1. hadoku_site for auth, header, hosting
> 2. hadoku_task for themes
> 3. watchparty for chat ui and networking
> and now i also want to grab
> 4. leaderboard, match history & profile stats from bomberman.
>
> there is a bunch of work needed for bomberman too because the goal for both
> games is to be parallel and unified and have:
>
> 1. standalone page (already done for us)
> 2. loadable submodule inside watchparty (done for them, not us)
> 3. clickable inside games-host (this one is probably trivial. i'm not
>    exaclty sure how i want this to look but it could honestly be as simple as
>    just being a button that opens (1).

### Answers to the follow-up questions (verbatim)

> 1. yeah i think it does need to go to its own repo, that makes the most
>    sense and is how we're currently doing ours. i think our repo is the
>    rolemodel for standalone
> 2. thats a good question and i need your help to think about this. the
>    server/java process can obviously be seperate, as a pm2 process how we do
>    everything else. i think (a) sounds more right, but iframe sounds slow. are
>    we not able to deliver a static package? i guess the issue is the server
>    component. so maybe (b) is better. we need to make sure the watchparty
>    component loading our package is as thin as possible so they dont need to
>    make any changes. The more complex thing is probably to decouple however
>    the chat is currently working in watchparty to make it use its own
>    decoupled chat-ui package. because essentially their 'media player' should
>    really just act as a 'game bundle' the same way bomberman and cardtable
>    will. does that make sense? I'm not sure how difficult that will be or if
>    its necessary. i guess the whole chat is entirely seperate anyway, the
>    only thing linked is the avatar/theme change right?
> 3. try to keep it as generic/modular as possible hopefully we can utilize
>    and share as much code as possible from the generic
>    matchhistory/leaderboard functionality we're building.
> 4. Sure, that seems fine. i dont care too much about making it too complex,
>    mostly i want stats to see which decks win the most. and i want people to
>    be able to see their match history and stats about their favorite colors
>    and what not. in the future i also want to support earning rewards like
>    new card art from loot boxes and stuff like that. drafting isn't in the
>    game yet, but in theory we can support that in the future as well.
> 5. there already a games-host package, it's a very thin react host so we can
>    redesign it however. i dont mind it just being a link to click on and
>    navigate to our standalone pages. lets not overcomplicate that so it's
>    faster to land it.
> 6. cardtable is nearly done with the alpha. all thats left is getting audio
>    in which i will do in a seperate session. i'm hoping none of the work here
>    needs to touch the game engine/logic so you can keep working while the
>    other agents are finishing that up.

### The three tasks it became (verbatim)

> 1. scaffold the worktree for bomberman so they can learn from our standalone
>    page utilizing the watchparty-ui chat and whatever else we have going
>    here. ideally their game module can drop in whatever is currently our
>    board module.
> 2. extract the highscore/match history/profile stats code and see if we can
>    build this into the generalizable userdata for how we're already storing
>    data for users, i would prefer to keep all user data in the same place if
>    possible.
> 3. then, lets get user stats in here. we'll have to design what it actually
>    needs to look like. it doesnt need to be too complex at first but i'd like
>    to keep track of as many stats as possible and then think about whats
>    actually fun to show

## What was true when this started

- Bomberman's stats were **TypeScript, not Rust** — watchparty's server
  (better-sqlite3 + Elo) mirrored to hadoku_site's `watchparty-stats-api` D1
  worker, 28 bomberman-shaped columns. Only the game itself is Rust.
- Bomberman lived inside `hadoku-watchparty/game/`, loaded as a cross-origin
  iframe (`GameModule.tsx`, the `__wpgame` postMessage bridge).
- "games-host" turned out to be two things: `hadoku-games-host`, a Python
  docker start/stop panel, and hadoku_site's `/games/` Astro gallery — the
  latter is the launcher.
- D17 had ruled out "cardtable lives inside watchparty"; the vision adds a
  second deployment beside the standalone one, so D17 needs an amendment, not
  a reversal, when that work starts.

## Status

| # | Goal | State | Where |
| - | ---- | ----- | ----- |
| A | Generic stats in the user-data store | **Live** | hadoku_site `49116439`: prefs-api `/_games/:gameId/*`, D1 `hadoku_prefs`; `@wolffm/prefs-client/games` 1.0.15; design `docs/planning/game-stats-2026-10-09.md` there |
| B | Cardtable reports matches + Stats screen | **Landed** `5c5eea6`; recording waits on the prod service key | `apps/server/src/stats/`, `apps/ui/src/stats/`, `#/stats` |
| C | Bomberman in its own repo, cardtable-shaped | **Repo live**: relay, CI game pipeline, stats reporting, lobby parity (characters, countdown, session crown), embed bundle (`e8065e1`), in-page mount without an iframe (`6b391cb`, opt-in via `?gameMount=page`; proven in headless Chromium inside the embed's shadow root; flipping the default deletes the iframe path). Not yet served: DNS/ingress, repo secrets, service key | `WolffM/hadoku-bomberman` (private); `docs/PORT_BRIEF.md` there is its task list |
| D | Both games clickable from the games host | Cardtable **live**; Bomberman card inert until its page serves | hadoku_site `c78c22cf`, `src/pages/games/index.astro` |
| E | Both games loadable inside watchparty | **Landed**, off in prod: watchparty loads games from data (`d490b0f6`, `GAMES` env); cardtable's bundle `/cardtable/embed/cardtable-embed.js` (`fa9c593`, D21); bomberman's `/bomberman/embed/bomberman-embed.js` (`e8065e1`). Turn on by setting watchparty's `GAMES` | contract in `@wolffm/rooms-protocol` 0.41.4; cardtable `apps/ui/src/embed/`; watchparty `GameBundleSlot.tsx` |
| F | Watchparty's player as "just another game bundle" | **Not started** | |
| G | Shared stats UI package | **Landed**: `@wolffm/game-stats-ui` (hadoku_site `847fc9ac`, fixes `c24fa4c2`); cardtable's `#/stats` draws through it (`39c7ee7`, −393 lines). bomberman's `#/stats` too (`c3502e9`, `6e4f4d2`; package 0.1.2 adds `flagCounters` for 0/1-per-match counters) | hadoku_site `packages/game-stats-ui` |
| H | Bomberman history import + watchparty cutover | Not started. Cutover = point watchparty's bomberman `GAMES` entry at bomberman's bundle, then delete watchparty's `GameModule.tsx`, `game/`, `gameStatic.ts`, game-dist pipeline, `d1Sync.ts` and hadoku_site `watchparty-stats-api` | bomberman brief §5, §7 |
| I | Rewards (unlockable art, loot) | Future — an inventory table beside game stats | |
| J | Draft stats | Future — `mode: 'draft'` already has a rating pool | |

Operator-owned (hadoku_site session): the cardtable and bomberman service keys
in their PM2 wrappers (`CARDTABLE_SERVICE_KEY`, `BOMBERMAN_SERVICE_KEY`),
bomberman's repo secrets, DNS/ingress, and the room namespace.

## E — the shape we're heading for

The operator's answer to Q2 picks **a package, not an iframe**: watchparty
imports a game's UI and mounts it in the slot its media player occupies,
while the game's server stays its own PM2 process. The constraint that shapes
everything: **the watchparty side must be as thin as possible, so watchparty
makes no per-game changes.** That implies one generic contract every game
bundle (cardtable, bomberman, and eventually the media player) implements —
roughly `mount(el, { roomKey, serverOrigin, identity, theme, onLeave })` →
`unmount()` — and a game list that is data, not a hardcoded `GAMES` array.
The chat is already decoupled (`RoomChrome` is a package); what a bundle and
the room share is the room key, identity, and the theme/avatar.
