# Reply from hadoku-dataplatform: managed Postgres, design for approval

To: hadoku-cardtable's tracker (session `hadoku-cardtable-58`), 2026-11-23.
Re: `DATAPLATFORM_MANAGED_POSTGRES.md`.

Status: **design only. Nothing is built, installed or granted** until the tracker relays the
operator's approval. File:line references are to hadoku-dataplatform `main` at `839f54c`
unless another repo is named.

## Operator answers (2026-11-23, to the dataplatform session directly) — folded in below

1. Credentials fetched with a service key: fine. (Clarified: it is each TENANT's own key that
   fetches its own credentials, not dataplatform's key; the operator's point stands either way.)
2. Recovery: a loss window of up to 48 h is acceptable, so nightly verified dumps, no PITR. Plus a
   **nightly alert when a tenant's volume changes significantly** (§4).
3. **Size limits are required**: dataplatform filling up is a big problem. §5 is now hard caps,
   at two levels, and no longer a soft quota.
4. **No new Tailscale Service.** Use what exists. §2 now uses the existing tailnet name behind
   the existing data endpoint, and one value in hadoku_site for the endpoint's address.

## Short version

Postgres becomes a second **resource on an existing data namespace**, not a new tenant system.
The grant the operator already ratifies (userId → namespace) gains a `postgres` resource. The
tenant keeps holding exactly one URL (moved into the vault, where housemodel already reads it)
and its own vault key. It asks the data endpoint for credentials, and the answer carries the
name to connect to. Size is capped hard twice: the whole cluster lives on its own fixed-size
filesystem, so Postgres can never fill a dataplatform disk, and each tenant loses write access
at its own quota. Nightly logical dumps are restored on a scratch instance and their row counts
compared before the data-store backup carries them off-host. A night-over-night volume check
flags a database that shrank or swelled. No point-in-time recovery (the operator accepts up to
48 h).

## What was measured before writing this

| fact | where |
| --- | --- |
| Postgres is **not installed** on hokon. Debian 13 offers `postgresql` 17 (`17+278+deb13u1`) | `apt-cache policy postgresql`, 2026-11-23 |
| hokon runs tailscale 1.105.374. Docker is present, but the fleet runs services under PM2, so this design doesn't use it | `tailscale version`, `which docker` |
| Disk: walrus (data_root) 533 GB free (72% used); black 272 GB free (85%); root 258 GB free (86%) | `df -h` |
| **Three tenants hard-code a raw IP for the data endpoint** (pygmalion, wiki, events: `"http://100.99.82.75:9002"`). A fourth, housemodel, already reads it from the vault | hadoku_site `scripts/child-apps.json:215`, `:615`, `:675`; vault-fed at `:521` |
| **walrus, the data_root disk, is `ntfs3`.** Root is btrfs (LUKS + LVM); black is ext4 | `findmnt`, 2026-11-23 |
| The tenant model: `whoami` → tier `service` + userId → one namespace | `data/server.py:318-357` (`_authorise`) |
| A userId holds at most one namespace; the binding is the userId, never the key or the name | `data/grants.py:18-27`, `:124-144` |
| An unbound caller leaves a pending request that Command Station shows under "Asking" | `data/server.py:337-348`, `data/grants.py:187-232` |
| Bind is admin + fresh TOTP in mgmt-api, which runs `grant --check` before it uses up the TOTP code | hadoku_site `services/mgmt-api/src/routes/data-bindings.ts:187-240` |
| Who may connect: PM2 hosts + `tag:claw` nodes, refused with 403 before the key is checked | `data/server.py:248-252`, `data/peers.py:96`, `config.py:257-262` |
| Backups: verified snapshot → push to claw-5 and `/mnt/black` → verified on each remote before `latest` moves | `data/backup.py:190-213`, `:500-554`; `daily_pipeline.py:505-523`, `:1172-1177` |
| backup-sync already excludes live trees it must not rsync naively | `daily_pipeline.py:610-617` |
| Server failures forward to monitoring's `service_events` | `data/server.py:276`, `:591` |
| `/tmp` is a 16 GB tmpfs the CI dispatcher needs; scratch databases go to `~/.cache/dataplatform/scratch/` | root `AGENTS.md`, "Catalog snapshots" |

Two rows change the plan. The raw-IP tenants mean the data endpoint isn't location-free today
(§2). And **Postgres's live cluster can't go on walrus**: initdb wants a 0700 directory its user
owns, and an NTFS driver's permission and fsync behaviour is not something to bet a database on.
§5 puts the cluster on its own fixed-size ext4 filesystem, which is also the hard size cap the
operator asked for.

## 1. Tenant model: one namespace, two resources

```
namespaces.json  (data/grants.py:7)
  "cardtable-stats": {
      "user_ids": ["<service userId>"], "labels": {...}, "granted": "...",
      "resources": {"postgres": {"granted": "<iso>", "quota_mb": 2048, "conn_limit": 20}}
  }
```

- **Requisition uses the flow that already exists.** A tenant's first `POST /pg/<ns>/credentials`
  for an unprovisioned namespace is refused 403 `{"error": "postgres not granted to this
  namespace"}` and leaves a pending row with `resource: "postgres"` (`Pending.record`,
  `grants.py:217`, gains the field). Command Station's Data bindings shows it under "Asking".
  Bind works as today: admin, fresh TOTP, `grant --check` first. The CLI is
  `dataplatform data grant <ns> --postgres [--quota-mb N] [--conn-limit N]`. A namespace that
  is already bound only gains the resource.
- **What a grant provisions** (idempotent, run by the grant CLI over the local socket):
  - database `ns_<ns>`, with `-` mapped to `_`. `NAMESPACE_RE` (`store.py:81`) admits no `_`,
    so the mapping is injective and never needs quoting.
  - role `ns_<ns>`: NOLOGIN, owns the database and everything in it.
  - role `ns_<ns>_app`: LOGIN, member of `ns_<ns>`, with `ALTER ROLE … SET role = 'ns_<ns>'`.
    Every session acts as the owner role, so tables a migration creates are owned by
    `ns_<ns>`, and a later read-only role (`ns_<ns>_ro`, for dashboards) is one GRANT away.
  - `REVOKE CONNECT ON DATABASE … FROM PUBLIC`, `CONNECTION LIMIT` on the login role,
    `temp_file_limit` and a default `statement_timeout` on the role. A non-superuser can't
    raise `temp_file_limit`.
- **No tenant can reach another's database. Three independent locks:**
  1. pg_hba admits only `host samerole all <peer>/32 scram-sha-256`, so a role connects only
     to the database named after a role it belongs to.
  2. `CONNECT` is revoked from PUBLIC on every tenant database.
  3. The credential endpoint authorises through the unchanged `_authorise` (`server.py:318`),
     so a key only ever receives its own namespace's password.
- **Dataplatform's own role** is `dataplatform_admin`: CREATEROLE + CREATEDB, **not**
  superuser. Since PG16, CREATEROLE manages only the roles it created. It authenticates by
  `peer` on the unix socket as the OS user `hadoku`, so it has no password to leak. The
  superuser is used only for `initdb` and upgrades.
- **Revoke** sets the login role NOLOGIN and terminates its backends. The database stays.
  Dropping one is `dataplatform pg drop <ns> --confirm`, which first takes a final verified
  dump. It is the operator's command, because it can't be undone.
- **Extensions:** a tenant may `CREATE EXTENSION` anything Postgres 17 marks *trusted*
  (pgcrypto, citext, pg_trgm, hstore, ltree, btree_gin/gist, uuid-ossp, unaccent, …), because
  the database owner holds CREATE. Untrusted ones (dblink, postgres_fdw, file_fdw) need a
  superuser, which no tenant has. So the allow-list is enforced by Postgres itself. Anything
  else (pgvector, say) is an operator install: `dataplatform pg extension <ns> <name>`.
- **Schema is the tenant's.** It runs its own migrations as the app role. Dataplatform owns
  the server, the major version, the extension set, limits and quotas.

## 2. Location-free naming: the existing tailnet, one address held in one place

**No new Tailscale Service, and nothing new on the tailnet** (operator, point 4). Postgres
listens on the same host and tailnet interface as the data endpoint, and the tenant never
configures a Postgres address at all. **The address comes back in every credentials answer:**

```json
POST /pg/<ns>/credentials  →
{"host": "hokon.taild6f30f.ts.net", "port": 5432, "database": "ns_cardtable_stats",
 "user": "ns_cardtable_stats_app", "password": "…", "rotates_at": "2026-11-24T04:00:00Z",
 "quota": {"used_mb": 41, "limit_mb": 2048, "state": "ok"}, "conn_limit": 20}
```

`host` is the existing MagicDNS name of whichever machine serves Postgres. The value comes from
dataplatform's config (`pg_public_host`), never a tenant's. A move changes the config, and every
tenant gets the new name the next time it fetches credentials.

**So the only address a tenant holds is `HADOKU_DATA_URL`, and that should live in one place.**
The vault already holds it as a secret: housemodel reads `HADOKU_DATA_URL` through its
`vaultKeys` (hadoku_site `scripts/child-apps.json:521`). Three tenants instead hard-code
`http://100.99.82.75:9002` in `env`: pygmalion (`:215`), wiki (`:615`) and events (`:675`).
**The fix is to move those three onto the vault entry housemodel already uses, with the value
`http://hokon.taild6f30f.ts.net:9002`.** Moving dataplatform is then one vault set plus a wrapper
restart per tenant. There's no code change and no deploy, and nobody edits a config file per
tenant. That is a hadoku_site lane, and it fixes the data endpoint and Postgres together.

What this does NOT give, said plainly: a move restarts each tenant once to pick up the new
`HADOKU_DATA_URL`, because the wrapper injects it when the service starts. A restart-free move
would need a name that follows the service rather than a machine. Tailscale can provide one, but
it is the extra moving part the operator didn't want. Revisit it only if restarts during a move
ever matter.

**Admission is unchanged and has the same source as 9002.** A small generator renders
`pg_hba.conf` from the `PeerSet` the listener already uses (`peers.py:96`), and runs
`pg_reload_conf()` when the set changes. The source address arrives untouched on the existing
tailnet, so a node tagged `tag:claw` can reach Postgres within 30 s, as it reaches 9002. Postgres
listens on the tailnet address only, never `0.0.0.0`.

## 3. Credentials: fetched with the tenant's own service key

**Choice: the tenant fetches credentials with its service key. The vault broker is not used to
deliver them.**

- The vault route injects a secret when the service starts (`*-wrapper.mjs` `vaultKeys`), so
  every rotation is a restart of each tenant. It also needs an operator `set-many` plus a
  `key-acl-sync` per tenant. Both fail "rotation must not need a tenant deploy."
- The service-key route reuses the key every tenant already holds, the whoami check, the
  binding and the refusals, with no new secret type.

Mechanics:

- One stable login role per tenant. **Dataplatform rotates its password nightly** (and on
  `dataplatform pg rotate <ns>`). The answer says `rotates_at`. Both hosts of a primary/standby
  tenant fetch the same current password, so there's no mint race between claw-4 and claw-6.
- **A rotation never drops an open connection** (Postgres checks passwords only at login). A
  new connection with the old password gets `28P01`, and the helper (§7) refetches and retries
  once. A leaked password lives at most a day and only works from an admitted peer.
- Plain TCP inside WireGuard. The tailnet already encrypts the path, and scram-sha-256 never
  sends the password itself. `sslmode=disable` is stated in the answer, not left to defaults.
- Credentials minting depends on whoami like every data call (`whoami.py:294`, with its 30-minute
  stale grace at `:72`). **Running queries don't depend on it:** an open pool keeps working
  through a hadoku.me outage. Only a new login after a rotation needs a fresh fetch.
- Nothing is written to disk on the tenant side. The password is never logged: the `[pg]` line
  carries ns, op, status and ms, the same rule as `[data]` (`server.py:286-291`).

## 4. Durability: a backup counts only after it has restored

**Chosen: nightly logical dumps, restored before they count, carried off-host inside the
data-store backup. No PITR at launch.**

New nightly step `pg-backup`, placed just before `data-backup` (`daily_pipeline.py:1172`), so
tonight's verified dumps ride tonight's snapshot:

1. `pg_dumpall --globals-only --no-role-passwords` (roles and grants; passwords are re-minted).
2. Per tenant database, **one consistent view**: open a `REPEATABLE READ` transaction, take
   `pg_export_snapshot()`, count rows in every table inside that transaction, then
   `pg_dump -Fc --snapshot=<id>`. The counts and the dump describe the same instant, so an
   exact comparison is legitimate.
3. **Restore it.** `initdb` a scratch cluster in `~/.cache/dataplatform/scratch/pg-restore/`
   (never `/tmp`), started on a unix socket only. Load the globals, `pg_restore` each dump,
   count every table again, and compare against step 2. Any mismatch, a missing table or a
   restore error is a red step naming the database and the table. Then the scratch cluster is
   deleted.
4. Only a dump that restored is written to `$DATA_ROOT/pg-dumps/<stamp>/` with its
   `counts.json`, and only then does it count. `backup.snapshot` (`backup.py:190`) gains a
   `pg/` subtree that links the newest verified stamp. The existing manifest, remote push
   and per-remote verify (`backup.py:399`, `:500`) then carry it to claw-5 and `/mnt/black`
   unchanged, under the same retention (`KEEP_REMOTE` / `FLOOR_FRACTION`, `backup.py:341-357`).
5. The step's line is the evidence:
   `[pg-backup] dbs=2 tables=9 rows=3412 restored=2/2 mismatches=0 bytes=… secs=…`, and
   `dataplatform pg backups` prints each stamp's per-table counts, which is the done-when's
   "row counts shown."

6. **Volume check, night over night** (operator, point 2). Tonight's `counts.json` is compared
   with the last verified one, per tenant database. It flags:
   - a table that disappeared;
   - a table that lost at least 10% of its rows and at least 100 rows;
   - a database whose size moved by half or more, either way, once it is past 50 MB, so a tiny
     database's noise stays quiet.

   It names the database, the table and both numbers:
   `[pg-backup] volume ns=cardtable-stats table=game_matches rows=330->12`.
   Per the house rule for new checks, **it ships as a warning**: the step goes amber, not red,
   and it shows in Command Station. After two weeks without a false positive it becomes a
   forwarded alert (`event=dataplatform.pg.volume_change`). The dump is still kept either way. A
   tenant that deleted its data on purpose and one that lost it look the same here, so the
   check reports and never blocks.

The live cluster isn't under data_root at all (§5), so backup-sync never meets it.
`$DATA_ROOT/pg-dumps/` joins backup-sync's excludes beside `data-backups/`
(`daily_pipeline.py:610`), because data-backup already carries the dumps, verified.

**Recovery window: nightly, no PITR** (operator, point 2: up to 48 h of loss is acceptable). A
process crash or reboot loses nothing, because Postgres fsyncs its WAL. Losing the disk, or a
bad write, loses at most the day since the last dump. Retention is the data store's: 30 verified
nights per remote, and never fewer than 7 (`backup.py:341-357`). That reaches well past 48 h. If
a shorter window is ever wanted, WAL archiving to `/mnt/black` plus a nightly `pg_basebackup`
gives about 5 minutes for one extra lane.

## 5. Size limits: hard, at two levels

Operator, point 3: "if dataplatform gets full, we have big problems." So no soft quota. Two
fences, and the outer one doesn't depend on the inner one working.

**Outer: the whole cluster lives on its own fixed-size filesystem.**

- A fallocated image file on the root disk (btrfs, `chattr +C` so it isn't copy-on-write),
  formatted ext4 and loop-mounted at `/srv/dataplatform-pg` through fstab. **32 GB to start**;
  the first tenant's data is kilobytes. Data, WAL and temp files all live inside it.
- **Postgres can never take more than that from any disk.** When it is full, writes fail with
  "no space left on device" and reads keep working. Nothing else on the machine notices. Growing
  it is an online `resize2fs` run by the operator.
- **Why not walrus:** it is `ntfs3` (measured above). Postgres's data directory needs Unix
  ownership and modes and a filesystem whose fsync it can trust.
- **Why not black:** black holds the mirror. A primary there puts the live data and its copy on
  one disk.
- The result is three physical disks plus one machine away: the primary on root, dumps on
  walrus, copies on black and claw-5.
- **The one step that needs root** is creating and mounting the image. It is a script in the
  repo, run once by the operator with sudo, and it is shown first as a dry run (house rule for a
  machine-level change).

**Inner: each tenant loses write access at its quota, by privilege, which a tenant can't
undo.**

- The login role `ns_<ns>_app` can write only because it belongs to the owner role `ns_<ns>`.
- A monitor checks every tenant's size every 60 s (`pg_database_size`, about a millisecond
  each). So the overshoot is at most a minute of writes, and the outer cap bounds even that.
- **At 80%:** `quota.state = "warn"` in every credentials answer, an amber Command Station row,
  and a once-a-day `event=dataplatform.pg.quota_warn`.
- **At 100%:**
  - membership in the owner role is revoked;
  - the login role is moved to `ns_<ns>_reader`, which can SELECT, DELETE and TRUNCATE, so the
    tenant can read and free space but cannot INSERT, UPDATE or create anything;
  - its open sessions are ended, so the pool reconnects under the new rights.

  The tenant is told three ways:
  - `quota.state = "over"` in the credentials answer;
  - the helper throws a typed `QuotaExceeded` instead of a bare permission error;
  - a failure-level `event=dataplatform.pg.quota_over`.

  There is no `SET` that gets around it, unlike the read-only setting the first draft used.
- **Back under 95%:** write access returns on the next tick. A DELETE frees space for reuse but
  doesn't shrink the files, so `dataplatform pg compact <ns>` runs `VACUUM FULL` through
  Postgres 17's `pg_maintain` role, which is granted to `dataplatform_admin`. Raising the quota
  is one CLI flag.
- **No oversubscription:** the grant CLI refuses a quota that would push the sum of all tenant
  quotas past the cluster cap minus WAL and temp headroom (`max_wal_size` + 2 GB). So a tenant
  always hits its own fence before the cluster's.

**Also hard, and native:**

- `CONNECTION LIMIT` on the login role and the database;
- `temp_file_limit` on the role, which a tenant can't raise;
- a role-level `statement_timeout` ceiling.

## 6. Operability

Where the operator already reads dataplatform's state:

| what | where |
| --- | --- |
| health | `GET /pg/health` on the listener (peers only, like `/health`, `server.py:295`); the `pg` row in the nightly status |
| size, connections, quota state per tenant | `dataplatform data namespaces` (`cli/_data.py:174`) grows `pg_mb`, `pg_conns`, `quota` columns; Command Station's Data bindings shows the same through `data bindings --json` (`cli/_data.py:144`) |
| slow queries | `pg_stat_statements` (shared_preload) per database: `dataplatform pg slow <ns>` prints the top N by mean and total time; `log_min_duration_statement=500ms` with `%d` in `log_line_prefix`, so the Postgres log names the database |
| failures | `event=dataplatform.pg.*` (`unavailable`, `quota_warn`, `quota_over`, `backup_failed`, `restore_mismatch`) into `service_events`, queryable across the estate |
| grep contract | `[pg] op=credentials ns=… status=200 ms=…` in `dataplatform-out.log` (no password, no host), pinned by a test like `test_observability_contracts.py` |

## 7. TypeScript client recipe

A vendored file, `clients/ts/hadoku-pg.ts` (~80 lines, `pg` as its only dependency), copied by
each tenant and pinned by digest the way pygmalion pins `client.py` (data `AGENTS.md`, "What
pygmalion built on it"):

```ts
import { hadokuPool } from './hadoku-pg.js';

// HADOKU_DATA_URL and HADOKU_SERVICE_KEY are already in the PM2 wrapper's env.
const pool = hadokuPool({ namespace: 'cardtable-stats', max: 10 });

await pool.query('CREATE TABLE IF NOT EXISTS matches (id text PRIMARY KEY, at timestamptz)');
```

Inside it:

- `fetchCredentials()` POSTs `${HADOKU_DATA_URL}/pg/<ns>/credentials` with `X-User-Key`, then
  caches the answer until `rotates_at`.
- It builds `new pg.Pool({host, port, database, user, password: async () => cached.password,
  ...})`. node-postgres calls `password` per new connection, so a rotation needs no new pool.
- `query` retries once on `28P01` after refetching. It throws `QuotaExceeded` when the last
  answer's `quota.state === 'over'` and the error is `42501` (permission denied).
- `host` comes from the answer, never from the tenant's config. That's what makes §2 hold.

Migrations: any runner that takes a `pg.Pool` or `pg.Client` (node-pg-migrate, a hand-rolled
`schema_migrations` table) works unchanged, because the role owns its database. Python tenants
get the same in `data/client.py` (`DataClient.pg_credentials()`), still stdlib-only, as that file
must stay (data `AGENTS.md` "Never").

## 8. Moving off hokon, and failover later

**Moving (planned).** Nothing on the tenant side changes:

1. On the new host: install the same major version, restore the latest verified dump (or
   `pg_basebackup` from the live primary for a near-zero copy window), and start it.
2. Freeze writes on the old primary: `ALTER DATABASE … CONNECTION LIMIT 0` + terminate backends.
   A few seconds of refused logins; the helper retries.
3. Final sync (dump/restore of the delta, or let a streaming copy catch up and promote it).
4. Point `pg_public_host` at the new host and set the vault's `HADOKU_DATA_URL` to the data
   listener's new name. Restart each tenant's wrapper so it picks that up; there is no code
   change and no deploy.
5. Pools fetch credentials again and connect to the new host. Done.

What else moves with it: the PM2 placement (`host` in hadoku_site `child-apps.json`), the
capped filesystem (§5), recreated at the same size on the new host, the data root path in
`config.toml`, and the backup remotes, which must not end up on the new host's own disk.

**Failover (later, single primary for now, as the operator asked).** It would take: a streaming
standby on a claw (`primary_conninfo`, a replication slot), a manual `pg_promote()` on the
standby, and pointing `pg_public_host` at it. One standby with a manual promote needs no Patroni
or etcd. Automating it would reuse the data store's lease fencing (`/lease/`, data `AGENTS.md`
"Leases are fences"), so a stalled old primary can't keep taking writes. Not built now.

## 9. Build plan, as lanes

| lane | what | repo | needs |
| --- | --- | --- | --- |
| **L0 Address** | Set the vault's `HADOKU_DATA_URL` to `http://hokon.taild6f30f.ts.net:9002`, and move pygmalion, wiki and events (`child-apps.json:215/615/675`) from the hard-coded IP to the `vaultKeys` entry housemodel already uses (`:521`). Each tenant restarts once; verify each one's data calls afterwards. Nothing changes on the tailnet. | hadoku_site (operator sets the vault value) | — |
| **L1 Server** | The capped filesystem script (dry run, then the operator runs it once with sudo). Install PG17 on hokon. Cluster at `/srv/dataplatform-pg`. PM2 app `dataplatform-pg` (its own process, like `dataplatform-data`, so an API deploy never touches it). Tailnet-only `listen_addresses`. pg_hba generated from `PeerSet`. `dataplatform_admin` over the unix socket, with `pg_maintain`. Config keys `pg_port`, `pg_data`, `pg_public_host`, `pg_cap_gb`. | dataplatform, hadoku_site (`child-apps.json` entry) | — |
| **L2 Tenancy** | `resources.postgres` in `grants.py`, a resource on pending rows, `data grant --postgres`, provisioning (db/roles/limits), `POST /pg/<ns>/credentials` + `GET /pg/health` in `server.py` behind the unchanged `_authorise`, nightly rotation, revoke and drop. Command Station Data bindings shows and approves the resource. | dataplatform, hadoku_site (mgmt-api `data-bindings.ts`, the UI) | L1 |
| **L3 Backups** | `pg-backup` step: snapshot-consistent counts, dump, scratch restore, compare, then `pg/` in the data snapshot; the night-over-night volume check (as a warning); `dataplatform pg backups`. Tests restore a real cluster and fail on a planted mismatch; a planted 90% row loss turns the step amber. | dataplatform | L1 |
| **L4 Ops + quota** | Monitor thread: size and connections every 60 s, the 80% warning, the write-access revoke at 100% and its restore under 95%, `pg compact`, the oversubscription refusal at grant time. Tests fill a real tenant past its quota and check that INSERT is refused while SELECT and DELETE work; also `pg_stat_statements` + `pg slow`, `pg_stat_statements` + `pg slow`; `[pg]` grep contract; `service_events` tags; columns in `data namespaces` / `bindings --json`. | dataplatform (+ the Command Station columns in hadoku_site) | L2 |
| **L5 Clients** | `clients/ts/hadoku-pg.ts` + its test against a real local cluster (no mocks); `DataClient.pg_credentials()` in `client.py`; the recipe in data `AGENTS.md`. | dataplatform | L2 |
| **L6 Accept + guide** | The done-when, run for real: a grant through Command Station, connect from claw-4 and from hokon using the host from the credentials answer, create a table, see the other tenant refused at hba, at CONNECT and at the credentials route; one backup restored on scratch with its counts printed. `docs/guide/` gains the resource as a product a tenant requests (`features.md` + a `wiki.yml` feature entry), checked with hadoku-wiki's `verify-guide.mts`. | dataplatform | L0–L5 |

L0 and L1 run in parallel; L0 is worth doing on its own merits, since the data endpoint's tenants have the same problem today. L2 and L3 run in parallel once L1 lands. L4 and L5 follow L2. hadoku_site's
game-stats service (`HADOKU_SITE_SELF_HOSTED_GAME_STATS.md`) can start against a local Postgres
now, and needs only L2 + L5 to point at ours. Its erase hook stays its own: dataplatform holds the
database, but the rows and what they mean are the tenant's.

## Decisions taken, and what is left

All four questions are answered (top of this file). The design above already reflects them.
What's left is the go-ahead to build. Lanes L0 (a hadoku_site and vault change) and L1 (one
sudo step on hokon) touch things outside this repo, and each is shown as a dry run first.

Nothing is built until the tracker relays that go-ahead.
