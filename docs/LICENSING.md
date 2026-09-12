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
`requests/WATCHPARTY_ROOM_MODULE.md`: if the room layer lives in the watchparty
repo as `@wolffm/rooms` (MIT) and we consume it as a dependency, it stays MIT and
reusable by every other hadoku app. If we instead copy it in here, **our copy
becomes GPL-3** and can't flow back. Extraction is the licence-clean option, not
just the tidy one.

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

> **⚠️ Unverified.** `scryfall.com/docs/api` returned HTTP 403 to our fetch, so
> the specifics below are from memory and **must be checked against the live page
> before we ship any ingest.** Don't treat this section as settled.
>
> To confirm: exact request rate limit and required delay between requests;
> required `User-Agent` and `Accept` headers; the attribution wording they ask
> for; and — most importantly — **their stated position on image
> redistribution**, which we expect to be "we don't own these, don't mirror
> them", consistent with rule 2 above.

Design intent regardless of what the terms say: **pull bulk data on a schedule,
cache the JSON locally, never hammer the API per-request, and never proxy
images.**
