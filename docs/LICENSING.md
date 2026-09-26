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
binary. It is **not** the AGPL. Running a modified Forge on hokon and letting
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
| **Public availability** — open signup, SEO, app stores | Friend-tier edge gate, no public signup, no indexing |
| **Card images at scale** — hosting/mirroring scans | **We host art on `cdn.hadoku.me`** as of 2026-09-15 (D15) — one cube, ~53 MB, treated as a replaceable placeholder. This moved us *up* this row on purpose; §3.1 records the trade and its price. Before that date this row read *"Never mirror."* |
| **Looking official** — WotC logos, mana symbols, set symbols, the Magic wordmark, card frames | Our own visual language. No WotC marks anywhere in the UI. |
| **Scale / visibility** — big playerbase, streams, press | A handful of friends |
| Card names + Oracle text | Unavoidable for any engine; functional; lowest-attention item on this list |

### Concrete rules for this repo

1. **No money, in any form, ever.**
2. **Card art lives on `cdn.hadoku.me`, and image bytes never enter this repo.**
   Changed on **2026-09-15** by the operator (**D15**, superseding D13's image
   clause). Until then this rule read *"Never commit or host card images"* —
   §3.1 keeps that argument in full and records why it was overruled, because a
   rule that changes without a recorded reason is one that flips back.
   - **Still absolute:** no image file is ever committed. `.gitignore` refuses
     `cards/`, `card-images/`, `*.jpg` and `*.png` (its one exception,
     `!docs/**/*.png`, is for documentation screenshots, not card art), and
     `scripts/d13-gate.sh` — run by CI — fails the build if an image file
     reaches the built bundle.
   - **The art is a placeholder.** The operator expects to re-source it. A
     card's art is a lookup, not a URL: `apps/ui/src/draft/art-manifest.json`
     maps `scryfallId → { source, key }` and
     `packages/carddata/src/art/index.ts` resolves it. Repointing one card is a
     one-line data edit. Keep it that way — a component that hardcodes an image
     host has broken this rule even if every URL it emits is legal.
3. ~~**Our own origin never serves an image.**~~ **REPEALED 2026-09-19 — D18.**
   The rule required every art URL to be absolute on `cdn.hadoku.me` or
   `cards.scryfall.io`, and `scripts/d13-gate.sh` failed a relative or
   same-origin one. The operator repealed it: *"this seems unnecessary. i dont
   care to follow this strictness regarding the WOTC ip."*

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

4. **No WotC trademarks in the UI.** No mana symbols, set symbols, tap symbol,
   card frames, or the Magic logo. Draw our own.
5. **Keep the friend gate.** The `/cardtable/` prefix is friend-tier at the edge.
   Do not add a public tier. Do not add anonymous access "just for the draft".
6. **Carry the disclaimer** (`NOTICE.md`, and in the UI footer):
   unofficial, unaffiliated, not endorsed by Wizards.
7. **If we ever want to open this up** — stop and think properly first. Every
   mitigation above is "we are tiny and private". Opening up removes all of them
   at once.

---

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

**We satisfy all of them by construction**, and each one has a specific rule
holding it true. Naming the pairs, so that deleting one of these rules is
visibly deleting a promise and not just a line of CSS:

| Their guideline | The rule that enforces it |
| --- | --- |
| Don't cover, crop or clip the copyright line or the artist name | We serve the **whole unmodified card face**, never `art_crop`. The `.card:has(.card__art) { aspect-ratio: 488 / 680 }` rule in `apps/ui/src/styles.css` pins the tile to the image's own ratio, so the `object-fit: cover` on `.card__art` has nothing left to crop. The copyright and artist lines sit at the bottom of a card — exactly where a mismatched box crops — which is why that one CSS rule is the whole of this promise. |
| Don't distort, skew, stretch, blur, sharpen, desaturate or recolour | Same rule: `object-fit: cover` at the image's true ratio cannot distort. And no `filter` declaration exists on `.card__art`, which the ruleset states in a comment so that adding one reads as the violation it is. |
| Don't add your own watermark | We add nothing to the image. The CDN is content-addressed by SHA-256, so the bytes we serve are provably the bytes we fetched: a modified image would be a different key. |
| Using `art_crop` obliges you to surface artist + copyright in the same interface | Not engaged — we don't use `art_crop`. The whole card face carries both, printed on it. |
| Don't present a card as though someone other than Wizards made it | `NOTICE.md` carries the unaffiliated/unendorsed disclaimer, and no WotC marks appear in our own chrome (§2 rule 4). **Gap, verified 2026-09-15:** the UI footer (`apps/ui/src/App.tsx`) does **not** yet carry that disclaimer — it carries a since-falsified line saying the project "never loads, caches or proxies a card image". §2 rule 6 requires the footer text and it is outstanding. |

Note that these survived the change of posture below untouched — **hosting the
bytes ourselves does not loosen a single one of them.** If anything it tightens
the first row: we now control what is stored, so a cropped or re-encoded upload
would be our doing rather than upstream's.

**There is no blanket prohibition on caching, storing or serving the image
bytes.** We looked for one; it is not there. The nearest thing is a *data*
rule — *"You may not simply repackage, republish, or proxy Scryfall data. Your
software must create additional value for end-users."*

#### What this section used to conclude, and who overruled it

Until **2026-09-15** this section ended on a stronger rule. It is kept here
verbatim rather than deleted, because the argument was carefully built, it was
never *refuted*, and a reader is entitled to see what was traded away:

> **Our no-images rule (D13, and rule 2 in §2) is stricter than Scryfall
> requires, and it stays.** It is not derived from Scryfall's terms and does not
> relax when those terms are read carefully. It is driven by **WotC's IP**: card
> art belongs to Wizards and to the artists, *nobody* can license it to us —
> Scryfall included — and "hosting card images at scale" is the second-loudest
> item on §2's risk table.
>
> Anyone who later finds this section and concludes "Scryfall didn't forbid
> caching, so we can mirror images" has read the right sentence and drawn the
> wrong conclusion. The permission we lack is not Scryfall's to give.

**The operator overruled that rule** — explicitly, three separate times — and
card art now lives on `cdn.hadoku.me`. That is **D15** in `DECISIONS.md`, which
supersedes D13's image clause. The grounds, recorded so nobody has to
reconstruct them:

- **No money, in any form, ever.** §2 rule 1 is untouched and is still the
  brightest line in the project.
- **Private and access-gated.** `/cardtable/*` is friend-tier at the edge and
  answers 401 to anonymous. There is still no public tier and there will not be
  one.
- **The art is a replaceable placeholder.** The operator expects to source art
  elsewhere: *"there's a good chance i source the art from somewhere else in the
  future… just make sure that it's easy to simply hook up a link to a new image
  in the cdn whenever that happens."* So it is held behind an indirection —
  `apps/ui/src/draft/art-manifest.json` (`scryfallId → { source, key }`) resolved
  by `packages/carddata/src/art/index.ts`. **Replacing WotC's art with something
  we commissioned is a data edit, not a refactor.** That is the difference
  between a placeholder and a dependency, and it is why this was affordable.
- **The CDN's public-read posture was seen and accepted.** `cdn.hadoku.me` is
  *"upload friend+, read public"* by design, so every uploaded image is fetchable
  by anyone who has its SHA-256 URL. The operator was shown this and accepted it
  knowingly. Do not "fix" it by putting a gate on the CDN — that is somebody
  else's service and this is not a bug in it.

**Write this down as what it is: a judgement, not a compliance argument.** §3.2
is the model — this document's value is that it refuses to pretend tensions
cancel out, and this one does not cancel either. Honestly stated:

- It **moves us up §2's risk table.** "Card images at scale" goes from *we don't
  do that at all* to *we do some of that*. Hosting is a louder act than linking,
  because we become the party serving the bytes rather than the party pointing
  at someone else's.
- **The permission we lacked was never Scryfall's to give, and still isn't.**
  This is a call about the card publisher's IP — Wizards' and the artists' — and
  no reading of Scryfall's terms grants or withholds it. Nothing below licenses
  anything; it records that a person weighed it.
- **Every other mitigation stays exactly where it was**, which is the whole
  reason the trade was payable: no money, no public tier, no WotC marks, and the
  friend gate. The bundle also still carries zero image bytes — but note that
  since **D18** that is a performance rule (arm 1 of the gate), **not** a
  licensing mitigation: the *"our own origin never serves an image"* rule itself
  is repealed and must not be cited back as live from this list.

Do not read this section as cover. Read it as a recorded decision with its price
named.

**Scale is the part to watch, and it is not settled.** One cube is 534 cards at
roughly 100 KB of art each — about **53 MB**. All 95 bundled cubes is a
different conversation and **nobody has had it yet**; the project tracker holds
that as an open watch. "Some of that" stops being true somewhere between one
cube and ninety-five, and the honest answer is that we do not know where. Bring
it back to the operator before crossing it, rather than discovering the line by
having crossed it.

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

**Images** — this is the part that changed on 2026-09-15 (§3.1, D15). The old
text here read *"never touch images"*; it no longer describes what we do. What
we do now:

- Art is fetched from Scryfall **once**, offline, by
  `packages/carddata/src/cli/upload-art.ts`, rate-limited per their guidance,
  and uploaded to `cdn.hadoku.me`. Browsers then fetch from the CDN. That is
  strictly **fewer** requests at Scryfall than hotlinking every tile was, not
  more.
- Bytes are never modified in transit and never committed to git. They also do
  not come from the app's own origin today — that is how the CDN happens to be
  wired, not a rule: **D18 repealed the origin rule** and image URLs are no
  longer restricted by host.
- The manifest keeps the source swappable per card, so "touching images" here
  means holding a key, not owning an asset pipeline.

There is **no prescribed attribution string** on Scryfall's pages. The only
attribution-shaped obligations are the image ones in §3.1 (artist + copyright
visible, satisfied by serving the whole card face) and "don't imply Scryfall
endorsed you". We carry a credit anyway, in `NOTICE.md`. (It is **not** in the
UI footer — checked 2026-09-15. §2 rule 6 asks for footer text and that is still
outstanding; the footer currently says the project "never loads, caches or
proxies a card image", which D15 made false.)
