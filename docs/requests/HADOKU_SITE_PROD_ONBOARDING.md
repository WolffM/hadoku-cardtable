# Handoff — put `hadoku-cardtable` in production at `hadoku.me/cardtable/`

**For:** a hadoku_site agent.
**From:** hadoku-cardtable's tracker.
**Status:** cardtable has never been deployed anywhere. There is no route, no
service, no registry entry — it exists only as a green `main` and a CI job.
**The ask:** tell us which shape this app should be, then the two of us do our
halves. §3 is the decision; everything else follows from it.

The previous handoff (`HADOKU_SITE_SECRET_DISTRIBUTION.md`) landed cleanly —
cardtable is on `additional_repos` and both secrets are seeded. Thank you. This
is the next step and it needs a design call from your side rather than a list
entry.

---

## 1. What cardtable is, honestly

A private cube-drafting app for a friend group. `hadoku.me/cardtable/`,
**friend tier, never public** — that is a hard rule in its `CLAUDE.md`, not a
preference, and it is the one thing that must not be got wrong.

**What works today**, on `main`, CI green:

- A complete cube-draft engine (`@hadoku/draft`) — seeded and deterministic,
  8 seats, 3 packs, heuristic bots, 231 tests.
- A React SPA that plays a real draft over a real 493-card Vintage Cube,
  rendered entirely from text. **No card images, ever** — that is D13, and it
  is enforced in three places (the ingest projection, the pool build step, and
  a test that walks whole serialised payloads).
- A Vite production build: **508 kB, 130 kB gzipped, builds in ~400 ms.**

**What does not exist yet:**

- **No server.** `apps/server/` is a single `.gitkeep`. The draft engine runs
  *in the browser tab*.
- **No multiplayer.** No socket, no room. What would deploy today is one person
  drafting against seven bots. Friends cannot join, because there is nothing to
  join yet.
- **`apps/ui` is not a publishable package** — `"private": true`, no
  `main`/`types`/`files`, and a Vite *app* build rather than a library build.

That last point matters for §3, and we are not asking you to solve it — it is
our work. We are asking which target to build toward.

## 2. What we will do on our side, once §3 is settled

Ready and committed already:

- `.github/workflows/publish.yml` — modelled on `hadoku-craft`'s: `setup-pnpm@v1`,
  install, `pnpm check`, build, a **D13 release gate that greps the built
  bundle** for image URLs and Scryfall image fields, version-bump-if-published,
  `pnpm publish` on the repo-local `GITHUB_TOKEN`, then a `packages_updated`
  dispatch to hadoku_site on `HADOKU_SITE_TOKEN`.
- It is **gated off** behind a `PUBLISHABLE=false` step and is a no-op until
  `apps/ui` is a library build. Committed early so you can review the shape,
  not to half-publish something.

Still to do here, gated on §3:

- Make `apps/ui` publishable as `@wolffm/cardtable-ui` — library build,
  `main`/`types`/`files`/`publishConfig`, CSS extracted to a named file, the
  app shell split from the mountable component.
- Flip `PUBLISHABLE` in the same commit.

## 3. **The decision we need from you**

Two shapes exist in the fleet and cardtable could be either. We do not know
which you want, and guessing it is how we would build the wrong thing.

### Option A — UI package (the `craft` / `watchparty-ui` shape)

We publish `@wolffm/cardtable-ui`; you add an entry to `scripts/child-apps.json`
under `apps`:

```json
{
  "id": "cardtable",
  "packageName": "@wolffm/cardtable-ui",
  "repoName": "hadoku-cardtable",
  "targetDir": "cardtable",
  "hasCSS": true,
  "cssSource": "cardtable-ui.css",
  "registryProps": {}
}
```

- **Fits today**: cardtable is a pure SPA, exactly what this shape is for.
- **Against**: the moment PR-4 lands a draft/play server, cardtable needs a
  backend too, and watchparty's answer to that was to be *both* a UI package
  **and** a PM2 service. We would arrive at the same place by a longer road.

### Option B — Tunnel app (the `games-host` shape)

```json
{
  "id": "cardtable",
  "repoName": "hadoku-cardtable",
  "includeInRegistry": false,
  "tunnel": {
    "port": "____",
    "type": "node",
    "tier": "friend",
    "serveOwnUI": true,
    "monorepo": true,
    "vaultKeys": {},
    "proxy": false
  }
}
```

- **Fits where this is going**: `serveOwnUI: true` means we serve our own
  bundle, so the packaging work in §2 largely goes away, and there is already a
  place for the server PR-4 will add. `games-host` is friend-tier, so the gate
  is a shape you have run before.
- **Against**: heavier than a static SPA needs today, and we would be standing
  up a service that currently serves one static page.

**Our lean is B**, but weakly, and we would rather take your call — you own the
consequences of another tunnel. If B, we need a port assignment.

## 4. The friend gate — the part that must not be got wrong

Whichever shape: cardtable requires a rule in
`workers/edge-router/src/route-tiers.ts`, in the shape of the `games-host`
entries at `:634-645`:

```ts
{
  match: 'prefix',
  path: '/cardtable',
  tier: 'friend',
  why: 'private cube drafting for the friend group; no public or anonymous tier, ever',
},
```

**There is no public surface to carve out.** Unlike watchparty — where the
lobby is public and only room shells are gated — *every* cardtable path is
friend tier, including any future socket and API paths. If a later change adds
a `public` rule under `/cardtable`, that is a bug, and it would be worth a test
in `workers/edge-router/test/public-surface.test.ts` asserting no `/cardtable`
path ever resolves to `public`. We would rather that test exist than rely on
nobody writing the rule.

`docs/routes.json` is generated from `route-atlas.ts` + `spec/categories.json`,
so it should regenerate; we mention it only so the generated file is not edited
by hand.

## 5. Also needed, probably yours

- **A catalogue entry** in `spec/categories.json`, if cardtable should appear in
  the site's app listing at all. Given it is friend-tier and private, it may
  deliberately not want one — your call.
- **A display name and category.** "Cardtable", and something like `games`.

## 6. What we are NOT asking for

- **No ACL or package-access grant.** Settled last round: the read token is a
  classic PAT owned by the account that owns both repos.
- **No new secret.** `HADOKU_NPM_READ_TOKEN` and `HADOKU_SITE_TOKEN` are both
  seeded and verified working — CI went green on `97ebb63` with
  `registry credential present` and a cold-runner install of 212 packages.
- **No public tier, not even temporarily, not even for a demo.** If shipping
  friend-tier is blocked for any reason, we would rather stay undeployed.

## 7. One thing worth saying plainly

We can ship the solo-draft SPA this week and it would be genuinely useful — it
puts card rendering, the pick loop, and the D13 no-images rule in front of real
eyes. But it is **not** the thing to invite friends to, because they cannot
join. If your preference is to onboard cardtable once, properly, when it has a
room and a server, say so and we will hold. We are not in a hurry; we would
rather do it in the right shape than twice.
