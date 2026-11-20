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
draft moving.

Cogwork Librarian works as printed: it is drafted face up, where the whole
table sees it beside its drafter's name, and on a later pack its drafter
presses its name, then two cards, to take both and put the Librarian into
that pack for the next seat.

**What it does not do.** The other 23 cards that change a draft (Lore
Seeker, Canal Dredger, Agent of Acquisitions and the rest of Conspiracy's)
draft as ordinary cards; none is in a cube offered today. Bots never use a
Librarian they draft. Only the 97 cube lists carried over from Forge's
own bundle are offered (`AGENTS.md`) — nothing builds a cube from an
arbitrary card pool, and nothing asks a human or Scryfall for picks beyond
those lists.

## Hosting a draft

**What it does.** Any member can open a pod: pick a cube and a pick timer,
then wait for its eight seats to fill, or let bots take the rest.

**How to use it.** Click **Create room** in the lobby and set **Game type**
to **Draft**, then open the room. Its leader picks a cube from the **Cube**
tab, then turns the pick timer on and sets its speed (½×, 1×, 2× or 4×) in
the room's match rules before the pod deals.

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

## Room link previews

**What it does.** Pasting a room's link into Discord, or any app that
unfurls links, shows a generated card: the room's name, its format and
mode, and the seated players' faces. A 1v1 room is its host against the
other seat, or a dashed "You?" while that seat is open; a tournament or a
draft is its whole field, open seats dashed.

**How to use it.** Nothing to click; it happens automatically whenever a
room link is shared.

**What it does not do.** A room with a password, a testing room, and a room
that does not exist all answer with the same plain 404 — the preview never
shows more than the room's own members would see.

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
