# Deck art ahead of the picker — evidence

Operator, of the deck chooser: *"some loaded quick, but others loaded extremely
slowly. are these relying on external requests? this is a static list we should
be able to cache these images."*

## What changed

`ConstructedScreen.tsx` now warms every option's art the moment an era's (or a
pod's) decks answer: `cardImageUrl` resolves each option's Scryfall id to a URL,
and `prefetchCardImages` (`apps/ui/src/draft/cardImage.ts`) creates one
`new Image()` per DISTINCT url and sets its `.src`, skipping any url the room
has already asked for. The map of url → `Image` is a `useRef` on
`ConstructedScreen`, so it lives for the mount (preventing garbage collection
from cancelling an in-flight warm) and de-dupes across eras the same way. A
failed warm changes nothing: `DeckArt`'s own `onError` still draws
`deckpick__art--none`, exactly as before.

**Revision note.** The first cut of this used `<link rel="prefetch">` instead
of `new Image()`. Measured against a real browser, that was a real defect, not
a style choice: a `<link rel="prefetch">` response lives in a separate cache
partition from an ordinary image load, so it does not coalesce with the
picker's own `<img>` for the same URL — the two raced, and the era sent
**18** requests to the art host for 9 distinct URLs instead of 9. Switching to
`new Image()` (an ordinary image load, which DOES coalesce with a same-URL
`<img>`) fixed that; the numbers below are from that version.

## How this was measured

A real Chromium (Playwright, headless), against the REAL built UI
(`apps/ui/dist`) and the REAL built server, behind `e2e/harness.ts`'s edge
stand-in — same mechanism the repo's own e2e specs use, run by hand rather than
through `playwright test`. Script: `/tmp/claude-1000/w56-D-scratch/evidence.cjs`
(kept in the lane's own scratch dir, not committed). Two rooms are created back
to back in ONE browser context, with **no `page.route`/`context.route` and no
`page.on('request'/'response')` listener anywhere in the script** — every
number below is read from inside the page itself
(`performance.getEntriesByType('resource')`), not from Playwright's network
events, so nothing in this measurement could itself be disabling or
interfering with the browser's cache.

- **room 1** — the first room this browser profile has ever opened: a
  genuinely cold HTTP cache for every art URL the newest era's decks resolve to.
- **room 2** — a second room, same identity, same default (newest) era, so it
  offers the identical deck list and therefore the identical art URLs — now
  warm, because room 1 already asked the browser to fetch every one of them.

For each room the script records: the wall-clock time from room creation to
every option row having either a fully-loaded `<img>` or the `--none`
placeholder; the per-image completion times (so the SPREAD between the first
option painted and the last is visible — the shape of the operator's
complaint); and every `PerformanceResourceTiming` entry the art hosts
(`cdn.hadoku.me`, `cards.scryfall.io` — real, external, over the real network,
which is fine for this evidence) actually produced.

**A caveat the first draft of this doc got wrong.** `transferSize` and
`decodedBodySize` on a cross-origin resource read as `0` for a cache hit AND
for a real fetch alike, because neither art host sends
`Timing-Allow-Origin`, and the Resource Timing spec zeroes every size/byte
field for a cross-origin entry without that header. That is not a Chromium
quirk and not something this app's code controls; it just means those two
fields cannot distinguish a cache hit from a network fetch here.
`duration` is NOT behind that gate (exposed since Resource Timing's first
version) and is what the numbers below actually use.

The newest era this library offers has **12 deck options resolving to 9
distinct art URLs** (several decks share their most-expensive card's art).

## Results — 3 runs, same browser profile, cold then warm each time

| run | cold: time to last art painted | cold: requests to art host | cold: per-request duration (ms) | warm: time to last art painted | warm: requests to art host | warm: per-request duration (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1079 ms | 9 | 378–636 | 251 ms | 9 | **0, every one** |
| 2 | 1010 ms | 9 | 376–638 | 209 ms | 9 | **0, every one** |
| 3 | 955 ms | 9 | 382–635 | 164 ms | 9 | **0, every one** |

Every run, both cold and warm: **9 requests to the art host for 9 distinct
URLs** — one each, never two, which is exactly `constructed.test.ts`'s own pin
(`deck art is warmed ahead of the picker`, asserted directly on the `Image()`
calls `prefetchCardImages` makes, not inferred from this browser run).

Every warm run painted every option's art in **164–251 ms** — well under the
one-second bar — with a `duration: 0` resource-timing entry for every single
one of the 9 art-host resources: the browser answered from its own cache with
no round trip at all, not merely a fast one.

## What the fix actually buys, measured

1. **One request per distinct URL, total — not per option, and not doubled.**
   12 options, 9 distinct URLs, 9 `new Image()` warms, 9 resource-timing
   entries. Proven directly by `constructed.test.ts`'s two new cases, not
   inferred from the browser run — the browser run is here to confirm the real
   art hosts agree.
2. **The cold run's own per-request durations are the operator's complaint,
   measured directly**: 376 ms up to 638 ms for the SAME 9-option era, in one
   run — nearly a 2x spread between the fastest and slowest art request,
   purely from real network variance to Scryfall/the CDN. That spread exists
   whether or not this fix runs; what the fix changes is that EVERY one of
   those 9 requests starts immediately, together, the moment the era answers,
   rather than however many of them an `<img loading="lazy">` happens to have
   started by the time it is scrolled near — which is the mechanism behind
   "some loaded quick, others loaded extremely slowly" on a longer list than
   this 12-row fixture.
3. **Repeat opens are a true cache read, not a fast fetch.** `duration: 0` on
   every warm-run resource entry is the browser's own record of zero network
   time, not an inference from how fast the picker painted.

## What this measurement still cannot show

- **Local loopback-to-internet timings are specific to this machine's network
  path at this moment** (cold per-request durations here: 376–638 ms). The
  mechanism — parallel, non-viewport-gated warming vs. a lazy per-row fetch —
  holds regardless of the absolute numbers, and will look more dramatic on the
  operator's own connection with a longer deck list, which is the situation
  the original complaint was actually about.
- Each of the 3 runs above launches a brand-new Chromium process with its own
  non-persistent context (`browser.newContext()`, no profile directory), so
  there is no cache carried between runs — every "cold" figure really is a
  first-ever open, confirmed by every cold run showing a nonzero,
  real-network-sized duration for all 9 requests (a leftover warm cache would
  show `0` the way the warm room already does).
