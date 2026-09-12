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
- **Never commit, host, mirror, cache or proxy card images.** `.gitignore`
  refuses `*.jpg`/`*.png`/`cards/`. Browsers fetch images upstream directly; our
  server never touches them.
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
| The whole net protocol (62-method enum) | `forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java` |
| The transport seam (3 methods) | `forge-gui/src/main/java/forge/gamemodes/net/IRemote.java` |
| Server→client seam (empty interface) | `.../net/server/IToClient.java` |
| Server-side GUI proxy | `.../net/server/RemoteClientGuiGame.java` |
| Per-client visibility / hidden info | `.../net/server/DeltaSyncManager.java`, `.../net/TrackableSerializer.java` |
| View layer (214-property enum) | `forge-game/src/main/java/forge/trackable/TrackableProperty.java` |
| Draft / cube engine | `forge-gui/src/main/java/forge/gamemodes/limited/` |
| Bundled cubes | `forge-gui/res/cube/`, `forge-gui/res/draft/` |
| Headless entry points | `forge-gui-desktop/src/main/java/forge/view/Main.java` |
| Scryfall ingest | `forge-gui/src/main/java/forge/gui/download/Scryfall*.java` |
| Ability dispatch (enum of 206 class literals) | `forge-game/src/main/java/forge/game/ability/ApiType.java` |
| The whole product UI (libGDX, 103k lines) | `forge-gui-mobile/src/forge/screens/`, `FDeckEditor.java` |

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

- Does NOT ship card images or card art
- Does NOT accept money in any form
- Does NOT expose a public or anonymous tier
- Does NOT use `.env` files
