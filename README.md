# hadoku-cardtable

Cube drafting and Magic play for a small group of friends — a fork of
[Forge](https://github.com/Card-Forge/forge) for the rules engine, with the room
and networking layer from [hadoku-watchparty](https://github.com/WolffM/hadoku-watchparty)
in place of Forge's own online infrastructure.

Runs behind `hadoku.me/cardtable/` at friend tier. Unofficial, unaffiliated, and
non-commercial — see [`NOTICE.md`](NOTICE.md).

> **Status: scaffold + design.** Nothing runs yet. What exists is a verified
> analysis of the Forge codebase, an architecture, and a request to watchparty
> for the room module. Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Why this is tractable

Forge's reputation says its networking is a mess welded to the GUI. Reading the
actual source says otherwise — the full evidence is in
[`docs/FORGE_ANALYSIS.md`](docs/FORGE_ANALYSIS.md):

- The **entire** client↔server protocol is one closed enum of **62 methods**.
- The **entire** transport seam is a **3-method interface** (`IRemote`), and the
  server→client half (`IToClient`) is an *empty* interface extending it.
- The view layer is a closed enum of **214 typed properties**.
- `FServerManager` imports **zero** Swing/AWT/libGDX, and headless startup is
  regression-tested upstream.
- Per-client hidden information is **already** handled server-side.
- Cube draft is first-class, with **96 bundled cube lists**.
- `Main.java` has a `case "server":` that prints *"Not implemented."* — upstream
  left the dedicated-server slot open.

So the plan isn't "bolt networking onto Forge". It's: keep Forge's
server-authoritative model, replace its wire format at the seam Forge already
drew, and let the watchparty room layer own everything above a match.

## Plan

| Phase | What | State |
| --- | --- | --- |
| **P1** | Browser cube draft on the watchparty room layer → exports `.dck` | next |
| **P2** | Play the drafted decks in Forge desktop over Forge's netplay | — |
| **P3** | WS/JSON bridge at `IToClient`; headless Forge on hokon | — |
| **P4** | Browser play client; drop the desktop dependency | — |

Draft-first is deliberate: drafting is the social bottleneck, it's a small
protocol, and it's playable long before the bridge exists.

## Layout

```
forge/          vendored Forge fork (GPL-3.0) — see "Getting forge/" below
apps/server/    Node room + draft server
apps/ui/        React SPA
packages/shared/ Zod wire schemas shared by both ends
cubes/          cube lists
docs/           architecture, Forge analysis, licensing
docs/requests/  the ask to watchparty
```

## Getting `forge/`

`forge/` is **not tracked by this repo yet** (it's in `.gitignore`). It's
currently a plain shallow clone of upstream, used for analysis:

```bash
git clone --depth 1 https://github.com/Card-Forge/forge.git forge
```

Once `WolffM/forge` exists, this becomes a submodule pointing at the fork, with
`upstream` set to `Card-Forge/forge`. Until then there's nothing to fork *from* —
no changes have been made.

**Prerequisite not yet met:** building Forge needs Maven. hokon has none, and
upstream ships no `mvnw` wrapper (only `.mvn/maven.config`). Java 21 is present.

## Licence

**GPL-3.0-or-later**, inherited from Forge — see [`LICENSE`](LICENSE),
[`NOTICE.md`](NOTICE.md), and [`docs/LICENSING.md`](docs/LICENSING.md) for what
that does and doesn't require, plus the separate and more important question of
Wizards of the Coast's IP.

Short version: no money ever, no public access, never host card images, no WotC
trademarks in the UI.
