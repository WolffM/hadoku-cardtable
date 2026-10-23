# Release process: PPE and prod

The operator's words are quoted verbatim. **Design** is ours and may change. The quotes and rulings may not.

## The ask (2026-10-23, verbatim)

> regarding the patch notes, i would like it if we started working on a new release process. i want a
> seperated prod and ppe environment. by default all our dev work should go to main and auto-deploy to
> ppe.
>
> the main production environment in cardtable should only get updated by manual release deployments.
>
> whenever we cut a new release is also when we should generate patch notes. does that make sense?

## Rulings (2026-10-23, "go with your recommendations on all three")

1. **PPE lives at `hadoku.me/cardtable-ppe/`, friend tier.** Friends can try upcoming builds. It's
   gated the same as prod, never public.
2. **PPE records no shared game stats.** Its matches are test traffic. Rooms, drafts and tournaments
   are separate per environment anyway (each deploy tree has its own `data/`).
3. **A release has one product version, `vX.Y.Z`.** The per-package `ui 0.32.x / server 0.32.x`
   bumps stay as build numbers.

## The shape

```
dev work ──► main ──► CI check green ──► redeploy.yml ──► cardtable-ppe   (automatic, every green sha)
                                                              │
operator: "cut a release" ──► scripts/release/collect.ts ──► agent drafts docs/releases/vX.Y.Z.md
                                                              │  operator edits, lands it on main
                                                              ▼
                              release.yml (manual) ──► tag release/vX.Y.Z ──► cardtable (prod)
                                                              │
                                              prod boots vX.Y.Z ──► ArchiveBot posts the notes
```

- **PPE** is what `main` is. It's the old prod behaviour under a new name: every green `check`
  deploys its exact sha (`redeploy.yml`), with no other gate.
- **Prod** moves only when `release.yml` runs. It takes a version and an optional sha (default:
  the PPE-deployed head). It refuses unless that sha's `check` is green and `docs/releases/vX.Y.Z.md`
  exists at it. Then it tags `release/vX.Y.Z` and dispatches `redeploy_service` for `cardtable`
  with that sha, the same exact-sha path deploys already use.
- **Patch notes are written for players, at the cut.** Commit subjects are engineering prose. The
  source is the playtest ledger: every AF row has a player-facing "what you'll see" column, and the
  range's new or changed rows are exactly the release's content. `collect.ts` gathers the rows
  and commit subjects since the previous `release/*` tag. An agent writes `docs/releases/vX.Y.Z.md`
  from them in plain language, the operator edits it, and it lands on main like any doc (a docs-only
  change doesn't redeploy PPE).
- **The announcement rides with the deploy.** When prod boots on a release whose notes it hasn't
  announced, it posts them through ArchiveBot (`/api/messages/send` with embeds; idempotency key
  `cardtable-release-vX.Y.Z`) and records that in its `data/`. PPE has no announce channel
  configured and never posts. A posting failure is logged and retried next boot, and never blocks
  serving. This waits on ArchiveBot Asks 1–2 and the hadoku_site secret
  (`docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION.md`).

## Isolation: what each environment gets

| Thing | prod (`cardtable`) | PPE (`cardtable-ppe`) | How |
| --- | --- | --- | --- |
| Deploy tree | `~/srv/hadoku-cardtable` | `~/srv/hadoku-cardtable-ppe` | deploy-config entry |
| Port | 9008 | 9011 (9009 is housemodel's, 9010 bomberman's) | wrapper `CARDTABLE_PORT` |
| URL | `/cardtable/` | `/cardtable-ppe/` | edge route; `CARDTABLE_BASE_PREFIX` at build (Vite `base`) and at run (server) |
| rooms / drafts / tournaments / sounds / logs | tree's `apps/server/{data,logs}` | same, in its own tree | automatic: `config.ts` resolves them under the package root |
| Forge run dirs | `/tmp/cardtable-play` (today) | `~/.cache/cardtable-ppe/play` | wrapper `CARDTABLE_PLAY_WORK_DIR`. **Must differ:** the pool boot-sweeps its work dir, so sharing it kills the other instance's matches |
| Stream ports / container names | 6080+, 6100+, `cardtable-room` | 6280+, 6300+, `cardtable-ppe-room` | wrapper `CARDTABLE_STREAM_PORT`, `CARDTABLE_ROOM_STREAM_PORT`, `CARDTABLE_STREAM_NAME_PREFIX` |
| Game stats | recorded | not recorded | PPE's wrapper passes no `CARDTABLE_SERVICE_KEY`, its only consumer (`config.ts` `statsServiceKey`) |
| Catalog, Scryfall cache | shared | shared | read-only caches under `~/.local/share/cardtable` |
| Forge jar | its release's pin | main's pin | per-pin jars, below |

**Per-pin jars.** One `~/.local/share/cardtable/forge.jar` serves prod today. Its switch is a symlink
flip done after a pin lands. With two environments on two pins, each wrapper resolves
`~/.local/share/cardtable/jars/<forge-sha>.jar` from its own tree's `forge` gitlink. A pin landing on
main then reaches PPE automatically, and reaches prod at the release that includes it. The jar
install step writes the per-pin file instead of flipping a shared link.

## Who does what

| Where | Change | State |
| --- | --- | --- |
| hadoku_site | `cardtable-ppe` deploy-config entry, PM2 wrapper, edge route `/cardtable-ppe/*` (friend), tunnel host; per-pin jar resolution in both wrappers | **done** 2026-10-23, hadoku_site `0648fc05` (`docs/requests/HADOKU_SITE_CARDTABLE_PPE_REPLY.md`) |
| cardtable | Vite `base` from `CARDTABLE_BASE_PREFIX` (app and embed builds) | **done** `a90b319a` |
| cardtable | `scripts/release/collect.ts`, `.github/workflows/release.yml`, `docs/RELEASE.md` | **done** `a90b319a` |
| cardtable | `redeploy.yml` dispatches `cardtable-ppe` instead of `cardtable` | **done** with v0.33.0's notes; `build-jar.sh` lost `--switch` (each wrapper loads its own pin's jar) |
| cardtable | announce-on-boot through ArchiveBot | after ArchiveBot Asks 1–2 |

## Cutover

1. hadoku_site brings up `cardtable-ppe`, deployed by hand from current main. Confirm
   `hadoku.me/cardtable-ppe/` serves and `/health` answers on 9011. **Done 2026-10-23** (hadoku_site `0648fc05`, reply `docs/requests/HADOKU_SITE_CARDTABLE_PPE_REPLY.md`).
2. One commit lands the `redeploy.yml` flip together with `docs/releases/v0.33.0.md` ("first
   versioned release"). From then on main only reaches PPE.
3. Run `release.yml` for **v0.33.0** at that commit. The notes have to be on the sha being
   released, which is why they land in step 2. It's the first `release/*` tag, so the next
   release's `collect.ts` has a base.
4. Lane and landing docs (`scripts/land.sh` comments, `docs/WAVE_WORKTREE.md`, memory notes
   that say "prod deploys every green sha") are updated in the step 2 commit.
