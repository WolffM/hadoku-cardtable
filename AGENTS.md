# hadoku-cardtable

Cube drafting + Magic play for a private friend group. Forge (GPL-3) supplies the
rules engine; the hadoku-watchparty room layer replaces Forge's online infra.
Behind `hadoku.me/cardtable/` at friend tier.

**Read `docs/ARCHITECTURE.md`, `docs/FORGE_ANALYSIS.md` and
`docs/WASM_AND_PORTING.md` before touching anything.** They're short, and they're the result of reading the actual Forge
source rather than its reputation.

**The post-alpha goal lives in `docs/planning/games-platform-vision.md`** — the
operator's own words on making cardtable and bomberman parallel games
(standalone, inside watchparty, on the games host) with shared stats. Read it
before planning cross-game work.

## Critical rules

- **No money, ever.** No sales, subs, ads, donations, sponsorship, "buy me a
  coffee". This is the single brightest legal line — see `docs/LICENSING.md`.
- **Card art lives on `cdn.hadoku.me`; image bytes never enter this repo.**
  Changed 2026-09-15 by the operator (**D15**, superseding D13's image clause).
  Until then this rule read *"never commit, host, mirror, cache or proxy card
  images"* — `docs/LICENSING.md` §3.1 keeps that argument and records why it was
  overruled. Do not restore the old rule from a stale comment.
  `.gitignore` still refuses `*.jpg`/`*.png`/`cards/`, and that half is absolute.
  Since 2026-10-03 that includes wave evidence screenshots under `docs/`: the
  old `!docs/**/*.png` exception is gone, and the 60 that were tracked were
  deleted on 2026-10-11. Never `git add -f` one.
- ~~**Our own origin never serves an image.**~~ **Repealed 2026-09-19 (D18)**
  by the operator, as stricter than needed for a private, non-commercial,
  friend-tier app. Image URLs are no longer restricted by host, and `scripts/d13-gate.sh`
  no longer checks them. `docs/LICENSING.md` §3.1 keeps the original argument.
  What still holds the licensing posture up is unchanged: **no money**, the
  **friend gate**, a handful of players, and the disclaimer in `NOTICE.md`.
  Still enforced, for reasons that are not about copyright: **no image bytes in
  the bundle** (a 5.85 MB inlined PNG is a performance bug) and **no copied
  Scryfall `image_uris` blob** (that is what keeps art swappable).
- **A card's art is a lookup, not a URL.** `apps/ui/src/draft/art-manifest.json`
  maps `scryfallId → {source, key}`; `packages/carddata/src/art/index.ts`
  resolves it. The art is a **placeholder** the operator expects to re-source, so
  repointing a card must stay a one-line data edit. A component that hardcodes an
  image host has broken this even if every URL it emits is legal.
- ~~**No WotC trademarks in the UI**~~ — **amended 2026-09-27 (D20)** by the
  operator, who chose established third-party symbol fonts over drawing our
  own. **Mana symbols, the tap symbol
  and set symbols ship from Keyrune (GPL-3.0 glyphs, OFL font) and Mana (OFL
  font)** — third-party fonts, never WotC's own files, and never
  `svgs.scryfall.io`. `docs/LICENSING.md` §3.2 records what each licence
  actually says, because the two packs differ.
  **Still forbidden:** the WotC logo, the Magic wordmark, card frames. Also
  still true: do not ship `mplantin` from the Mana pack (Monotype's typeface,
  a different question, and we need none of it) and do not rename either font
  (OFL reserved-font-name).
- **Keep the friend gate.** `/cardtable/*` is friend-tier at the edge. Never add
  a public or anonymous tier, not even "just for drafting".
- **GPL-3.0-or-later** applies to this whole repo (we vendored Forge). Don't
  strip Forge's per-file copyright headers.
- **No `.env`.** Secrets, if any ever exist, come from the vault broker. This app
  should hold none.

## Layout

```
forge/           Forge, a git submodule of the public fork WolffM/forge
apps/server/     Node room + draft server
apps/ui/         React SPA
packages/shared/ Zod wire schemas
cubes/           cube lists
docs/            architecture, Forge analysis, licensing
docs/requests/   outbound asks to other repos
```

## Where things are in Forge

Paths under `forge/`, all verified:

| What | Where |
| --- | --- |
| The whole net protocol (60-method enum: 45 server→client, 15 client→server) | `forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java` |
| The transport seam (3 methods) | `forge-gui/src/main/java/forge/gamemodes/net/IRemote.java` |
| Server→client seam (empty interface) | `.../net/server/IToClient.java` |
| Server-side GUI proxy | `.../net/server/RemoteClientGuiGame.java` |
| Per-client visibility / hidden info | `.../net/server/DeltaSyncManager.java`, `.../net/TrackableSerializer.java` |
| View layer (214-property enum) | `forge-game/src/main/java/forge/trackable/TrackableProperty.java` |
| Draft / cube engine | `forge-gui/src/main/java/forge/gamemodes/limited/` |
| Bundled cubes (95 `.dck`) and draft recipes (94 `.draft`) | `forge-gui/res/cube/`, `forge-gui/res/draft/` |
| Headless entry points | `forge-gui-desktop/src/main/java/forge/view/Main.java` |
| Scryfall ingest | `forge-gui/src/main/java/forge/gui/download/Scryfall*.java` |
| Ability dispatch (202 constants naming 199 effect classes) | `forge-game/src/main/java/forge/game/ability/ApiType.java` |
| The whole product UI (libGDX, 103k lines) | `forge-gui-mobile/src/forge/screens/`, `FDeckEditor.java` |

`forge/` is a submodule, so these commands only run in a checkout that has
it initialised. Every count in the table above comes from one of them —
run from the repo root:

```sh
# 60 protocol methods = 45 SERVER + 15 CLIENT
P=forge/forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.SERVER' $P   # 45
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.CLIENT' $P   # 15

# 95 cubes, 94 draft recipes
find forge/forge-gui/res/cube  -maxdepth 1 -type f -name '*.dck'   -printf '.' | wc -c  # 95
find forge/forge-gui/res/draft -maxdepth 1 -type f -name '*.draft' -printf '.' | wc -c  # 94

# 202 ApiType constants naming 199 distinct effect classes
A=forge/forge-game/src/main/java/forge/game/ability/ApiType.java
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\([A-Za-z][A-Za-z0-9_]*\.class' $A  # 202
grep -oE '^ *[A-Za-z][A-Za-z0-9_]* *\(([A-Za-z][A-Za-z0-9_]*)\.class' $A \
  | sed -E 's/.*\(([A-Za-z0-9_]*)\.class/\1/' | sort -u | wc -l          # 199
```

**Count enum constants, not matching lines.** A bare `grep -c 'Mode\.'` on
`ProtocolMethod.java` returns **61**, because one `Mode.SERVER` is inside a
method body (`ProtocolMethod.java:136`) — that off-by-one is where the wrong
count this table carried for two waves came from. Likewise a `.class` grep that
does not anchor on the line start counts the commented-out constant at
`ApiType.java:137`.
`docs/WASM_AND_PORTING.md` §0 has the full derivation of the ApiType numbers.

## Build prerequisites

Java 21 ✓ and Maven ✓ — **both are installed, and both are deliberately off
`PATH`.** Wave 1 put them under `~/.local/opt` per D14 (no sudo, no host
mutation): Temurin **JDK 21** and Maven **3.9.16**. `scripts/spike/run.sh`
resolves them; a bare `which mvn` or `which javac` finds nothing and has now
misled two separate sessions into reporting a missing toolchain.

**Before concluding the toolchain is absent, look in `~/.local/opt`.** The JRE
that *is* on `PATH` has no `javac` and no `lib/ct.sym`, so a stock Forge build
fails with `error: release version 17 not supported` — which reads like a
version mismatch and is in fact a missing compiler (D14's amendment).

**In a wave worktree, jar suites and e2e need env the worktree does not have**
(Node 24, `CARDTABLE_FORGE_JAR`, `CARDTABLE_FORGE_RES` from the main checkout's
pinned `forge/`, a per-lane `CARDTABLE_PLAY_WORK_DIR`). Without it every jar spec
skips and exits 0. `docs/WAVE_WORKTREE.md` has the working block and the
scaffolding still to build. Read it before scaffolding or managing a wave.

## Working agreements

- Facts about Forge go in `docs/FORGE_ANALYSIS.md` **with the file they came
  from**. If something wasn't checked, say so — that doc distinguishes verified
  from assumed on purpose, and the distinction has already caught one wrong
  assumption (P1's Forge-independence).
- Don't modify `forge/` until the fork exists. Right now it's stock upstream and
  keeping it that way is what makes forking clean.
- **Concurrent work: claims.** Several sessions and lanes work this repo at once.
  Before touching an area (a path, a glob, or a topic like `cost-payment`), run
  `scripts/lanes/claim.sh list`, then `scripts/lanes/claim.sh claim <area> <you> [note]`;
  it refuses (exit 1, naming the holder) when someone else's claim overlaps, and
  then you report instead of colliding. `release <area|--all> <you>` when done.
  The file is host-wide (`~/.local/state/cardtable/claims.tsv`); claims older
  than 24 h list as stale and stop blocking.
- **Waiting on CI and landing.** Wait for a run with ONE background
  `scripts/lanes/watch-run.sh <run-id>`, never a poll loop in your own context.
  `scripts/lanes/prove-and-land.sh <worktree> -f only=… -f specs=…` rebases onto
  origin/main, proves that exact HEAD on the claws, and lands only on green. A new
  ledger row in a landing commit is `| AF??? |`; `scripts/land.sh` numbers it.

## Does NOT

- Does NOT commit image bytes, and does NOT serve images from its own origin
- Does NOT accept money in any form
- Does NOT expose a public or anonymous tier
- Does NOT use `.env` files
