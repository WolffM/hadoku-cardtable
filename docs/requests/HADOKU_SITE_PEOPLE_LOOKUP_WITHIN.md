# Request to hadoku_site: a bounded people lookup that answers with the last answer

**Filed 2026-11-26 by cardtable (lane people-lookup).** For `packages/prefs-client/src/people.ts`
(`createPeopleLookup`), published as `@hadoku/prefs-client`. cardtable pins 1.2.2.

## What cardtable measured

- `people-resolve-failed` ("The operation was aborted due to timeout", the lookup's 5 s
  `AbortSignal.timeout`): 28 in 2026-11-21..26, most of them the Discord events sweep's
  one-id lookup on its 10-minute tick.
- The edge's request log has the sweep's lookup on every tick **except** the ones that failed
  (e.g. 2026-11-22 10:00–11:00: :07:40, :17:40, :37:40, :47:40, :57:40 logged; 10:27:40, the
  failure, absent). So either the request never reached the edge, or prefs-api took over 5 s
  and the worker was cancelled when cardtable hung up, which leaves no log line. The logged
  answers can't show which (p50 561 ms, p99 1004 ms, max 1773 ms over 911 answers,
  2026-11-24..26), because a cancelled one is never logged.
- Two failures (2026-11-25 21:51:03, 23:29:59) *were* answered: 200 in 614 ms and 538 ms. Those
  were stalls in cardtable's own process (an `agent-watch-stalled` gap of 5867 ms beside the
  first), not prefs-api.
- From hokon, 12 processes asking at 10-minute idle gaps plus one at 0.2–60 s gaps: no hangs
  Those asks were refused 401 at the edge's auth, so they
  test the network and the edge and never reach prefs-api. 270 asks, 84 of them after a
  10-minute idle: 0 hung, 0 over 1.5 s.

cardtable now logs how far a failed lookup got (`packages/game-server/src/fetch-trace.ts`:
`socket` new/reused, `connectMs`, `idleMs`, `sentMs`, `bodySentMs`, `headersMs`, `failedMs`,
on the `people-resolve-failed` line). `sentMs` with no `headersMs` on a new socket means
prefs-api or the edge did not answer. We will append the first instrumented failures here.

## The ask

`resolve(userIds, { within })`: wait at most `within` ms, then answer each id from `last()`
(the stale-window answer it already keeps), and let the lookup run on and fill the cache.

Why it belongs in prefs-client:

- Every server that shows people waits on this lookup inside a request a person is waiting for.
  In cardtable that is the events list, tournaments, replays, cubes and the room link preview,
  each of which waited the whole 5 s when a lookup hung (GET /events: 5002 ms, measured in
  `games/magic/server/src/http/events.test.ts`). watchparty uses the same lookup.
- cardtable has done its part outside the package (`people.ts`, `SCREEN_WAIT_MS` = 1200 ms),
  but it can answer only from `peek()`, which is fresh-only. When a bound passes, someone the
  lookup answered for 2 minutes ago is shown as the unnamed word, not as their name.
  `last()` is private to the lookup.

Done when: `@hadoku/prefs-client` exports the option and a test where the fetch hangs answers
within the bound with a stale entry's name. cardtable then deletes its own race in
`packages/game-server/src/people.ts` and passes `within` through.
