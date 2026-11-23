# Request to hadoku-dataplatform: managed Postgres, requisitioned by onboarded tenants

From hadoku-cardtable's tracker, 2026-11-23, on the operator's decision. A request is a
hypothesis about what you need to build, not a design: the mechanism is yours. Reply in
`docs/requests/DATAPLATFORM_MANAGED_POSTGRES_REPLY.md` in hadoku-cardtable, or message the
cardtable tracker session.

## What the operator decided (2026-11-23, his words)

> postgres from dataplatform makes sense. not necessarily on hokon (hokon is the current host for
> dataplatform but that might change in the future). it should be inside the dataplatform corpus and
> be requisitionable by a tenant onboarded app. lets make sure we build this so dataplatform is a
> proper cloud provider.

And, on cardtable's data: *"i would prefer if all the data was self-hosted so we don't rely on
cloudflare for this."* Today the fleet's game history (cardtable, bomberman) lives in prefs-api's D1 at
Cloudflare. It moves onto this, along with a new room-history record.

## The ask: Postgres as a second resource type beside the data store

The data store (`server/dataplatform/data/`) already has a tenant model:
- a service's own vault key, checked through `whoami`, which yields tier `service` and a userId;
- a grant per namespace (`grants.py`), ratified by the operator in hadoku_site's admin
  (`data-bindings.ts`);
- one env var and a client file to onboard.

Managed Postgres should be the same product with a different resource.

Requirements, as outcomes:

1. **Requisition.** An onboarded tenant gets a database by the same grant flow the operator already
   ratifies: one database (or schema) per grant, named, with its own role. No tenant can reach
   another's.
2. **Location-free.** A tenant never holds a host or an IP. It reaches its database by a
   dataplatform-owned name, so moving dataplatform off hokon changes no tenant. Say how a tenant
   resolves it (tailnet name, a lookup through the data endpoint, or something else).
3. **Credentials without `.env`.** The fleet rule is that secrets come from the vault broker,
   through each service's PM2 wrapper. Either deliver the tenant's password that way, or let the
   tenant fetch short-lived credentials with its own service key. Rotation must not need a tenant
   deploy.
4. **Durability like the rest of the corpus.** Nightly backups that restore in full before
   retention counts them (the standard the cardtable state backup set: a backup "succeeds" only
   after it restores), carried off-host with the data store's own backups. Point-in-time recovery
   is your call; say what you chose.
5. **Tenant-owned schema.** Each tenant runs its own migrations. Dataplatform owns the server,
   versions, extensions it allows, connection limits and quotas.
6. **Operable.** Health, size per tenant, connections per tenant, slow queries, all visible
   wherever the operator reads dataplatform's state. A tenant at quota is told, not silently
   refused.
7. **A client story for TypeScript tenants.** Most tenants are Node services (cardtable,
   hadoku_site's services). A documented connection recipe is enough; a tiny helper is better.
8. **Single primary.** The operator: *"i dont want to deal with distributed database yet, lets try
   with just one for now."* No replicas are required. Say what a failover would take later.

## Who will use it first

- **hadoku_site's shared game stats** (`HADOKU_SITE_SELF_HOSTED_GAME_STATS.md`, sent alongside):
  match history, ratings and breakdowns for cardtable AND bomberman, plus a generic room-history
  record. Today that is about 330 matches and 740 seats, growing by tens a day. Small.
- Later, cardtable's own live state (rooms, drafts, tournaments) might move to the data store
  (not Postgres), per `docs/planning/telemetry-and-state-inventory.md` §4 in hadoku-cardtable.

## Done when (checkable)

- A tenant onboarded through the operator's grant flow connects from a claw AND from hokon by the
  name in (2), creates a table, and cannot see another tenant's.
- A backup restores in full on a scratch instance, with its row counts shown.
- The guide (`docs/guide/`, your wiki page) describes the resource as a product a tenant can
  request.
