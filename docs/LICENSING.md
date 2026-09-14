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

### Checklist

- [x] `LICENSE` = GPL-3.0 at repo root
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
| **Card images at scale** — hosting/mirroring scans | **Never mirror.** See below. |
| **Looking official** — WotC logos, mana symbols, set symbols, the Magic wordmark, card frames | Our own visual language. No WotC marks anywhere in the UI. |
| **Scale / visibility** — big playerbase, streams, press | A handful of friends |
| Card names + Oracle text | Unavoidable for any engine; functional; lowest-attention item on this list |

### Concrete rules for this repo

1. **No money, in any form, ever.**
2. **Never commit or host card images.** `.gitignore` already refuses `*.jpg`,
   `*.png`, `cards/`, `card-images/`. Card art belongs to WotC and the artists —
   *nobody* can license it to us, Scryfall included.
3. **Client-side image fetching only.** The browser fetches images from an
   upstream source directly; our server never proxies, caches or stores them.
   This keeps us a link, not a host.
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

**There is no blanket prohibition on caching, storing or serving the image
bytes.** We looked for one; it is not there. The nearest thing is a *data*
rule — *"You may not simply repackage, republish, or proxy Scryfall data. Your
software must create additional value for end-users."*

So state this plainly, because the inference in the other direction is the
dangerous one:

> **Our no-images rule (D13, and rule 2 in §2) is stricter than Scryfall
> requires, and it stays.** It is not derived from Scryfall's terms and does not
> relax when those terms are read carefully. It is driven by **WotC's IP**: card
> art belongs to Wizards and to the artists, *nobody* can license it to us —
> Scryfall included — and "hosting card images at scale" is the second-loudest
> item on §2's risk table.

Anyone who later finds this section and concludes "Scryfall didn't forbid
caching, so we can mirror images" has read the right sentence and drawn the
wrong conclusion. The permission we lack is not Scryfall's to give.

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

Design intent, unchanged by any of the above: **pull bulk data on a schedule,
cache the JSON locally, never hammer the API per-request, and never touch
images.** The ingest projects a named subset of fields rather than passing bulk
records through — which is also what keeps us clear of *"simply repackage,
republish, or proxy"*. See `docs/CARD_DATA.md` and the D13 control, which
fails the build if `image_uris` reaches the projection.

There is **no prescribed attribution string** on that page. The only
attribution-shaped obligations are the image ones in §3.1 (artist + copyright
visible) and "don't imply Scryfall endorsed you". We carry a credit anyway.
