---
name: cutrelease
description: Cut a cardtable release — combine every pending release-note file in docs/releases/pending/ into docs/releases/vX.Y.Z.md, show the operator the notes to edit, land them (removing the pending files), run release.yml and confirm prod. Use when the operator says /cutrelease, "cut a release", "ship to prod", "release vX.Y.Z", or asks what the next release would contain.
---

# Cut a release

The operator invokes this. Prod (`hadoku.me/cardtable/`) moves only through it; `main` already
deploys to PPE (`hadoku.me/cardtable-ppe/`) by itself. `docs/RELEASE.md` is the process this
follows, step for step; read it if anything here is unclear.

## 1. Gather

```sh
git fetch -q origin --tags
LAST=$(git tag -l 'release/*' --sort=-v:refname | head -1)        # e.g. release/v0.33.0
git ls-tree --name-only origin/main docs/releases/pending/ | grep -v README.md
node scripts/release/collect.ts > "$SCRATCH/release-content.md"    # ledger rows + commits since $LAST
```

Read every pending file (`git show origin/main:<path>`), then **every commit since `$LAST`**, not
only the ones a pending file names — a land may have shipped with no file:

```sh
git log --reverse --format='%h %s' "$LAST"..origin/main
```

For each commit, decide whether a player would see or feel it. Skip version bumps (`ui 0.32.…`,
`server …`), dependency updates, CI, tests, docs and admin-only work (testing rooms, the sound
builder). When a subject does not say enough, read the commit (`git show --stat <sha>`, its body,
the files it touched) before deciding. Every player-visible commit is either covered by a pending
file or a ledger row (`collect.ts`'s output), or it is a **gap**: write its bullet yourself, from
the commit and its ledger row's "check it by" column if it has one, in the players' words.

If there are no pending files and no player-visible commit since `$LAST`, say there is nothing to
release and stop.

## 2. Combine

Write `docs/releases/vX.Y.Z.md` in a worktree off `origin/main`:

```markdown
# vX.Y.Z — <a short headline>

<one or two sentences: what this release is about>

## New
## Changed
## Fixed
```

- **Version:** `$LAST` plus a minor bump if any bullet is under New or Changed, else a patch
  bump. `v0.33.0` → `v0.34.0` or `v0.33.1`.
- **Every pending bullet**, under its own heading, in the order the files sort (they are dated).
  Fold two bullets about the same thing into one; drop an empty heading.
- **Players' words** only: no file names, ids, internals. Keep each bullet's bold lead sentence.
  The whole file is posted as a Discord embed (4096 characters), so keep it tight.

## 3. The operator edits

Show the operator the full notes text in chat, plus what fed it: the pending files, and each
bullet you wrote for a gap with the commit(s) it came from, so they can check it and drop any
that should not be there. Ask them to edit or approve. Apply their edits verbatim. Do not land
or release until they say the notes are right.

## 4. Land the notes

One commit on the worktree: the notes file added, every `docs/releases/pending/*.md` it combined
removed (never the README). Message `release: vX.Y.Z notes`, no AI attribution. Rebase on
`origin/main` and push with an explicit refspec (`git push origin HEAD:main`). Re-read the
pending folder after the rebase: a file another lane landed meanwhile is not in these notes,
so leave it for the next release and tell the operator.

## 5. Check PPE and the jar

The sha to release is the notes commit, or main's head once it contains it. PPE normally runs
the code already (`curl -s localhost:9011/health`). Its Forge pin's jar must be installed:

```sh
ls ~/.local/share/cardtable/jars/$(git rev-parse <sha>:forge).jar
```

## 6. Release

`release.yml` refuses a sha whose `check` is not green or that lacks the notes file. Wait for
`check` on the notes commit with ONE background `scripts/lanes/watch-run.sh <run-id>`; if a newer
push cancelled it, use the newest main sha whose `check` is green and that contains the notes.

```sh
gh workflow run release.yml -f version=vX.Y.Z -f sha=<sha>
```

Then wait for that run the same way.

## 7. Confirm prod

- `curl -s localhost:9008/health` reports the released bundle;
  `git -C /home/hadoku/srv/hadoku-cardtable merge-base --is-ancestor <sha> HEAD` succeeds.
- `pm2 logs cardtable` shows `"svc":"cardtable-release"` with `outcome: posted` (or
  `already-posted` after a restart) for the Discord announcement; `failed` says why.

Tell the operator: the version, the sha, that prod runs it, and that the notes were posted.
