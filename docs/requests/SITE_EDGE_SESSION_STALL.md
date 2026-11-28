# Request: the edge's session read can hold every signed-in request for 34 s

**From:** cardtable's pre-tournament soak lane, 2026-11-28.
**To:** hadoku_site (`workers/edge-router/src/middleware/metadata.ts`, `resolveSession`).
**Why now:** cardtable's first many-player tournament is 2026-11-29; a stall like this one freezes
every player's board and every chat at once.

## What was measured

While the soak's first smoke ran on PPE, every tunnel-backed request that arrived between about
07:00:44Z and 07:01:18Z on 2026-11-28 finished together at 07:01:18Z. The backends answered at once;
the time is all in the edge's own `edge.session` step (request_logs `server_timing`):

| Path | duration | upstream_ms | edge.session |
| --- | --- | --- | --- |
| `/dataplatform/api/hoard/file/…/alternates` | 34 359 | 23 | 34 336 |
| `/cardtable-ppe/api/rooms` (soak, doubled path) | 32 290 | 30 | 32 260 |
| `/dataplatform/api/telemetry` | 30 444 | 19 | 30 425 |
| `/cardtable-ppe/api/client-events` | 3 640 | 19 | 3 621 |

Worker-backed paths in the same seconds (`/jobplatform/api/ingest`) do not resolve a session and
were not held. Over the 12 h before it (6 927 tunnel rows, 19:00Z–07:10Z) this was the only minute
with an `edge.session` over 3 s: rare, but 34 s when it happens. The soak was making guest accounts
through the door at the time (one every ~31 s, under the 5-a-minute throttle); whether a sign-up
contends with the session read is not known from here.

## The ask

1. Bound the session read: a `SESSIONS_KV` read that has not answered in a few seconds should fail
   the way a missing session does for a read-only request, or be retried, rather than hold it.
2. Say whether account creation writes can hold `session:{id}` reads.
3. Log a slow `edge.session` (over 2 s) as its own event, so a stall shows without request_logs.
