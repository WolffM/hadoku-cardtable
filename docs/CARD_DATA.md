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
| Image rules: do not cover/crop the copyright or artist name, do not distort, recolour, watermark, or imply non-WotC authorship | Satisfied by **mechanism**, not by absence. This cell used to read *"we hold no images at all"*; since D15 we host card art on `cdn.hadoku.me`. What holds the rules now: we serve the **whole unmodified card face**, never `art_crop`; the `.card:has(.card__art) { aspect-ratio: 488 / 680 }` rule in `apps/ui/src/styles.css` means `object-fit: cover` crops nothing, so the artist and © lines printed at the card's foot stay legible; no `filter` touches `.card__art`; and the CDN is content-addressed by SHA-256, so the bytes served are provably the bytes fetched. Same table as `LICENSING.md` §3.1 — keep the two in step. |
| When using `art_crop`, the artist and copyright must be identifiable in the same interface | **Not engaged** — we do not use `art_crop`; the whole card face carries both. Relevant to the UI, not this package. We keep the `artist` field locally so the UI *can* satisfy it if that ever changes. |

They close with: "Repeated mishandling or misrepresentation of data or images
in your project may result in Scryfall restricting or blocking your API
access."

### 1.5 Image redistribution — verified, and our posture changed around it

The expectation recorded in `LICENSING.md` §3 was that Scryfall's stance would
be "we don't own these, don't mirror them". **What they actually publish is
narrower than that and worth stating precisely:** their image rules govern
*presentation* (don't crop the copyright line, don't distort, don't watermark,
don't imply someone else made the card) and their footer states the images are
"copyright Wizards of the Coast, LLC". They do not, on these pages, publish a
blanket "never cache our images" prohibition.

The finding above is about **Scryfall** and it has not changed. What changed is
what we do with it. Until 2026-09-15 this paragraph read:

> **Our no-images rule is stricter than Scryfall requires, and it stays.** It is
> driven by `LICENSING.md` §2 — WotC's IP, not Scryfall's terms — and by the
> plain fact that nobody, Scryfall included, is in a position to license card art
> to us. Do not relax D13 on the grounds that Scryfall did not forbid it.

**The operator repealed that rule** on 2026-09-15 — `DECISIONS.md` **D15**, which
supersedes D13's image clause. Card art is hosted on `cdn.hadoku.me`, as a
replaceable placeholder behind a per-card manifest.

The warning in the quoted paragraph is still worth heeding on its own terms, and
the two facts sit together without contradiction:

- **The permission we lacked was never Scryfall's to give.** D15 is a judgement
  about WotC's and the artists' IP, weighed by the operator against no money, a
  private friend gate, and art held as a placeholder. It is **not** derived from
  the "no blanket prohibition" finding above, and nobody should cite that finding
  as authority for anything. See `LICENSING.md` §3.1 for the full register,
  including what it costs on §2's risk table.
- **The narrower claim in this document is still true.** The card-*data*
  ingest and `pool.json` carry no image field and no image URL — see §2.3, which
  is a live control and not a historical note.

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

**For card resolution (§5) you want `--type=default_cards`.** The default
`oracle_cards` file has one entry per Oracle ID and carries no per-printing
`set`/`collector_number`, so it cannot answer a `name`+`set` lookup at all.
`resolve-cubes` refuses to run against it rather than reporting a corpus-wide
failure that is really a wrong cache.

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
is exactly what §5's resolver needs, and what it insists on.

### 2.3 How "the ingest holds no image data" is enforced

**Read the scope of this section first, because it narrowed on 2026-09-15.** It
used to be headed *"How 'no images' is enforced"* and it stood for a
project-wide claim. That wider claim is gone: D15 repealed it and card art is
hosted on `cdn.hadoku.me`.

What is **still true, still enforced, and must not be softened** is the narrow
claim about this package:

- **The card-data projection has no image field.** `ALLOWED_CARD_FIELDS` names
  none, `resolve.ts` emits none, and `pool.json` carries ids and no URLs.
  `build-pool.ts` prints its runtime control on every run —
  `D13 control: N cards, no image field and no image URL.` —
  and `project.test.ts` and `resolve.test.ts` both still bite on it.
- **Art lives in a separate file that `build-pool` never writes.**
  `apps/ui/src/draft/art-manifest.json` maps `scryfallId → { source, key }`.
  That separation is deliberate and load-bearing: the pool is regenerated
  wholesale, so art assignments kept inside it would be silently discarded by
  the next regeneration. Do not "simplify" by merging them.
- **Enforcement is now two controls, not one:** the projection allowlist below,
  and `scripts/d13-gate.sh` (run by CI against `apps/ui/dist`), which fails the
  build on shipped image bytes, on image bytes inlined as a `data:image/…` URI,
  on a relative or same-origin image URL **in any JS quoting or bare in CSS
  `url(...)`**, and on a copied `image_uris` / `image_status` / `art_crop` blob.
  The first keeps images out of the **data**; the second keeps the app's own
  origin from **serving** them. `bash scripts/d13-gate.sh --self-test` proves
  the second bites, in both directions, without touching a real bundle.

The allowlist itself, unchanged:

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
2. A gate over the projection source:

   ```sh
   grep -rniE "\.jpg|\.png|image_uris|scryfall\.io" \
     packages/carddata/src/scryfall/project.ts packages/carddata/src/resolve.ts
   echo $?
   ```

   must print nothing and exit **1**. Verified 2026-09-15: it does.

   **This grep used to be scoped to all of `packages/carddata/src` and it no
   longer can be.** That wider form now exits **0** — legitimately — because
   `src/art/index.ts` names `cards.scryfall.io` and `cdn.hadoku.me` as the two
   allowed art origins, and `src/cli/upload-art.ts` exists to fetch and upload
   art. Both are D15 working as designed. Left un-narrowed, the gate would be a
   red build for doing the right thing; left un-narrowed *and* then deleted for
   being noisy, the projection invariant would lose its cheap check. So it is
   scoped to the two files the invariant is actually about. A grep is only ever
   a proxy here — check 1 above, the allowlist-subset test, is the real control.

The 55 MB cache produced by a real full run was scanned as well: 44 distinct
top-level keys across 38,740 cards, none image-, URI- or price-bearing, and
zero raw occurrences of the gated tokens anywhere in the file.

The bulk-download URL is **taken from Scryfall's listing response**, not
hardcoded, so no bulk-file hostname appears in our source at all. It is required
to be HTTPS. (The two *image* hostnames do appear, deliberately and in exactly
one place each — `SCRYFALL_IMAGE_BASE` and `CDN_BASE` in
`packages/carddata/src/art/index.ts`. That is D15's art path, not this ingest.)

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
files. The 96 came from `res/draft/`, which holds 96 *entries* — and those are
**94 `.draft` files, a `rankings/` directory, and `rankings_cubecobra.txt`**,
not 96 recipes. (Wave 1 wrote "96 `.draft` files" here; re-counted in Wave 2
against the same tree, it is 94. See §4.1.)

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

Exit **0** (74 tests in this package as of Wave 2; 29 of them are Wave 1's
`.dck` and projection tests). It parses five real cube files and asserts both the
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

## 4. Draft recipes and the `.draft` format

A `.dck` says which cards are in a cube. A `.draft` says how packs are made out
of them. Both halves are needed before anyone can sit down at a pod, and Wave 1
imported only the first.

### 4.1 The files

`drafts/` holds **94** `.draft` files copied byte-identically from
`forge/forge-gui/res/draft/` (verified with `cmp` per file, all 94 clean).

`res/draft/` has **96 entries, not 96 recipes**: these 94, a `rankings/`
*directory*, and `rankings_cubecobra.txt`. Neither of the last two is a recipe
and neither is imported — this repo's draft bots are a heuristic, not a
rankings table (Wave 2, settled).

**95 cubes, 94 recipes.** `ArabianExtended.dck` has no recipe.

### 4.2 The format, as Forge actually reads it

`src/draft.ts`, again a reimplementation with each rule cited:

| Rule | Source |
| --- | --- |
| The whole recipe: seven keys read, one more defaulted | `CustomLimited.java:104` |
| `key:value`, split on the **first** colon, both halves trimmed, keys case-insensitive | `FileSection.java:85,42` |
| `Booster` split on `,` then each slot on the first space → count, type | `CustomLimited.java:110-114` |
| That split drops empty segments, which is what makes `", 1 Mythic"` parse | `TextUtil.java:110` |
| `NumPacks`/`NumPlayers` are `getInt`, **defaulting to 0** on absent or unparseable | `FileSection.java:151` |
| `Singleton` is `getBoolean`, so absent or non-`"true"` is **false** | `FileSection.java:162` |
| No `Booster` line at all falls back to the generic 10/3/1/1 draft booster | `CustomLimited.java:116` |
| The only caller: `FileUtil.readFile` + `CustomLimited.parse`, per `.draft` file | `BoosterDraft.java:537` |

**Eight keys, not seven.** The wave brief names `Name`, `DeckFile`,
`Singleton`, `Booster`, `NumPacks`, `NumPlayers`, `LandSetCode`. Forge's parser
also reads `CustomRankings`, defaulting to `rankings_cubecobra.txt`
(`CustomLimited.java:123`). No vendored recipe sets it, but it is part of the
format and is parsed rather than silently dropped.

### 4.3 The corpus, re-counted

Measured off the committed files, cross-checked with an independent shell count:

| Booster | Recipes |
| --- | --- |
| `15 Any` | **91** |
| `16 Any` | 1 |
| `9 Any` | 1 |
| `5 Rare, 1 Mythic, 5 Common, 5 Uncommon` | 1 |

- 93/94 `Singleton:True` — the exception is `cube_juzamjedi.draft`, which has
  no `Singleton` key at all, so Forge reads it as **false**.
- 93/94 are 3 packs × 8 players. The exception is
  `The Original Recipe Twobert.draft`: 5 packs × 4 players.
- 4 recipes set `LandSetCode` (`BFZ`, `M11` ×2, `RTR`).
- 0 set `CustomRankings`.

**The board and the Wave 2 plan both say 92 `15 Any`; it is 91.** 91 + 1 + 1 + 1
= 94, which 92 cannot be made to add up to. The tracker owns that row.

The one rarity recipe is **not** special-cased. It parses into four slots like
any other; deciding what `Rare` *means* against a cube pool belongs to whoever
builds packs.

### 4.4 Three things that will bite anyone who assumes

- **`Name` ≠ `DeckFile` ≠ filename.** `Frontier.draft` is named "Frontier
  Draft" and points at the cube named "Frontier Cube", in a file called
  `Frontier Cube.dck`. All three differ.
- **`DeckFile` is matched against the cube's `[metadata] Name=`, not its
  filename.** Forge looks it up as `cubes.get(DeckFile)` against a store keyed
  by `DeckBase::getName` (`DeckStorage.java:50`), and that name comes from the
  `.dck` header (`DeckFileHeader.java:84`).
- **Two of Forge's own recipes therefore find no cube**, and this is an
  upstream defect, not a parser bug:

  | Recipe | Its `DeckFile` | The cube's actual `Name=` |
  | --- | --- | --- |
  | `The Pauper Cube 2026-02.draft` | `The Pauper Cube 2026-02` | `The Pauper Deck 2026-02` |
  | `The Peasant Cube 2023 (June).draft` | `The Peasant Cube 2023 (June)` | `The Peasant Cube 2023` |

  In Forge a missing cube falls through to
  `FModel.getMagicDb().getCommonCards().getUniqueCards()`
  (`CustomLimited.java:126`) — i.e. it drafts the **entire card database**
  instead of the cube. `cubeForRecipe` returns `null` rather than inheriting
  that, so the condition is visible instead of catastrophic.

---

## 5. Card resolution

`src/resolve.ts` turns a cube line's `1 Stoneforge Mystic|PRM` into a real card.

### 5.1 The contract

`(CardRequest, CardIndex) -> ResolvedCard | UnresolvedCard`. **Failures are
returned, never thrown, and never a `null` that becomes a blank card on a draft
table.** A cube that is 97% resolvable is not draftable, and the only way
anyone finds that out before eight people sit down is if the 3% comes back as
data.

Three tiers, each strictly more specific than the next:

| Tier | Match | Picks |
| --- | --- | --- |
| 1 | `name` + `set` + `collector_number` | that exact printing |
| 2 | `name` + `set` | earliest printing in that set |
| 3 | `name` | earliest **non-digital** printing |

Tiers 1 and 2 honour whatever set the cube asked for, **digital sets
included** — `VMA` (Vintage Masters, MTGO-only) is the single most-referenced
set in the corpus at 1,687 lines, and refusing digital printings there would
fail all of them. Tier 3 prefers paper because there the choice of printing is
ours rather than the cube's.

Tier 3 is reached both by bare-name references and by any reference whose set
did not resolve. Those look identical in the returned card and completely
different in a bug report, so a resolution carries `requestedSet`,
`scryfallSet` and a `setFellBack` flag, and the report counts them separately.

### 5.2 Forge set codes are not Scryfall set codes

`src/set-codes.ts` plus the generated `src/set-codes.generated.ts`.

The table is **not ours**. Forge declares the mapping itself, one
`ScryfallCode=` line per edition file, and the generated module is that
declaration extracted verbatim from `forge-gui/res/editions/*.txt`:

- 679 edition files → **760 lookup keys** (`Code`, `Code2` and `Alias` all
  resolve), 668 identity and 92 genuinely different.
- 6 editions declare no `ScryfallCode` and fall back to their own `Code`
  (AKH, DS0, IKO, PLS, TMC, PZA). Recorded in the generated file's header so
  the fallback is visible rather than assumed.
- **1 collision**, resolved `Code` > `Code2` > `Alias`: `ARC` is Archenemy's
  `Code` and also another edition's `Alias` (→ `OARC`). Forge looks up by
  `Code` first, so Archenemy wins and we match.

Across the 95 cubes: **388 distinct Forge set codes**, of which 360 are
identity, **26 genuinely need translating** (covering **679 card lines**), and
2 are unknown to Forge's own edition data. Without the table those 679 lines
would each silently degrade to a tier-3 name match on some other printing.

Regenerate after a Forge bump and `git diff` the result:

```sh
pnpm --filter @hadoku/carddata gen:set-codes -- --editions=<forge-gui/res/editions>
```

It is not run at build time and `forge/` may be absent; the table is committed
precisely so a Forge set-code rename shows up as a diff rather than as a
resolution failure.

### 5.3 Name variants, and why there are four

Within every tier a name is matched through four spellings, best first. Which
one hit is reported as `matchedBy`, because "resolved" and "resolved via an
accent-folded front-face name" are not the same claim and the weaker one
should have to say so.

| Variant | Corpus matches | Why it exists |
| --- | --- | --- |
| `name` | 48,394 | Scryfall's top-level `name`, exact. |
| `front-face` | **942** | Forge writes `Delver of Secrets`; Scryfall's name for it is `Delver of Secrets // Insectile Aberration`. Spans `transform`, `modal_dfc`, `adventure` and `flip`. |
| `folded-name` | 1 | `Jim Davis's Cube.dck` writes `Lim-Dul's Vault`; the card is `Lim-Dûl's Vault`. |
| `folded-front-face` | 0 | Completeness. |

The front-face variant is the whole difference between a usable corpus and an
unusable one: without it 951 references fail and only 12 of 95 cubes resolve
cleanly.

The fold is safe here and that was **measured, not assumed**: across all 36,308
distinct English card and front-face names in the cache, no two fold to the
same key, so the fold cannot introduce an ambiguity. It is still ranked last
and still reported, because that guarantee is about today's card pool.

Two things the index deliberately excludes, because both would return an object
with no mana cost or type line — a blank card by another route:

- **Non-gameplay layouts** (`token`, `double_faced_token`, `emblem`,
  `art_series`). `art_series` is the one that actually bites: 36 of the
  corpus's front-face names have an art-series printing.
- **Non-English printings.** Scryfall gives every printing the English `name`
  regardless of language (the localised string is `printed_name`, which the
  allowlist does not keep), so indexing them would make "earliest printing"
  depend on which translation Scryfall happened to list first.

### 5.4 The report

```sh
pnpm --filter @hadoku/carddata resolve
```

Writes `packages/carddata/reports/cube-resolution.json` — **deliberately not
under any directory called `data/`**, which `.gitignore` refuses repo-wide. A
report that silently fails to commit is worse than no report.

Run 2026-09-14 against `default_cards` (source `2026-09-14T09:05:27.256+00:00`,
117,941 cards; 109,434 printings indexed over 772 sets):

| | |
| --- | --- |
| cubes | 95 |
| card lines (`main`) | **49,345** |
| resolved | **49,337** (99.984%) |
| — tier 1 `name+set+collector` | 989 |
| — tier 2 `name+set` | 48,274 |
| — tier 3 `name` | 74 (only **2** of which asked for a set) |
| unresolved | **8** |
| cubes resolving 100% | **93 / 95** |

**The two that do not:**

| Cube | Unresolved | Rate |
| --- | --- | --- |
| `MTGO Vintage Cube 2025-12.dck` | 6 / 540 | 98.89% |
| `MTG Arena Chromatic Cube June 24.dck` | 2 / 558 | 99.64% |

**All eight unresolved references, individually** — every one a gap in
Scryfall's data, none a resolver failure:

- `Ademi of the Silkchutes`, `Cam and Farrik, Havoc Duo`,
  `Desecrex, Gift of Servitude`, `Goben, Gene-Splice Savant`,
  `Makdee and Itla, Skysnarers`, `The Scouring Stormsoul` — all `|OM1`. The
  set exists in the cache (189 printings); these six cards do not. A partially
  spoiled set. **They will resolve on a later Scryfall sync**, and until then
  `MTGO Vintage Cube 2025-12` is not fully draftable.
- `A-Alrund's Epiphany|KHM`, `A-Omnath, Locus of Creation|ZNR` — Arena
  *rebalanced* cards. Scryfall carries no printing under either name.
  Resolving `A-X` to `X` would be a guess and a wrong one: a rebalanced card
  has different rules text. Refused on purpose.

**The two set codes Forge's own edition data does not know** — both resolved to
a real card at a different printing, and both flagged rather than hidden:

| Forge code | Line |
| --- | --- |
| `PTDM` | `LSVCube.dck:237` `1 Cori-Steel Cutter\|PTDM` |
| `PWOE` | `LSVCube.dck:331` `1 Agatha's Soul Cauldron\|PWOE` |

### 5.5 The regression gate

`resolve-cubes` is **not** the gate — it needs the 180 MB card cache, which is
gitignored and absent in CI. The gate is `src/resolve.test.ts`, which asserts
the committed report's numbers and so runs everywhere `pnpm check` does,
alongside unit tests built on a hand-made index. Re-run the CLI after a Forge
or Scryfall bump and the test tells you exactly what moved.

`pnpm check` → exit **0** (137 tests).

### 5.6 D13 still bites

```sh
grep -rniE "\.jpg|\.png|image_uris|scryfall\.io" packages/carddata/src; echo $?
```

prints nothing, exit **1** — unchanged by any of the above. A second,
independent check lives in `resolve.test.ts`: the resolution path's sources are
read and asserted to name no image field, and every `ALLOWED_CARD_FIELDS` entry
is asserted not to match `image|art_crop|png|jpg|uri`. The resolver reads a
cache that was already projected onto the gameplay allowlist, so there is
nothing image-shaped for it to reach.

---

## 6. What is not done

- **No `.dck` writer.** The parser exists; export does not.
- **No scheduler.** The command is schedule-*able*; nothing schedules it. Wire
  it up when there is a deployment to wire it into.
- **Pack building is not here.** `drafts/` carries the recipes and `resolve.ts`
  carries the cards; turning `15 Any` into eight shuffled packs is the draft
  engine's job (PR-2 lane B), not this package's.
- **`artIndex` is parsed but never used for selection.** It is a Forge-internal
  art-variant ordinal with no Scryfall equivalent; `collector_number` is what
  pins a printing here.
- **Basic lands are not resolved from `LandSetCode`.** Four recipes set it;
  nothing consumes it yet.

