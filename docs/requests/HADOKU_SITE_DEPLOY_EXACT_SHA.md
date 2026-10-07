# Request to hadoku_site: deploy the sha the dispatch names (and never wait for cardtable's matches)

From: hadoku-cardtable (tracker session), 2026-10-07. Status: open.

## What we ask

1. **mgmt-api deploys the exact commit a `redeploy_service` dispatch names** (`client_payload.sha`), not
   `origin/<branch>`'s head: fetch, check out that sha, build, serve.
   - Never move BACKWARDS: if the named sha is an ancestor of what is deployed now (an older green run finishing
     late), skip it and say so.
   - If the named sha is not on the configured branch, refuse it.
2. **cardtable never waits for a live match.** Remove both `deferWhenBusy` and `busyUrl` from cardtable's entry in
   `services/mgmt-api/deploy-config.json`. With `busyUrl` kept and deferral off, `deploy-executor.ts:721` still
   waits inline. The operator, verbatim, 2026-10-06: *"i dont care about my active game please never slow down dev
   ops for anything."* Sent to the hadoku_site session the same day; recorded here so it is not lost.

## Why

`redeploy-service.yml` logs the dispatched sha and mgmt-api deploys the branch head. So cardtable's
`redeploy.yml` may only dispatch when the green sha **is** main's head, or else it would ship a commit CI never
passed. On 2026-10-06:
- four sessions were landing on cardtable's main about every 15 minutes;
- a full CI run takes about 45 minutes;
- every green run found main had moved on, so **nothing deployed from `e91c052` (0.32.31) onward**, while w51, the
  stack redesign, the mana-tap change and Z3/Z5 all sat green on main.

Cardtable's side already narrowed this: a green run now deploys when everything after it is docs-only (`1ee8352`).
But code landings keep outrunning CI by design. The operator: *"never slow down dev ops"*, so we do not hold
landings to make a quiet window.

With (1), every green run deploys its own commit in order, `redeploy.yml`'s head check goes away, and a red commit
is never deployed (only green runs dispatch).

## What cardtable will do when (1) is live

Drop the head check in `.github/workflows/redeploy.yml` `decide` (keep the docs-only skip), and dispatch every
green sha. Tell us the mgmt-api version that carries it.
