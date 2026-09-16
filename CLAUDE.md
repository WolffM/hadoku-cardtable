# hadoku-cardtable

Cube drafting + Magic play for a private friend group. Forge (GPL-3) supplies the
rules engine; the hadoku-watchparty room layer replaces Forge's online infra.
Behind `hadoku.me/cardtable/` at friend tier.

**Read `docs/ARCHITECTURE.md`, `docs/FORGE_ANALYSIS.md` and
`docs/WASM_AND_PORTING.md` before touching anything.** They're short, and they're the result of reading the actual Forge
source rather than its reputation.

## Critical rules

- **No money, ever.** No sales, subs, ads, donations, sponsorship, "buy me a
  coffee". This is the single brightest legal line — see `docs/LICENSING.md`.
- **Card art lives on `cdn.hadoku.me`; image bytes never enter this repo.**
  Changed 2026-09-15 by the operator (**D15**, superseding D13's image clause).
  Until then this rule read *"never commit, host, mirror, cache or proxy card
  images"* — `docs/LICENSING.md` §3.1 keeps that argument and records why it was
  overruled. Do not restore the old rule from a stale comment.
  `.gitignore` still refuses `*.jpg`/`*.png`/`cards/`, and that half is absolute.
- **Our own origin never serves an image.** Every art URL is absolute, at
  `cdn.hadoku.me` or `cards.scryfall.io` — never relative, never `/cardtable/…`.
  That would make the app server the image host, which is the thing D15 did
  *not* change. `scripts/d13-gate.sh` fails CI on it.
- **A card's art is a lookup, not a URL.** `apps/ui/src/draft/art-manifest.json`
  maps `scryfallId → {source, key}`; `packages/carddata/src/art/index.ts`
  resolves it. The art is a **placeholder** the operator expects to re-source, so
  repointing a card must stay a one-line data edit. A component that hardcodes an
  image host has broken this even if every URL it emits is legal.
- **No WotC trademarks in the UI** — no mana symbols, set symbols, tap symbol,
  card frames, Magic wordmark. Draw our own.
- **Keep the friend gate.** `/cardtable/*` is friend-tier at the edge. Never add
  a public or anonymous tier, not even "just for drafting".
- **GPL-3.0-or-later** applies to this whole repo (we vendored Forge). Don't
  strip Forge's per-file copyright headers.
- **No `.env`.** Secrets, if any ever exist, come from the vault broker. This app
  should hold none.

## Layout

```
forge/           vendored Forge fork — gitignored until WolffM/forge exists
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

`forge/` is gitignored until the fork exists, so these commands only run in a
checkout that has it. Every count in the table above comes from one of them —
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

Java 21 ✓. **Maven ✗** — hokon has no `mvn` and upstream ships no `mvnw`
(only `.mvn/maven.config`). Install Maven before attempting a Forge build.

## Working agreements

- Facts about Forge go in `docs/FORGE_ANALYSIS.md` **with the file they came
  from**. If something wasn't checked, say so — that doc distinguishes verified
  from assumed on purpose, and the distinction has already caught one wrong
  assumption (P1's Forge-independence).
- Don't modify `forge/` until the fork exists. Right now it's stock upstream and
  keeping it that way is what makes forking clean.

## Does NOT

- Does NOT commit image bytes, and does NOT serve images from its own origin
- Does NOT accept money in any form
- Does NOT expose a public or anonymous tier
- Does NOT use `.env` files
