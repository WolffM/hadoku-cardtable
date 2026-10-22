# Licensing

Two separate questions that get conflated constantly:

1. **Software licence** — GPL-3.0, inherited from Forge. Well-defined, and we
   comply by construction.
2. **Wizards of the Coast IP** — *not* well-defined, and the actual risk.

**Not legal advice.** This is engineering notes on how to stay in the low-risk
part of the space.

---

## 1. GPL-3.0

Forge is **GPL-3.0-or-later** — confirmed, not assumed: `forge/LICENSE` is the
GPL-3 text, and 491 Java files carry the header *"either version 3 of the
License, or (at your option) any later version"*.

### What we did and what it costs

We chose to **vendor Forge into this repo**. The consequence, accepted
deliberately: **this whole repo is GPL-3.0.** `LICENSE` at the root is the GPL-3
text, and that's correct.

### The obligation triggers on *distribution*, not on *running*

GPL-3 obligations attach when you **convey** the software — hand someone a
binary. It is **not** the AGPL. Running a modified Forge on the host and letting
friends connect over the network is **not** conveying, and triggers no
source-offer obligation.

That distinction stops mattering the moment we do **P2**. P2 hands friends a
Forge desktop client to play matches in. If that client is *modified*, we are
conveying a modified GPL-3 work and owe every recipient the complete
corresponding source under GPL-3.

**So, a design rule for P2:** ship friends the **stock upstream Forge build**,
unmodified, and keep our changes server-side. If P2 ever needs a patched client,
that's fine too — but it means publishing this repo, which we should be happy to
do anyway. Just make it a decision rather than an accident.

### Where the licence boundary actually sits

The two-process topology in `ARCHITECTURE.md` is not only an engineering
preference. The FSF's own position is that separate programs communicating at
arm's length — separate address spaces, a socket, a documented protocol — are
separate works, whereas linking into one process is not.

- **Inside the JVM** (`forge-net-json`, the `IToClient` implementation, the
  headless `server` mode): derivative of Forge. GPL-3. Fine — publish it, and
  push the `server` mode upstream.
- **The Node room server**: a separate process over a socket. Not forced to GPL
  by the socket alone — **but it is GPL-3 anyway**, because it's in this repo and
  we vendored Forge here.

That last point is a concrete argument for the extraction request in
`requests/WATCHPARTY_ROOM_MODULE.md`, and **the extraction has happened**: the
room layer lives in the watchparty repo as **`@wolffm/rooms-protocol`** and
**`@wolffm/rooms-server`** (MIT), published `0.38.109` on 2026-09-14. (It was
requested as `@wolffm/rooms`; that name never shipped and still resolves E404 —
don't cite it.) Consuming them as dependencies keeps them MIT and reusable by
every other hadoku app. If we instead copied them in here, **our copy becomes
GPL-3** and can't flow back. Extraction was the licence-clean option, not just
the tidy one.

The direction matters and only works one way: **MIT → GPL-3 is fine**, which is
the direction we need. GPL-3 → MIT is not, which is why D12's clean-room
firewall on P4 exists — our P3–P6 contributions land in *their* MIT packages and
must not be derived from Forge's GPL-3 source.

### The one MIT file inside this GPL tree

**`packages/room-ask` is MIT** and everything else here, including the repo
root, is GPL-3.0-or-later. That is D16, and it is the only carve-out. It works
for one reason and would not work without it: the package is **not a derivative
of Forge** — it was written under D12's clean room by an agent that read
`docs/requests/P4_ASK_REGISTRY.md` and nothing else, so copyleft never attached.
It is MIT rather than GPL because it was specified as watchparty's P4 and MIT is
the only licence their MIT packages could consume.

Checkable, and worth re-checking rather than trusting: `packages/room-ask/LICENSE`
carries the MIT text, `src/index.ts:2` carries
`SPDX-License-Identifier: MIT` in its opening block comment,
and `grep -rniE 'forge|replypool' packages/room-ask/` returns nothing. **If that
grep ever hits, D16 is void** and the file is relicensed GPL or discarded —
D20 records that as the package's death condition, along with the two others.
The sibling `packages/room-store` is GPL-3.0-or-later precisely because it is
ours and is not going upstream.

### Checklist

- [x] `LICENSE` = GPL-3.0 at repo root
- [x] Exactly one MIT carve-out (`packages/room-ask`, D16), with its own
      `LICENSE` and SPDX header, and no Forge reference in it
- [x] `NOTICE.md` credits Forge and links upstream
- [ ] Don't strip or rewrite Forge's per-file copyright headers
- [ ] Keep our Forge changes on a branch that can be published as-is
- [ ] Decide P2's client story (stock vs. patched) *before* handing anyone a jar

---

## 2. Wizards of the Coast — the part that actually matters

### The Fan Content Policy does **not** cover us. Say so plainly.

It's tempting to cite the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy)
as cover. It isn't. The policy explicitly prohibits using Wizards' IP
**"in other games…regardless of whether it is distributed for free."** A rules
engine that plays Magic is exactly that.

So Forge, XMage, Cockatrice and everything in this category sit in a **tolerated
grey zone**, not a licensed one. They have existed publicly for many years
without being shut down, which tells you something about enforcement appetite —
but "long-tolerated" is not "permitted", and building on that should be a
conscious choice.

The honest summary: **we are doing the same thing thousands of people do with
Forge every day, at the smallest possible scale, for no money, behind a login.**
That is about as far into the safe corner as this activity goes.

### What actually raises risk

Roughly in order of how much attention each attracts:

| Risk | Us |
| --- | --- |
| **Money** — sales, subs, ads, donations, Patreon | **None. Ever.** Not even "buy me a coffee". This is the single brightest line. |
| **Public availability** — open signup, SEO, app stores | Friend-tier edge gate, no public signup, no indexing. **The source is public** (since 2026-10-13, the whole repo and its history); the running app is not — reading the code gives nobody a way to play. |
| **Card images at scale** — hosting/mirroring scans | **Card images are shown, loaded from Scryfall's image CDN (`cards.scryfall.io`).** D15 (2026-09-15) also allowed hosting art on `cdn.hadoku.me`; the per-card manifest that would point at it is currently empty, so nothing is served from there today. Either way the art is a replaceable placeholder; §3.1 records the trade. Before D15 this row read *"Never mirror."* |
| **Looking official** — WotC logos, mana symbols, set symbols, the Magic wordmark, card frames | **Mana and set SYMBOLS ship from Keyrune and Mana** as of 2026-09-27 (D20) — third-party fonts, not WotC's own files; §3.2 records the trade. No WotC **logo**, no Magic **wordmark**, no card **frames**, and the UI still says unofficial. Before that date this row read *"Our own visual language. No WotC marks anywhere in the UI."* |
| **Scale / visibility** — big playerbase, streams, press | A handful of friends |
| Card names + Oracle text | Unavoidable for any engine; functional; lowest-attention item on this list |

### Concrete rules for this repo

1. **No money, in any form, ever.**
2. **Image bytes never enter this repo, and a card's art is a lookup.**
   D15 (**2026-09-15**, superseding D13's image clause) allowed the app to show
   and host card art. Until then this rule read *"Never commit or host card
   images"* — §3.1 records why it changed, because a rule that changes without
   a recorded reason is one that flips back.
   - **Still absolute:** no image file is ever committed. `.gitignore` refuses
     `cards/`, `card-images/`, `*.jpg` and `*.png` with no exceptions (the
     documentation-screenshot exception was removed on 2026-10-03 and the
     screenshots it had let in were deleted on 2026-10-11), and
     `scripts/d13-gate.sh` — run by CI — fails the build if an image file
     reaches the built bundle.
   - **The art is a placeholder.** The operator expects to re-source it. A
     card's art is a lookup, not a URL: `apps/ui/src/draft/art-manifest.json`
     maps `scryfallId → { source, key }` and
     `packages/carddata/src/art/index.ts` resolves it, falling back to
     Scryfall's CDN for any card without a row (today, every card). Repointing
     one card is a one-line data edit. Keep it that way — a component that
     hardcodes an image host has broken this rule even if every URL it emits is
     legal.
3. ~~**Our own origin never serves an image.**~~ **REPEALED 2026-09-19 — D18.**
   The rule required every art URL to be absolute on `cdn.hadoku.me` or
   `cards.scryfall.io`, and `scripts/d13-gate.sh` failed a relative or
   same-origin one. The operator repealed it as stricter than needed for a
   private, non-commercial, friend-tier app.

   **The counter-argument, kept because it is what the rule was for:** a policy
   is not a licence. Copying an unaltered image is still reproduction, and
   WotC's Fan Content Policy is permission that can be withdrawn rather than a
   grant. Serving art from our own origin makes this app the image host, which
   is a different posture from linking to one.

   **Why it was nonetheless a reasonable call.** Nothing in the row table above
   moved. The exposure was always carried by *scale* and *money*, and both
   mitigations are untouched: no revenue in any form, a friend-tier gate, a
   handful of players, and the `NOTICE.md` disclaimer. The repealed rule was
   belt-and-braces on top of those, not one of them.

   **What survived, and why.** The gate still fails image BYTES in the bundle
   and a copied Scryfall `image_uris`/`image_status`/`art_crop` blob. Neither
   is a copyright control: the first is a bundle-size rule, the second is what
   keeps a card's art a lookup rather than a URL, so re-sourcing the art stays
   a one-line data edit.

4. ~~**No WotC trademarks in the UI.**~~ **Amended 2026-09-27 (D20)** by the
   operator, who chose the established Keyrune and Mana fonts over drawing our
   own symbols.
   **Mana symbols, the tap symbol and set symbols now ship** from those two
   fonts — see §3.2 for what each licence actually says, because the two are
   NOT the same position. Still forbidden, and not loosened by D20: **the WotC
   logo, the Magic wordmark, and card frames.** `ManaPip.tsx`'s old rationale
   (a plain disc and a letter, Phyrexian as a dashed ring) is superseded; its
   token PARSER is not, and is what maps onto the font's classes.
5. **Keep the friend gate.** The `/cardtable/` prefix is friend-tier at the edge.
   Do not add a public tier. Do not add anonymous access "just for the draft".
6. **Carry the disclaimer** in `NOTICE.md`. The UI footer carried it too until
   2026-10-21, when the operator removed it (D23).
7. **If we ever want to open this up** — stop and think properly first. Every
   mitigation above is "we are tiny and private". Opening up removes all of them
   at once.

---

## 3.2 Symbols — D20, and why the two fonts are not one decision

**The operator's call, 2026-09-27:** use established third-party symbol fonts
rather than draw our own, with `keyrune-master.zip` and `mana-master.zip`
supplied. What follows is what those
two packs actually license, checked in the files rather than assumed, because
they differ and the difference is the whole of our position.

**Keyrune — set symbols. The stronger half.**

- Icons and code: **GPL 3.0**. Fonts: **SIL OFL 1.1**. © 2019 Andrew Gioia.
- Its own licence text: the glyphs are *"redrawn by hand and distributed for the
  express purpose of identifying Wizards of the Coast products (i.e., card sets
  and expansions), as provided in the Wizards Play Network Marketing Material
  Policy"*, and *"the use of these trademarks does not indicate endorsement"*.
- So: not WotC's artwork, a third party's original drawings, distributed under a
  stated nominative-use rationale citing WotC's own policy — and **GPL 3.0,
  which is this repo's licence already** (we vendored Forge). A licence match,
  not a tension.
- Coverage checked: all **12** set codes our nine eras need (`AVR DKA ISD M11
  M12 M13 MBS NPH ROE SOM WWK ZEN`) are present, out of 434 glyphs.

**Mana — mana symbols. The weaker half.**

- Font: **SIL OFL 1.1**. CSS/LESS/Sass: **MIT**. mana-font 1.18.0, Andrew Gioia.
- But its README says plainly: *"All mana, tap, and card type symbol images are
  copyright Wizards of the Coast."* The OFL covers the font WRAPPER; the
  artwork's copyright is attributed upstream. There is no redrawn-by-hand claim
  here and no nominative-use rationale in the pack.
- Coverage checked: every token `ManaPip` already parses — `W U B R G C S X`,
  numerals 0–20, tap, hybrid (`ms-wu`), twobrid (`ms-2w`), Phyrexian (`ms-bp`,
  `ms-wup`).

**Still better than the alternative that was on the table.** The other route was
`svgs.scryfall.io/card-symbols/` and `svgs.scryfall.io/sets/` — WotC's own files,
served by a third party, with no licence grant to us at all. Both fonts are a
better position than that, and Keyrune is a genuinely defensible one.

**What holds the posture up is unchanged**, and D20 leans on it exactly as D18
did: **no money**, the **friend gate**, a handful of players, and the disclaimer
in `NOTICE.md`. D20 spends some of the "looking official" mitigation; it spends
none of those four.

**Obligations D20 creates.**

- **Attribution travels with the fonts.** SIL OFL 1.1 requires the copyright
  notice and licence to accompany the font; `NOTICE.md` credits both packs, the
  vendored CSS keeps each pack's copyright line, and the full licence texts sit
  beside the fonts in `apps/ui/src/symbols/LICENSE-keyrune.md` and
  `LICENSE-mana.md`.
- **Do not rename the font files.** OFL's reserved-font-name clause.
- **`mplantin` is not ours to take.** Mana ships a Plantin-alike text face
  alongside the symbols. Plantin is a Monotype typeface, it is a different and
  worse question, and we need none of it. Ship `mana.woff2` and
  `keyrune.woff2`, nothing else from the packs' `fonts/` directories.
- **The image gate does not need changing.** `scripts/d13-gate.sh` matches
  `(jpe?g|png|webp|gif|avif)`; a `woff2` is neither an image file nor a
  `data:image/…` URI, so both fonts pass it as they stand. The gate's arms are
  about raster card-image bytes, which is what "a 5.85 MB inlined PNG is a
  performance bug" meant.

## 3. Scryfall

Card **data** (Oracle text, types, costs, legality) is the practical source for
P1. Scryfall publishes bulk data for this purpose, and Forge already ships an
ingest for it (`forge-gui/src/main/java/forge/gui/download/ScryfallBulkDataSync.java`,
`ScryfallSetSync.java`), so we're not inventing the pattern.

### The 403 was a phantom

This section used to carry a ⚠️ saying `scryfall.com/docs/api` returned **403**
and that everything below was from memory. It doesn't, and it wasn't policy.
Verified by Wave 1 lane C (`7db43ca`), re-run by the Wave 2 manager, and
re-fetched again on 2026-09-14 while writing this:

- no `User-Agent`/`Accept` → **400**, with Scryfall's own error text explaining
  that both headers are required
- an honest `User-Agent` + `Accept` → **200**
- `server: cloudflare`

It was Cloudflare bot-filtering the *fetching tool's* egress, not Scryfall
refusing us. The ⚠️ was wrong for three days and nearly fossilised into "their
terms are unknowable".

Their required headers, quoted from the live page: *"All HTTP requests to
api.scryfall.com must include a User-Agent header and an Accept header… Do not
allow HTTP libraries to choose the header for you."* Send a real one naming this
app. The page states endpoints have hard rate limits and defers the numbers to
the per-endpoint docs; we don't press on that boundary because we pull **bulk
data on a schedule** rather than per-card.

### 3.1 Their image rules govern *presentation*, not redistribution

This is the important correction, and it points the opposite way from what the
old ⚠️ guessed.

Every image guideline Scryfall publishes is about **how an image is displayed**:
don't cover, crop or clip off the copyright or artist name; don't distort, skew
or stretch; don't blur, sharpen, desaturate or colour-shift; don't add your own
watermarks; don't present a card as though someone other than Wizards made it;
and when using `art_crop`, surface the artist and copyright somewhere in the
same interface.

**Where we stand, as of 2026-10-11.** Art is loaded by the browser straight
from **Scryfall's image CDN (`cards.scryfall.io`)**: the art manifest is empty,
so `packages/carddata/src/art/index.ts` resolves every card to Scryfall. Each
guideline against what the UI actually does:

| Their guideline | What we do |
| --- | --- |
| Don't cover, crop or clip the copyright line or the artist name | Card tiles show the **whole card face** at its own 488 / 680 ratio, so the artist and copyright lines printed on the card stay visible. Three places show **cropped art** instead — the stack's ability chip, the deck-chooser tiles, and the `/cover` tile (Scryfall's `art_crop`) — and each carries an *"Illus. <artist>"* credit. Counters and relation badges sit clear of the card's credit strip. |
| Don't distort, skew, stretch, blur, sharpen, desaturate or recolour | Images are drawn at their true ratio, and no CSS `filter` is applied to card art at rest. States such as summoning sickness are shown with an overlay on top of the card, not by altering the image. **One knowing departure (D22):** while a spell is held on the stack, its face is drawn through a slight heat haze and `saturate(1.16)`. Both drop off as it resolves. |
| Don't add your own watermark | Nothing is added to or baked into the image; overlays are separate elements. |
| Using `art_crop` obliges you to surface artist + copyright in the same interface | Engaged by the three cropped views above; each names the artist, on the art itself, and only while that art is drawn: a chip whose source has no printed art of its own (an emblem, an effect, a token with no art row) draws neither. **One knowing departure:** the emblem medallions around a player's avatar (14 px circles of the emblem's source art) carry no credit since 2026-10-21 — the operator, on the avatar's emblem hover: *"we don't need to show the 'illustration and copyright WOTC' in the text."* Asked directly whether the circles' source art may go uncredited, the operator chose (2026-10-21): *"Keep it, no credit"*, over moving the credit into the hover chip or drawing a star mark instead of the art. |
| Don't present a card as though someone other than Wizards made it | `NOTICE.md` carries the unaffiliated/unendorsed disclaimer; the UI footer no longer does (D23). No WotC logo, wordmark or card frame appears in our own chrome (§2 rule 4). |

**There is no blanket prohibition on caching, storing or serving the image
bytes** in Scryfall's terms. The nearest thing is a *data* rule — *"You may not
simply repackage, republish, or proxy Scryfall data. Your software must create
additional value for end-users."*

#### How we got here

Until **2026-09-15** this section concluded that we would show no card images at
all (D13), stricter than Scryfall requires, because card art belongs to Wizards
and the artists and nobody — Scryfall included — can license it to us. That
argument was never refuted; it was weighed and overruled:

- **D15 (2026-09-15)** allowed card art, including hosting it on
  `cdn.hadoku.me`, on the grounds that the project takes **no money**, sits
  behind a **friend gate**, and holds the art as a **replaceable placeholder**
  behind the per-card manifest. `cdn.hadoku.me` is public-read by design, so
  anything uploaded there is fetchable by URL; that was accepted knowingly.
- **D18 (2026-09-19)** repealed "our own origin never serves an image" (§2 rule 3).

This is a **judgement, not a compliance argument**. Showing card art moves us up
§2's risk table, and no reading of Scryfall's terms grants the permission that
only Wizards and the artists could give. What carries the posture is unchanged:
no money, no public tier, a handful of players, and the disclaimer. If art is
ever hosted at more than one cube's scale, bring it back to the operator first.

### 3.2 The anti-paywall clause, and the tension we are not resolving

Quoted in full, because paraphrasing it is how it gets waved away:

> *"You may not 'paywall' access to Scryfall data. You may not require anyone to
> make payments, take surveys, agree to subscriptions, rate your content, join
> chat servers, or follow channels in exchange for access to Scryfall data. If
> you have an account system, end-users should be able to access card data
> anonymously or with free accounts."*

Where we stand against it, honestly, both halves:

- **The paywall proper is not engaged.** We take no money in any form, ever
  (§2, rule 1, and the brightest line in `CLAUDE.md`). No payments, no
  subscriptions, no surveys, no ratings, no follows. That is the clause's
  subject and we are clear of it by construction.
- **The last sentence we do not satisfy.** We have an account system — the
  friend-tier gate — and it offers **neither** anonymous access **nor** free
  accounts. There is no signup at all. You are on the list or you are not.

Those two facts do not cancel out and this document is not going to pretend
they do. Note also that the enumerated list is not purely financial: *"join
chat servers, or follow channels"* are social gates, not payments, which is the
part of the clause nearest to what a friend gate actually is.

**The tension, written down rather than resolved:**

1. The clause's evident purpose is to stop people **monetising or farming
   engagement off** Scryfall's free database. We do neither, and a private
   eight-person tool is not the harm it was written against.
2. The clause's literal text says end-users of an account system should be able
   to get at card data anonymously or with a free account. We do not offer
   that, and we are not going to — **the friend gate is itself one of §2's
   primary WotC-IP mitigations** (`CLAUDE.md`: "Never add a public or anonymous
   tier, not even 'just for drafting'"). Opening access to satisfy Scryfall
   would worsen the larger risk.
3. So the two mitigations **pull against each other**, and we have chosen the
   WotC one. That is a judgement, not a compliance argument.
4. Scryfall's own remedy is stated and proportionate: *"Repeated mishandling or
   misrepresentation of data or images in your project may result in Scryfall
   restricting or blocking your API access."* The downside risk here is losing
   bulk-data access, which would cost us an ingest, not a lawsuit.

**Do not "fix" this by opening a public tier.** If it ever needs resolving, the
resolution is on the other side: ask Scryfall, or source the data elsewhere.

One more thing worth noticing: Scryfall offers this database *"As part of the
Wizards of the Coast Fan Content Policy"* — the same policy §2 says does not
cover a rules engine. We are consuming data offered under a policy that does
not cover our use of it. That doesn't change what we do; it does mean §2, not
§3, is where our actual exposure lives.

### 3.3 What we do

**Data** — design intent unchanged by any of the above: **pull bulk data on a
schedule, cache the JSON locally, and never hammer the API per-request.** The
ingest projects a named subset of fields rather than passing bulk records
through — which is also what keeps us clear of *"simply repackage, republish, or
proxy"*. It carries **no `image_uris`, no `image_status` and no `art_crop`**: the
payload carries a `scryfallId` and the client builds the URL. See
`docs/CARD_DATA.md` and the D13 gate (`scripts/d13-gate.sh`, run by CI), which
fails the build if any of those blobs reaches the bundle.

**Images** — browsers load card art from Scryfall's image CDN at the sizes the
UI needs (`normal` for tiles, `art_crop` for the cover tile). The bytes are
never modified, never committed to git and never bundled. The manifest keeps the
source swappable per card: `packages/carddata/src/cli/upload-art.ts` can upload
art to `cdn.hadoku.me` and point manifest rows at it, which is not in use today.

There is **no prescribed attribution string** on Scryfall's pages. The
attribution-shaped obligations are the image ones in §3.1 (artist and copyright
visible: the printed lines on whole card faces, an *"Illus. <artist>"* credit on
cropped art) and "don't imply Scryfall endorsed you". We carry a Scryfall credit
anyway, in `NOTICE.md`.
