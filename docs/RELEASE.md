# Releasing cardtable

`main` deploys to **PPE** (`hadoku.me/cardtable-ppe/`) on every green `check`. **Prod**
(`hadoku.me/cardtable/`) moves only when a release is cut. Why and how it was decided:
`docs/planning/release-process.md`.

## Where the notes come from

Every land a player would notice adds a file to `docs/releases/pending/` in the same commit (its
`README.md` has the shape: bullets under `## New`, `## Changed`, `## Fixed`, in the player's
words). They pile up there between releases. The release's notes are those files combined, and
they're deleted in the commit that lands the notes.

## Cutting a release

**`/cutrelease`** (`.claude/skills/cutrelease/SKILL.md`) does steps 1–7 with the operator: it
combines the pending files, shows the notes for editing, lands them and runs the release. By hand:

1. **Pick the version.** `vX.Y.Z`, one product version per release. Bump the minor when any
   pending file has a `## New` or `## Changed` bullet, the patch when they are all fixes. The
   per-package versions `land.sh` bumps are build numbers and don't change here.
2. **Collect what's in it:** every file in `docs/releases/pending/` (except its `README.md`), and
   every commit since the last `release/*` tag, because a land may have shipped without a file:
   ```sh
   node scripts/release/collect.ts > "$SCRATCH/release-content.md"
   ```
   lists the playtest-ledger rows added or changed since that tag, then every commit subject.
   Read each commit a player could notice (its body and files, where the subject is not enough).
3. **Combine the notes** into `docs/releases/vX.Y.Z.md` (shape below): a headline and a sentence
   or two on what the release is about, then every pending bullet under its own heading, merged,
   with near-duplicates folded into one. A commit or ledger row a player would notice that no
   pending file covers gets a bullet too, in the player's words (a row's "check it by" column
   helps); say which bullets came from commits, so the operator can check them. Leave out
   anything a player can't see (tests, CI, refactors), unless it fixed something they hit.
4. **The operator reads and edits them.** Then land the notes file and the removal of the pending
   files in one commit on `main`, like any doc. A docs-only change doesn't redeploy PPE.
5. **Check PPE.** The sha being released is (normally) what PPE already runs (`hadoku.me/cardtable-ppe/`,
   `curl -s localhost:9011/health`). Play it there. Its Forge pin's jar must be installed
   (`ls ~/.local/share/cardtable/jars/$(git rev-parse <sha>:forge).jar`): prod loads it on boot
   (`docs/FORGE_JAR.md`).
6. **Run the release:**
   ```sh
   gh workflow run release.yml -f version=vX.Y.Z            # main's head
   gh workflow run release.yml -f version=vX.Y.Z -f sha=<sha>
   ```
   It refuses unless `check` is green on that sha, the notes file is on it, and the tag is
   new. Then it dispatches the prod redeploy for that exact sha and tags `release/vX.Y.Z`.
7. **Confirm prod.** `/health` on 9008 reports the deployed bundle (see the memory note
   "Confirm a deploy from /health"). Prod posts the notes to Discord's `#announcements` when it
   boots on the release: look for `"svc":"cardtable-release"` with `outcome: posted` (or
   `already-posted` on a restart) in `pm2 logs cardtable`. A `failed` line says why; the next boot
   retries.

## Notes style

The operator, 2026-10-23: *"make sure that the formatting for the patch notes is consistent and
also make sure the wording is not too verbose. the big features can get extra wording, but for
random bugfixes we can keep the wording simple. make sure all commits get a mention in each
release note"*. And of v0.35.0's post: *"everything in the bullets is bolded which looks bad"*.
Every notes file, and every pending file, follows this.

```markdown
# vX.Y.Z — <headline, a few words>

<one sentence: what this release is about>

## New
- **A big feature, in a sentence.** Up to two short sentences more: what it is and where to find it.
- A small addition.

## Changed
- What works differently now.

## Fixed
- What was wrong is right now.

## Under the hood
- Faster checks before an update ships.
- Dependency updates.
```

- **These headings, in this order**, and no others. Drop an empty one.
- **Every bullet leads with one sentence**, ending in a full stop, that stands on its own.
- **Words follow size.** A big feature (something players will go looking for, or will notice
  on every game) gets the lead plus up to two short sentences, and only there is the lead bold,
  to set it off from what follows. Everything else, every bug fix and small change, is the lead
  alone, plain, on one line, about ten words. When unsure, shorter. A bullet that is bold from
  end to end is wrong.
- **Every commit gets a mention.** Each commit `collect.ts` lists under "Commits to cover" is in
  exactly one bullet; related commits share one. Version bumps and notes commits are the only
  ones left out, and `collect.ts` leaves them out for you. A commit no player sees (CI, tests,
  tooling, docs, dependency updates, admin-only tools such as the testing rooms or the sound
  builder) goes under **Under the hood**, grouped by kind, one plain sentence each.
- **Players' words**, Under the hood too: no file names, commit ids, ticket numbers or internals.
- **Blank lines are for the file.** Write a blank line around each heading as usual; the post
  drops them, since Discord already spaces a heading, and joins a wrapped line back up.
- **Length.** It's posted as a Discord embed. A body over 4096 characters is split at its `##`
  headings into more embeds, and Discord caps a message at 6000 characters in all.

## Fixing prod

A fix for prod takes the same path: land it on main, let PPE take it, and release a patch version.
To ship a fix without the rest of main, release a sha from a branch cut off the last `release/*`
tag. The fix still lands on main too.

## Rolling back

Re-run the release workflow with the previous release's sha and a new patch version, and notes that
say what was rolled back. Prod never runs a sha that has no release tag.
