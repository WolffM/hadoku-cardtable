---
title: Card Table
summary: >-
  Cube drafting and casual Magic: The Gathering, free for every signed-in
  member. A fork of Forge (the open-source rules engine) runs the actual game
  headless on the server; a browser room layer handles lobbies, drafts, chat
  and matches. No money changes hands anywhere in it.
features:
  - name: Cube drafting
    summary: "Draft a cube with up to eight seats; any empty seat is filled by a bot."
  - name: Hosting a draft
    summary: "Pick a cube and a pick timer, then let the pod's eight seats fill."
  - name: Playing a match
    summary: "Play a drafted or constructed deck against a friend or against Forge's own AI."
  - name: The deck library
    summary: "Preconstructed decks spanning Magic's Standard, Modern and Legacy history."
  - name: Match music
    summary: "Rate the music each mode plays; only friends may weigh in on a pick."
    tier: friend
  - name: Room link previews
    summary: "A shared room link unfurls in Discord with its name, mode and seated faces."
  - name: Early builds
    summary: "Friends can play the next release before it reaches the main app."
    tier: friend
trivia:
  - "The first commit (`7a2108d`) scaffolded the whole plan — a Forge fork plus a browser room layer — before a line of game code existed."
  - "445 commits landed in a single day, 2026-10-21 (fact sheet, 2026-11-16)."
  - "A private companion repo's neural draft-rating service went from a cost spike to picking live in 49 minutes, `138e8f911` to `7b2be16fc`."
  - "One commit (`f13ed39`) rewrote 1.19 million lines moving the card library forward to Pro Tour 2025's summer."
---

# Card Table

Card Table is a browser app for drafting Magic: The Gathering cubes and
playing the decks that come out of them, open to every signed-in member for
free. No sales, subs, ads or donations — see [`NOTICE.md`](../../NOTICE.md) —
and no public or anonymous access either.

Under the hood it is two processes behind one browser tab. A fork of
[Forge](https://github.com/Card-Forge/forge), the open-source Magic rules
engine, runs the real game headless on the server. A Node room layer, built
on a private companion repo's room, chat and presence code, owns everything
above a single match: lobbies, pods, presence, chat.
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) has the full design and the seam
in Forge's own code that makes a browser client possible at all.

![Card Table's Rooms panel: the Draft/Constructed filters, Create room and Create event buttons, and a grid of seeded "Testing:" rooms, most waiting for players](images/lobby.webp)

- [Features](features.md): what each part does and how to use it.
- [Contributing](contributing.md): running it locally, the build, the gates, how it ships.
- [History](history.md): the eras this became in, across two months and 5,500-odd commits.
- [Trivia](trivia.md)

## Trivia

The repo's very first commit (`7a2108d`) laid out the whole design in one
go — a Forge fork plus a browser room layer bolted onto Forge's own
server-authoritative netplay seam — before a single line of game logic
existed ([history](history.md#the-whole-plan-one-commit)).
