# Request to hadoku_site: a PPE environment for cardtable

**From:** hadoku-cardtable, 2026-10-23
**Plan:** `hadoku-cardtable/docs/planning/release-process.md`

The operator wants prod and PPE separated: *"by default all our dev work should go to main and
auto-deploy to ppe. the main production environment in cardtable should only get updated by manual
release deployments."* Rulings: PPE at `hadoku.me/cardtable-ppe/`, **friend tier** (never public), and
it records no shared game stats.

cardtable's side: `redeploy.yml` will send `redeploy_service` with `service: "cardtable-ppe"` on every
green check, and a manual `release.yml` will send `service: "cardtable"` with a release tag's sha. The
existing exact-sha behaviour applies to both. **cardtable will not flip its auto-deploy to
`cardtable-ppe` until you confirm PPE is live**, so nothing changes for prod until then.

## Ask 1: the `cardtable-ppe` service

- **`services/mgmt-api/deploy-config.json`:** a second entry next to `cardtable`.
  - `name: cardtable-ppe`, `repo: WolffM/hadoku-cardtable`, `branch: main`
  - `localPath: /home/hadoku/srv/hadoku-cardtable-ppe` (a separate clone, with the `forge` submodule
    initialised like prod's)
  - `buildCommand: pnpm install && CARDTABLE_BASE_PREFIX=/cardtable-ppe pnpm build`. The UI's Vite
    `base` reads that variable; unset, it stays `/cardtable/`.
  - `pm2Service: cardtable-ppe`, health `http://127.0.0.1:9009/health`
- **`services/pm2/cardtable-ppe-wrapper.mjs`:** the same shape as `cardtable-wrapper.mjs`, with this env:

  | Var | Value | Why |
  | --- | --- | --- |
  | `CARDTABLE_PORT` | `9009` | |
  | `CARDTABLE_BASE_PREFIX` | `/cardtable-ppe` | the server's prefix arithmetic (`apps/server/src/config.ts:42`) |
  | `CARDTABLE_PLAY_WORK_DIR` | `~/.cache/cardtable-ppe/play` | **required.** The play pool boot-sweeps its work dir; sharing prod's `/tmp/cardtable-play` would kill prod's live matches on every PPE restart |
  | `CARDTABLE_STREAM_PORT` / `CARDTABLE_ROOM_STREAM_PORT` | `6280` / `6300` | prod uses 6080+ / 6100+ |
  | `CARDTABLE_STREAM_NAME_PREFIX` | `cardtable-ppe-room` | docker container names must not collide with prod's |
  | `CARDTABLE_WEB_DIR`, `CARDTABLE_FORGE_RES` | under the PPE tree | |
  | `EDGE_AUTH_SECRET` | same as prod | |
  | `CARDTABLE_SERVICE_KEY` | **not set** | its only use is game-stats recording; unset = PPE records nothing (ruling 2) |
  | `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` | set (from the ArchiveBot handoff) | PPE won't post release notes, but it may post to a test channel |

  Rooms, drafts, tournaments, sounds and logs need nothing: they resolve under each tree's
  `apps/server/` (`config.ts:18-22`).

## Ask 2: the edge route

`/cardtable-ppe/*` at **friend** tier, with `stripPrefix '/cardtable-ppe'`, to a new tunnel host
`cardtable-ppe.hadoku.me` → `127.0.0.1:9009`. Mirror the `cardtable.hadoku.me` row in
`docs/ROUTES.md:221` (`CARDTABLE_PPE_BASE`). It needs no catalogue or front-page entry: PPE is reached
by URL, not listed.

## Ask 3: per-pin Forge jars in both wrappers

Both wrappers point at `~/.local/share/cardtable/forge.jar` today, a link flipped by hand after a pin
lands. PPE runs main's Forge pin and prod runs its release's pin, so each wrapper should resolve
`~/.local/share/cardtable/jars/<forge-sha>.jar`, where `<forge-sha>` is
`git -C <tree> rev-parse HEAD:forge`. It should fail loudly (entryCheck-style hint) when that jar is
missing. cardtable will make its jar install write the per-pin file. Until it does, falling back to
`forge.jar` when the per-pin file is absent keeps prod unchanged.

## Done when

- `https://hadoku.me/cardtable-ppe/` serves the app behind the friend gate, and
  `http://127.0.0.1:9009/health` answers, while prod on 9008 is untouched.
- A manual `redeploy_service {service: "cardtable-ppe", sha}` dispatch deploys that sha to PPE.
- Reply in `hadoku-cardtable/docs/requests/HADOKU_SITE_CARDTABLE_PPE_REPLY.md`. cardtable then flips
  its auto-deploy.
