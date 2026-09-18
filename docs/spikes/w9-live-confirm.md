# Wave 9 integration check — a human answers Forge mid-match, in a browser

The wave's question: **can a human be asked something mid-match and answer it
without desyncing?** Run by the wave manager on 2026-09-18 against the landed
lanes A (`a4c0444`) and B (`29632e1`) plus the mount (`dffe787`). Every number
below is from that run; the raw outputs are reproduced verbatim.

**Answer: yes, on loopback.** A real Forge match in a child JVM sent a real
`showConfirmDialog` to a browser seat. The browser rendered it, the answer
reached Forge, and the board the browser showed afterwards matched the server's
record of that seat field for field.

## Setup

- Server: `tsx apps/server/src/index.ts` from the w9 worktree on
  `127.0.0.1:9128` (9008 is the production PM2 process and was left alone), with
  `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES` at the prebuilt 2ad70eb4 build
  in `~/.cache/cardtable-w8/forge-build`, `CARDTABLE_INSECURE_NO_EDGE_AUTH=1`,
  `CARDTABLE_PLAY_PROBE=1`.
- Seat 0: Chromium (Playwright), lane B's dev harness via vite on 5188:
  `/cardtable/src/play/live/harness.html?match=<id>&server=http://127.0.0.1:9128`.
- Seat 1: lane A's command-line seat, `src/play/dev/seat.ts --user bob --ok`.

## The match

```console
$ curl -X POST -d '{"opponent":"human"}' …/api/play/matches
{"matchId":"m-40103db90bd9","epoch":"m-40103db90bd9:1789716310875","seats":[{"seat":0,"kind":"human","deck":"Surge of Resistance"},{"seat":1,"kind":"human","deck":"Mind Swarm"}]}
201 4.471939s
```

Seat 1's log shows Forge's real opening: `"Seat 2, you have won the coin toss…
play or draw?"`, `[Play] [Draw]`, then `[Keep] [Mulligan]`.

## The question

`POST /api/play/matches/<id>/probe` makes Forge's server side send seat 0 a
`showConfirmDialog` through the stock `sendAndWait`. It blocks until the answer
returns; `ms` is timed inside Forge. The probe's default is **No**, so `true`
can only come from the browser.

The dialog rendered as `role="alertdialog"`, `data-call-id="s0-1"`, title
"cardtable probe", with Yes/No and No as the focused default.

**Answered by a click** (the latency is mostly the manager's tool round-trip,
not the wire):

```
{"answer":true,"ms":10633.628822}
200 10.635597s
```

**Answered the moment it rendered** (an in-page MutationObserver clicked Yes as
soon as the dialog appeared; this is the wire round-trip Forge → Node → socket
→ React render → click → socket → Node → Forge):

```
{"answer":true,"ms":6.46547}  curl_total=0.007652s
{"answer":true,"ms":5.821703} curl_total=0.006756s
{"answer":true,"ms":6.07822}  curl_total=0.007058s
{"answer":true,"ms":5.369742} curl_total=0.006264s
{"answer":true,"ms":5.080553} curl_total=0.006054s
```

Median **5.8 ms**, range 5.1–6.5 ms. Six asks, six answers, six `true`.
Call ids `s0-1` … `s0-6`, each rendered once.

## Did the board desync?

After the answers, `GET /api/play/matches/<id>/seats/0/state` (cursor
`{"epoch":"m-40103db90bd9:1789716310875","seq":18}`) against the browser's
rendered board:

| | server, seat 0's state | browser |
| -- | -- | -- |
| turn / phase | no Turn/Phase on the game yet | "Turn 0 · Not started" |
| Seat 1 (me) | life 20, hand 7, library 53, bf/gy/exile 0 | life 20, hand 7, library 53, all 0 |
| Seat 2 | life 20, hand 7, library 53, bf/gy/exile 0 | life 20, hand 7, library 53, all 0 |
| my hand, in order | Mountain, Mountain, Anticipate, Island, Lavastep Raider, Cyclone Sire, Island | the same seven, same order |
| opponent's hand | 7 ids, **no face objects sent** | "7 cards, hidden" |

Seat 0's whole state held 7 CardStateView objects: its own hand. Neither the
opponent's hand nor either library carried a face.

## What this does not show

- **Loopback only.** No cloudflared tunnel, no edge, no `hadoku.me`. The
  production server has no Forge configured (`POST /api/play/matches` answers
  503 there by design), so this cannot yet be run in production. Settling it
  needs a Forge build and a JRE on the deploy host, plus the two env vars.
- **The state did not move under the answer.** The probe is a dialog, not a
  game action, and the browser seat cannot press Keep/Mulligan: lane B renders
  only `showConfirmDialog`, and lane C's components are not wired in yet. So
  "no desync" is shown for asks interleaved with a live stream (server cursor
  18; the client's own resync count was not read), not across a state change caused by the answer.
- **An engine-originated `showConfirmDialog`** was not triggered. Its one
  in-game caller is the "mana floating, pass priority anyway?" check. The probe
  goes through the same `sendAndWait` path.
- Playwright's console log for the page was deleted with its artifact dir
  before it was read.
