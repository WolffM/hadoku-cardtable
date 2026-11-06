# Spike: CubeCobra's draftbot in our server

What it costs to run CubeCobra's neural draftbot (encoder + draft decoder, the
TF.js graph models its recommender service loads) inside our Node server.
Measured 2026-11-06 on hokon (Ryzen 5 7600X, 12 threads, load ~4–7) with
`scripts/spike/cubecobra-draftbot/measure.mjs`, Node 24.18, tfjs 4.22.0.
The script's header has the setup; nothing it downloads enters the repo.

## Numbers

|                                           | tfjs-node (native)                                  | pure-JS tfjs (`cpu`) |
| ----------------------------------------- | --------------------------------------------------- | -------------------- |
| install on disk                           | 658 MB (both packages; libtensorflow is most of it) | same install         |
| weights on disk                           | 149 MB                                              | 149 MB               |
| RSS added by loading tfjs                 | 117 MB                                              | 33 MB                |
| RSS added by the two models               | 446 MB                                              | 311 MB               |
| RSS peak while picking                    | 723 MB                                              | 566 MB               |
| model load                                | 0.2 s                                               | 0.3 s                |
| one pick round, 1 seat (p50 / p95)        | 5.3 / 8.4 ms                                        | 57 / 61 ms           |
| one pick round, 7 seats (one pod's bots)  | 5.5 / 7.1 ms                                        | 330 / 341 ms         |
| one pick round, 28 seats (4 pods at once) | 7.8 / 10.2 ms                                       | 1.3 s                |
| one pick round, 56 seats (8 pods at once) | 18.5 / 23 ms                                        | 2.6 s                |
| whole 8-seat draft, all bots (360 picks)  | 0.26 s                                              | 18–22 s              |

The model's vocabulary is 37,238 oracle ids. All 540 cards of
`MTGO Vintage Cube 2013` were in it.

## What that means

- **One copy serves every draft.** The weights load once per process; a pick
  for any number of bots is one batched forward pass. The memory is a flat
  ~0.5–0.7 GB, not per drafter or per draft.
- **Native tfjs-node is free on CPU**: a whole all-bot draft is a quarter of a
  second, and 8 pods picking at the same moment is ~20 ms.
- **Pure-JS works but must run off the event loop** (a worker thread): a pod's
  pick round is ~330 ms of blocked CPU.
- **tfjs-node 4.22 (the last release, January 2025) does not run on Node 23+**
  as published: it calls `util.isNullOrUndefined`, which Node removed. The
  spike shims it. Shipping it means carrying that shim, or a fork, on an
  unmaintained native package.
- **Our catalog has no oracle id.** The model is keyed by Scryfall oracle id;
  `cards.json` carries `scryfallId` only. The spike asks Scryfall's
  collection endpoint. Using the model for real needs `oracle_id` added at
  catalog build.
- **The weights carry no stated licence** (public S3 bucket
  `cubecobra-public`, CubeCobra's code is Apache-2.0). Shipping them needs the
  maintainer's permission first.
