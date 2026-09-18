# Handoff — what cardtable needs from hadoku_site to let two people play a game

**For:** a hadoku_site agent.
**From:** hadoku-cardtable's tracker.
**Bundled deliberately.** Three outstanding asks in one request rather than
three, at the operator's instruction.

**Read this first, because it reframes the request:** the operator asked me to
bundle "the vault/ACL grants". Having checked, **only one of the three is a
credential at all.** The other two are configuration and a deploy step. Sizing
them as ACL work would make this look far heavier than it is.

| # | Ask | Kind | Blocks |
| - | --- | ---- | ------ |
| 1 | Two env vars on the cardtable PM2 service | **Config** — paths, not secrets | Playing a match at all |
| 2 | `git submodule update` in the deploy step | **Deploy step** — already asked, branch unmerged | Ask 1, and a latent `git pull` failure |
| 3 | A way for an automated job to upload to `cdn.hadoku.me` | **Credential / design** — the only real one | Card art on our CDN |

Asks 1 and 2 are coupled: 1 cannot work until 2 lands. Ask 3 is independent and
can be answered later or declined.

---

## Current state, so nothing here is guessed

`hadoku.me/cardtable/` is live at friend tier and answers 401 to anonymous. The
PM2 service is `online`. **Drafting works today** — two browsers, one pod, 45
picks each, verified end to end.

**Playing a match does not**, and production says why on every boot:

```
[cardtable] play: no Forge (CARDTABLE_FORGE_JAR is not set) — POST /api/play/matches answers 503
```

That is a deliberate, graceful refusal, not a crash. The running process has
`CARDTABLE_PORT`, `CARDTABLE_WEB_DIR` and `EDGE_AUTH_SECRET`, and no Forge
config.

---

## Ask 1 — two env vars on the cardtable service

`services/pm2/cardtable-wrapper.mjs` is **generated** ("edit
`scripts/child-apps.json` + re-run hydration to change"), and already sets
`CARDTABLE_PORT` and `CARDTABLE_WEB_DIR` directly in its `env:` block while
pulling only `EDGE_AUTH_SECRET` through `vaultKeys`.

**These two are the same kind as `CARDTABLE_WEB_DIR` — filesystem paths, not
secrets.** They do not belong in `vaultKeys` and need no ACL grant:

| var | value |
| --- | --- |
| `CARDTABLE_FORGE_RES` | `<repos>/hadoku-cardtable/forge/forge-gui/res` |
| `CARDTABLE_FORGE_JAR` | a built Forge fat jar — **see below, this is the real question** |

**`CARDTABLE_FORGE_RES` is free once ask 2 lands**: `forge/` is a git submodule
of `WolffM/forge`, and `forge/forge-gui/res` (462 MB, includes `cardsfolder`) is
simply there once the submodule is initialised. That is the coupling — without
ask 2 the deploy tree has an empty `forge/` and this path does not exist.

**`CARDTABLE_FORGE_JAR` needs a decision we should not make alone.** It is a
~38 MB `forge-gui-desktop-*-jar-with-dependencies.jar` produced by a Maven
build. Nothing in `pnpm build` builds it and we are not proposing that it
should — the deploy command is `pnpm install && pnpm build` and a Maven build
does not belong in it. Three options, our preference first:

1. **Build once to a stable path outside the repo**, e.g.
   `/home/hadoku/.local/share/cardtable/forge.jar`, and point the env at it.
   Rebuilt by hand only when cardtable's submodule pin moves, which is rare (it
   has moved once). Toolchain is already on the host: Temurin JDK 21 and Maven
   3.9.16 under `~/.local/opt`, installed user-local with no sudo (our D14).
   **A build already exists** at
   `~/.cache/w7b-forge/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar`
   — it is a scratch build in a cache directory and should be **moved, not
   depended on where it is**.
2. A deploy-time Maven build. Correct but slow (~69 s cold) and adds a JDK
   dependency to every cardtable deploy, for an artifact that changes ~never.
3. We host the jar ourselves and hand you a path. Same as (1), different owner.

**We are happy to do the build and the move ourselves** if you tell us the path
you want it at — that half needs no hadoku_site change. What we cannot do is
add the env vars, because the wrapper is generated from your `child-apps.json`.

### Done when

`pm2 logs cardtable` no longer prints the "no Forge" line at boot, and
`POST /api/play/matches` stops answering 503.

---

## Ask 2 — `git submodule update` in the deploy step

**Already asked**, on branch **`cardtable/w8-submodule-deploy`** in your repo
(`954687c0`, `docs/requests/CARDTABLE_SUBMODULE_DEPLOY.md`). It is **unmerged
and 4 commits behind main.** This bundle exists partly to say: that branch is
still the ask, and it is now a prerequisite rather than hygiene.

`deploy-config.json`'s cardtable entry runs `pnpm install && pnpm build`, and
mgmt-api's `git pull` does not touch submodules. Two consequences:

- `forge/` in the deploy tree stays uninitialised, so **ask 1's
  `CARDTABLE_FORGE_RES` path does not exist**.
- Every time cardtable moves its submodule pin the deploy tree goes ` M forge`,
  and a later `git pull` can refuse outright with *"local changes would be
  overwritten"*. It is clean right now only because we synced it by hand.

### Done when

The deploy step initialises submodules, and a pin move followed by a deploy
leaves the tree clean.

---

## Ask 3 — the only real credential question

**This one we genuinely do not know the right shape of, so it is a question
rather than a request.**

cardtable wants to upload ~500 card images (~50 MB) to `cdn.hadoku.me` on a
schedule. The pipeline is written, paced to Scryfall's guidance, idempotent and
resumable — it has never been run, because it has nothing to authenticate with.

`workers/cdn-api/src/index.ts`'s `requireUploader` is
`tierAtLeast(auth, 'friend')`, and we found **no service-tier path** — uploading
appears to assume a human with a session. cardtable is a service, and it has
**no vault identity at all**: no `.devvault.json`, no `.devvault.local.json`.
Its wrapper takes `EDGE_AUTH_SECRET` from the broker by name and that is the
whole of its relationship with the vault.

So the options as we see them, and we have no strong preference:

1. **The operator runs the upload from their own browser session.** Zero
   platform change; the pipeline is a CLI and could take a session cookie. Least
   machinery, and it is a once-per-cube job rather than a daily one.
2. **cardtable gets a vault identity** — `.devvault.json` declaring what it
   needs, a minted service key, then `key-acl-sync`. The documented path
   (`SECRETS.md` §"How to grant a child repo's service key access to a vault
   key"), and the heaviest.
3. **`cdn-api` grows a service-tier upload path.** Cleanest for any future
   automated uploader, and the largest change to your code — so your call
   entirely.

**Not urgent.** Art currently loads client-side from `cards.scryfall.io`,
measured at 30–48 ms with a one-year browser cache, so nothing is broken. This
is about becoming a host rather than a link, which our D15 decided we may do.

### Done when

You tell us which of the three, and we do our half.

---

## What we are NOT asking for

- **No ACL grant for asks 1 and 2.** Neither touches a secret.
- **No new vault key.** `EDGE_AUTH_SECRET` is the only one cardtable uses and it
  already works.
- **No change to the friend gate.** Every `/cardtable` path is friend tier with
  no public carve-out, deliberately, and your own
  `workers/edge-router/test/public-surface.test.ts` asserts it. Please keep it.
- **No Maven in the deploy command**, unless you prefer option 2 of ask 1.

## Priority, if you only do one

**Ask 2, then ask 1.** Together they are what stand between the operator and
testing a real game of Magic in production. Ask 3 can wait indefinitely.
