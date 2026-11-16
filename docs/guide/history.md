# Card Table: history

Card Table's history is a story of eras, not a changelog — 5,500-odd commits
across about ten weeks, most of it in service of one of five shifts.

## The whole plan, one commit

The first commit (`7a2108d`, 2026-09-11) scaffolded the whole approach before
a line of game logic existed: a fork of Forge (the open-source Magic rules
engine) vendored in as a git submodule, plus a Node room layer built on a
private companion repo's existing room, chat and presence code. The design
argument — keep Forge's own server-authoritative model, and replace only the
transport at the one seam Forge had already drawn for a remote GUI — is
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), written the same day and
unchanged in shape since.

## The card library grows backward

Through late September and October, a run of large commits pulled Magic's
own competitive history into the deck library one era at a time: the
power-era Standard decks of 2008–2016 (`7029898`), a format picker splitting
Standard, Modern and Legacy with Modern and Legacy history pulled from
Forge's own archive (`3490bc8`), Standard pushed back to 1995's Type 2 and
Modern to 2011 (`446ba8f`), and finally the whole library brought forward to
Pro Tour 2025's summer in one 1.19-million-line commit (`f13ed39`,
2026-10-16) — still the single largest commit in the repo's history.

## Going public, then free

The repo went public on 2026-10-15 (`1574149`), dropping the private-snapshot
export it had used until then. A week later, PPE (a continuously-deployed
preview instance, separate from the manually-released production app) split
off from prod (`69016bd52`, 2026-10-23). Then, on the operator's call that
the app would always be free, the floor moved from friend tier to member
tier and membership itself became open to anyone — decided 2026-10-30
(`8d25176d8`) and flipped in production on 2026-11-02 (`b000d90f1`). The
Wizards of the Coast disclaimer, removed earlier in the UI's redesign,
returned as one muted line at the foot of the front page now that strangers
could sign up and never read `NOTICE.md` on their own (`aeb431a93`,
2026-11-01).

## A bot joins the draft

On the morning of 2026-11-06, a private companion repo vendoring a
third-party neural draft-rating model was measured for cost inside this
server (`138e8f911`) and then on a lighter WASM backend (`61ae017a2`,
15 ms per pod's pick round, no native dependency) — and wired into live
drafts as the bots' first choice, with the existing heuristic kept as a
fallback, 49 minutes after the first measurement (`7b2be16fc`). See
[features.md#cube-drafting](features.md#cube-drafting) for how a draft
chooses between the two today.

## Magic moves home

Over 2026-11-12 and 11-13, three commits each touching hundreds of thousands
of lines moved every Magic-specific package out of `apps/` and into its own
home under `games/magic/`: card data, deck and draft packages first
(`6f0c583`), then the server (`1c1ee38a4`), then the UI (`8793ca5`). The
point was to leave `apps/server` and `apps/ui` as thin, game-agnostic shells
so the same room layer could eventually host more than one small hadoku
game side by side, each keeping its own package boundary.

## Since

Match music got its own friend-tier review flow the same month the library
work was finishing (`e74ed9cd1`), and room links began unfurling in Discord
with the room's own name, mode and seated faces a few days after the floor
opened to members (`3310926c3`). The repo has since collected 41 tags, from
an early work-in-progress snapshot to its latest release, `release/v0.68.2`
(fact sheet, 2026-11-16).

## Trivia

The floor moved from friend tier to member tier within three days of the
operator's decision to make it — decided `8d25176d8` on 2026-10-30, live by
`b000d90f1` on 2026-11-02.
