# Card data

How cardtable gets card data, and the terms it is allowed to get it under.

Everything in §1 was read off Scryfall's live pages on **2026-09-11** with the
exact requests recorded below. Where something was *not* checked, this document
says so — same convention as `FORGE_ANALYSIS.md`, and for the same reason.

---

## 1. Scryfall's terms — verified

`docs/LICENSING.md` §3 has carried a ⚠️ because automated fetch returned **403
twice**. That ⚠️ can now come off: the pages are reachable and were read.

### 1.1 The 403 was ours, not theirs

**The 403 did not reproduce, and it is not what Scryfall returns for a
malformed request.** Six probes from hokon, all with `curl`:

| # | Request | Status |
| --- | --- | --- |
| A | `api.scryfall.com/bulk-data`, **no** `User-Agent`, **no** `Accept` | **400** |
| B | `api.scryfall.com/bulk-data`, curl's default UA, no `Accept` override | 200 |
| C | `api.scryfall.com/bulk-data`, browser-shaped UA | 200 |
| D | `api.scryfall.com/bulk-data`, honest identifying UA + `Accept` | 200 |
| E | `scryfall.com/docs/api`, honest UA | 200 |
| F | `scryfall.com/docs/api`, **no** UA | 200 |

Probe A's body is Scryfall telling us the rule in their own words:

```json
{"object":"error","code":"bad_request","status":400,
 "details":"You submitted an invalid request. HTTP requests to api.scryfall.com
 must contain a User-Agent and Accept header. More info: https://scryfall.com/docs/api"}
```

So a missing header is **400**, not 403. Responses are served through
Cloudflare (`server: cloudflare`, `cf-ray` present). The conclusion that
actually follows: **the earlier 403 was Cloudflare bot-filtering the fetching
agent's egress, not a Scryfall policy about who may read the docs.** It was an
environmental block on one tool, and it should not have been read as a
statement about our access. Nothing about our intended usage was ever
disallowed.

The practical lesson is the interesting one: a 403 from behind a CDN says
something about the *requester*, and the way to find out what is to vary one
thing at a time — which is what the table above does.

### 1.2 Required headers — verified

From <https://scryfall.com/docs/api>:

- Both a `User-Agent` **and** an `Accept` header are required on every request
  to `api.scryfall.com`.
- The `User-Agent` "must be accurate to your usage context… the name of your
  application, such as `MTGExampleApp/1.0`". They add: **"Do not allow HTTP
  libraries to choose the header for you."**
- The `Accept` header "must be present, but you can provide a generic
  preference" — both `*/*` and `application/json;q=0.9,*/*;q=0.8` are named as
  acceptable.

Note what this means for the earlier assumption that a browser-shaped UA was
the workaround: probe C shows it *works*, and Scryfall's rule shows it is
**wrong to use**. An honest identifying UA is both compliant and sufficient.
Ours is set in `packages/carddata/src/scryfall/client.ts`:

```
hadoku-cardtable/0.1 (+https://hadoku.me/cardtable/)
```

overridable via `SCRYFALL_USER_AGENT`.

### 1.3 Rate limits — verified

Verbatim from <https://scryfall.com/docs/api/rate-limits>:

| Endpoint | Limit |
| --- | --- |
| `/cards/search` | 2/second (500 ms) |
| `/cards/named` | 2/second (500 ms) |
| `/cards/random` | 2/second (500 ms) |
| `/cards/collection` | 2/second (500 ms) |
| `/cards/manifest` | 10/minute (6,000 ms) |
| everything else | 10/second (100 ms) |

- **The direct file origins have no rate limit.** This is why the bulk archive
  download is not paced, while the `/bulk-data` listing request that discovers
  it is (100 ms bucket).
- A 429 limits access for **30 seconds**. "Continuing to overload the API after
  this point may result in a temporary or permanent ban of your application."
- **"It is not acceptable to ignore HTTP 429 responses. You must act to reduce
  your application's overages."** So our client raises `RateLimitedError` and
  the CLI exits non-zero rather than retrying into a ban.
- They ask that downloaded data be cached "at least for 24 hours", and say
  outright: "If you need to rapidly look up card names, prices, or resolve a
  large number of card images, you **must** use the bulk data files."
- Prices update at most daily; **gameplay data changes far less often** —
  "downloading card data once per week or right after set releases would most
  likely be sufficient."

### 1.4 Usage rules — verified

From the "Use of Scryfall Data and Images" section of
<https://scryfall.com/docs/api>. Their rules, then where we stand:

| Their rule | Us |
| --- | --- |
| No Scryfall logos, and no use of the name implying endorsement | No Scryfall branding anywhere. |
| **No paywalling Scryfall data.** No payments, surveys, subscriptions, ratings, chat-server joins or channel follows in exchange for access | No money, ever (D13). But see §1.6 — the second half of this clause deserves a straight look. |
| Not to create **new games**, or imply the data is from another game | We play Magic, and say so. |
| **"You may not simply repackage, republish, or proxy Scryfall data. Your software must create additional value for end-users."** | We are a drafting and play client, not a card search site. We do not expose a card-data endpoint to anyone. |
| Image rules: do not cover/crop the copyright or artist name, do not distort, recolour, watermark, or imply non-WotC authorship | We hold **no images at all**, so all of these are satisfied by construction. |
| When using `art_crop`, the artist and copyright must be identifiable in the same interface | Relevant to the UI, not this package. We keep the `artist` field locally so the UI *can* satisfy it. |

They close with: "Repeated mishandling or misrepresentation of data or images
in your project may result in Scryfall restricting or blocking your API
access."

### 1.5 Image redistribution — verified, and it matches our posture

The expectation recorded in `LICENSING.md` §3 was that Scryfall's stance would
be "we don't own these, don't mirror them". **What they actually publish is
narrower than that and worth stating precisely:** their image rules govern
*presentation* (don't crop the copyright line, don't distort, don't watermark,
don't imply someone else made the card) and their footer states the images are
"copyright Wizards of the Coast, LLC". They do not, on these pages, publish a
blanket "never cache our images" prohibition.

So: **our no-images rule is stricter than Scryfall requires, and it stays.** It
is driven by `LICENSING.md` §2 — WotC's IP, not Scryfall's terms — and by the
plain fact that nobody, Scryfall included, is in a position to license card art
to us. Do not relax D13 on the grounds that Scryfall did not forbid it.

Two related facts, both verified, that support the client-side-only design:

- The image origins **set CORS headers** for `GET`/`HEAD`/`POST`/`OPTIONS`,
  provided the request carries a matching `Origin` header
  (<https://scryfall.com/docs/api/http-concerns>). A browser can therefore
  fetch card art directly.
- Their published CSP guidance grantlists `*.scryfall.com` (or, exhaustively,
  their API origin under `connect-src` and their image origins under
  `img-src`). That is the UI's job to configure; **the server needs neither.**

### 1.6 One tension, stated plainly rather than buried

Scryfall's anti-paywall rule ends: *"If you have an account system, end-users
should be able to access card data anonymously or with free accounts."*

Cardtable is behind a friend-tier gate with no public or anonymous tier, and
that gate is non-negotiable (D13, `CLAUDE.md`). We take no money in any form,
so the paywall clause proper is not engaged. But the trailing sentence asks for
anonymous or free-account access, and **we do not offer either.**

The honest reading is that this clause is aimed at people gating *card data* —
search results, price lookups, a card database — behind a signup wall or a
Discord join, and that a private group playing a game together is not the
target. We also never re-serve Scryfall's data as data: it is engine input
behind a login, not a product. That is a reasonable position, not a certain
one, and it is written down here so nobody later mistakes silence for
clearance.

**Not verified:** whether Scryfall would consider a private friend-group gate
acceptable. Nobody has asked them. If this ever stops being a handful of
friends, ask before scaling — that is the same trigger `LICENSING.md` §2 rule 7
already sets.

---

## 2. The ingest

`packages/carddata`. **Zero runtime dependencies** — Node 24 builtins only
(`fetch`, `node:zlib`, `node:stream`, `node:readline`, `node:fs`). There is no
build step: Node 24 strips TypeScript natively, so the files in `src/` are what
run.

### 2.1 The command

```sh
pnpm --filter @hadoku/carddata sync
```

Options (pass after `--`):

| Flag | Meaning |
| --- | --- |
| `--type=<name>` | bulk file to ingest. Default `oracle_cards`. Also `default_cards`, `unique_artwork`, `all_cards`. |
| `--out=<dir>` | cache directory. Default `packages/carddata/data/`. |
| `--force` | re-download even when the cache already matches Scryfall's timestamp. |
| `--limit=<n>` | stop after *n* cards. Smoke tests only — writes a deliberately partial cache and says so. |

Exit codes: `0` success · `1` failure · `2` bad arguments · `3` rate limited.

**Run it on a schedule, never per request.** Weekly, or after a set release, is
what Scryfall themselves suggest for gameplay data (§1.3).

### 2.2 What it writes

Into `packages/carddata/data/` (already gitignored by the root `data/` rule —
verified with `git check-ignore`):

- `cards.jsonl` — one projected card per line.
- `manifest.json` — `bulkType`, `sourceUpdatedAt` (Scryfall's timestamp, used
  as the freshness key), `ingestedAt`, `cardCount`, `limit`, `skippedLines`.

A re-run whose `sourceUpdatedAt` still matches the listing skips the download
entirely. `cards.jsonl` is written to a `.partial` file and renamed only on
success, so an interrupted run cannot leave a truncated cache that looks whole.

Why `oracle_cards` by default: one object per Oracle ID is exactly the
granularity a rules engine and a cube list need, at roughly a third the size of
`default_cards`. Switch to `default_cards` when you need every printing — which
is what resolving a cube line's `Name|SET|artIndex` to a specific card will
eventually want.

### 2.3 How "no images" is enforced

Not by stripping image fields. By an **allowlist** of the fields we keep
(`src/scryfall/project.ts`), which is the only version of this that stays true:

- A denylist would have to name the image fields, would silently start storing
  anything Scryfall adds in a later schema change, and is one typo from caching
  art. An allowlist cannot be wrong that way — a field not named is never
  written, today or after any upstream change.
- It recurses into `card_faces` and `all_parts`, which carry their own image
  references on split and transform cards.
- **No prices, no purchase links, no back-links.** Prices are dropped on
  principle (no money, ever) and because Scryfall calls bulk prices
  "dangerously stale after 24 hours".
- `artist` **is** kept. It is attribution text, not art, and it is what lets the
  UI identify the artist beside an image it fetched itself (§1.4).

Two independent checks back this up:

1. `src/scryfall/project.test.ts` asserts the projected key set is a **subset of
   the allowlist** for inputs carrying unknown keys — proving *any* unlisted
   field is dropped, which is stronger than proving one named field is. A
   further test rejects any allowlist entry whose name matches
   `img|image|art_crop|picture|thumb|illustration|uri|url|price|purchase`.
2. The repo's gate over the source:

   ```sh
   grep -rniE "\.jpg|\.png|image_uris|scryfall\.io" packages/carddata/src; echo $?
   ```

   must print nothing and exit **1**. It does.

The 55 MB cache produced by a real full run was scanned as well: 44 distinct
top-level keys across 38,740 cards, none image-, URI- or price-bearing, and
zero raw occurrences of the gated tokens anywhere in the file.

The download URL is **taken from Scryfall's listing response**, not hardcoded,
so no file-origin hostname appears in our source at all. It is required to be
HTTPS.

### 2.4 Verified end-to-end

Full run on 2026-09-11 against live `oracle_cards`
(source timestamp `2026-09-11T21:01:55.052+00:00`, 24.6 MB compressed):
**38,740 cards** written, `skippedLines: 0`, exit 0. A second run correctly
reported the cache current and downloaded nothing. A `--limit=500` run produced
exactly 500 cards and no leftover `.partial`.

### 2.5 Prior art

Forge does the same thing in
`forge/forge-gui/src/main/java/forge/gui/download/ScryfallBulkDataSync.java`,
with pacing in `forge-core/src/main/java/forge/util/ScryfallRateLimiter.java`.
Both were read before this was written. Two deliberate divergences:

- Forge syncs bulk data **to warm an image cache**. We do not have one, so our
  ingest keeps gameplay fields and Forge's keeps artwork UUIDs.
- Forge's UA is `Forge/<version>` (`BuildInfo.getUserAgent()`); ours identifies
  this project.

Forge's rate-limit constants agree with the live docs (2/s search, 10/s
default, 30 s cooldown), which is a useful cross-check on §1.3.

---

## 3. Cube lists and the `.dck` format

### 3.1 The files

`cubes/` holds **95** `.dck` files copied byte-identically from
`forge/forge-gui/res/cube/` (`diff -rq` clean). Filenames are unchanged —
spaces, apostrophes and all — so each still lines up with its counterpart in
`forge/forge-gui/res/draft/*.draft`.

**The tracker says 96 cubes; there are 95.** `res/cube/` contains 95 `.dck`
files and `res/draft/` contains 96 `.draft` files, so the 96 is the *draft*
count. Corrected here rather than propagated.

Totals across all 95: **49,345** distinct card lines in the `main` sections.

### 3.2 The format, as Forge actually reads it

`src/dck.ts` is a faithful reimplementation of Forge's own reader, not a guess.
Each rule cites the file it came from:

| Rule | Source |
| --- | --- |
| `[section]` headers; `#` comments; **anything before the first header is discarded** | `FileSection.java:102` |
| Card line `((\d+)\s+)?(.*?)` — count optional, defaults to 1; `;` and `#` are comments | `CardPool.java:413,435` |
| `Name\|SET\|artIndex\|[collector]\|#flags`, in that precedence order | `CardDb.java:237` |
| `\|`-split **drops empty segments**, so `Name\|\|2` is `Name` + artIndex 2 | `TextUtil.java:110` |
| Foil is a trailing `+` on the name | `CardDb.java:43,249` |
| Art index is numeric and **at most two digits**; `$alt` marks the back face | `CardDb.java:216`, `ImageKeys.java:39` |
| Collector number is `[...]`; when present the art index is *not* defaulted | `CardDb.java:208,284` |
| Set code `???` means "unknown" → `null` | `CardEdition.java:264` |

Quirks that are faithful, not bugs:

- **`isSetCode` is just "not numeric"**, and it is tested first. So `Name|[42]`
  — a collector number with no set — is read by Forge as the *set code* `[42]`.
  None of the 95 vendored cubes exercise this. Diverging would make us disagree
  with the engine that owns the format.
- Forge's `artPrefs` "preferred art" lookup (`CardDb.java:275`) is **not**
  reproduced: it is interactive client state, not part of the file format.

Real-world variation the parser has to survive, all measured across the 95
files: `[main]` 60× vs `[Main]` 35× and `[Sideboard]` 10× vs `[sideboard]` 2×
(so section keys are lowercased); 8 files carry `[Planes]`, `[Schemes]`,
`[Conspiracy]` or `[Avatar]` sections and 6 carry `[Dungeon]`; 72 card lines
carry no set at all; 3,991 carry a third field; 12 files are UTF-8 rather than
ASCII (`Dandân`, `El-Hajjâj`).

### 3.3 The test

```sh
pnpm vitest run packages/carddata
```

29 tests, exit **0**. It parses five real cube files and asserts both the
distinct-line count and the summed card count:

| File | entries | cards |
| --- | --- | --- |
| `ArabianExtended.dck` | 96 | 195 |
| `Adam Styborkski's Pauper Cube.dck` | 395 | 395 |
| `MTGO Vintage Cube 2022-02.dck` | 540 | 540 |
| `Amaz Peasant Cube.dck` | 600 | 600 |
| `Legendary Cube.dck` | 598 | 598 |

Every count was cross-checked with an independent `awk` pass before being
written down, rather than taken from the parser being tested — and rather than
from the cube's name, which `Hypercube (383 cards).dck` is a standing reminder
not to trust.

`ArabianExtended` is in the list precisely because 96 lines yield 195 cards: one
line reads `100 Suleiman's Legacy|VIS`. A count regex that assumed a single
digit would silently lose 99 cards, so there is a test for exactly that.

A final case walks **all 95 files** and asserts that the number of parsed
entries equals the number of non-blank, non-comment lines inside card sections
— the check that catches a line the parser quietly drops — plus the 49,345
total.

---

## 4. What is not done

- **No card-name → card-data resolution yet.** The `.dck` parser produces
  `Name|SET|artIndex` requests and the ingest produces Oracle records; nothing
  joins them. That needs `default_cards` (per-printing) rather than
  `oracle_cards`, and belongs with the draft engine in PR-2.
- **No scheduler.** The command is schedule-*able*; nothing schedules it. Wire
  it up when there is a deployment to wire it into.
- **`res/draft/*.draft`** (the 96 draft-pack definitions that pair with these
  cubes) are **not** imported. Pack collation is PR-2 / O2 territory.
