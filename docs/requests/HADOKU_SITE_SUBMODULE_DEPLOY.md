# HADOKU_SITE_SUBMODULE_DEPLOY — the deploy tree's `forge/` drift, and the O-number collision

This file has two parts, and they're independent.

- **Part 1** is the ask we sent to hadoku_site. The text is copied verbatim,
  with every heading demoted one level so it fits under this file's title. **Delivered
  2026-09-17:** `WolffM/hadoku_site` branch `cardtable/w8-submodule-deploy`,
  commit `954687c0`, file `docs/requests/CARDTABLE_SUBMODULE_DEPLOY.md`. We
  didn't open a PR, and their owner merges it. If the two copies ever disagree,
  theirs wins.
- **Part 2** is a proposal *for this repo*: one numbering scheme for open
  questions. It proposes a change and doesn't apply one. Nothing has been
  renumbered, and the tracker lands it.

**This rewrites operator item O8's premise** (`docs/planning/workstreams.md:279`).
Deploys stopped running `git pull` in hadoku_site `0710bc13` (2026-07-14), and
reproduction shows a dirty submodule gitlink never makes the deploy refuse. The
real symptom is silent: the deploy tree claims to be at origin/main while its
submodule isn't, and a permanent ` M forge` sits in `git status`. The stopgap
command in O8 is still right.

---

# Part 1 — the ask, as delivered

## Ask from hadoku-cardtable: sync submodules in the deploy step

**From:** hadoku-cardtable (Wave 8, lane D) · **Date:** 2026-09-17 ·
**Priority:** low. This is a latent trap, not an outage. Nothing is broken
today, and nothing on the served path would break if you left it.

Every file and line cited here was read at `origin/main` = `2c8c5922`, and every
git behaviour claimed was reproduced in a throwaway repo (the recipe is at the
end). Where something was _not_ checked, it says so.

### TL;DR

`executeDeploy` promises to _"Sync the clone to exactly origin/<branch>"_, but
that is not true for a repo with submodules. `git reset --hard` moves the
gitlink and leaves the submodule's checkout where it was. cardtable is the only
deployed repo with a `.gitmodules`, so it's the only one exposed. After every
deploy that moves its `forge` pin, the deploy tree sits at ` M forge` for good.
The deploy doesn't notice, stays green, and doesn't stash or refuse.

**Ask:** add one generic step to `executeDeploy`, right after
`git reset --hard`. It should only run when `.gitmodules` exists:

```sh
git submodule sync --recursive && git submodule update --init --recursive --depth 1
```

It must not use `--force`. The per-clone `submodule.<name>.update=none` stays
the opt-out.

### The deploy tree, and how it gets there

| Claim                                                                                                                                    | Where (origin/main `2c8c5922`)                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| cardtable's entry: `"localPath": "hadoku-cardtable"`, `"buildCommand": "pnpm install && pnpm build"`                                     | `services/mgmt-api/deploy-config.json:139-147` (`localPath` `:143`, `buildCommand` `:144`) |
| A relative `localPath` resolves against `REPOS_DIR`                                                                                      | `services/mgmt-api/src/deploy/deploy-config.ts:70`, `:91-93`                               |
| mgmt-api runs from `~/srv/hadoku_site/services/mgmt-api` with `REPOS_DIR` = the parent of the ecosystem file's checkout                  | `ecosystem.config.cjs:62`, `:286`, `:321`                                                  |
| **Live check:** the running mgmt-api process has `REPOS_DIR=/home/hadoku/repos` and cwd `/home/hadoku/srv/hadoku_site/services/mgmt-api` | `/proc/<pid>/environ`, read 2026-09-17                                                     |

That puts the deploy tree at **`/home/hadoku/repos/hadoku-cardtable`**.

### What the deploy step actually does (it no longer pulls)

This ask began from the premise that _"mgmt-api's `git pull` does not update
submodules, and a future pull can refuse with 'local changes would be
overwritten'"_. The first half is out of date and the second doesn't happen:

- Child-service deploys stopped pulling in `0710bc13` (2026-07-14, #189, _"sync
  clones to origin/<branch> instead of pulling into them"_). The comment at
  `deploy-executor.ts:207-217` describes the change. The only `git pull` left
  in mgmt-api is its own self-update (`src/routes/pm2.ts:137`), which targets
  hadoku_site and has no submodules.
- The sequence today is:
  1. stash (`deploy-executor.ts:223`, with `git stash --include-untracked` at `:151`)
  2. `git fetch origin <branch>` (`:235`)
  3. the `unbackedCommits` guard (`:241`)
  4. `git checkout <branch>` (`:251`)
  5. `git reset --hard origin/<branch>` (`:255`)
  6. `pm2 stop` (`:286`)
  7. `buildCommand` (`:302-335`)

  Nothing in that sequence touches submodules.

- `~/srv/hadoku_site` is at `f6c746e6`. `git diff f6c746e6 origin/main` over
  `deploy-executor.ts` and `deploy-config.json` is empty. The compiled
  `dist/deploy/deploy-executor.js` contains `reset --hard origin`, so the live
  code is the fetch-and-reset path.

What happens to a submodule under that sequence was reproduced with a
superproject, a submodule and a "deploy" clone, all on git 2.47.3 (this host's
version):

| Step                                                                  | Observed                                                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin moves, and the deploy's stash + fetch + reset run                 | reset succeeds; `git status --porcelain` → ` M forge`; `git submodule status` → `+<old sha> forge`                                                                        |
| The next deploy, with the tree already dirty                          | `git stash --include-untracked` prints **"No local changes to save"**. Stash ignores submodule gitlinks, so no stash entry is made and no `workingTreeAction` is recorded |
| Another pin move                                                      | still ` M forge`, still the _first_ sha. The drift only grows                                                                                                             |
| The old `git pull --no-rebase` path, dirty gitlink, incoming pin move | **fast-forwards, exit 0.** It doesn't refuse, because git doesn't count a submodule's checked-out commit as a local change that a merge could overwrite                   |

So the "pull will refuse" failure isn't reachable, today or under the old code.
The real failure is quieter: **a tree that says it is at origin/main, and whose
submodule is not.** It shows up in three ways:

1. `git status --porcelain` on the deploy tree is permanently non-empty.
   Cardtable's agents are told to verify against the deployed tree, and the
   Wave 7 manager did exactly that: it saw ` M forge`, took it for someone
   mid-edit in production, and correctly refused to touch it. Every future pin
   move makes the same false alarm.
2. Anyone who reads `forge/` in that tree reads the wrong Forge. Cardtable
   measures Forge facts from a checkout's `forge/`, and every number in its
   docs is tied to a specific pin.
3. **Observed in the reproduction, not checked on the real tree:** git's default
   `fetch.recurseSubmodules=on-demand` made the superproject fetch print
   `Fetching submodule forge` once the gitlink changed. So the deploy may
   already be downloading the new pin's objects and then never checking them
   out.

### What is true today (checked read-only, 2026-09-17)

- **The deploy tree is clean right now.**
  `git -C /home/hadoku/repos/hadoku-cardtable status --porcelain` printed
  nothing (exit 0). `git … submodule status` printed
  ` 2ad70eb447a22efe5b80904c07188311da034a42 forge`. The leading space means
  the checkout matches the pin, and that sha equals `git ls-tree HEAD forge`.
  HEAD equals `origin/main` equals `e0165c3`, and the stash list is empty. It's
  clean because someone ran `git submodule update --init forge` by hand after
  the last pin move. The next pin move undoes it.
- **Nothing builds or serves `forge/`.** The root `build` is
  `pnpm -r --if-present run build` (`package.json:19`). The workspace globs are
  `apps/*` and `packages/*` only, and `pnpm-workspace.yaml` says outright that
  `forge/` is not a member. The two packages with a `build` script are
  `apps/server` (`tsc` + `esbuild src/index.ts`) and `apps/ui` (`vite build`).
  The server serves `CARDTABLE_WEB_DIR || '../ui/dist'`
  (`apps/server/src/config.ts:49`). No source under `apps/` or `packages/`
  imports from `forge/`. The references that exist are doc comments and
  offline CLI generators whose output is committed.
- **CI doesn't fetch it.** `.github/workflows/ci.yml:42` is a bare
  `uses: actions/checkout@v6` with no `with:`, so `submodules` defaults to
  `false`. `redeploy.yml` has no checkout step at all.
- `forge` is `https://github.com/WolffM/forge.git`, **public** (a fork). No
  credential is needed to fetch it.

### The proposal

#### Where

In `services/mgmt-api/src/deploy/deploy-executor.ts`, immediately after the
`git reset --hard origin/${service.branch}` call (`:255-258`) and before the
`Now at origin/…` log (`:259-263`):

```ts
if (fs.existsSync(path.join(service.localPath, '.gitmodules'))) {
  addLog('Syncing submodules to the recorded pins');
  await runStreamed(
    'git submodule sync --recursive && git submodule update --init --recursive --depth 1',
    {
      cwd: service.localPath,
      timeout: 600000,
      env: deployEnv(),
      onLine: (_stream, line) => addLog(`[submodule] ${line}`),
    }
  );
}
```

`deploy-executor.ts` imports `fs` (`:3`) but not `path`, so this snippet also
needs `import path from 'node:path'`.

That spot is before `stopService` (`:286`), which matters. If the submodule
fetch fails, the deploy fails with the service still running the old code. It
never leaves cardtable stopped over a repository its build doesn't read.

Use `runStreamed`, not `execAsync`, because forge is big. The existing tree's
`forge` is a shallow clone whose pack is **1.08 GiB**. Almost all of that is the
single commit's tree rather than history, and a shallow re-fetch of a new pin
can move a lot of it.

#### Generic, not per-service

**Recommendation: generic, gated on `.gitmodules`.** Reasons:

- The bug is in the step's own promise ("sync the clone to exactly
  origin/<branch>"), not in cardtable's config. Any repo that later adds a
  submodule hits it silently, and only if someone happens to remember to add
  a per-service flag.
- It costs nothing for the other 14 entries. None of their checkouts has a
  `.gitmodules` (checked across every `localPath` in `deploy-config.json`), so
  the step doesn't run.
- Putting `git submodule update` into cardtable's `buildCommand` would work,
  but it's the wrong layer. It would run _after_ `pm2 stop` (`:286` comes
  before the build at `:302`), so a GitHub hiccup fetching a gigabyte of Java
  would turn into a cardtable outage.

#### Safety: keep the "refuse, don't destroy" rule

`stashWorkingTree` protects dirty work in the superproject, but stash ignores
submodules (reproduced). So nothing currently protects uncommitted work _inside_
a submodule. The proposed step keeps that safe on its own. Plain
`git submodule update` (checkout mode, no `--force`) **refuses** instead of
overwriting. In the reproduction, a local file that the new pin also adds made
it exit 1 with _"untracked working tree files would be overwritten by
checkout"_, and the file survived.

For the same reason, **don't** use `git reset --hard --recurse-submodules`. It
would discard submodule contents, and the stash wouldn't have saved them first.
That's the silent destruction `stashWorkingTree`'s own comment
(`:130-142`) says a deploy must never do.

#### `--depth 1`

It's harmless and it's the right default: the deploy never needs submodule
history. It helps less than you'd expect for forge, whose cost is its tree
rather than its history. Fetching a pin that isn't a branch tip by sha needs the
server to allow reachable-sha fetches. GitHub does, but **that wasn't tested
live**. The reproduction used a local remote with
`uploadpack.allowReachableSHA1InWant=true`.

#### The alternative: `submodule.forge.update=none`, weighed

cardtable's deploy doesn't need forge's contents at all, so a clone-local
opt-out is a real option:

```sh
git -C /home/hadoku/repos/hadoku-cardtable submodule deinit -f forge
git -C /home/hadoku/repos/hadoku-cardtable config submodule.forge.update none
```

Reproduced: once the submodule is deinitialised, pin moves leave
`status --porcelain` empty (exit 0), and `git submodule update --init` prints
`Skipping submodule 'forge'` (exit 0). So **the generic step above respects
this opt-out, and the two compose.** Weighing it:

- **For:** no gigabyte download on a pin move, and a clean tree forever.
- **Against, for cardtable today:** that tree is also the repo's main checkout,
  and cardtable's agents measure Forge from a `forge/` checkout. Deinit empties
  `forge/`. That's cardtable's call to make, not the platform's.
- **`update=none` alone does not fix the drift.** On a forge that's still
  checked out, it only stops `submodule update` from correcting it, and status
  stays ` M forge`. It only works together with `deinit`.
- **Two side effects in the reproduction.** A superproject fetch after deinit
  still printed `fatal: not a git repository: '.git'` / `Fetching submodule
forge`, with exit 0: noise in the deploy log. `fetch.recurseSubmodules=false`
  on that clone would silence it. Separately, the real tree's `forge/.git` is
  an embedded **directory**, not an absorbed gitfile, so `deinit` there may
  need `git submodule absorbgitdirs` first. **Neither was tried on the real
  tree**, because it was read-only for this lane.
- Don't put `update = none` in cardtable's `.gitmodules`. That would reach
  every developer checkout, and the spikes need forge there.

**Recommendation:** ship the generic step. Leave cardtable opted _in_, so its
tree tracks the pin. If cardtable's operator ever wants a deploy-only tree, the
opt-out is two clone-local commands and needs no hadoku_site change.

#### Also rejected

`submodule.forge.ignore=all` makes ` M forge` disappear from `git status`
without fixing anything. It hides the drift instead of removing it.

### Stopgap until this lands

After any cardtable commit that moves the `forge` pin, run:

```sh
git -C /home/hadoku/repos/hadoku-cardtable submodule update --init --depth 1 forge
```

### Test

`stashWorkingTree` was pulled out so it could be tested against real git. A
`syncSubmodules(localPath)` helper deserves the same treatment. This is the
reproduction, runnable as-is in a temp dir:

```sh
set -e; export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b master subup
for m in A B; do git -C subup commit -q --allow-empty -m $m; done
A=$(git -C subup rev-parse HEAD~1); B=$(git -C subup rev-parse HEAD)
git -C subup config uploadpack.allowReachableSHA1InWant true
git init -q --bare -b main origin.git && git clone -q origin.git dev
( cd dev && git -c protocol.file.allow=always submodule add -q ../subup forge \
  && git -C forge checkout -q $A && git add -A && git commit -qm "pin A" && git push -q origin HEAD:main )
git clone -q origin.git deploy && git -C deploy -c protocol.file.allow=always submodule update --init -q
( cd dev && git -C forge checkout -q $B && git add forge && git commit -qm "pin B" && git push -q origin HEAD:main )
# today's deploy step
( cd deploy && git stash --include-untracked && git fetch -q origin main && git reset -q --hard origin/main )
git -C deploy status --porcelain        # " M forge"   <- the drift
# the proposed step
git -C deploy -c protocol.file.allow=always submodule update --init --recursive --depth 1
git -C deploy status --porcelain        # empty
```

(`protocol.file.allow=always` is only there because the reproduction uses a
local-path remote. It isn't needed against GitHub.)

### Nothing needed from cardtable

We don't need a reply. If you'd rather we open the change against mgmt-api
ourselves, say so. We didn't, because `deploy-executor.ts` is yours.

---

# Part 2 — one scheme for open-question numbers (proposal only)

## The collision, verified

`docs/DECISIONS.md` and `docs/planning/workstreams.md` each mint `O`-numbers on
their own. Line numbers below are from branch `w8` at `e0165c3`.

**`docs/DECISIONS.md`** — "Still open" table, `:542-550`:

| # | Meaning | Line | Status there | Actual status |
| --- | --- | --- | --- | --- |
| O1 | Create `WolffM/hadoku-cardtable` and fork `Card-Forge/forge`? | `:546` | open | **both done**. The repo exists (workstreams `:283`), and the fork `WolffM/forge` exists with `forge/` pinned to it (workstreams `:383-384`) |
| O2 | P1 draft: reimplement in TS, or reuse Forge's `limited/`? | `:547` | open | **resolved 2026-09-14: TS** (workstreams `:287`) |
| O3 | One JVM per match, or one hosting many? | `:548` | open | open |
| O4 | Does the WASM spike block Wave 2? | `:549` | struck, moot | moot |
| **O5** | **How much card art do we host?** | `:550`, cited at `:431`, `:435` | open | open |

**`docs/planning/workstreams.md`** — "Operator's list", `:275-291`:

| # | Meaning | Line | Status there | Actual status |
| --- | --- | --- | --- | --- |
| O1 | Fork `Card-Forge/forge` (repo half done) | `:283` | struck, "fork deferred" | **fork done** (`:383-384`). The row is stale |
| O2 | P1 draft: TS vs. `limited/` | `:287` | struck, resolved | resolved |
| O3 | One JVM per match vs. many | `:290` | open | open |
| O4 | Does the spike block Wave 2? | `:291` | struck, moot | moot |
| **O5** | **D2 vs. `packages/room-ask` — the MIT carve-out** | `:281`, cited at `:447` | **not struck** | **closed by D16** (`DECISIONS.md:446`; stated at workstreams `:380-381`, `:392`) |
| O6 | The CDN art upload has never run (credential) | `:282` | open | open |
| O7 | D6 needs superseding | `:280`, cited at `:273` | **not struck** | **closed by D17** (`DECISIONS.md:493`; workstreams `:380-381`) |
| O8 | The deploy tree's submodule drifts | `:279`, cited at `:336` | open | open. Premise corrected in Part 1 |

The workstreams file flags the collision itself at `:389-394`.

**What the tables show:**

- **O1–O4 are the same four items in both docs. They split at O5.**
  DECISIONS O5 is art hosting; workstreams O5 is the MIT carve-out.
- **Both docs have gone stale on status, in different directions.** DECISIONS
  still lists O1 and O2 as open. Workstreams still shows O5 and O7 as live rows
  after D16 and D17 closed them, and its O1 row still says the fork is
  deferred.
- **The `O` sequence also mixes two kinds of item.** O1–O5 in DECISIONS are
  *decisions*: each one ends as a D-entry. Workstreams O6 (a credential) and O8
  (an ask to hadoku_site) are *chores*: something only the operator can do,
  with nothing to decide.

**The same disease, one letter over (not asked for, but relevant):** `P` means
three different things here:

- D3's phases P1–P4 (`DECISIONS.md:34`)
- D9's room-module phases P0–P6 (`DECISIONS.md:204-210`). Our request
  filenames (`docs/requests/P3_…` to `P6_…`) depend on these. Workstreams uses
  the same meaning on its board (`workstreams.md:140-151`)
- workstreams' operator chores P1–P5 (`workstreams.md:284-289`). So one file
  uses `P3` for two different things

Workstreams already solved one of these collisions by renaming the programmes
to `PR-n` (`:84-88`). That's the precedent for the proposal below.

## Proposal

1. **`O-n` means an open *decision*, and `docs/DECISIONS.md` owns it.** Only
   the "Still open" table mints `O`-numbers. An O closes when a D-entry
   answers it: strike the row and write `→ Dnn`. `workstreams.md` can cite an
   O-number but never mints one. DECISIONS owns it because a decision's
   question and answer should live in the same file, and because its O5 is the
   one other text already cites (`DECISIONS.md:431`, `:435`).
2. **`A-n` means an operator *action* (a chore), and `workstreams.md`'s
   operator list owns it.** Credentials, repo secrets, shell profile, asks to
   other repos. That list keeps being a to-do list, just with its own letter.
3. **`P-n` is kept for D9's room-module phases.** File names depend on it.
   Programmes stay `PR-n`. D3's settled P1–P4 text stays as it is, because it's
   history.
4. **Numbers are never reused.** A retired number stays retired, and new
   numbers continue from the highest one ever issued.

**Proposed mapping, for the tracker to apply:**

| Today | Becomes | Why |
| --- | --- | --- |
| DECISIONS O1–O4, workstreams O1–O4 | unchanged (same items) | Strike DECISIONS O1 (done) and O2 (→ TS, 2026-09-14). Fix workstreams O1's "fork deferred" |
| DECISIONS O5 (art hosting) | **O5**, unchanged | It's a decision, and it lives in the file that owns the series |
| workstreams O5 (MIT carve-out) | **retired → D16** | Closed. Mark it closed; don't renumber it |
| workstreams O7 (D6 superseding) | **retired → D17** | Closed. Mark it closed; don't renumber it |
| workstreams O6 (CDN upload credential) | **A1** | A chore, not a decision |
| workstreams O8 (deploy submodule) | **A2** | A chore on hadoku_site's side. Track the pushed branch in Part 1 |
| workstreams P4 (seed `KEY_SERVICE_CARDTABLE`, or decide not to) | **A3** | Mostly a chore. If the operator decides "don't report", that half becomes an O |
| workstreams P5 (duplicate `NODE_AUTH_TOKEN` export) | **A4** | A chore |
| workstreams P1–P3 (closed) | left as they are | They're struck history, and renaming them only makes churn |
| next new decision | **O9** | Continues past the highest O ever issued (workstreams O8), so no new number can be mistaken for an old one |

Nothing in this section has been applied. `docs/DECISIONS.md` and
`docs/planning/workstreams.md` are exactly as they were. This lane owns
neither file.
