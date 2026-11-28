# Card Table: features

What each part of Card Table does and how to use it. How it is built is in
[contributing.md](contributing.md).

Card Table is free for every signed-in member at
[hadoku.me/cardtable/](https://hadoku.me/cardtable/) — no public or
anonymous access, and no money anywhere in it
([`NOTICE.md`](../../NOTICE.md), [`docs/LICENSING.md`](../LICENSING.md)).

## Cube drafting

**What it does.** Up to eight seats draft packs from a chosen cube list,
passing and picking in turn; any seat nobody has joined is filled by a bot.
A bot's pick normally asks a private companion repo's hosted neural
draft-rating service for the best card left in its pack; if that service is
unreachable, times out, or has no rating for the pack, the bot falls back to
a built-in heuristic instead.

**How to use it.** From the lobby, join an open pod or wait for the host to
start one. Packs open to every seat at once, and a pick timer keeps the
draft moving. Take a card by clicking it, by pressing Enter, or by dragging
it onto your picks (onto their sideboard pile to file it there at once);
drag the fan sideways or use the arrow keys to move along the pack. The (i)
button in the room's bar, by Close, lists every control, beside the switch
between the fan and the grid.

Cards that change the draft itself work as printed. What such a card does
in public is listed under the pod for everyone, and a card drafted face up
shows beside its drafter's name.

Used with a pick, by pressing the face-up card's name and then the pick.
Cogwork Librarian takes two cards and goes into that pack for the next seat.
Leovold's Operative takes a second card, then its drafter's next pack passes
on untouched. Agent of Acquisitions takes the whole pack, and for the rest of
the round every pack that reaches its drafter passes on untouched (they are
shown each one). Cogwork Grinder removes the picked card from the draft
without the table learning which, on every pick it is pressed; Animus of
Predation does the same with the card shown to everyone. Noble Banneret and
Paliano Vanguard reveal a creature as it is drafted and note its name or its
creature types; Smuggler Captain notes any card's name. Pressed with a card
that is no creature, the Banneret and the Vanguard refuse the pick.

Asking a seat. Lore Seeker is revealed and asks its drafter whether to add a
booster pack: on Yes a pack the draft never opened is their next pick, then
passes on. Paliano, the High City and Regicide are revealed, then the player
to the drafter's right, the drafter and the player to its left each choose a
colour on their own screen, and the table is told the three. Deal Broker is
drafted face up and runs after the last pick: its holder may reveal a card of
its pool, each other player may offer one of theirs (only the holder sees an
offer), and the holder may accept one, which swaps the two cards before deck
building opens.

Changing where packs go and what a seat sees. Canal Dredger is drafted face
up, and from then on the last card of every pack goes to its drafter; when
several seats drafted one, a seat that did keeps its own and any other seat
is asked which of them gets it. Archdemon of Paliano is drafted face up and
hides its drafter's packs: each is a count and one button that drafts a card
at random, and after three such cards it turns face down.

Showing one seat something hidden, sent to that seat alone and listed under
the pod on their screen only. Cogwork Spy shows its drafter the next card
drafted from the pack it came from. Spire Phantasm asks its drafter to guess,
among the cards left in that pack, the next one drafted from it; that card is
then revealed to the table, and a right guess is noted for the match.
Illusionary Informant and Whispergear Sneak lie face up until their drafter
presses their name, at any time: the Informant shows the next card a chosen
seat drafts, the Sneak a whole pack nobody is looking at (unopened, or
waiting behind the one a seat is picking from).

Revealing and noting. Custodi Peacekeeper, Garbage Fire, Lurking Automaton
and Pyretic Hunter are revealed and note how many cards their drafter has
drafted that round. Cogwork Tracker notes who passed it. Aether Searcher is
revealed, and the next card its drafter drafts is revealed and noted too.

What a card notes during the draft goes with the drafted deck into its
matches, where the same card reads it: the Automaton enters with that many
counters, Paliano makes only the three chosen colours, the Banneret pumps the
creature it named. A bot's deck carries its notes as well.

**What it does not do.** Cogwork Tracker's note changes nothing in a match:
Forge never reads it back, and with two players the card attacks the only
opponent there is. Bots never use a face-up card they draft, answer No to what a card
asks them (asked for a colour, the first offered; asked where a last card
goes, the nearest Dredger seat) and make no offer to a Deal Broker. Lore
Seeker adds a pack only from cards the cube has left over after the deal, so
a cube the pod uses up, and a set drafted as real boosters, has none to add.
A cube is a list of cards and nothing more: no custom pack rules, no
weighting, and no card Forge cannot play, which a draft leaves out.

## Hosting a draft

**What it does.** Any member can open a pod: pick a cube and a pick timer,
then wait for its eight seats to fill, or let bots take the rest.

**How to use it.** Click **Create room** in the lobby and set **Game type**
to **Draft**, then open the room. Its leader picks a cube from the **Cube**
tab, then turns the pick timer on and sets its speed (½×, 1×, 2× or 4×) in
the room's match rules before the pod deals.

**Bringing your own cube.** The Cube tab's **Import** box takes a Cube Cobra
link (any of a cube's pages, or its id) or a pasted card list with a name:
one card a line, with or without a count or a set, or a Cube Cobra export
(plain text, CSV, MTGO or Forge). The import becomes the room's cube at
once. Cards Forge cannot play are named, and **Draft without them** deals
the rest. Every import is kept in the **Library**'s **Cubes** tab for the next
draft, under its importer's name, where a Cube Cobra cube can be refreshed and
the importer can delete theirs.

**What it does not do.** Opening a pod, like creating any room, event or
match, is rate-limited per caller — a member cannot spin up pods without
limit.

## Playing a match

**What it does.** A drafted or constructed deck plays a real game of Magic,
against another member or against Forge's own AI, with Forge running the
actual rules headless on the server.

**How to use it.** A match starts from a pod once drafting finishes, or
straight from the deck library, or by clicking **Create room**, setting
**Game type** to **Constructed**, and opening the room.

**What it does not do.** No card image ever ships in this repo. A card's art
is looked up live, from a CDN mirror or from Scryfall, never committed
(`docs/LICENSING.md` §3.1) — a card whose art source has gone away shows as
text only, not a broken image.

### Motion and game speed

Each kind of movement on the page can be turned off on its
own, for players who find motion distracting: card animations (cards
travelling, creatures ramming, cracks, floating numbers), screen shake,
looping animations (pulses, glows, flyers bobbing) and the match playing on
the front page. Separately, **Game speed** sets how long the board waits
between the opponent's actions: Normal, Fast (everything plays twice as
quickly) or Instant (nothing waits, which used to be Fast Mode).

In the settings (the gear in the header): **Gameplay**
holds Game speed, and **Display** holds the UI scale and the four motion
switches. The front page's match also has a pause button on its title bar.

A switch the player has never touched follows the
device's own "reduce motion" setting, so on a device that asks for less
motion all four start off. Once a player sets one, their choice wins, in
either direction.

## The deck library

**What it does.** Preconstructed decks spanning Magic's own competitive
history — Standard back to 1995, Modern back to 2011, and a run of Legacy
and power-era Standard decks, pulled from Forge's own archive and tournament
record.

**How to use it.** In a Constructed room, the leader turns on **Free pick**
in the room's match rules. Then anyone can choose a **Standard**,
**Modern** or **Legacy** tab and drag its year slider to browse that
era's decks.

**What it does not do.** Only catalogued eras reach the picker — a season or
format nobody has catalogued yet is not browsable even if Forge's own
archive has the cards for it.

## The Library

**What it does.** One page for everything a player owns: their decks, the
cubes they have drafted and their card art, as tabs. Decks come in three rows: the ones they
starred, the ones they made their own, and the ones a draft made that they
have not touched yet, each with the one played last first. Every deck tile
says when it was last played, or that it never was.

**How to use it.** Press **Library** on the front page. The Decks tab's one
text box finds a deck by its name, a card in it, or the cube or set it was
drafted from; sort by last played, win rate, name or newest, and star a deck to
keep it at the top. A cube on the Cubes tab says how many of the player's decks
came from it and opens the Decks tab with that cube's name in the box. The Cubes
tab, and a draft room's Cube and Set tabs, have one search box and one sort:
newest (the default), most drafted, most played or name. A star on a cube or
set keeps it first in every sort, in the Library and in every room.
**New deck** opens the deck builder on an empty deck: pick a format (any era a
room offers, or Any card), search for cards and press them in, up to four of
each, with basics from the land counters. A named deck saves itself as it is
built, and once it reaches 60 cards it is offered under a room's **My decks**.

**Art choices.** The Library's **Cards** tab picks which printing each card
is drawn as. Search a card and open it: its printings line up oldest first,
each with its set and year, the oldest and the default marked. Press one to
pick it, or **Reset to default**. With the box empty, the tab shows the cards
already picked. **Always use oldest art**, in Settings, draws every other card
as its oldest printing; a hand pick still wins. The choice is fixed when a match starts,
drawn that way on both screens and in the replay, and never changes the
opponent's cards. A drafted deck keeps its drafted art while its tournament
runs. Every drafted deck shows cover art, including decks from sets and
imported cubes.

**What it does not do.** A drafted deck whose tournament is still running can't
be renamed or deleted until it ends. A built deck has no sideboard. The old
Decks and Inventory links still work and open the matching tab.

## Match music

**What it does.** Each game mode has its own music. Any friend can rate the
takes on offer and submit a pick for a slot; an admin's own pick is what
actually plays.

**How to use it.** Open `#/sounds/music`. A submitted pick is saved to
the reviewer's own preferences row, never a shared file.

**What it does not do.** The app's own floor is member, but this screen
checks friend tier for itself rather than leaning on the floor, so
reviewing stayed friend-only once the floor opened to every member. Seeing every member's reviews, or
writing which take actually plays, needs admin. _Tier: friend to submit or
read your own review; admin to read everyone's or set the pack._

## Events and the calendar

**What it does.** The front page's **Calendar** lists upcoming events. An
event is a room with a start time, such as a draft night or a tournament.
Each event also appears in the Card Table Discord server's Events tab. An
hour before it starts, a reminder is posted in #events. Each row on the
calendar shows a row of faces and "N signed up". Pressing it opens the list
of everyone signed up: whoever answered the event's sign-up poll, and whoever
is in its room, each person once. The same list opens from beside the
event room's name.

**How to use it.** In the room list, press **Create event**, then choose
the room's settings and a start time. To let people say when they can play
first, attach a Rally sign-up poll in the same dialog: **Create** builds a
new one in Rally, **Load** takes one by its link. The poll then shows on the
calendar's **Polls** page. Its **Create event** fills in the event from the
poll and offers the start times most people can make. An event made from a poll is organized by whoever
created the poll. The organizer moves or cancels it from its calendar row,
and Discord follows. Press **Sign up** on a row to join the event's room.
Its seats open 30 minutes before the start.

**What it does not do.** A room with a password and a testing room stay off
Discord. Clicking "Interested" on the Discord event does not sign you up on
Card Table.

## Leaving a room

**What it does.** **Leave**, at the start of a room's top row, takes you out
of the room: you stop being one of its members and land on the front page.
Clicking **Card Table** in the top bar from a room's page does the same. If
the leader leaves, the room passes to whoever has been in it longest.

**How to use it.** Press **Leave**, or click **Card Table** at the top.

**What it does not do.** Inside a watchparty room the table belongs to
watchparty, so there is no Leave there; watchparty's own controls end it.
Mid-tournament the button reads **Leave tournament** and asks once more,
because leaving drops you from the event; clicking **Card Table**, a match's
**Main menu**, closing the tab or losing your connection only take you away,
and your seat waits for you for as long as the event runs.

## Room link previews

**What it does.** Pasting a room's link into Discord, or any app that
unfurls links, shows a generated card: the room's name, its format and
mode, and the seated players' faces. A 1v1 room is its host against the
other seat, or a dashed "You?" while that seat is open; a tournament or a
draft is its whole field, open seats dashed.

**How to use it.** Nothing to click; it happens automatically whenever a
room link is shared.

**What it does not do.** A room with a password, a testing room, a
friends-only room, and a room that does not exist all answer with the same
plain 404 — the preview never shows more than the room's own members would
see.

## Friends-only rooms

**What it does.** A room made friends-only exists only for the fleet's friend
tier and above: anyone below it never sees it in the room list, and reading,
joining, its chat and its game's relay all answer as if it did not exist. A
verified member is not a friend here, though Card Table lets a member do
everything else a friend does. A game can also be friends-only as a whole,
in which case every room of it is.

**How to use it.** On **Create room**, set **Friends only** to On. Only a
friend or above is offered the switch.

**What it does not do.** An event's room is never friends-only: events are
public on the calendar and in Discord. _Tier: friend._

## Early builds

**What it does.** A separate instance, PPE, runs the next build the moment
it passes CI — ahead of the manually-released version everyone else plays.

**How to use it.** [hadoku.me/cardtable-ppe/](https://hadoku.me/cardtable-ppe/)
(`docs/planning/release-process.md`).

**What it does not do.** PPE keeps no game stats and shares no data with the
main app — every room, draft and match there is thrown away with the next
deploy. _Tier: friend._

## Trivia

The room-link preview's card is drawn as SVG and rasterised server-side —
nothing a crawler fetches ever renders in a browser (`3310926c3`).
