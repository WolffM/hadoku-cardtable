# hadoku-cardtable

Cube drafting and Magic play for a small group of friends — a fork of
[Forge](https://github.com/Card-Forge/forge) for the rules engine, with the room
and networking layer from hadoku-watchparty (a private repo)
in place of Forge's own online infrastructure.

Runs behind `hadoku.me/cardtable/` at friend tier. Unofficial, unaffiliated, and
non-commercial — see [`NOTICE.md`](NOTICE.md).

> **Status: in use.** Friends draft cubes and play constructed and drafted
> decks in the browser against each other or Forge's AI, with Forge running
> headless on the server as the rules engine. Start with
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design it grew from.

## Why this is tractable

Forge's reputation says its networking is a mess welded to the GUI. Reading the
actual source says otherwise — the full evidence is in
[`docs/FORGE_ANALYSIS.md`](docs/FORGE_ANALYSIS.md):

- The **entire** client↔server protocol is one closed enum of **60 methods**
  (45 server→client, 15 client→server).
- The **entire** transport seam is a **3-method interface** (`IRemote`), and the
  server→client half (`IToClient`) is an *empty* interface extending it.
- The view layer is a closed enum of **214 typed properties**.
- `FServerManager` imports **zero** Swing/AWT/libGDX, and headless startup is
  regression-tested upstream.
- Per-client hidden information is **already** handled server-side.
- Cube draft is first-class, with **95 bundled cube lists**.

So the approach isn't "bolt networking onto Forge". It's: keep Forge's
server-authoritative model, replace its wire format at the seam Forge already
drew, and let the watchparty room layer own everything above a match.

## Layout

```
forge/            Forge fork (GPL-3.0), a git submodule of github.com/WolffM/forge
apps/server/      Node room, draft and play server; runs Forge headless per match
apps/ui/          React SPA: lobby, draft, deck building, the play table
packages/         shared wire schemas, card data, draft and deck logic
cubes/, decks/    cube lists and preconstructed decks
docs/             architecture, Forge analysis, licensing, decisions
e2e/              Playwright specs against a real Forge
```

## Building

The app builds from a fresh clone with no credentials: Node 24 and pnpm (the
`packageManager` field pins the version), then

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The shared fleet packages it imports as `@wolffm/*` (themes, prefs, the
hadoku-watchparty room layer and others) install from the public npm registry
as `@hadoku/*`, through aliases such as
`"@wolffm/themes": "npm:@hadoku/themes@5.12.15"`. The source of those packages
lives in other repos, some private, but nothing here needs it. Running it the
way hadoku.me does needs infrastructure that is not part of this repo. The
Forge side builds from the public submodule with JDK 21 and Maven — see
[`docs/FORGE_JAR.md`](docs/FORGE_JAR.md).

## Licence

**GPL-3.0-or-later**, inherited from Forge — see [`LICENSE`](LICENSE),
[`NOTICE.md`](NOTICE.md), and [`docs/LICENSING.md`](docs/LICENSING.md) for what
that does and doesn't require, plus the separate and more important question of
Wizards of the Coast's IP.

Short version: no money ever, no public access to the app, and an
"unofficial, not affiliated with or endorsed by Wizards of the Coast"
disclaimer. Mana and set symbols come from the third-party Keyrune and Mana
fonts (licence texts in `apps/ui/src/symbols/`). Card art is loaded from
Scryfall's image CDN as a replaceable placeholder (D15); no image is ever
committed to this repo.
