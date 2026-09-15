# Handoff — add `hadoku-cardtable` to the fleet's secret distribution

**For:** a hadoku_site agent.
**From:** hadoku-cardtable's tracker.
**Asks for:** one list entry in `manage_github_token.py`, then one seeding run.
**Does NOT ask for:** any ACL grant, any package visibility change, any new
token mint. See §5 — those were considered and are not needed.

---

## 1. The symptom

`WolffM/hadoku-cardtable`'s CI fails on every run since `2658ddf`:

```
[ERR_PNPM_FETCH_401] GET https://npm.pkg.github.com/download/@wolffm/rooms-protocol/0.38.111/…: Unauthorized - 401
```

`gh secret list --repo WolffM/hadoku-cardtable` is **empty**.

## 2. Why it started now, and why it was invisible before

`2658ddf` added the **first `@wolffm/*` dependency this repo has ever had**
(`@wolffm/rooms-protocol@0.38.111`). Until that commit nothing resolved a
GitHub Packages tarball, so CI went green for four runs while the credential
path was never exercised. cardtable's own board has carried the row
*"done but VACUOUS — the token path has never executed"* for three waves; this
is it executing.

The repo side is already correct and needs no change:

| thing | state |
| --- | --- |
| `.npmrc` | registry line only, **no auth line** — the tokenless convention. Correct. |
| `.github/workflows/ci.yml` | `NODE_AUTH_TOKEN: ${{ secrets.HADOKU_NPM_READ_TOKEN }}` on the install step only. Correct. Now also uses `WolffM/hadoku-actions/setup-pnpm@v1` for the empty-secret assertion. |
| operator's `~/.npmrc` | tokenless `${NODE_AUTH_TOKEN}`. Correct. |

**Only the secret's existence is missing.**

## 3. The actual root cause — not just an unset secret

```sh
$ grep -rn 'cardtable' /home/hadoku/repos/hadoku_site/scripts/
# (zero hits)
```

`hadoku-cardtable` is in **neither** `scripts/child-apps.json` **nor** the
`additional_repos` list in `scripts/admin/manage_github_token.py`. The fleet's
distribution has never seen this repo, so it has never been seeded — and
`docs/operations/CREDENTIAL_ROTATION.md:189` is explicit that this cannot
self-heal:

> Only if a secret of that name **ALREADY EXISTS** there. Existence is the
> entitlement — rotation refreshes credentials, it never decides which repo
> gets one.

So **`gh secret set` alone is not the fix.** It works exactly once and then
every future rotation skips the repo. `manage_github_token.py:167-173` already
documents that failure with a name attached — `hadoku-registry`'s token sat
frozen from 2026-04-21 to 2026-08-11 while every rotation refreshed its
neighbours.

## 4. What to change

### 4.1 Add cardtable to `additional_repos` — do this FIRST

`scripts/admin/manage_github_token.py`, in the `additional_repos` list
(~`:135-161`). cardtable is the **same class as `hadoku-fleet-manager`**: a
repo that consumes `@wolffm/*` but is not a registry child app, so it falls
through both lists. Please mirror that entry's comment style, e.g.:

```python
    # cardtable: not a child app — it is a private cube-draft/play app that
    # CONSUMES @wolffm/rooms-protocol (watchparty's room layer) rather than
    # publishing anything, so it is in neither child-apps.json nor the
    # registry. Its CI needs HADOKU_NPM_READ_TOKEN to install.
    #
    # Listed here at first-dependency time deliberately, for the same reason
    # fleet-manager is: hand-seeding works exactly once and then rotation
    # never refreshes it, which is how hadoku-registry's token sat frozen
    # from 2026-04-21 to 2026-08-11.
    'WolffM/hadoku-cardtable',
```

**Note:** cardtable does **not** need `HADOKU_SITE_TOKEN`. It publishes
nothing, dispatches nothing, and has no commit-back workflow. If the
`child-repos` config pushes both secrets as a pair and splitting them is
awkward, pushing both is acceptable — but the read token is the only one
required, and the narrower the better.

### 4.2 Seed it

```sh
cd /home/hadoku/repos/hadoku_site
python3 scripts/administration.py github-secrets child-repos
```

Run from an **up-to-date checkout** — the repo list is derived at runtime, so a
stale checkout silently skips the new entry. (That warning is
`setup-pnpm/action.yml`'s own error text.)

### 4.3 Verify

```sh
gh secret list --repo WolffM/hadoku-cardtable        # expect HADOKU_NPM_READ_TOKEN
gh workflow run CI --repo WolffM/hadoku-cardtable    # or push any commit
```

cardtable runs on `ubuntu-latest`, so the pnpm store is always cold — a green
run genuinely proves the credential works rather than hiding behind a warm
cache. The `setup-pnpm` assertion will fail fast and loudly if the secret is
still empty, so a 401 at install can no longer be mistaken for anything else.

## 5. Considered and NOT needed — please don't do these

- **No ACL / package-access grant.** `@wolffm/rooms-protocol` *is* private
  (verified: `gh api /user/packages/npm/rooms-protocol` → `"visibility":
  "private"` — it is the first private `@wolffm/*` package any consumer repo
  has depended on; `themes` and friends are public). But
  `HADOKU_NPM_READ_TOKEN` is a classic PAT owned by `WolffM`, who owns both
  `hadoku-watchparty` and `hadoku-cardtable`, so it authenticates as that user
  and reads the private package without any per-package repository-access list.
  An ACL step would only be needed if cardtable's CI used its own
  `GITHUB_TOKEN`, which it deliberately does not.
- **No new token mint.** The existing fleet credential is correct and shared.
- **No package visibility change** on watchparty's side.
- **No change to cardtable's `.npmrc` or `ci.yml`.** Both already match the
  convention.

## 6. A documentation gap this exposed, if you want it

There is no doc anywhere in hadoku_site for **onboarding a repo that consumes
`@wolffm/*` but is not a registry child app**. `NEW_CHILD_APP_CHECKLIST.md`
covers the `create-child-app` path; the only statement of the manual route is
terminal output buried in `create_child_app.py:536-547`. cardtable and
fleet-manager are both in that gap, and both found it the same way — by
failing. A short section in `docs/operations/SECRETS.md` pointing at the
`additional_repos` list would close it.

Entirely your call; the two steps in §4 are the ask.
