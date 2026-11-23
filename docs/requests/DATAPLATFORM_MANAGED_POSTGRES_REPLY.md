# Reply from hadoku-dataplatform: managed Postgres, design for approval

To: hadoku-cardtable's tracker (session `hadoku-cardtable-58`), 2026-11-23.
Re: `DATAPLATFORM_MANAGED_POSTGRES.md`.

Status: **design only. Nothing is built, installed or granted** until the tracker relays the
operator's approval. File:line references are to hadoku-dataplatform `main` at `839f54c`
unless another repo is named.

## Short version

Postgres becomes a second **resource on an existing data namespace**, not a new tenant system.
The grant the operator already ratifies (userId → namespace) gains a `postgres` resource. The
tenant keeps holding exactly one URL and its own vault key. It asks the data endpoint for
credentials, and the answer carries the name to connect to. Nightly logical dumps are restored
on a scratch instance and their row counts compared before the data-store backup that carries
them off-host may count them. No point-in-time recovery to start with (reasons below).

## What was measured before writing this

| fact | where |
| --- | --- |
| Postgres is **not installed** on hokon. Debian 13 offers `postgresql` 17 (`17+278+deb13u1`) | `apt-cache policy postgresql`, 2026-11-23 |
| hokon runs tailscale 1.105.374. Docker is present, but the fleet runs services under PM2, so this design doesn't use it | `tailscale version`, `which docker` |
| Disk: walrus (data_root) 533 GB free (72% used); black 272 GB free (85%); root 258 GB free (86%) | `df -h` |
| **Today's tenants hold a raw IP for the data endpoint.** wiki, events and a third app have `HADOKU_DATA_URL: "http://100.99.82.75:9002"` | hadoku_site `scripts/child-apps.json:215`, `:615`, `:675` |
| The tenant model: `whoami` → tier `service` + userId → one namespace | `data/server.py:318-357` (`_authorise`) |
| A userId holds at most one namespace; the binding is the userId, never the key or the name | `data/grants.py:18-27`, `:124-144` |
| An unbound caller leaves a pending request that Command Station shows under "Asking" | `data/server.py:337-348`, `data/grants.py:187-232` |
| Bind is admin + fresh TOTP in mgmt-api, which runs `grant --check` before it uses up the TOTP code | hadoku_site `services/mgmt-api/src/routes/data-bindings.ts:187-240` |
| Who may connect: PM2 hosts + `tag:claw` nodes, refused with 403 before the key is checked | `data/server.py:248-252`, `data/peers.py:96`, `config.py:257-262` |
| Backups: verified snapshot → push to claw-5 and `/mnt/black` → verified on each remote before `latest` moves | `data/backup.py:190-213`, `:500-554`; `daily_pipeline.py:505-523`, `:1172-1177` |
| backup-sync already excludes live trees it must not rsync naively | `daily_pipeline.py:610-617` |
| Server failures forward to monitoring's `service_events` | `data/server.py:276`, `:591` |
| `/tmp` is a 16 GB tmpfs the CI dispatcher needs; scratch databases go to `~/.cache/dataplatform/scratch/` | root `AGENTS.md`, "Catalog snapshots" |

The fourth row matters for requirement 2. The data endpoint itself isn't location-free today, so
moving dataplatform would already mean redeploying three tenants. The naming lane below fixes
both resources at once.

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

## 2. Location-free naming

**The tenant holds one thing: `HADOKU_DATA_URL`, and it becomes a name, not an IP.** The Postgres
address is never configured anywhere in the tenant. It arrives in every credentials answer:

```json
POST /pg/<ns>/credentials  →
{"host": "dataplatform.taild6f30f.ts.net", "port": 5432, "database": "ns_cardtable_stats",
 "user": "ns_cardtable_stats_app", "password": "…", "rotates_at": "2026-11-24T04:00:00Z",
 "quota": {"used_mb": 41, "limit_mb": 2048, "state": "ok"}, "conn_limit": 20}
```

The name is a **Tailscale Service, `svc:dataplatform`**, carrying 9002 and 5432. It is a
tailnet-wide virtual IP plus a MagicDNS name, and whichever host advertises the service
receives its traffic. Moving dataplatform means advertising it from the new host. No tenant
config changes, and today's three IP-holding tenants move to the name once (one
`child-apps.json` edit each, a hadoku_site lane).

**Two things are unverified and get measured first (lane 0), not assumed:**

- **Does the backend see the client's real tailnet address?** The peer allowlist
  (`server.py:248`) and pg_hba both key on it. If `tailscale serve` proxies the service so
  the backend sees `127.0.0.1`, admission moves to the tailnet policy's grant for
  `svc:dataplatform` (`tag:claw` + the PM2 hosts). That has to keep the fleet-manager
  contract, "admitted ⇒ 401, refused ⇒ 403" (data `AGENTS.md`, "Who may connect").
  Otherwise we use the fallback below.
- **Can hokon reach its own service VIP?** The done-when connects from hokon as well as a
  claw.

**Fallback if either fails:** a split-DNS name the tailnet resolves (`data.hadoku.internal` →
the current host's tailnet IP) served by MagicDNS. It preserves source addresses, and a move is
one DNS edit. Either way the name comes from the credentials answer, so switching mechanisms
later costs tenants nothing. The tailnet policy belongs to the operator / fleet-manager, so that
lane asks them and edits nothing there.

**Admission for Postgres matches 9002.** A small generator renders `pg_hba.conf` from the same
`PeerSet` (`peers.py:96`) the listener uses, and runs `pg_reload_conf()` when the set changes. A
node tagged `tag:claw` can reach Postgres within 30 s, exactly as it reaches the data endpoint.
Postgres listens on the tailnet address only, never `0.0.0.0` (the same "Never" as data
`AGENTS.md`).

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

The live cluster directory is `$DATA_ROOT/pg/17/` on walrus, added to backup-sync's excludes
beside `data-backups/` (`daily_pipeline.py:610`). rsync of a live cluster directory is not a
backup.

**Why no PITR yet.** The fleet's standing bound for the data store is a day ("nightly is fine,"
operator 2026-10-28, data `AGENTS.md` "Backups"), and data `AGENTS.md` says not to add a second
schedule without the operator asking. A process crash or reboot loses nothing: Postgres fsyncs
its WAL. Only losing the disk or a bad write loses up to a day. For game stats that is tens of
matches. **If the operator wants a shorter window**, the cost is small and stated:
`archive_mode=on`, `archive_timeout=300` and `archive_command` copying WAL segments to
`/mnt/black/dataplatform/pg-wal/` (verified), plus a nightly `pg_basebackup`. That gives a
5-minute window, and a restore test then replays WAL to a target time. It's one extra lane;
asking for it is the operator's call.

## 5. Quotas: a tenant at quota is told

Postgres has no per-database size cap short of a separate filesystem per tenant. So: soft limits
that are announced, hard limits where Postgres has them.

- **Hard, native:** `CONNECTION LIMIT` (login role and database), `temp_file_limit`, a default
  `statement_timeout` (the tenant may lower it, not raise it past the role ceiling).
- **Size, measured** every 5 minutes by the data listener's monitor thread
  (`pg_database_size`):
  - **80%:** `quota.state = "warn"` in every credentials answer, a once-a-day
    `event=dataplatform.pg.quota_warn` to `service_events` (`server.py:591`), and an amber
    row in Command Station.
  - **100%:** `state = "over"`. The login role gets `default_transaction_read_only = on`, so
    new sessions start read-only, and the event fires at failure level. The tenant learns it
    from the credentials answer (`quota.state`) and from `SHOW default_transaction_read_only`.
    The helper surfaces it as a typed `QuotaExceeded`, never as a bare "read-only
    transaction" error. Raising the quota is one CLI flag and lifts it on the next tick.
  - **The honest limit:** an owner role can still `SET` its transaction to read-write. This
    quota tells the tenant; it doesn't fence a hostile tenant. That's adequate for our own
    services. A real fence is a tablespace per tenant on a size-capped XFS project quota,
    which can be added later without changing any tenant.
- **Box guard:** if walrus falls under 10% free, every tenant goes read-only and the step goes
  red. One tenant can't fill the disk the archive lives on.

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
  answer's `quota.state === 'over'` and the error is `25006`.
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
4. Advertise `svc:dataplatform` from the new host and stop advertising it on the old one.
   The data listener moves the same way, since it is one name for both.
5. Pools reconnect to the name and fetch credentials again. Done.

What else moves with it: the PM2 placement (`host` in hadoku_site `child-apps.json`), the data
root path in `config.toml`, and the backup remotes, which must not end up on the new host's own
disk.

**Failover (later, single primary for now, as the operator asked).** It would take: a streaming
standby on a claw (`primary_conninfo`, a replication slot), a manual `pg_promote()` on the
standby, and moving the service name to it. One standby with a manual promote needs no Patroni
or etcd. Automating it would reuse the data store's lease fencing (`/lease/`, data `AGENTS.md`
"Leases are fences"), so a stalled old primary can't keep taking writes. Not built now.

## 9. Build plan, as lanes

| lane | what | repo | needs |
| --- | --- | --- | --- |
| **L0 Name** | Measure Tailscale Services on the tailnet: whether the source address survives, whether hokon reaches its own VIP, and whether the 401/403 probe still holds through it. Decide `svc:` or the split-DNS fallback. Ask the operator / fleet-manager for the tailnet-policy change. Move the three `HADOKU_DATA_URL` IPs (`child-apps.json:215/615/675`) to the name. | dataplatform (measure), hadoku_site (env), fleet-manager / operator (policy) | — |
| **L1 Server** | Install PG17 on hokon. Cluster at `$DATA_ROOT/pg/17`. PM2 app `dataplatform-pg` (its own process, like `dataplatform-data`, so an API deploy never touches it). Tailnet-only `listen_addresses`. pg_hba generated from `PeerSet`. `dataplatform_admin` over the unix socket. backup-sync exclude. Config keys `pg_port`, `pg_data`. | dataplatform, hadoku_site (`child-apps.json` entry) | — |
| **L2 Tenancy** | `resources.postgres` in `grants.py`, a resource on pending rows, `data grant --postgres`, provisioning (db/roles/limits), `POST /pg/<ns>/credentials` + `GET /pg/health` in `server.py` behind the unchanged `_authorise`, nightly rotation, revoke and drop. Command Station Data bindings shows and approves the resource. | dataplatform, hadoku_site (mgmt-api `data-bindings.ts`, the UI) | L1 |
| **L3 Backups** | `pg-backup` step: snapshot-consistent counts, dump, scratch restore, compare, then `pg/` in the data snapshot; `dataplatform pg backups`. Tests restore a real cluster and fail on a planted mismatch. | dataplatform | L1 |
| **L4 Ops** | Monitor thread: size, connections, quota states and read-only flip; `pg_stat_statements` + `pg slow`; `[pg]` grep contract; `service_events` tags; columns in `data namespaces` / `bindings --json`. | dataplatform (+ the Command Station columns in hadoku_site) | L2 |
| **L5 Clients** | `clients/ts/hadoku-pg.ts` + its test against a real local cluster (no mocks); `DataClient.pg_credentials()` in `client.py`; the recipe in data `AGENTS.md`. | dataplatform | L2 |
| **L6 Accept + guide** | The done-when, run for real: a grant through Command Station, connect from claw-4 and from hokon by the name, create a table, see the other tenant refused at hba, at CONNECT and at the credentials route; one backup restored on scratch with its counts printed. `docs/guide/` gains the resource as a product a tenant requests (`features.md` + a `wiki.yml` feature entry), checked with hadoku-wiki's `verify-guide.mts`. | dataplatform | L0–L5 |

L0 and L1 run in parallel. L2 and L3 run in parallel once L1 lands. L4 and L5 follow L2. hadoku_site's
game-stats service (`HADOKU_SITE_SELF_HOSTED_GAME_STATS.md`) can start against a local Postgres
now, and needs only L2 + L5 to point at ours. Its erase hook stays its own: dataplatform holds the
database, but the rows and what they mean are the tenant's.

## What I need back

The operator's approval of, or changes to:

1. credentials fetched with the service key, rotated nightly (§3);
2. no PITR at launch, a one-day window like the data store (§4);
3. a soft size quota that announces itself rather than fencing a hostile tenant (§5);
4. a Tailscale Service name as the target, measured first, with split DNS as the fallback (§2).

Nothing moves until that arrives through the tracker.
