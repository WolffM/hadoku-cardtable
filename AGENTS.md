# hadoku-cardtable

Cube drafting + Magic play, free, for signed-in members (D24; it began as a
private friend group). Forge (GPL-3) supplies the rules engine; the
hadoku-watchparty room layer replaces Forge's online infra. Behind
`hadoku.me/cardtable/` at member tier since 2026-11-02.

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
  **One exception, `brand/discord/`** (operator, 2026-11-07): the Discord
  server icon, our own drawing, as its SVG source and the 512 px PNG Discord
  takes. `.gitignore` re-includes that one folder's PNGs; it opens nothing else.
- ~~**Our own origin never serves an image.**~~ **Repealed 2026-09-19 (D18)**
  by the operator, as stricter than needed for a private, non-commercial,
  friend-tier app. Image URLs are no longer restricted by host, and `scripts/d13-gate.sh`
  no longer checks them. `docs/LICENSING.md` §3.1 keeps the original argument.
  What still holds the licensing posture up is unchanged: **no money**, the
  **member gate** (D24; it was the friend gate), a small player base, and the disclaimer in `NOTICE.md`.
  Still enforced, for reasons that are not about copyright: **no image bytes in
  the bundle** (a 5.85 MB inlined PNG is a performance bug) and **no copied
  Scryfall `image_uris` blob** (that is what keeps art swappable).
- **A card's art is a lookup, not a URL.** The server decides every card's
  Scryfall id (`games/magic/server/src/play/art-ids.ts`) and every image a browser draws
  is `/api/art/<id>`, which redirects to our copy on `cdn.hadoku.me` (the art
  mirror, `upload-art` → `~/.local/share/cardtable/art/mirror.jsonl`) or else to
  Scryfall (`games/magic/server/src/http/card-art.ts`). `games/magic/server/src/play/art-manifest.json`
  maps `scryfallId → {source, key}` over the mirror. The art is a **placeholder**
  the operator expects to re-source, so repointing a card must stay a one-line
  data edit. A component that hardcodes an image host has broken this even if
  every URL it emits is legal.
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
- ~~**Keep the friend gate.**~~ **Keep the member gate** — amended 2026-10-30
  (**D24**) by the operator: *"we will be always free … let's just make it so
  anyone can get member status for now."* `/cardtable/*` is gated at the edge
  at member tier, and the server's own seal (`CARDTABLE_MIN_TIER`, hadoku_site's
  wrapper — not ours to flip) is member too; both moved on 2026-11-02
  (hadoku_site 20b9f8f84). `config.ts` still defaults to friend, so a wrapper
  that loses the variable fails closed. Membership is
  free and open. Never add a public or anonymous tier, not even "just for
  drafting". Friend-only features (the music review, admin writes) check their
  own tier rather than lean on the floor; making rooms, events and matches is
  rate limited per caller (`perCallerLimit`). `docs/LICENSING.md` §2 has D24.
  **One exception, a room's link preview** (operator, 2026-11-08): the edge
  serves `/cardtable/preview/room/<id>.png` publicly and reads the `.html` beside
  it, both through the kernel's `sealed` router, so Discord can unfurl a room as
  its name, its mode line and its seated faces. It opens nothing else;
  `docs/LICENSING.md` §2 has the reasoning.
- **The licence is split, not one blanket GPL.** `forge/` and everything that touches Magic stay
  GPL-3.0-or-later; new platform code (no card kit, no Forge content) is MIT by default (D26,
  2026-11-06, amending D16). Don't strip Forge's per-file copyright headers, and don't relicense a
  package by editing its `package.json` alone — `docs/LICENSING.md` has the mechanics.
- **Layer fence.** `scripts/layers/layers.json` maps every tracked source file to `platform` (MIT,
  imports platform only), `magic` (GPL, imports platform/magic/tangled), `tangled` (GPL, today's
  generic-mechanism-plus-Magic debt, an explicit list that may only shrink) or `site` (GPL for
  now, the composition roots, may import anything). `scripts/layers/ratchet.test.ts` runs in
  `pnpm run check` and fails when a new import crosses a forbidden direction, when a package's
  licence no longer matches what its files are, or when a `platform` file carries a GPL header.
  When it fails: move the Magic part next to its Magic peers, classify the importing file as Magic
  in `layers.json` if that is what it is, or put the generic part in a platform file — the failure
  message names the file and line, and `node scripts/layers/baseline.ts` is the one command that
  accepts a count once it has genuinely fallen.
- **No `.env`.** Secrets come from the vault broker through the PM2 wrapper. The
  app holds two: its stats service key and ArchiveBot's webhook secret
  (`ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET`, prod only, for release notes). Never add one
  without a vault key behind it.

## Layout

```
forge/           Forge, a git submodule of the public fork WolffM/forge
apps/server/     the site: boots Magic's server and bomberman's room type; its dist/ is what PM2 runs
apps/ui/         React SPA
packages/shared/ Zod wire schemas
packages/*       the platform packages (MIT where every file is platform)
games/magic/     Magic's own home (GPL, games/magic/LICENSE): packages/{carddata,deck,draft,forge-wire},
                 and server/ (@hadoku/magic-server: the bridge, rooms, drafts, pools, Magic's routes)
cubes/           cube lists
docs/            architecture, Forge analysis, licensing
docs/requests/   outbound asks to other repos
```

## Where things are in Forge

Paths under `forge/`, all verified:

| What | Where |
| --- | --- |
| The whole net protocol (57-method enum: 38 server→client, 16 client→server, 3 client macro calls) | `forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java` |
| The transport seam (3 methods) | `forge-gui/src/main/java/forge/gamemodes/net/IRemote.java` |
| Server→client seam (empty interface) | `.../net/server/IToClient.java` |
| Server-side GUI proxy | `.../net/server/RemoteClientGuiGame.java` |
| Per-client visibility / hidden info | `.../net/server/DeltaSyncManager.java`, `.../net/TrackableSerializer.java` |
| View layer (211-property enum) | `forge-game/src/main/java/forge/trackable/TrackableProperty.java` |
| Draft / cube engine | `forge-gui/src/main/java/forge/gamemodes/limited/` |
| Bundled cubes (97 `.dck`) and draft recipes (96 `.draft`) | `forge-gui/res/cube/`, `forge-gui/res/draft/` |
| Headless entry points | `forge-gui-desktop/src/main/java/forge/view/Main.java` |
| Scryfall ingest | `forge-gui/src/main/java/forge/gui/download/Scryfall*.java` |
| Ability dispatch (204 constants naming 201 effect classes) | `forge-game/src/main/java/forge/game/ability/ApiType.java` |
| The whole product UI (libGDX, 103k lines) | `forge-gui-mobile/src/forge/screens/`, `FDeckEditor.java` |

`forge/` is a submodule, so these commands only run in a checkout that has
it initialised. Every count in the table above comes from one of them —
run from the repo root:

```sh
# 57 protocol methods = 38 SERVER + 16 CLIENT + 3 MACRO
P=forge/forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.SERVER' $P   # 38
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.CLIENT' $P   # 16
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\(Mode\.MACRO' $P    # 3

# 97 cubes, 96 draft recipes
find forge/forge-gui/res/cube  -maxdepth 1 -type f -name '*.dck'   -printf '.' | wc -c  # 97
find forge/forge-gui/res/draft -maxdepth 1 -type f -name '*.draft' -printf '.' | wc -c  # 96

# 204 ApiType constants naming 201 distinct effect classes
A=forge/forge-game/src/main/java/forge/game/ability/ApiType.java
grep -cE '^ *[A-Za-z][A-Za-z0-9_]* *\([A-Za-z][A-Za-z0-9_]*\.class' $A  # 204
grep -oE '^ *[A-Za-z][A-Za-z0-9_]* *\(([A-Za-z][A-Za-z0-9_]*)\.class' $A \
  | sed -E 's/.*\(([A-Za-z0-9_]*)\.class/\1/' | sort -u | wc -l          # 201
```

**Count enum constants, not matching lines.** A bare `grep -c 'Mode\.'` on
`ProtocolMethod.java` returns **59**, because a `Mode.SERVER` and a `Mode.MACRO` are inside
method bodies (`ProtocolMethod.java:136,156`) — that off-by-one is where the wrong
count this table carried for two waves came from. Likewise a `.class` grep that
does not anchor on the line start counts the commented-out constant at
`ApiType.java:138`.
`docs/WASM_AND_PORTING.md` §0 has the full derivation of the ApiType numbers.

## Build prerequisites

Java 21 ✓ and Maven ✓ — **the fleet provides both, on `PATH`** (D14, amended
2026-11-02): `jdk21` and `maven` in `fleet converge-toolchain`, a Temurin JDK 21
and Maven 3.9 under `/opt/fleet-tools`, behind `/usr/local/bin/{java,javac,mvn}`
on every node, kept current by the fleet (exception, checked 2026-11-10: claw-1 has `javac` but
no `mvn`, so build Forge jars on another claw). `which javac` and `which mvn` find
them. The old user-local tarballs under `~/.local/opt` are retired: nothing
updates them, so never point anything there.

A `java` with no `javac` beside it is a JRE, not this JDK, and a stock Forge
build on it fails with `error: release version 17 not supported` — which reads
like a version mismatch and is in fact a missing compiler (D14's amendment).

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
- **Lane agents: read `docs/lanes/RULES.md` first.** It is the standing brief
  every lane works under (proof, fix quality, safety on hokon, the report); a
  lane's own brief adds to it.
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
- **Release notes accumulate in `docs/releases/pending/`.** A land that changes
  something a player can see or feel adds one file there, in the same commit:
  `<YYYY-MM-DD>-<slug>.md`, bullets under `## New` / `## Changed` / `## Fixed`, in
  the player's words (`docs/releases/pending/README.md` has the shape). Never edit
  a `docs/releases/vX.Y.Z.md` directly and never run `release.yml` yourself: the
  operator cuts a release with `/cutrelease`, which combines the pending files into
  that release's notes and runs it (`docs/RELEASE.md`).
- **Correcting a past tournament** (a playoff, a mis-scored match, a rename) goes through
  `npx tsx games/magic/server/src/cli/tournaments.ts <list|show|add|set|rm|rename|regenerate> --site prod`,
  never a hand edit of `~/srv-data/cardtable/tournaments.json`. It re-ranks the standings from the
  results with the live pods' own ranking, dry-runs unless `--write`, and backs the file up beside
  it first; the running server re-reads the file when it changes, so the tab shows it on the next
  load with no restart. Show the operator the dry run before writing.
- **No commit edits a version.** A build's version is derived from the tree
  (`scripts/release/build-version.ts`: the newest `docs/releases/vX.Y.Z.md` plus the
  commit, or `CARDTABLE_VERSION`), and `release.yml` defaults to that notes file's
  version. The `version` fields in `apps/*/package.json` are inert; never bump them.

## Does NOT

- Does NOT commit image bytes, and does NOT serve images from its own origin
- Does NOT accept money in any form
- Does NOT expose a public or anonymous tier (members only, free — D24); a room's link preview is the one public picture
- Does NOT use `.env` files

## Telemetry: where your app's data lives

What a visitor did is in monitoring-api's D1, readable with this repo's own
service key. Query it. Don't use Cloudflare Workers Logs (a normal
`wrangler login` can't read them), and don't ask the operator what a visitor
saw. If the log can't answer, add telemetry.

```sh
K=$(node -p "require('./.devvault.local.json').key")
curl -s -A "Mozilla/5.0 hadoku-agent" -H "X-User-Key: $K" \
  "https://hadoku.me/health/api/logs/query?path=/cardtable&since=2026-10-27T00:00:00Z&limit=200"
```

- **Watch it:** `node scripts/telemetry/watch.ts [--hours 24]` summarises both
  stores: new accounts, anonymous callers by agent and IP (our own egress
  excluded), the busiest accounts, rate limits, errors. It exits 2 on a gate
  breach (an anonymous caller cardtable itself answered) or a `seal-refused`.
  **It runs daily** (hadoku's crontab, 06:00 host time (Pacific), `scripts/telemetry/daily.sh`
  from the PPE tree, reading the caller key from `~/repos/hadoku-cardtable/.devvault.local.json`,
  where key rotation writes it): reports in `~/.local/state/cardtable/telemetry/`
  (`latest.txt`), and an `ALERTS` line for every day it exited non-zero. Read
  `latest.txt` and `ALERTS` at the start of a session.
- **What the server reports** (`packages/game-server/src/telemetry.ts`, one post per
  event and caller a minute, the rest counted as `suppressed`):
  `caller-first-seen` (once per account, ever), `seal-refused` (the server's
  own floor refused what the edge passed, on HTTP or any socket),
  `costly-act` / `rate-limited` (every `perCallerLimit`, named by `act`).
  A new expensive step goes through `perCallerLimit` and is covered.
  Every 5 min: `usage` (screens shown and controls pressed, counted by
  `data-testid` with ids stripped — `packages/game-ui/src/usage.ts`, so a control needs
  a testid to be counted) and `capacity` (peak sockets, rooms, drafts, matches,
  JVMs, free Forge slots, request rate and p95, event-loop stall —
  `packages/game-server/src/capacity.ts`); `capacity-refused` when a start meets the
  server's match ceiling.
- Events your code posts go to `service_events`: `POST /health/api/telemetry`
  with `context.service: "cardtable"`, read back with
  `GET /health/api/service-events?service=cardtable`. Not `console.log`.
  Browser events: POST to your own `/cardtable/api/*` route and relay from
  the backend, which holds the key.
- Only finished requests that reach the edge are logged. A UI app's page
  is served by GitHub Pages, so only its `/cardtable/api/*` calls show up; a
  tunnel app's whole prefix does.
- `user_id c8c59a87-f8af-4da7-9c99-d9e536b3fca8` is the daily automated tour
  (~09:2x UTC), not a visitor.

Params, write format, caveats: `../hadoku_site/docs/child-apps/TELEMETRY.md`.
