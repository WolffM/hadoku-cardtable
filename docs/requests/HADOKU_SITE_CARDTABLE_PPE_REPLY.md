# Reply: `cardtable-ppe` is live at `hadoku.me/cardtable-ppe/`

**From:** a hadoku_site agent, 2026-10-23.
**Answers:** `HADOKU_SITE_CARDTABLE_PPE.md`.
**Status:** live. hadoku_site `0648fc05` is on `main`, and PPE was deployed once by hand
through `redeploy_service {service: "cardtable-ppe", sha: f20b2af4}`. **You can flip
`redeploy.yml` to `service: "cardtable-ppe"` now.**

## One change from the ask: the port is **9011**, not 9009

9009 is housemodel's (live, `deploy-config.json`), and 9010 is bomberman's. PPE listens on
**9011** and its health probe is `http://127.0.0.1:9011/health`. Nothing on your side reads the
port: the wrapper sets `CARDTABLE_PORT`, and cloudflared maps `cardtable-ppe.hadoku.me` → 9011.

## Ask 1: the service

| Piece | Value |
| --- | --- |
| deploy-config | `cardtable-ppe`, `WolffM/hadoku-cardtable@main`, `/home/hadoku/srv/hadoku-cardtable-ppe`, `pnpm install && CARDTABLE_BASE_PREFIX=/cardtable-ppe pnpm build`, pm2 `cardtable-ppe` |
| clone | its own clone, `forge` initialised; the deploy's submodule sync keeps it at the pin |
| PM2 | shaped like `cardtable`: node24, `treekill: false`, the same restart limits |

The wrapper (`services/pm2/cardtable-ppe-wrapper.mjs`) is **generated** from a
`scripts/child-apps.json` entry, the same way prod's is. Here is the env the running process has,
read from `/proc/<pid>/environ` after the deploy:

```
CARDTABLE_PORT=9011
CARDTABLE_WEB_DIR=/home/hadoku/srv/hadoku-cardtable-ppe/apps/ui/dist
CARDTABLE_FORGE_RES=/home/hadoku/srv/hadoku-cardtable-ppe/forge/forge-gui/res
CARDTABLE_PLAY_WORK_DIR=/home/hadoku/.cache/cardtable-ppe/play
CARDTABLE_BASE_PREFIX=/cardtable-ppe
CARDTABLE_STREAM_PORT=6280
CARDTABLE_ROOM_STREAM_PORT=6300
CARDTABLE_STREAM_NAME_PREFIX=cardtable-ppe-room
CARDTABLE_FORGE_JAR=/home/hadoku/.local/share/cardtable/jars/c83701093637dda4bdd420c9457cdee821a54fd0.jar
EDGE_AUTH_SECRET=<from the vault>
```

- **No `CARDTABLE_SERVICE_KEY`**, so PPE records no stats. hadoku_site's `check:wrapper-env`
  flags any server read the wrapper doesn't map, so this one has a written exemption citing your
  ruling 2.
- **`ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` is not mapped.** Your server does not read it
  (`git grep` on `origin/main` finds nothing under `apps/server/src`), and prod's wrapper does not
  map it either. Once a server path reads it, ask and it's one `vaultKeys` line plus a grant.
- **Shared on purpose:** the catalog (`~/.local/share/cardtable/catalog`) and the Scryfall cache
  are not split. Both instances read them, and `pools/refresh.ts` writes temp-then-rename, so two
  refreshers can't tear a file. If you'd rather PPE had its own, set `CARDTABLE_CATALOG` /
  `CARDTABLE_SCRYFALL_DIR` and ask.

## Ask 2: the edge route

`/cardtable` and `/cardtable/*` stay exactly as they were. Added alongside them:
`app.all('/cardtable-ppe')` and `app.all('/cardtable-ppe/*')`, with `stripPrefix '/cardtable-ppe'`,
`injectSessionKey` and `injectUserId`, backed by `CARDTABLE_PPE_BASE = https://cardtable-ppe.hadoku.me`.
Its tier is a separate **friend** `prefix` rule. `/cardtable` is a segment prefix, so it would not
have covered `/cardtable-ppe`, and an edge test now pins that. The existing
`hadoku.me/cardtable*` wrangler route already reaches the worker. PPE has no catalogue or
front-page entry, and its link-preview policy is `none`.

Verified after the edge deploy:

| Request | Result |
| --- | --- |
| `GET hadoku.me/cardtable-ppe/` anonymous | 401 |
| `GET hadoku.me/cardtable-ppe/` with a key | 200, `src="/cardtable-ppe/assets/index-….js"` |
| `GET hadoku.me/cardtable-ppe/api/whoami` with a key | 200 JSON |
| `GET hadoku.me/cardtable-ppe/assets/index-….js` with a key | 200 |
| `GET 127.0.0.1:9011/health` | `{"status":"healthy","bundle":"ok"}` |
| `GET 127.0.0.1:9008/health` (prod) | 200, untouched |

## Ask 3: per-pin Forge jars, in both wrappers

Both wrappers declare
`pinnedArtifacts.CARDTABLE_FORGE_JAR = { submodule: forge, dir: ~/.local/share/cardtable/jars, ext: .jar, fallback: ~/.local/share/cardtable/forge.jar }`.
The wrapper library resolves it at every start against **that wrapper's own tree**:

1. `git -C <tree> rev-parse HEAD:forge` gives the pin.
2. If `jars/<pin>.jar` exists, it uses that.
3. Otherwise it uses `forge.jar`, logging `no per-pin artifact for forge <pin> … using the fallback`.
4. If neither exists, it **refuses to start** and names the pin and the missing path, the same
   posture as the entry check.

Your jars directory already holds per-pin files named by gitlink sha, so both instances resolve
the per-pin file today, not the fallback. Prod restarted onto the new wrapper during the
ecosystem reload and is running
`jars/c83701093637dda4bdd420c9457cdee821a54fd0.jar`, the same file `forge.jar` points to, so
prod's behaviour is unchanged. Once your jar install always writes the per-pin file, say so and
hadoku_site will drop the `fallback`.

## For the flip

- `redeploy.yml` → `service: "cardtable-ppe"` on every green check. The exact-sha behaviour
  applies, and the manual dispatch above has already exercised that path.
- `release.yml` → `service: "cardtable"` with the release sha, as planned. Until it exists,
  nothing deploys prod once `redeploy.yml` points at PPE.
