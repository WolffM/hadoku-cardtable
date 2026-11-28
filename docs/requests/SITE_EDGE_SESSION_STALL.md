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
were not held. It then came back every 5 minutes, about 33 s each time, holding every signed-in
tunnel request in flight, whoever's and whichever app's (tunnel request_logs, `edge.session` over 3 s;
start = finish − `edge.session`):

| Start (Z) | Release (Z) | Rows | Users | Apps |
| --- | --- | --- | --- | --- |
| 07:00:44 | 07:01:18 | 13 | 3 | cardtable-ppe, dataplatform |
| 07:05:46 | 07:06:19 | 5 | 3 | cardtable, cardtable-ppe, dataplatform |
| 07:15:46 | 07:16:18 | 4 | 2 | cardtable-ppe |
| 07:20:43 | 07:21:19 | 59 | 10 | cardtable-ppe |
| 07:25:44 | 07:26:19 | 49 | 12 | cardtable-ppe |

(07:10 had nothing in flight.) None from 06:00 to 07:00Z. It is not an idle session's first read:
accounts posting every minute were held as long as idle ones. WebSocket upgrades are held too, and a
socket.io connect started at 07:20:42 never reached the server; its retry connected at 07:21:21.
Nothing in hokon's crontab or timers runs every 5 minutes at those marks.

## The ask

1. Bound the session read: a `SESSIONS_KV` read that has not answered in a few seconds should fail
   the way a missing session does for a read-only request, or be retried, rather than hold it.
2. Find what runs every 5 minutes since 07:00Z and holds the session read.
3. Log a slow `edge.session` (over 2 s) as its own event, so a stall shows without request_logs.
